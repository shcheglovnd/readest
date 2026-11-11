import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  discoverNativeServer,
  initializeNativeServerConfig,
  nativeServerSessionKey,
  normalizeServerUrl,
  parseNativeServerConfig,
  readNativeServerConfig,
  saveNativeServerConfig,
} from '@/services/nativeServerConfig';

const selectedServer = {
  apiBaseUrl: 'https://books.example.org',
  supabaseUrl: 'https://auth.example.org',
  supabaseAnonKey: 'public-anon-key',
  objectStorageType: 's3',
  selfHosted: true,
};

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'tauri');
  localStorage.clear();
  delete window.__READEST_RUNTIME_CONFIG;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  localStorage.clear();
  delete window.__READEST_RUNTIME_CONFIG;
});

describe('native server selection at startup', () => {
  it('clears legacy compiled-server credentials once before a portable Android build uses its default', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 16)');
    localStorage.setItem('token', 'legacy-local-token');
    localStorage.setItem('sb-readest-auth-token', 'legacy-local-session');
    localStorage.setItem('reader-preference', 'keep');
    initializeNativeServerConfig();
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('sb-readest-auth-token')).toBeNull();
    expect(localStorage.getItem('reader-preference')).toBe('keep');
    localStorage.setItem('token', 'new-server-token');
    initializeNativeServerConfig();
    expect(localStorage.getItem('token')).toBe('new-server-token');
  });
  it('loads the chosen backend before authentication clients are constructed', async () => {
    localStorage.setItem('readest-native-server-config', JSON.stringify(selectedServer));
    const { getRuntimeConfig } = await import('@/services/runtimeConfig');
    expect(getRuntimeConfig()).toMatchObject(selectedServer);
  });

  it('clears the previous server login before using a newly selected backend', async () => {
    localStorage.setItem('readest-native-server-config', JSON.stringify(selectedServer));
    localStorage.setItem('readest-native-server-reset-auth', '1');
    localStorage.setItem('token', 'old-server-access-token');
    localStorage.setItem('user', '{"id":"old-server-user"}');
    localStorage.setItem('sb-readest-auth-token', '{"access_token":"old-server-access-token"}');
    localStorage.setItem('unrelated-reader-preference', 'keep');
    const { getRuntimeConfig } = await import('@/services/runtimeConfig');
    getRuntimeConfig();
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('user')).toBeNull();
    expect(localStorage.getItem('sb-readest-auth-token')).toBeNull();
    expect(localStorage.getItem('unrelated-reader-preference')).toBe('keep');
  });

  it('keeps web deployments bound to their own injected configuration', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'web');
    localStorage.setItem('readest-native-server-config', JSON.stringify(selectedServer));
    window.__READEST_RUNTIME_CONFIG = { apiBaseUrl: 'https://web.example.org' };
    const { getRuntimeConfig } = await import('@/services/runtimeConfig');
    expect(getRuntimeConfig()).toEqual({ apiBaseUrl: 'https://web.example.org' });
  });

  it('keeps the old runtime snapshot until reload, then discards late old-session writes', async () => {
    localStorage.setItem('readest-native-server-config', JSON.stringify(selectedServer));
    const oldRuntime = await import('@/services/runtimeConfig');
    expect(oldRuntime.getRuntimeConfig()).toMatchObject(selectedServer);
    const next = { ...selectedServer, apiBaseUrl: 'https://other.example.org' };
    saveNativeServerConfig(next);
    localStorage.setItem('token', 'late-old-session-callback');
    expect(oldRuntime.getRuntimeConfig()).toMatchObject(selectedServer);
    expect(localStorage.getItem('readest-native-server-reset-auth')).toBe('1');
    vi.resetModules();
    const nextRuntime = await import('@/services/runtimeConfig');
    expect(nextRuntime.getRuntimeConfig()).toMatchObject(next);
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('recovers from corrupted configuration without reusing the old account', () => {
    localStorage.setItem('readest-native-server-config', '{broken');
    localStorage.setItem('token', 'old-token');
    expect(readNativeServerConfig()).toBeUndefined();
    expect(initializeNativeServerConfig()).toBeUndefined();
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('readest-native-server-config')).toBeNull();
  });

  it('returns to the compiled default without deleting downloaded-book preferences', () => {
    localStorage.setItem('readest-native-server-config', JSON.stringify(selectedServer));
    localStorage.setItem('sb-custom-old-auth-token-code-verifier', 'old-proof');
    localStorage.setItem('reader-layout', 'keep');
    saveNativeServerConfig();
    expect(initializeNativeServerConfig()).toBeUndefined();
    expect(localStorage.getItem('sb-custom-old-auth-token-code-verifier')).toBeNull();
    expect(localStorage.getItem('reader-layout')).toBe('keep');
  });
});

describe('server addresses and public configuration', () => {
  it.each([
    [' books.example.org/ ', 'https://books.example.org'],
    ['https://BOOKS.example.org:8443/reader/', 'https://books.example.org:8443/reader'],
    ['http://192.168.1.20:8080/', 'http://192.168.1.20:8080'],
    ['https://[fd00::1]:8443/', 'https://[fd00::1]:8443'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });

  it.each([
    '',
    'file:///etc/passwd',
    'ftp://books.example.org',
    'https://user:password@books.example.org',
    'https://books.example.org/?token=secret',
    'https://books.example.org/#token',
    'not a domain',
  ])('rejects unsafe or invalid addresses: %s', (input) => {
    expect(() => normalizeServerUrl(input)).toThrow();
  });

  it('persists only public supported fields, including split auth and storage quotas', () => {
    const config = parseNativeServerConfig('https://books.example.org', {
      ...selectedServer,
      storageFixedQuota: 100000,
      translationFixedQuota: -1,
      fontBaseUrl: 'https://fonts.example.org/cjk/',
      supabaseAdminKey: 'never-copy-an-admin-key',
      nested: { password: 'never-copy-a-password' },
    });
    expect(config).toMatchObject({
      storageFixedQuota: 100000,
      fontBaseUrl: 'https://fonts.example.org/cjk',
    });
    expect(config).not.toHaveProperty('supabaseAdminKey');
    expect(config).not.toHaveProperty('nested');
    expect(config).not.toHaveProperty('translationFixedQuota');
  });

  it('resolves server-relative API, auth and font addresses against the entered server', () => {
    const config = parseNativeServerConfig('https://books.example.org/reader', {
      apiBaseUrl: '/backend',
      supabaseUrl: '/auth-proxy',
      fontBaseUrl: './fonts',
      supabaseAnonKey: 'public-anon-key',
    });
    expect(config.apiBaseUrl).toBe('https://books.example.org/backend');
    expect(config.supabaseUrl).toBe('https://books.example.org/auth-proxy');
    expect(config.fontBaseUrl).toBe('https://books.example.org/reader/fonts');
  });

  it.each([
    'service_role',
    'authenticated',
  ])('rejects a %s JWT instead of treating it as a public key', (role) => {
    const token = `${btoa('{}')}.${btoa(JSON.stringify({ role }))}.signature`;
    expect(() => parseNativeServerConfig('books.example.org', { supabaseAnonKey: token })).toThrow(
      /public API key/,
    );
  });

  it('rejects modern secret keys and accepts public publishable keys', () => {
    expect(() =>
      parseNativeServerConfig('books.example.org', { supabaseAnonKey: 'sb_secret_private' }),
    ).toThrow();
    expect(
      parseNativeServerConfig('books.example.org', { supabaseAnonKey: 'sb_publishable_public' })
        .supabaseAnonKey,
    ).toBe('sb_publishable_public');
  });

  it('does not write anything when manual configuration is invalid', () => {
    expect(() =>
      saveNativeServerConfig({ ...selectedServer, supabaseAnonKey: 'sb_secret_private' }),
    ).toThrow();
    expect(localStorage.getItem('readest-native-server-reset-auth')).toBeNull();
    expect(localStorage.getItem('readest-native-server-config')).toBeNull();
  });

  it('does not silently downgrade an HTTPS connection to plaintext authentication', () => {
    expect(() =>
      parseNativeServerConfig('https://books.example.org', {
        ...selectedServer,
        supabaseUrl: 'http://auth.example.org',
      }),
    ).toThrow(/HTTPS/);
    expect(
      parseNativeServerConfig('http://books.lan', {
        supabaseUrl: 'http://auth.lan',
        supabaseAnonKey: 'public-anon-key',
      }).supabaseUrl,
    ).toBe('http://auth.lan');
  });

  it('separates auth sessions for domains, ports, paths and split auth endpoints', () => {
    const variants = [
      selectedServer,
      { ...selectedServer, apiBaseUrl: 'https://books.other.org' },
      { ...selectedServer, apiBaseUrl: 'https://books.example.org:8443' },
      { ...selectedServer, apiBaseUrl: 'https://books.example.org/second' },
      { ...selectedServer, supabaseUrl: 'https://auth.other.org' },
    ];
    expect(new Set(variants.map(nativeServerSessionKey)).size).toBe(variants.length);
  });
});

describe('public configuration discovery', () => {
  it('reads existing runtime-config.js as JSON data without sending account headers', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(`window.__READEST_RUNTIME_CONFIG=${JSON.stringify(selectedServer)};`),
      );
    expect(await discoverNativeServer('books.example.org', request)).toMatchObject(selectedServer);
    expect(request).toHaveBeenCalledWith(
      'https://books.example.org/runtime-config.js',
      expect.objectContaining({ credentials: 'omit' }),
    );
    expect(request.mock.calls[0]![1]).not.toHaveProperty('headers');
  });

  it.each([
    '<html>Not a Readest server</html>',
    'window.__READEST_RUNTIME_CONFIG={broken};',
    `window.__READEST_RUNTIME_CONFIG=${JSON.stringify(selectedServer)};globalThis.executedUntrustedScript=true;`,
    `window.__READEST_RUNTIME_CONFIG=${JSON.stringify(selectedServer)};${' '.repeat(65536)}`,
  ])('rejects non-data, malformed or oversized responses', async (body) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    await expect(discoverNativeServer('books.example.org', request)).rejects.toThrow();
    expect('executedUntrustedScript' in globalThis).toBe(false);
  });

  it('reports HTTP failure without executing or accepting the response', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 }));
    await expect(discoverNativeServer('books.example.org', request)).rejects.toThrow(
      /advanced settings/,
    );
  });
});
