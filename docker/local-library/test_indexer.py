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


if __name__ == '__main__':
    unittest.main()
