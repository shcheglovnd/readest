#!/usr/bin/env python3
"""Index existing HDD originals through unmodified Readest sync/storage APIs."""
import argparse
from collections import Counter
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from catalog import Catalog, digest_file
from readest_local import BASE, ORIGIN, api, env, login
import book_metadata as legacy

POLICY_FILE = Path(os.environ.get('LIBRARY_POLICY', BASE / 'roots.json'))
POLICY = json.loads(POLICY_FILE.read_text())
ROOTS = [Path(p).resolve() for p in POLICY['roots']]
EXCLUDED = [Path(p).resolve() for p in POLICY.get('excluded', [])]
GROUP_BASE = Path(POLICY['group_base']).resolve()
DATABASE = Path(os.environ.get('LIBRARY_DATABASE', BASE / 'data/library/catalog.sqlite'))


def folder_group(path):
    return Path(path).parent.relative_to(GROUP_BASE).as_posix()


def update_group(session, owner, identity, path, current):
    group = folder_group(path)
    if current.get('group_name') == group:
        return False
    from readest_local import response_json
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    # Change only group membership. synced_at propagates it to peers; leaving
    # updated_at intact preserves the user's date-read sort and reading state.
    response_json(session.patch(ORIGIN + '/rest/v1/books',
        params={'user_id': 'eq.' + owner, 'book_hash': 'eq.' + identity},
        headers={'apikey': env()['ANON_KEY']}, json={'group_name': group,
            'group_id': hashlib.md5(group.encode()).hexdigest()[:7], 'group_updated_at': now}, timeout=30))
    return True


def scan(catalog, state, full=False):
    paths = []
    for root in ROOTS:
        for directory, dirs, names in os.walk(root):
            dirs[:] = sorted(d for d in dirs if not d.startswith('.') and
                             not any((Path(directory) / d).resolve().is_relative_to(e) for e in EXCLUDED))
            paths.extend(Path(directory) / n for n in sorted(names)
                         if not n.startswith('.') and Path(n).suffix.lower() in legacy.FORMATS)
    sources = []
    invalid = []
    for path in paths:
        try:
            catalog.safe_path(path)
        except PermissionError:
            continue
        if path.suffix.lower() == '.epub' and not zipfile.is_zipfile(path):
            invalid.append(str(path))
            continue
        info = path.stat()
        previous = catalog.source(path)
        if not full and previous and previous['size'] == info.st_size and previous['mtime_ns'] == info.st_mtime_ns:
            checksum = previous['sha256']
            identity = previous['book_hash']
        else:
            checksum = digest_file(path)
            if path.stat().st_mtime_ns != info.st_mtime_ns or path.stat().st_size != info.st_size:
                raise RuntimeError('A book changed while hashing; retry after the copy completes')
            old = state.get(str(path))
            with catalog.connect() as db:
                candidates = db.execute('SELECT * FROM sources WHERE sha256=?', (checksum,)).fetchall()
            moved = [r for r in candidates if r['path'] != str(path) and not Path(r['path']).exists()]
            inode_match = next((r for r in moved if r['device'] == info.st_dev and r['inode'] == info.st_ino), None)
            renamed = inode_match or (moved[0] if len(moved) == 1 else None)
            if previous:
                identity = previous['book_hash']
            elif renamed:
                identity = renamed['book_hash']
            elif old and old.get('sha256') == checksum:
                identity = old['hash']  # Includes the original grammar PDF's established alias.
            else:
                identity = legacy.partial_md5(path)
            if not previous and not renamed:
                with catalog.connect() as db:
                    collision = db.execute('SELECT 1 FROM sources WHERE book_hash=? AND path!=? LIMIT 1', (identity, str(path))).fetchone()
                if collision:
                    identity = hashlib.sha256(('readest-file-v1\0' + str(path) + '\0' + checksum).encode()).hexdigest()[:32]
            catalog.add_source(path, checksum, identity)
            old_path = renamed['path'] if renamed else str(path)
            with catalog.connect() as db:
                db.execute('UPDATE objects SET source_path=?,sha256=? WHERE source_path=?', (str(path), checksum, old_path))
                if renamed:
                    db.execute('DELETE FROM sources WHERE path=?', (old_path,))
        sources.append({'path': str(path), 'sha256': checksum, 'hash': identity,
                        'size': info.st_size, 'mtime_ns': info.st_mtime_ns})
        if len(sources) % 100 == 0:
            print(json.dumps({'indexed_sources': len(sources)}), flush=True)
    return sources, invalid



def restore_entry(catalog, session, owner, source):
    """Explicitly re-add a known deleted entry without resetting its history."""
    from readest_local import response_json
    path = Path(source['path'])
    identity = source['hash']
    name = f'books/{identity}/{identity}.{path.suffix[1:].lower()}'
    catalog.bind(f'{owner}/{name}', source['sha256'], path=path)
    api(session, 'POST', '/api/storage/upload', json={
        'fileName': name, 'fileSize': source['size'], 'bookHash': identity})
    _, _, _, cover, _ = legacy.metadata(path)
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    group = folder_group(path)
    fields = {'deleted_at': None, 'uploaded_at': now, 'updated_at': now,
              'group_name': group, 'group_id': hashlib.md5(group.encode()).hexdigest()[:7],
              'group_updated_at': now}
    if cover:
        legacy.upload(session, cover, f'books/{identity}/cover.png', identity)
        fields.update({'cover_hash': legacy.partial_md5(cover), 'cover_updated_at': now})
    response_json(session.patch(ORIGIN + '/rest/v1/books',
        params={'user_id': 'eq.' + owner, 'book_hash': 'eq.' + identity},
        headers={'apikey': env()['ANON_KEY']}, json=fields, timeout=30))


def publish(catalog, sources, restore_hashes=()):
    session, owner, _ = login()
    current = api(session, 'GET', '/api/sync?type=books&since=0')['books'] or []
    known = {b['book_hash']: b for b in current}
    counts = Counter()
    missing_restores = set(restore_hashes) - {source['hash'] for source in sources}
    if missing_restores:
        raise ValueError('Requested restore has no source in the included folders')
    for source in sources:
        identity = source['hash']
        if identity in known:
            if identity in restore_hashes and known[identity].get('deleted_at'):
                restore_entry(catalog, session, owner, source)
                known[identity]['deleted_at'] = None
                known[identity]['group_name'] = folder_group(source['path'])
                counts['restored_entries'] += 1
            if not known[identity].get('deleted_at'):
                path = Path(source['path'])
                if update_group(session, owner, identity, path, known[identity]):
                    known[identity]['group_name'] = folder_group(path)
                    counts['folder_groups_updated'] += 1
            counts['existing_or_deleted'] += 1
            continue  # Never overwrite user edits, progress or bookshelf deletions.
        path = Path(source['path'])
        title, author, metadata, cover, pages = legacy.metadata(path)
        now = int(time.time() * 1000)
        group = folder_group(path)
        book = {'hash': identity, 'format': legacy.FORMATS[path.suffix.lower()], 'title': title,
                'sourceTitle': metadata.get('title') or title, 'originalFilename': path.name,
                'author': author, 'metadata': metadata, 'createdAt': now, 'updatedAt': now,
                'uploadedAt': now, 'deletedAt': None, 'groupId': hashlib.md5(group.encode()).hexdigest()[:7],
                'groupName': group, 'groupUpdatedAt': now, 'tags': [group], 'readingStatus': 'unread',
                'readingStatusUpdatedAt': now, 'metadataUpdatedAt': now}
        if pages:
            book['pageCount'] = pages
        name = f'books/{identity}/{identity}.{path.suffix[1:].lower()}'
        catalog.bind(f'{owner}/{name}', source['sha256'], path=path)
        # Reserve the ordinary files row. No PUT: its book bytes already exist on the HDD.
        api(session, 'POST', '/api/storage/upload', json={'fileName': name, 'fileSize': source['size'], 'bookHash': identity})
        if cover:
            legacy.upload(session, cover, f'books/{identity}/cover.png', identity)
            book.update({'coverHash': legacy.partial_md5(cover), 'coverUpdatedAt': now})
        api(session, 'POST', '/api/sync', json={'books': [book]})
        known[identity] = book
        counts['new_entries'] += 1
    return dict(counts)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--full-hash', action='store_true')
    parser.add_argument('--restore', action='append', default=[], metavar='BOOK_HASH',
                        help='Explicitly restore a deleted entry whose HDD source exists')
    args = parser.parse_args()
    for name in ('private', 'audit', 'data/library'):
        (BASE / name).mkdir(parents=True, exist_ok=True)
    lock = open(BASE / 'private/import.lock', 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    mount = POLICY.get('mount_point')
    if (mount and not os.path.ismount(mount)) or not all(root.is_dir() for root in ROOTS):
        raise RuntimeError('Library storage is not mounted')
    statefile = BASE / 'private/import-state.json'
    state = json.loads(statefile.read_text()) if statefile.exists() else {}
    catalog = Catalog(DATABASE, ROOTS, EXCLUDED)
    sources, invalid = scan(catalog, state, args.full_hash)
    report = {'time': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'source_files': len(sources), 'invalid_sources': invalid}
    report.update(publish(catalog, sources, args.restore))
    (BASE / 'audit/library-index-latest.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
