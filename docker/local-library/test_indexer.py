import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import Mock, patch

from catalog import Catalog

spec = importlib.util.spec_from_file_location('indexer', Path(__file__).with_name('index-library.py'))
index = importlib.util.module_from_spec(spec)
with tempfile.TemporaryDirectory() as setup:
    policy = Path(setup) / 'roots.json'
    policy.write_text(json.dumps({'roots': [str(Path(setup) / 'books')], 'excluded': [], 'group_base': setup}))
    with patch.dict(os.environ, {'LIBRARY_POLICY': str(policy), 'ANON_KEY': 'test-anon-key'}):
        spec.loader.exec_module(index)


class FileIdentities(unittest.TestCase):
    def setUp(self):
        self.config = patch.dict(os.environ, {'ANON_KEY': 'test-anon-key'})
        self.config.start()
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'books'
        self.root.mkdir()
        self.catalog = Catalog(Path(self.temp.name) / 'state.sqlite', [self.root], [self.root / 'excluded'])
        index.ROOTS = [self.root]
        index.EXCLUDED = [self.root / 'excluded']
        self.first = self.root / 'first.pdf'
        self.first.write_bytes(b'%PDF-' + b'x' * 10000)

    def tearDown(self):
        self.temp.cleanup()
        self.config.stop()

    def scan(self):
        rows, invalid = index.scan(self.catalog, {})
        self.assertFalse(invalid)
        return {Path(r['path']).name: r for r in rows}

    def test_identical_copies_are_independent_and_stable(self):
        self.first_id = self.scan()['first.pdf']['hash']
        shutil.copy2(self.first, self.root / 'second.pdf')
        rows = self.scan()
        self.assertNotEqual(rows['first.pdf']['hash'], rows['second.pdf']['hash'])
        self.assertEqual(rows['first.pdf']['sha256'], rows['second.pdf']['sha256'])
        self.assertEqual(rows, self.scan())

    def test_rename_preserves_identity_then_another_copy_gets_a_new_identity(self):
        identity = self.scan()['first.pdf']['hash']
        renamed = self.root / 'renamed.pdf'
        self.first.rename(renamed)
        self.assertEqual(self.scan()['renamed.pdf']['hash'], identity)
        shutil.copy2(renamed, self.root / 'copy.pdf')
        rows = self.scan()
        self.assertEqual(rows['renamed.pdf']['hash'], identity)
        self.assertNotEqual(rows['copy.pdf']['hash'], identity)

    def test_different_notes_with_the_same_sampled_hash_are_separate(self):
        annotated = self.root / 'annotated.pdf'
        annotated.write_bytes(self.first.read_bytes() + b'additional annotation')
        self.assertEqual(index.legacy.partial_md5(self.first), index.legacy.partial_md5(annotated))
        rows = self.scan()
        self.assertNotEqual(rows['first.pdf']['sha256'], rows['annotated.pdf']['sha256'])
        self.assertNotEqual(rows['first.pdf']['hash'], rows['annotated.pdf']['hash'])

    def test_renaming_remaining_hardlink_ignores_a_deleted_alias_identity(self):
        first = self.scan()['first.pdf']
        second = self.root / 'second.pdf'
        os.link(self.first, second)
        rows = self.scan()
        second_id = rows['second.pdf']['hash']
        first_key = '11111111-1111-1111-1111-111111111111/books/' + first['hash'] + '/book.pdf'
        second_key = first_key.replace(first['hash'], second_id)
        self.catalog.bind(first_key, first['sha256'], path=self.first)
        self.catalog.bind(second_key, first['sha256'], path=second)
        self.first.unlink()
        self.catalog.detach(first_key)
        second.rename(self.root / 'renamed.pdf')
        self.assertEqual(self.scan()['renamed.pdf']['hash'], second_id,
                         'A live hardlink must not inherit the intentionally deleted copy identity')

    def test_restored_original_path_keeps_identity_even_after_reference_deletion(self):
        first = self.scan()['first.pdf']
        key = '11111111-1111-1111-1111-111111111111/books/' + first['hash'] + '/book.pdf'
        self.catalog.bind(key, first['sha256'], path=self.first)
        content = self.first.read_bytes()
        self.first.unlink()
        self.catalog.detach(key)
        self.first.write_bytes(content)
        self.assertEqual(self.scan()['first.pdf']['hash'], first['hash'])

    def test_legacy_deleted_reference_is_not_a_rename_candidate(self):
        first = self.scan()['first.pdf']
        key = '11111111-1111-1111-1111-111111111111/books/' + first['hash'] + '/book.pdf'
        self.catalog.bind(key, first['sha256'], enabled=False)
        self.first.rename(self.root / 'new.pdf')
        self.scan()
        self.assertIsNotNone(self.catalog.source(self.first),
                             'The deleted source identity must remain available for restoration')

    def test_restore_with_preserved_mtime_refreshes_inode_without_changing_identity(self):
        first = self.scan()['first.pdf']
        original_inode = self.catalog.source(self.first)['inode']
        backup = Path(self.temp.name) / 'backup.pdf'
        shutil.copy2(self.first, backup)
        with self.first.open('rb'):
            self.first.unlink()
            shutil.copy2(backup, self.first)
            self.assertNotEqual(self.first.stat().st_ino, original_inode)
            self.assertEqual(self.first.stat().st_mtime_ns, first['mtime_ns'])
            self.assertEqual(self.scan()['first.pdf']['hash'], first['hash'])
            self.assertEqual(self.catalog.source(self.first)['inode'], self.first.stat().st_ino)

    def test_excluded_subtrees_are_not_indexed(self):
        excluded = self.root / 'excluded'
        excluded.mkdir()
        shutil.copy2(self.first, excluded / 'private.pdf')
        self.assertEqual(set(self.scan()), {'first.pdf'})

    def test_folder_groups_use_the_configured_base(self):
        with patch.object(index, 'GROUP_BASE', Path(self.temp.name)):
            self.assertEqual(index.folder_group(self.root / 'Physics' / 'book.pdf'), 'books/Physics')

    def test_first_scan_does_not_require_legacy_migration_state(self):
        state = Path(self.temp.name) / 'new-state'
        with patch.object(index, 'BASE', state), patch.object(index, 'DATABASE', state / 'data/library/catalog.sqlite'), patch.object(index, 'publish', return_value={}) as publish, patch.object(index.sys, 'argv', ['index-library.py']):
            index.main()
        self.assertTrue((state / 'audit/library-index-latest.json').exists())
        self.assertFalse((state / 'private/import-state.json').exists())
        self.assertEqual(len(publish.call_args.args[1]), 1)

    def test_explicit_restore_keeps_the_id_source_and_existing_history_fields(self):
        source = self.scan()['first.pdf']
        session = Mock()
        session.patch.return_value.ok = True
        session.patch.return_value.content = b'[]'
        session.patch.return_value.json.return_value = []
        with patch.object(index, 'api') as request, patch.object(index, 'folder_group', return_value='books/Physics'), patch.object(index.legacy, 'metadata', return_value=('Title', 'Author', {}, None, None)):
            index.restore_entry(self.catalog, session, '11111111-1111-1111-1111-111111111111', source)
        fields = session.patch.call_args.kwargs['json']
        self.assertIsNone(fields['deleted_at'])
        self.assertEqual(fields['group_name'], 'books/Physics')
        self.assertFalse({'progress', 'reading_status', 'metadata', 'title', 'created_at'} & fields.keys())
        self.assertEqual(request.call_args.kwargs['json']['bookHash'], source['hash'])
        key = '11111111-1111-1111-1111-111111111111/books/' + source['hash'] + '/' + source['hash'] + '.pdf'
        self.assertEqual(self.catalog.resolve(key), self.first)

    def publish(self, sources, known):
        owner = '11111111-1111-1111-1111-111111111111'
        def request(session, method, route, **kwargs):
            if method == 'GET':
                return {'books': list(known)}
            if route == '/api/sync':
                for book in kwargs['json']['books']:
                    known.append({'book_hash': book['hash'], 'deleted_at': None})
            return {}
        with patch.object(index, 'login', return_value=(Mock(), owner, {})), \
             patch.object(index, 'api', side_effect=request) as api, \
             patch.object(index, 'update_group', return_value=False), \
             patch.object(index, 'folder_group', return_value='books'), \
             patch.object(index.legacy, 'metadata', return_value=('Title', 'Author', {}, None, None)):
            result = index.publish(self.catalog, sources)
        registrations = [c.kwargs['json']['bookHash'] for c in api.call_args_list
                         if c.args[2] == '/api/storage/upload']
        return result, registrations

    def test_first_publication_adds_one_entry_for_identical_files(self):
        shutil.copy2(self.first, self.root / 'second.pdf')
        sources = list(self.scan().values())
        known = []
        result, registrations = self.publish(sources, known)
        self.assertEqual(len(registrations), 1, 'Byte-identical files must create only one bookshelf entry')
        self.assertEqual(result['duplicate_sources_skipped'], 1)
        self.assertEqual(len(known), 1)
        self.assertEqual(self.publish(sources, known)[1], [])

    def test_new_copy_before_existing_path_does_not_get_an_independent_entry(self):
        original = self.scan()['first.pdf']
        shutil.copy2(self.first, self.root / 'a-copy.pdf')
        known = [{'book_hash': original['hash'], 'deleted_at': None}]
        result, registrations = self.publish(list(self.scan().values()), known)
        self.assertEqual(registrations, [], 'A new path must not duplicate an existing book')
        self.assertEqual(result['duplicate_sources_skipped'], 1)
        self.assertEqual(known[0]['book_hash'], original['hash'])

    def test_copy_does_not_recreate_a_deleted_book_under_a_new_id(self):
        original = self.scan()['first.pdf']
        key = '11111111-1111-1111-1111-111111111111/books/' + original['hash'] + '/book.pdf'
        self.catalog.bind(key, original['sha256'], enabled=False, path=self.first)
        self.first.rename(self.root / 'a-copy.pdf')
        known = [{'book_hash': original['hash'], 'deleted_at': '2026-01-01T00:00:00Z'}]
        result, registrations = self.publish(list(self.scan().values()), known)
        self.assertEqual(registrations, [], 'A copy must not bypass a prior bookshelf deletion')
        self.assertEqual(result['duplicate_sources_skipped'], 1)

    def test_existing_independent_entries_are_preserved(self):
        shutil.copy2(self.first, self.root / 'second.pdf')
        sources = list(self.scan().values())
        known = [{'book_hash': r['hash'], 'deleted_at': None} for r in sources]
        expected = [dict(r) for r in known]
        result, registrations = self.publish(sources, known)
        self.assertEqual(registrations, [])
        self.assertEqual(result['existing_or_deleted'], 2)
        self.assertEqual(known, expected)

    def test_different_full_content_with_same_sampled_hash_still_gets_two_entries(self):
        other = self.root / 'annotated.pdf'
        other.write_bytes(self.first.read_bytes() + b'embedded annotation')
        self.assertEqual(index.legacy.partial_md5(self.first), index.legacy.partial_md5(other))
        _, registrations = self.publish(list(self.scan().values()), [])
        self.assertEqual(len(registrations), 2)

    def test_previously_skipped_copy_is_added_if_its_content_becomes_different(self):
        original = self.scan()['first.pdf']
        other = self.root / 'second.pdf'
        shutil.copy2(self.first, other)
        known = [{'book_hash': original['hash'], 'deleted_at': None}]
        self.publish(list(self.scan().values()), known)
        other.write_bytes(other.read_bytes() + b'embedded annotation')
        _, registrations = self.publish(list(self.scan().values()), known)
        self.assertEqual(len(registrations), 1)
        self.assertEqual(len(known), 2, 'The original plus the edited copy should be the only entries')

    def test_existing_object_alias_also_prevents_a_duplicate_entry(self):
        original = self.scan()['first.pdf']
        alias = 'b' * 32
        key = '11111111-1111-1111-1111-111111111111/books/' + alias + '/book.pdf'
        self.catalog.bind(key, original['sha256'], path=self.first)
        _, registrations = self.publish([original], [{'book_hash': alias, 'deleted_at': None}])
        self.assertEqual(registrations, [], 'An existing object alias must count as the same content')


if __name__ == '__main__':
    unittest.main()
