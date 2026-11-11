import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SupabaseClient } from '@supabase/supabase-js';
import AuthPanel from '@/app/auth/components/AuthPanel';

const h = vi.hoisted(() => ({
  request: vi.fn(),
  restart: vi.fn(),
  stopRefresh: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (text: string) => text }));
vi.mock('@/app/auth/components/ReadestCloudOptIn', () => ({ default: () => null }));
vi.mock('@/app/auth/components/ProviderLogin', () => ({ ProviderLogin: () => null }));
vi.mock('@/app/auth/components/EmailPasswordAuth', () => ({ default: () => null }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: h.request }));
vi.mock('@/services/nativeServerConfig', async (original) => ({
  ...(await original<object>()),
  restartAfterNativeServerChange: h.restart,
}));

const client = { auth: { stopAutoRefresh: h.stopRefresh } } as unknown as SupabaseClient;
const setup = () => render(<AuthPanel supabaseClient={client} onProviderSignIn={async () => {}} />);

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'tauri');
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 16)');
  localStorage.clear();
  vi.clearAllMocks();
  h.stopRefresh.mockResolvedValue(undefined);
  h.invoke.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('native server connection form', () => {
  const certificate = {
    subject: 'CN=Example Home CA',
    issuer: 'CN=Example Home CA',
    fingerprint: Array(32).fill('AB').join(':'),
    validFrom: 1577836800,
    validUntil: 4733510400,
    currentlyValid: true,
  };

  it('previews a certificate and requires explicit trust before persisting it', async () => {
    h.invoke.mockImplementation(async (command) =>
      command === 'list_server_certificates' ? [] : [certificate],
    );
    setup();
    fireEvent.click(screen.getByText('Server'));
    fireEvent.change(screen.getByLabelText('Certificate file'), {
      target: { files: [new File(['example certificate bytes'], 'home.crt')] },
    });
    await screen.findByRole('button', { name: 'Trust certificate' });
    expect(screen.getByText('CN=Example Home CA')).toBeTruthy();
    expect(screen.getByText(`SHA-256: ${certificate.fingerprint}`)).toBeTruthy();
    expect(h.invoke.mock.calls.some(([name]) => name === 'import_server_certificates')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Trust certificate' }));
    await screen.findByRole('button', { name: 'Remove certificate' });
    expect(h.invoke).toHaveBeenCalledWith('import_server_certificates', {
      data: Array.from(new TextEncoder().encode('example certificate bytes')),
    });
    expect(localStorage.getItem('readest-native-server-config')).toBeNull();
    expect(h.restart).not.toHaveBeenCalled();
  });

  it('can cancel a preview without adding trust', async () => {
    h.invoke.mockImplementation(async (command) =>
      command === 'list_server_certificates' ? [] : [certificate],
    );
    setup();
    fireEvent.click(screen.getByText('Server'));
    fireEvent.change(screen.getByLabelText('Certificate file'), {
      target: { files: [new File(['certificate'], 'home.pem')] },
    });
    await screen.findByRole('button', { name: 'Trust certificate' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Trust certificate' })).toBeNull();
    expect(h.invoke.mock.calls.some(([name]) => name === 'import_server_certificates')).toBe(false);
  });

  it('removes only the selected app-local certificate', async () => {
    h.invoke.mockImplementation(async (command) =>
      command === 'list_server_certificates' ? [certificate] : [],
    );
    setup();
    fireEvent.click(screen.getByText('Server'));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove certificate' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove certificate' })).toBeNull(),
    );
    expect(h.invoke).toHaveBeenCalledWith('remove_server_certificate', {
      fingerprint: certificate.fingerprint,
    });
  });

  it('rejects oversized files and reports native validation failures without changing trust', async () => {
    h.invoke.mockImplementation(async (command) => {
      if (command === 'inspect_server_certificates')
        throw 'Import certificates only, never private keys.';
      return [];
    });
    setup();
    fireEvent.click(screen.getByText('Server'));
    fireEvent.change(screen.getByLabelText('Certificate file'), {
      target: { files: [new File([new Uint8Array(65537)], 'large.pem')] },
    });
    expect(screen.getByRole('alert').textContent).toMatch(/64 KiB/);
    expect(h.invoke.mock.calls.some(([name]) => name === 'inspect_server_certificates')).toBe(
      false,
    );
    fireEvent.change(screen.getByLabelText('Certificate file'), {
      target: { files: [new File(['private key'], 'key.pem')] },
    });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/never private keys/),
    );
    expect(h.invoke.mock.calls.some(([name]) => name === 'import_server_certificates')).toBe(false);
    expect(screen.queryByRole('button', { name: 'Trust certificate' })).toBeNull();
  });

  it('offers certificate import before connecting to an untrusted home server', async () => {
    setup();
    fireEvent.click(screen.getByText('Server'));
    expect(screen.getByLabelText('Certificate file')).toBeTruthy();
    expect(
      screen.getByText('PEM or DER (.pem, .crt, .cer, .der). Never import a private key.'),
    ).toBeTruthy();
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith('list_server_certificates'));
  });
  it('lets a native reader choose a server before signing in', () => {
    setup();
    fireEvent.click(screen.getByText('Server'));
    expect(screen.getByLabelText('Server address')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect and restart' })).toBeTruthy();
  });

  it('discovers public configuration, persists it, and reloads before sign-in', async () => {
    h.request.mockResolvedValue(
      new Response(
        'window.__READEST_RUNTIME_CONFIG={"supabaseUrl":"https://auth.example.org","supabaseAnonKey":"public-anon-key"};',
      ),
    );
    setup();
    fireEvent.click(screen.getByText('Server'));
    fireEvent.change(screen.getByLabelText('Server address'), {
      target: { value: 'books.example.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect and restart' }));
    await waitFor(() => expect(h.restart).toHaveBeenCalledOnce());
    expect(JSON.parse(localStorage.getItem('readest-native-server-config')!)).toMatchObject({
      apiBaseUrl: 'https://books.example.org',
      supabaseUrl: 'https://auth.example.org',
    });
    expect(h.stopRefresh).toHaveBeenCalledOnce();
    expect(localStorage.getItem('readest-native-server-reset-auth')).toBe('1');
  });

  it('keeps the current server if discovery fails and offers manual setup', async () => {
    h.request.mockRejectedValue(new Error('untrusted certificate'));
    setup();
    fireEvent.click(screen.getByText('Server'));
    fireEvent.change(screen.getByLabelText('Server address'), {
      target: { value: 'books.example.org' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect and restart' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(h.restart).not.toHaveBeenCalled();
    expect(localStorage.getItem('readest-native-server-config')).toBeNull();
    expect(screen.getByLabelText('Public API key')).toBeTruthy();
  });

  it('supports manual public configuration when discovery is unavailable', async () => {
    setup();
    fireEvent.click(screen.getByText('Server'));
    fireEvent.change(screen.getByLabelText('Server address'), {
      target: { value: 'https://books.example.org' },
    });
    fireEvent.change(screen.getByLabelText('Authentication server address'), {
      target: { value: 'https://auth.example.org' },
    });
    fireEvent.change(screen.getByLabelText('Public API key'), {
      target: { value: 'sb_publishable_public' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect and restart' }));
    await waitFor(() => expect(h.restart).toHaveBeenCalledOnce());
    expect(h.request).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('readest-native-server-config')!)).toMatchObject({
      supabaseUrl: 'https://auth.example.org',
      supabaseAnonKey: 'sb_publishable_public',
    });
  });

  it('can return to the compiled default and starts a fresh local login', async () => {
    localStorage.setItem(
      'readest-native-server-config',
      JSON.stringify({
        apiBaseUrl: 'https://books.example.org',
        supabaseUrl: 'https://auth.example.org',
        supabaseAnonKey: 'public-anon-key',
      }),
    );
    setup();
    fireEvent.click(screen.getByText('Server'));
    fireEvent.click(screen.getByRole('button', { name: 'Use default server' }));
    await waitFor(() => expect(h.restart).toHaveBeenCalledOnce());
    expect(localStorage.getItem('readest-native-server-config')).toBeNull();
    expect(localStorage.getItem('readest-native-server-reset-auth')).toBe('1');
  });

  it('keeps server selection out of the web/PWA sign-in flow', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'web');
    setup();
    expect(screen.queryByText('Server')).toBeNull();
  });

  it('keeps the Android-only selector out of native desktop windows', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)');
    setup();
    expect(screen.queryByText('Server')).toBeNull();
  });
});
