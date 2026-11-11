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
3. If the server uses a private CA or a self-signed certificate, import its
   **public certificate** under **Trusted certificates** as described below.
4. Select **Connect and restart**, then sign in with an account on that server.

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

Normal public HTTPS certificates work without importing anything. For a private
CA or self-signed HTTPS server:

1. Obtain the public CA certificate (or the self-signed server certificate)
   from the server administrator. Choose **Certificate file**. PEM and DER are
   supported, including a PEM bundle; common extensions are `.pem`, `.crt`,
   `.cer`, and `.der`.
2. Review the subject, issuer, validity dates, and **SHA-256 fingerprint**.
   Verify the fingerprint independently with the administrator, then select
   **Trust certificate**. Choosing a file alone does not add trust.
3. Connect to the server normally. Imported certificates persist across app
   restarts and can be removed individually with **Remove certificate**.

The certificate store is **app-local**, not the Android system/user trust store.
No personal hostname, certificate, private key, or account is baked into the APK.
Different people can configure the same build for their own home networks.
Never import a private key or a PKCS#12/client-identity bundle. Invalid,
expired/not-yet-valid certificates, private-key blocks, and ordinary server leaf
certificates signed by another issuer are rejected; import that issuer's CA
instead. The store supports up to 16 unique certificates within 64 KiB.

On Android, requests made with `fetch` to the selected API, auth, and font origins
use Tauri's native HTTP client. The transport is installed before authentication
initializes. Native HTTP, discovery, and Rust file transfers all read the same
app-private PEM bundle in addition to normal WebPKI roots. New clients reload the
bundle after an import/removal, without rebuilding the APK. A CA is trusted by
native HTTP throughout this app; review it as a certificate authority, not a
single-host exception. Hostname, server-certificate validity, and chain checks
remain enabled; there is no "ignore certificate errors" switch or WebView SSL
error bypass. Other origins and bundled/local resources keep their existing
WebView transport. External browsers/OAuth provider pages and direct WebView
resources that are not loaded via `fetch` do not acquire this app-local trust.

The first launch of this portable Android version clears legacy login tokens
once, preventing a previously hardcoded server's session from reaching a changed
compiled default. Saved custom-server configuration, downloaded books, and reader
preferences are preserved. Switching back to the default server does not delete
imported certificates; remove any unwanted certificate explicitly.

Plain HTTP remains available for deliberate LAN/development use, with a notice
that sign-in traffic needs HTTPS protection.

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
  src/__tests__/services/native-server-fetch.test.ts \
  src/__tests__/components/auth/NativeServerSettings.test.tsx \
  src/__tests__/utils/supabase-storage-key.test.ts
pnpm test:rust
```

## Volume-button scrolling

Under **Controls → Page Turner**, enable **Use Volume Keys** and select
**Volume key action → Scroll**. This enables **Scrolled Mode** using the reader's
existing layout controls. Set **Scroll step (%)** from **1 to 100**; the default
is **25%** of the visible reading area. Try 3–5% for small movements.

Volume Down advances and Volume Up goes back. The renderer handles reading
direction, horizontal/vertical scroll, PDF zoom and section/book boundaries.
The current viewport and saved step are read on each press, so changing the
step or rotating the phone does not require reopening the book. This is a
geometric scrolling distance, not exact text-line snapping. It also works for
image-only PDFs. The preference follows the normal global/per-book settings
rules and resets with the reader's behavior settings.

Scroll takes priority over paragraph/ruler navigation while the renderer is in
continuous mode. It does not use full-page line snapping or the PDF page-overlap
setting, and small steps do not count as whole-page e-ink refresh turns. If you
manually turn Scrolled Mode off, the existing paginated behavior applies.

Select **Page** to use the previous volume-button behavior (also the default
for existing installations):

- Normally each press navigates one page or one viewport in scrolled mode.
- With **Paragraph Mode**, volume keys navigate previous/next paragraphs.
- Under **Theme → Reading Ruler**, select **Band** and **Lines to Highlight = 1**
  for single-line ruler navigation in reflowable books such as EPUB. The ruler
  moves through the visible lines and advances the viewport at its edge.
  Paragraph Mode takes priority; disable it when using the ruler's line controls.
- Fixed-layout formats, including PDF, use a fixed ruler step rather than text
  line snapping. A dedicated "scroll the PDF by exactly one text line per press"
  setting is not implemented; use the percentage-based Scroll mode instead.

Volume keys temporarily control system volume while read-aloud is playing and
are released while reader controls are open, following upstream behavior.
