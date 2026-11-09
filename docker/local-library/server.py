"""Private storage RPC plus expiring browser transfers. Originals are read-only."""
import asyncio
import base64
import hashlib
import hmac
import json
import mimetypes
import os
from pathlib import Path
import secrets
import time

from aiohttp import web
from catalog import Catalog, book_key, digest_file


def create_app(database, roots, inbox, secret, origin, exclusions=(), owner_id=None):
    catalog = Catalog(database, roots, exclusions)
    inbox = Path(inbox)
    uploads = asyncio.Semaphore(4)

    def sign(action, key, size=0, ttl=1800):
        payload = json.dumps({'action': action, 'key': key, 'size': size,
                              'exp': int(time.time()) + min(max(int(ttl), 1), 1800)},
                             separators=(',', ':')).encode()
        encoded = base64.urlsafe_b64encode(payload).rstrip(b'=').decode()
        signature = hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).hexdigest()
        return f'{origin}/library-files/{encoded}.{signature}'

    def verify(token, action):
        try:
            encoded, signature = token.rsplit('.', 1)
            expected = hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(signature, expected):
                raise ValueError()
            data = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
            if data['action'] != action or data['exp'] <= time.time() or not book_key(data['key']):
                raise ValueError()
            return data
        except (ValueError, KeyError, TypeError):
            raise web.HTTPForbidden(text='Invalid or expired transfer') from None

    @web.middleware
    async def errors(request, handler):
        try:
            return await handler(request)
        except FileNotFoundError:
            raise web.HTTPNotFound(text='Original unavailable; check storage and rescan') from None
        except PermissionError:
            raise web.HTTPForbidden(text='Library path denied') from None
        except ValueError:
            raise web.HTTPBadRequest(text='Invalid storage request') from None

    async def rpc(request):
        if not hmac.compare_digest(request.headers.get('Authorization', ''), 'Bearer ' + secret):
            raise web.HTTPForbidden()
        data = await request.json()
        operation = request.match_info['operation']
        key = data.get('fileKey')
        if not book_key(key):
            raise web.HTTPBadRequest(text='Invalid book key')
        if operation == 'download':
            catalog.resolve(key)
            return web.json_response({'url': sign('GET', key, ttl=data.get('expiresIn', 1800))})
        if operation == 'upload':
            size = data.get('contentLength')
            if type(size) is not int or not 0 < size <= 4 * 1024**3:
                raise web.HTTPBadRequest(text='Invalid upload length')
            return web.json_response({'url': sign('PUT', key, size, data.get('expiresIn', 1800))})
        if operation == 'delete':
            catalog.detach(key)  # A bookshelf deletion never deletes an HDD original.
            return web.json_response({'ok': True})
        if operation == 'exists':
            try:
                catalog.resolve(key)
                exists = True
            except FileNotFoundError:
                exists = False
            return web.json_response({'exists': exists})
        if operation == 'copy':
            source = catalog.resolve(key)
            dest = data.get('destFileKey')
            if not book_key(dest):
                raise web.HTTPBadRequest(text='Invalid destination key')
            catalog.bind(dest, catalog.reference(key)['sha256'], path=source)
            return web.json_response({'ok': True})
        raise web.HTTPNotFound()

    async def download(request):
        data = verify(request.match_info['token'], 'GET')
        path = catalog.resolve(data['key'])
        # aiohttp provides bounded sendfile, HEAD, conditional requests and 206/416.
        content_type = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        return web.FileResponse(path, headers={'Content-Type': content_type,
                                              'Cache-Control': 'private, no-store',
                                              'X-Content-Type-Options': 'nosniff'})

    async def upload(request):
        data = verify(request.match_info['token'], 'PUT')
        if request.content_length != data['size']:
            raise web.HTTPBadRequest(text='Upload length does not match reservation')
        key = data['key']
        user, identity, extension = book_key(key)
        destination = inbox
        if owner_id and user != owner_id:
            destination = inbox / '.users' / user
            destination.mkdir(mode=0o700, parents=True, exist_ok=True)
        async with uploads:
            temp = destination / ('.readest-part-' + secrets.token_hex(16))
            try:
                sha = hashlib.sha256()
                received = 0
                with temp.open('xb') as target:
                    async for chunk in request.content.iter_chunked(1024 * 1024):
                        received += len(chunk)
                        if received > data['size']:
                            raise web.HTTPBadRequest(text='Upload exceeds reservation')
                        target.write(chunk)
                        sha.update(chunk)
                    if received != data['size']:
                        raise web.HTTPBadRequest(text='Incomplete upload')
                    target.flush()
                    os.fsync(target.fileno())
                checksum = sha.hexdigest()
                reference = catalog.reference(key)
                if reference and reference['sha256'] and reference['sha256'] != checksum:
                    raise web.HTTPConflict(text='Existing original differs; it was not overwritten')
                try:
                    original = catalog.find_source(checksum, exact_path=reference['source_path'] if reference else None)
                except FileNotFoundError:
                    original = destination / f'{identity}-{checksum[:12]}.{extension}'
                    try:
                        os.link(temp, original)  # Publish complete file, without replacing anything.
                    except FileExistsError:
                        if digest_file(original) != checksum:
                            raise web.HTTPConflict(text='Destination already exists') from None
                    directory_fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                    catalog.add_source(original, checksum, identity)
                catalog.bind(key, checksum, path=original)
                return web.Response(status=200, headers={'ETag': '"' + checksum + '"'})
            finally:
                temp.unlink(missing_ok=True)

    async def health(request):
        return web.json_response({'ok': True})

    app = web.Application(client_max_size=64 * 1024, middlewares=[errors])
    app.router.add_get('/healthz', health)
    app.router.add_post('/v1/{operation}', rpc)
    app.router.add_get('/library-files/{token}', download)
    app.router.add_put('/library-files/{token}', upload)
    return app


if __name__ == '__main__':
    os.umask(0o077)
    roots = json.loads(os.environ['LIBRARY_ROOTS'])
    web.run_app(create_app(os.environ['LIBRARY_DATABASE'], roots, os.environ['LIBRARY_INBOX'],
                           os.environ['LOCAL_LIBRARY_SECRET'], os.environ['LIBRARY_ORIGIN'],
                           json.loads(os.environ.get('LIBRARY_EXCLUDED', '[]')),
                           os.environ.get('LIBRARY_OWNER')),
                host='0.0.0.0', port=8080, access_log=None, print=None)
