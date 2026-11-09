# Filesystem library for self-hosted Readest

This optional adapter serves existing book files from server storage. The same
folders can be managed through SMB/Samba; Readest accesses the mounted filesystem,
and browsers download books over HTTPS. There is no SMB implementation in the
browser. A server that mounts a remote SMB share can use the same integration.

The application changes are five hooks in `src/utils/object.ts` and the small
`localLibrary.ts` helper. With `LOCAL_LIBRARY_URL` unset, upstream storage behavior
is retained. With it set, book transfers use this service and fail if originals
are unavailable. Covers and other auxiliary assets continue using S3/R2. Keep the
normal Readest authentication, sync database and auxiliary object storage.

## Behavior

- The original file stays authoritative. The catalog stores paths and checksums;
  it does not store another copy of the book. Clients keep their normal downloads.
- The indexer mirrors relative directories into Readest's existing nested Groups
  view. Empty directories are omitted. Group edits in Readest do not move files;
  the next scan restores the filesystem's grouping.
- Each physical path has its own book ID and reading state, including identical
  copies and PDFs whose embedded annotations differ. Rename detection preserves
  established IDs when the original path disappears. Files are never rewritten
  to obtain a distinct ID. Manual browser imports retain upstream deduplication.
- Removed or edited originals require a rescan; unavailable references fail rather
  than returning a different physical copy. Existing client downloads may need a
  new download after an external edit. Missing sources do not delete user records.
- Deleting a bookshelf entry disables its reference and preserves its original.
  Scans honor bookshelf deletions. `--restore BOOK_HASH` explicitly restores an
  existing deleted entry with its established ID and reading history.
- Browser uploads publish complete files atomically into `Readest Inbox`, with
  size checks and no overwriting. Other accounts' uploads go into hidden `.users`
  directories, excluded from the owner's scanner. The inbox filesystem must
  support hard links for atomic publishing.
- Transfers support HEAD, ranges and conditional requests. Signed URLs expire
  after at most 30 minutes; private RPCs use a separate shared secret. Paths outside
  configured roots, excluded paths and symlink escapes are rejected.

The scanner extracts PDF/EPUB/FB2 metadata and covers; it also indexes MOBI, AZW,
AZW3, FBZ and CBZ. Rendering support remains Readest's. This scanner does not add
support for DRM or arbitrary comic archives.

## Setup

Start with [Readest's self-hosting instructions](../README.md). This directory is
an extension to that stack, not a replacement authentication/database stack.

Initialize the web build's submodules from the repository root before building:

```sh
git submodule update --init packages/foliate-js packages/simplecc-wasm \
  packages/qcms packages/js-mdict \
  apps/readest-app/src-tauri/plugins/tauri-plugin-turso
```

1. Mount the storage on the server first. Create only the roots you intend to
   expose, a writable `books/Readest Inbox`, and a private state directory:

   ```sh
   export READEST_STATE_DIR="$HOME/.local/share/readest-library"
   mkdir -p "$READEST_STATE_DIR"/private "$READEST_STATE_DIR"/data/library
   chmod 700 "$READEST_STATE_DIR" "$READEST_STATE_DIR/private"
   cp docker/local-library/roots.example.json "$READEST_STATE_DIR/roots.json"
   ```

   Edit `roots.json`: set `group_base`, `roots`, `excluded`, `inbox` and optionally
   `mount_point`. The mount guard makes scans fail when a storage mount is absent.
   Match the paths and exclusions in the sidecar's environment. The indexer and
   storage container must see originals at **the same absolute paths**. Ensure UID
   1000 can read originals and write the catalog/inbox; adjust the example UID if
   needed. Other original paths are mounted read-only.

2. Add `compose.example.yaml` as an override to the upstream stack. Set
   `LIBRARY_STORAGE_ROOT`, `READEST_STATE_DIR`, `LIBRARY_OWNER` (the Readest account
   UUID) and `LOCAL_LIBRARY_SECRET` (a new random secret) in your private Compose
   environment. Set `SITE_URL`, browser-facing Supabase URLs and storage URLs to
   your HTTPS public origin, as required by the upstream reverse-proxy setup.
   Build the fork's image; the example's `client.build` uses the root Dockerfile:

   ```sh
   docker compose --env-file /path/to/private/compose.env \
     -f docker/compose.yaml -f docker/local-library/compose.example.yaml \
     up -d --build
   ```

   Preserve existing database/object-store volumes when adopting this in an
   existing installation. No private environment file belongs in the repository.

3. Add the location from `nginx.example.conf` to the reverse proxy for that origin.
   The proxy must reach `library:8080` through the stack's Docker network. Keep
   `/v1/*` private and do not publish the service's port. The existing application
   routes, Supabase routes and auxiliary object-storage routes are still required.

4. Install the host-side indexer using Python 3.12 or newer:

   ```sh
   python3 -m venv /path/to/private/library-venv
   /path/to/private/library-venv/bin/pip install \
     -r docker/local-library/requirements-indexer.lock.txt
   export READEST_URL=https://readest.example.com
   export LIBRARY_POLICY="$READEST_STATE_DIR/roots.json"
   ```

   Store `ANON_KEY` and the library owner's `READEST_EMAIL`/`READEST_PASSWORD` in
   `$READEST_STATE_DIR/.env` with permissions 0600, or supply them through the
   process environment. Values in the file use literal `KEY=value` syntax without
   shell quotes. Alternatively put email/password in
   `$READEST_STATE_DIR/private/login.json`. `READEST_URL`, `READEST_STATE_DIR` and
   `LIBRARY_POLICY` are process environment variables. A private CA can be supplied
   through `READEST_CA_BUNDLE`; certificate verification stays enabled.

   ```sh
   /path/to/private/library-venv/bin/python docker/local-library/index-library.py
   # Rehash every source, even if size/mtime have not changed:
   /path/to/private/library-venv/bin/python docker/local-library/index-library.py --full-hash
   # Explicitly re-add a previously deleted bookshelf entry:
   /path/to/private/library-venv/bin/python docker/local-library/index-library.py --restore BOOK_HASH
   ```

   Run the normal scan every five minutes with your scheduler. Its file lock
   prevents overlapping scans. Reports go to the private state's `audit/`
   directory. Source files are read only by the indexer; book bytes are registered
   through the normal API without uploading them again. Covers use signed uploads.
   Select **Groups** in Readest to browse the mirrored directory structure.

## Existing installations and backups

The adapter is intended to index a new filesystem library, or to continue a
previously migrated one with its existing `catalog.sqlite`. It is **not an
automatic migration of arbitrary pre-existing S3 books**. Preserve the established
book IDs and explicitly map existing file records before enabling the adapter on
such a library. Old S3 cleanup and host-specific migration scripts are deliberately
not included or scheduled. Do not delete old objects until a migration has been
verified separately.

Back up Readest's Postgres data, private configuration, auxiliary object storage,
and the catalog using SQLite's online backup API. The catalog and database must
describe the same library. Back up original books separately. This adapter never
deletes originals. Restoring an old catalog/database can discard newer reading
state; updating the fork does not require replacing either.

## PWA changes included in the fork

The root Dockerfile builds with webpack so Serwist emits `sw.js`. The worker
precaches startup pages, runtime configuration, the required WASM and correctly
sized icons. Runtime configuration loads before the client SDK, and the existing
login is retained offline. Open/download books online before expecting offline
reading. External translation services still need network access.

The manifest requests fullscreen, and Readest recognizes that installed display
mode. Whether system bars disappear depends on the Android browser; this does not
force Firefox to honor fullscreen. General settings remain per browser. Native
Android apps still require their own backend configuration; these changes target
the self-hosted web/PWA build.

## Verification and upstream updates

```sh
pnpm --filter @readest/readest-app test --run src/__tests__/utils/local-library.test.ts
pnpm --filter @readest/readest-app test --run
pnpm --filter @readest/readest-app lint
python -m unittest discover -s docker/local-library -p 'test_*.py' -v
docker build -t local/readest:homelab .
# Full app test suite in the same Docker build environment:
docker build --target unit-tests .
docker build -t local/readest-library:homelab docker/local-library
```

Keep upstream as a separate remote and merge updates deliberately. Review the five
object-storage hooks and the PWA source diff, then repeat contract tests, full app
tests/type checking/lint, production build and staged reading/offline/sync checks.
Use disposable test accounts for browser checks. Never reset a live database to
make test counts match an old snapshot.
