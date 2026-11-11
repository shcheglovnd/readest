import type { ReadestRuntimeConfig } from './runtimeConfig';
import { getOSPlatform, stubTranslation as _ } from '@/utils/misc';

export interface NativeServerConfig extends ReadestRuntimeConfig {
  apiBaseUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

const CONFIG_KEY = 'readest-native-server-config';
const RESET_AUTH_KEY = 'readest-native-server-reset-auth';
const PORTABLE_AUTH_KEY = 'readest-native-portable-auth-v1';

export function normalizeServerUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error(_('Enter a server address.'));
  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    throw new Error(_('Enter a valid HTTP or HTTPS server address.'));
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(_('Enter a valid HTTP or HTTPS server address.'));
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(_('Use a server address without a password, query, or fragment.'));
  }
  return url.href.replace(/\/+$/, '');
}

export function parseNativeServerConfig(serverUrl: string, value: unknown): NativeServerConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(_('The server did not return valid Readest configuration.'));
  }
  const data = value as Record<string, unknown>;
  const baseUrl = normalizeServerUrl(serverUrl);
  const configUrl = (value: string) =>
    normalizeServerUrl(
      /^(?:\/|\.\.\/|\.\/)/.test(value) ? new URL(value, `${baseUrl}/`).href : value,
    );
  const key = typeof data['supabaseAnonKey'] === 'string' ? data['supabaseAnonKey'].trim() : '';
  if (!key || key.length > 16384) throw new Error(_('A public API key is required.'));
  let role: unknown;
  if (key.split('.').length === 3) {
    try {
      const claims: unknown = JSON.parse(
        atob(key.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')),
      );
      if (claims && typeof claims === 'object') role = (claims as Record<string, unknown>)['role'];
    } catch {
      throw new Error(_('Enter a valid public API key.'));
    }
  }
  if (key.startsWith('sb_secret_') || (typeof role === 'string' && role !== 'anon')) {
    throw new Error(_('Use a public API key, never a secret or service-role key.'));
  }
  const config: NativeServerConfig = {
    apiBaseUrl: configUrl(typeof data['apiBaseUrl'] === 'string' ? data['apiBaseUrl'] : baseUrl),
    supabaseUrl: configUrl(typeof data['supabaseUrl'] === 'string' ? data['supabaseUrl'] : baseUrl),
    supabaseAnonKey: key,
    selfHosted: data['selfHosted'] !== false,
  };
  if (
    baseUrl.startsWith('https:') &&
    [config.apiBaseUrl, config.supabaseUrl].some((url) => url.startsWith('http:'))
  ) {
    throw new Error(_('Use HTTPS for both API and authentication addresses.'));
  }
  if (typeof data['objectStorageType'] === 'string')
    config.objectStorageType = data['objectStorageType'];
  if (typeof data['fontBaseUrl'] === 'string' && data['fontBaseUrl']) {
    config.fontBaseUrl = configUrl(data['fontBaseUrl']);
  }
  for (const field of ['storageFixedQuota', 'translationFixedQuota'] as const) {
    const quota = data[field];
    if (typeof quota === 'number' && Number.isFinite(quota) && quota >= 0) config[field] = quota;
  }
  return config;
}

export async function discoverNativeServer(
  address: string,
  request?: typeof fetch,
): Promise<NativeServerConfig> {
  const serverUrl = normalizeServerUrl(address);
  // Native HTTP avoids CORS on the existing runtime-config.js endpoint. TLS
  // verification remains enabled; no auth/session headers are sent to discovery.
  const fetchConfig = request ?? (await import('@tauri-apps/plugin-http')).fetch;
  const response = await fetchConfig(`${serverUrl}/runtime-config.js`, {
    credentials: 'omit',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error(_('Could not load server configuration. Try advanced settings.'));
  const script = await response.text();
  // This is data discovery, not script execution. Reject any extra JavaScript.
  const match =
    script.length <= 65536 &&
    /^\s*window\.__READEST_RUNTIME_CONFIG\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(script);
  if (!match) throw new Error(_('The server did not return valid Readest configuration.'));
  let data: unknown;
  try {
    data = JSON.parse(match[1]!);
  } catch {
    throw new Error(_('The server did not return valid Readest configuration.'));
  }
  return parseNativeServerConfig(serverUrl, data);
}

export function readNativeServerConfig(): NativeServerConfig | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const saved = localStorage.getItem(CONFIG_KEY);
    if (!saved) return undefined;
    const data = JSON.parse(saved) as Record<string, unknown>;
    return parseNativeServerConfig(
      typeof data['apiBaseUrl'] === 'string' ? data['apiBaseUrl'] : '',
      data,
    );
  } catch {
    return undefined;
  }
}

export function saveNativeServerConfig(config?: NativeServerConfig): void {
  const validated = config ? parseNativeServerConfig(config.apiBaseUrl, config) : undefined;
  // Keep the current runtime snapshot unchanged until reload. An in-flight
  // request must never combine an old account token with a new server URL.
  localStorage.setItem(RESET_AUTH_KEY, '1');
  if (validated) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(validated));
  } else {
    localStorage.removeItem(CONFIG_KEY);
  }
}

export function initializeNativeServerConfig(): NativeServerConfig | undefined {
  const config = readNativeServerConfig();
  // Older locally configured APKs used the same auth keys as the compiled
  // default. Clear them once before a portable build can contact its default.
  const firstPortableStart =
    getOSPlatform() === 'android' && !localStorage.getItem(PORTABLE_AUTH_KEY);
  if (
    firstPortableStart ||
    localStorage.getItem(RESET_AUTH_KEY) ||
    (localStorage.getItem(CONFIG_KEY) && !config)
  ) {
    // Runs before Supabase or AuthContext reads its session. A callback from
    // the old page cannot restore an old token after this new document loads.
    const authKeys = ['token', 'user', 'refresh_token', 'lastRedirectAt'];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith('sb-') && /-auth-token(?:-code-verifier)?$/.test(key)) authKeys.push(key);
    }
    for (const key of authKeys) localStorage.removeItem(key);
    localStorage.removeItem(RESET_AUTH_KEY);
    if (!config) localStorage.removeItem(CONFIG_KEY);
  }
  if (firstPortableStart) localStorage.setItem(PORTABLE_AUTH_KEY, '1');
  return config;
}

export const nativeServerSessionKey = (config: NativeServerConfig): string =>
  `sb-custom-${encodeURIComponent(config.apiBaseUrl)}-${encodeURIComponent(config.supabaseUrl)}-auth-token`;

export const restartAfterNativeServerChange = () => window.location.replace('/auth');
