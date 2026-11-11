import type { NativeServerConfig } from './nativeServerConfig';
import { getOSPlatform } from '@/utils/misc';

export function createNativeServerFetch(
  config: NativeServerConfig,
  webFetch: typeof fetch,
  nativeFetch: typeof fetch,
): typeof fetch {
  const origins = new Set(
    [config.apiBaseUrl, config.supabaseUrl, config.fontBaseUrl]
      .filter((url): url is string => Boolean(url))
      .map((url) => new URL(url).origin),
  );
  return (input, init) => {
    let url: URL | undefined;
    try {
      url = new URL(input instanceof Request ? input.url : input);
    } catch {
      // Relative paths and bundled assets stay on the WebView transport.
    }
    return url && ['https:', 'http:'].includes(url.protocol) && origins.has(url.origin)
      ? nativeFetch(input, init)
      : webFetch(input, init);
  };
}

export function installNativeServerFetch(config: NativeServerConfig): void {
  if (getOSPlatform() !== 'android') return;
  // Install before Supabase captures fetch or starts refreshing a saved session.
  // Native reqwest clients use the app's imported roots, keep hostname/chain
  // verification enabled, and are also used by file transfers. No SSL-error
  // override or change to the Android system certificate store is needed.
  const webFetch = globalThis.fetch.bind(globalThis);
  const nativeFetch: typeof fetch = async (input, init) =>
    (await import('@tauri-apps/plugin-http')).fetch(input, init);
  globalThis.fetch = createNativeServerFetch(config, webFetch, nativeFetch);
}
