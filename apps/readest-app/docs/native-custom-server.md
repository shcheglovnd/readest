# Choose a custom server in the native app

This fork adds a **Server** section to the Android sign-in screen. A single build can
connect to different Readest installations; the chosen hostname and public
client key are saved on the device rather than compiled into the application.
The web/PWA and native desktop sign-in flows keep their existing behavior.

## Connect

1. Open the native sign-in screen and expand **Server**.
2. Enter the Readest server address, for example `https://books.example.org`.
   An address without a scheme uses HTTPS. Ports and reverse-proxy base paths
   are supported when the server is deployed at that path.
3. Select **Connect and restart**, then sign in with an account on that server.

The app discovers the public configuration from the existing
`/runtime-config.js` endpoint. Discovery parses the JSON assignment as data;
it does not execute the remote script. No account token is sent to discovery.
The advertised authentication URL, API URL, storage type, quotas and font URL
are preserved, including deployments with separate authentication and API hosts.
Server-relative URLs are resolved against the entered address. An HTTPS
connection rejects advertised plaintext API/authentication URLs.

For an older deployment without discovery, open **Advanced configuration** and
enter its **Public API key**, plus its **Authentication server address** when
that differs from the main address. Use the Supabase anon or publishable key;
secret/service-role keys and user-session JWTs are rejected. Operator passwords
and object-store credentials are not needed.

**Use default server** restores the backend configured by the build, normally
Readest Cloud. Selecting a different server clears the app's local login
sessions on the next page load. Auth session keys include the full API and auth
URLs, so different domains, ports and base paths cannot share a token by accident.
The current runtime configuration stays fixed until that reload, preventing an
old in-flight request from picking up the new destination.

Downloaded books and reader preferences stay on the device. The existing sync
controls govern which local content is synced after signing in to the selected
server. Sign-in and sync for third-party providers keep their existing behavior.

## Server and TLS requirements

Use a compatible Readest backend, including its authentication, database and
file-transfer API; a folder of static ebook files is not a Readest backend.
Existing filesystem storage adapters continue to work through those APIs.

HTTPS certificates must be trusted by both the platform web view and native HTTP
client. Normal public certificates work with the standard platform trust roots.
Private-CA deployments need the corresponding trust configuration in both stacks;
entering a hostname does not install a CA. This feature preserves certificate
verification. Plain HTTP is available for deliberate LAN/development use, with a
notice that sign-in traffic needs HTTPS protection.

Native discovery uses the existing Tauri HTTP permission scope, so the config
endpoint does not need extra browser CORS headers. Authentication and API routes
must accept native origins (`http://tauri.localhost` / `https://tauri.localhost`),
as the upstream API middleware already does.

## Build and verify

Follow the upstream Android build prerequisites and submodule setup. No custom
backend URL, private CA, account password or signing key is included in this fork.
Release signing remains an operator-owned build setting.
Use a separate Android application ID when installing a locally signed build
beside the vendor-signed application; Android requires the same signing key for
updates to an existing package.
For a custom-signed fork, set `NEXT_PUBLIC_DISABLE_UPDATER=true` in `.env.local`
and distribute updates signed with your own persistent key. The vendor updater
distributes vendor builds rather than this fork.

```sh
pnpm tauri android init
pnpm tauri icon ../../data/icons/readest-book.png
# Restore tracked native customizations after initialization, as upstream does.
git restore -- src-tauri/gen/android src-tauri/icons
pnpm tauri android build -t aarch64
```

Focused regression tests:

```sh
pnpm test --run src/__tests__/services/native-server-config.test.ts \
  src/__tests__/components/auth/NativeServerSettings.test.tsx \
  src/__tests__/utils/supabase-storage-key.test.ts
```

## Existing volume-button behavior

Enable **Controls → Page Turner → Use Volume Keys** in the reader.

- Normally each press navigates one page or one viewport in scrolled mode.
- With **Paragraph Mode**, volume keys navigate previous/next paragraphs.
- Under **Theme → Reading Ruler**, select **Band** and **Lines to Highlight = 1**
  for single-line ruler navigation in reflowable books such as EPUB. The ruler
  moves through the visible lines and advances the viewport at its edge.
  Paragraph Mode takes priority; disable it when using the ruler's line controls.
- Fixed-layout formats, including PDF, use a fixed ruler step rather than text
  line snapping. A dedicated "scroll the PDF by exactly one text line per press"
  setting is not implemented by this change.

Volume keys temporarily control system volume while read-aloud is playing and
are released while reader controls are open, following upstream behavior.
