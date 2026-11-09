"""Filesystem index and logical Readest object references; no book-byte storage."""
import hashlib
from contextlib import contextmanager
from pathlib import Path
import re
import sqlite3
import stat

EXTENSIONS = {'pdf', 'epub', 'mobi', 'azw', 'azw3', 'fb2', 'fbz', 'cbz', 'cbr', 'cb7', 'txt'}


def book_key(key):
    if not isinstance(key, str) or '\\' in key or '%' in key or '\x00' in key:
        return None
    parts = key.split('/')
    if any(p in ('', '.', '..') for p in parts):
        return None
    if len(parts) == 4 and parts[1] == 'books':
        owner, _, identity, name = parts
    elif len(parts) == 5 and parts[1:3] == ['Readest', 'Books']:
        owner, _, _, identity, name = parts
    else:
        return None
    extension = name.rsplit('.', 1)[-1].lower()
    if not re.fullmatch(r'[a-f0-9-]{36}', owner) or not re.fullmatch(r'[a-f0-9]{32}', identity) or extension not in EXTENSIONS:
        return None
    return owner, identity, extension


def digest_file(path):
    with open(path, 'rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


class Catalog:
    def __init__(self, database, roots, exclusions=()):
        self.database = Path(database)
        self.roots = [Path(root).resolve() for root in roots]
        self.exclusions = [Path(path).resolve() for path in exclusions]
        self.database.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript('''
                CREATE TABLE IF NOT EXISTS sources (
                    path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
                    mtime_ns INTEGER NOT NULL, book_hash TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sources_sha ON sources(sha256);
                CREATE TABLE IF NOT EXISTS objects (
                    file_key TEXT PRIMARY KEY, sha256 TEXT, enabled INTEGER NOT NULL DEFAULT 0
                );
            ''')
            for table, column, kind in [('sources', 'device', 'INTEGER'), ('sources', 'inode', 'INTEGER'),
                                         ('objects', 'source_path', 'TEXT')]:
                columns = {r['name'] for r in db.execute(f'PRAGMA table_info({table})')}
                if column not in columns:
                    db.execute(f'ALTER TABLE {table} ADD COLUMN {column} {kind}')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.database, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def safe_path(self, path):
        path = Path(path).resolve(strict=True)
        if not any(path.is_relative_to(root) for root in self.roots):
            raise PermissionError('Outside library roots')
        if any(path.is_relative_to(excluded) for excluded in self.exclusions):
            raise PermissionError('Excluded library folder')
        if not stat.S_ISREG(path.stat().st_mode):
            raise PermissionError('Not a regular book file')
        return path

    def add_source(self, path, sha256, book_hash):
        path = self.safe_path(path)
        info = path.stat()
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO sources (path,sha256,size,mtime_ns,book_hash,device,inode) VALUES (?,?,?,?,?,?,?)',
                       (str(path), sha256, info.st_size, info.st_mtime_ns, book_hash, info.st_dev, info.st_ino))

    def source(self, path):
        with self.connect() as db:
            row = db.execute('SELECT * FROM sources WHERE path=?', (str(path),)).fetchone()
            return dict(row) if row else None

    def find_source(self, sha256, exact_path=None):
        with self.connect() as db:
            if exact_path:
                rows = db.execute('SELECT * FROM sources WHERE sha256=? AND path=?', (sha256, str(exact_path))).fetchall()
            else:
                rows = db.execute('SELECT * FROM sources WHERE sha256=? ORDER BY path', (sha256,)).fetchall()
        for row in rows:
            try:
                path = self.safe_path(row['path'])
                info = path.stat()
                if info.st_size == row['size'] and info.st_mtime_ns == row['mtime_ns']:
                    return path
            except (OSError, PermissionError):
                continue
        raise FileNotFoundError('Original is missing or changed; rescan required')

    def reference(self, key):
        if not book_key(key):
            raise ValueError('Invalid book key')
        with self.connect() as db:
            row = db.execute('SELECT * FROM objects WHERE file_key=?', (key,)).fetchone()
            return dict(row) if row else None

    def bind(self, key, sha256, enabled=True, path=None):
        if not book_key(key):
            raise ValueError('Invalid book key')
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO objects (file_key,sha256,enabled,source_path) VALUES (?,?,?,?)',
                       (key, sha256, int(enabled), str(path) if path else None))

    def resolve(self, key):
        row = self.reference(key)
        if not row or not row['enabled'] or not row['sha256']:
            raise FileNotFoundError('Book not available')
        if row['source_path']:
            return self.find_source(row['sha256'], exact_path=row['source_path'])
        return self.find_source(row['sha256'])

    def detach(self, key):
        if not book_key(key):
            raise ValueError('Invalid book key')
        with self.connect() as db:
            db.execute('UPDATE objects SET enabled=0 WHERE file_key=?', (key,))
