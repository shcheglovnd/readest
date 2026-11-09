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
