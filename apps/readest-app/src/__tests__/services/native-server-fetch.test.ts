import { describe, expect, it, vi } from 'vitest';
import { createNativeServerFetch } from '@/services/nativeServerFetch';

const config = {
  apiBaseUrl: 'https://books.example.org:8443/reader',
  supabaseUrl: 'https://auth.example.org',
  supabaseAnonKey: 'public-anon-key',
  fontBaseUrl: 'https://fonts.example.org',
};

describe('Android custom-server transport', () => {
  it.each([
    'https://books.example.org:8443/reader/api/sync',
    'https://auth.example.org/auth/v1/token',
    'https://fonts.example.org/font.woff2',
  ])('uses certificate-aware native HTTP for %s', async (url) => {
    const web = vi.fn().mockResolvedValue(new Response('web'));
    const native = vi.fn().mockResolvedValue(new Response('native'));
    const request = createNativeServerFetch(config, web, native);
    const init = { method: 'POST', headers: { Authorization: 'Bearer local-token' }, body: 'body' };
    expect(await (await request(url, init)).text()).toBe('native');
    expect(native).toHaveBeenCalledWith(url, init);
    expect(web).not.toHaveBeenCalled();
  });

  it.each([
    'https://books.example.org:8444/api/sync',
    'http://books.example.org:8443/api/sync',
    'https://books.example.org.evil.test:8443/api/sync',
    'https://api.gemini.example/translate',
    'http://tauri.localhost/reader.js',
    '/reader.js',
    'blob:http://tauri.localhost/book',
  ])('keeps other origins and local assets on the WebView transport: %s', async (url) => {
    const web = vi.fn().mockResolvedValue(new Response('web'));
    const native = vi.fn();
    await createNativeServerFetch(config, web, native)(url);
    expect(web).toHaveBeenCalledWith(url, undefined);
    expect(native).not.toHaveBeenCalled();
  });

  it('preserves Request objects, abort signals, and HTTP failures without a fallback', async () => {
    const web = vi.fn();
    const native = vi.fn().mockRejectedValue(new Error('invalid peer certificate'));
    const input = new Request('https://auth.example.org/auth/v1/token', {
      method: 'POST',
      body: 'x',
    });
    const init = { signal: new AbortController().signal };
    await expect(createNativeServerFetch(config, web, native)(input, init)).rejects.toThrow(
      'certificate',
    );
    expect(native).toHaveBeenCalledWith(input, init);
    expect(web).not.toHaveBeenCalled();
  });
});
