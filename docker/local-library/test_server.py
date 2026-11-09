import base64
import asyncio
import hashlib
import hmac
import json
from pathlib import Path
import tempfile
import time
import unittest

from aiohttp.test_utils import TestClient, TestServer
from catalog import Catalog, digest_file
from server import create_app

KEY = '11111111-1111-1111-1111-111111111111/books/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/book.pdf'
SECRET = 'only-for-local-tests'


class StorageAcceptance(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.books = self.base / 'books'
        self.books.mkdir()
        self.inbox = self.books / 'inbox'
        self.inbox.mkdir()
        self.original = self.books / 'original.pdf'
        self.content = b'%PDF-1.7\n' + bytes(range(256)) * 50
        self.original.write_bytes(self.content)
        database = self.base / 'state/catalog.sqlite'
        self.catalog = Catalog(database, [self.books])
        self.catalog.add_source(self.original, digest_file(self.original), 'a' * 32)
        self.catalog.bind(KEY, digest_file(self.original))
        self.client = TestClient(TestServer(create_app(database, [self.books], self.inbox, SECRET, 'http://example.test')))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.temp.cleanup()

    async def rpc(self, operation, **data):
        return await self.client.post('/v1/' + operation, headers={'Authorization': 'Bearer ' + SECRET}, json={'fileKey': KEY, **data})

    async def link(self, operation='download', **data):
        response = await self.rpc(operation, **data)
        self.assertEqual(response.status, 200, await response.text())
        return (await response.json())['url'].replace('http://example.test', '')

    async def test_original_bytes_ranges_head_and_conditionals(self):
        link = await self.link()
        response = await self.client.get(link)
        self.assertEqual(await response.read(), self.content)
        etag = response.headers['ETag']
        response = await self.client.head(link)
        self.assertEqual(response.status, 200)
        self.assertEqual(int(response.headers['Content-Length']), len(self.content))
        for header, expected in [('bytes=5-20', self.content[5:21]), ('bytes=-17', self.content[-17:]), ('bytes=12000-', self.content[12000:])]:
            response = await self.client.get(link, headers={'Range': header})
            self.assertEqual(response.status, 206)
            self.assertEqual(await response.read(), expected)
        response = await self.client.get(link, headers={'Range': 'bytes=999999-'})
        self.assertEqual(response.status, 416)
        response = await self.client.get(link, headers={'If-None-Match': etag})
        self.assertEqual(response.status, 304)

    async def test_no_unsigned_or_tampered_access(self):
        response = await self.client.post('/v1/download', json={'fileKey': KEY})
        self.assertEqual(response.status, 403)
        link = await self.link()
        response = await self.client.get(link[:-1] + ('0' if link[-1] != '0' else '1'))
        self.assertEqual(response.status, 403)
        payload = base64.urlsafe_b64encode(json.dumps({'action': 'GET', 'key': KEY, 'size': 0, 'exp': int(time.time()) - 1}).encode()).rstrip(b'=').decode()
        signature = hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
        response = await self.client.get('/library-files/' + payload + '.' + signature)
        self.assertEqual(response.status, 403)

    async def test_traversal_and_symlink_escape(self):
        response = await self.rpc('download', fileKey=KEY.replace('/books/', '/../books/'))
        self.assertEqual(response.status, 400)
        outside = self.base / 'private.pdf'
        outside.write_bytes(b'secret')
        link = self.books / 'escape.pdf'
        link.symlink_to(outside)
        with self.assertRaises(PermissionError):
            self.catalog.add_source(link, digest_file(outside), 'b' * 32)

    async def test_excluded_subtree_is_rejected_inside_an_allowed_root(self):
        excluded = self.books / 'Учеба'
        excluded.mkdir()
        source = excluded / 'private.pdf'
        source.write_bytes(self.content)
        self.catalog.exclusions = [excluded]
        with self.assertRaises(PermissionError):
            self.catalog.add_source(source, digest_file(source), 'b' * 32)

    async def test_identical_physical_files_have_independent_references(self):
        copy = self.books / 'physical-copy.pdf'
        copy.write_bytes(self.content)
        checksum = digest_file(copy)
        self.catalog.add_source(copy, checksum, 'b' * 32)
        other_key = KEY.replace('a' * 32, 'b' * 32)
        self.catalog.bind(KEY, checksum, path=self.original)
        self.catalog.bind(other_key, checksum, path=copy)
        self.assertNotEqual(self.catalog.resolve(KEY), self.catalog.resolve(other_key))
        link = await self.link('upload', fileKey=other_key, contentLength=len(self.content))
        self.assertEqual((await self.client.put(link, data=self.content)).status, 200)
        self.assertEqual(self.catalog.resolve(other_key), copy)
        self.catalog.detach(other_key)
        self.assertEqual(self.catalog.resolve(KEY), self.original)
        self.assertTrue(copy.exists())

    async def test_delete_revokes_link_but_preserves_original(self):
        link = await self.link()
        self.assertEqual((await self.rpc('delete')).status, 200)
        self.assertEqual((await self.client.get(link)).status, 404)
        self.assertEqual(self.original.read_bytes(), self.content)

    async def test_missing_original_never_falls_back_to_a_copy(self):
        link = await self.link()
        self.original.unlink()
        self.assertEqual((await self.client.get(link)).status, 404)
        self.assertFalse((await (await self.rpc('exists')).json())['exists'])

    async def test_rename_and_duplicate_source_recovery(self):
        link = await self.link()
        renamed = self.books / 'renamed.pdf'
        self.original.rename(renamed)
        self.assertEqual((await self.client.get(link)).status, 404)
        self.catalog.add_source(renamed, digest_file(renamed), 'a' * 32)
        self.assertEqual(await (await self.client.get(link)).read(), self.content)

    async def test_upload_deduplicates_and_refuses_overwrite(self):
        link = await self.link('upload', contentLength=len(self.content))
        self.assertEqual((await self.client.put(link, data=self.content)).status, 200)
        self.assertEqual(list(self.inbox.iterdir()), [])
        changed = b'x' * len(self.content)
        self.assertEqual((await self.client.put(link, data=changed)).status, 409)
        self.assertEqual(self.original.read_bytes(), self.content)
        self.assertEqual(list(self.inbox.iterdir()), [])

    async def test_new_upload_is_atomic_and_copy_shares_the_original(self):
        key = KEY.replace('a' * 32, 'b' * 32)
        link = await self.link('upload', fileKey=key, contentLength=len(self.content) + 1)
        response = await self.client.put(link, data=self.content)
        self.assertEqual(response.status, 400)
        self.assertEqual(list(self.inbox.iterdir()), [])
        content = self.content + b'\n'
        self.assertEqual((await self.client.put(link, data=content)).status, 200)
        self.assertEqual(len(list(self.inbox.iterdir())), 1)
        destination = KEY.replace('11111111', '22222222')
        response = await self.rpc('copy', fileKey=key, destFileKey=destination)
        self.assertEqual(response.status, 200)
        self.assertEqual(self.catalog.resolve(key), self.catalog.resolve(destination))

    async def test_interrupted_upload_never_publishes_partial_bytes(self):
        key = KEY.replace('a' * 32, 'c' * 32)
        link = await self.link('upload', fileKey=key, contentLength=1024 * 1024)
        target = self.client.make_url(link)
        reader, writer = await asyncio.open_connection(target.host, target.port)
        writer.write((f'PUT {target.path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n').encode() + b'partial payload')
        await writer.drain()
        await asyncio.sleep(0.05)
        writer.close()
        await writer.wait_closed()
        await asyncio.sleep(0.1)
        self.assertEqual(list(self.inbox.iterdir()), [])
        self.assertIsNone(self.catalog.reference(key))


if __name__ == '__main__':
    unittest.main()
