'use client';

import { useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { IoChevronDown } from 'react-icons/io5';
import { useTranslation } from '@/hooks/useTranslation';
import { getBaseUrl } from '@/services/environment';
import { getOSPlatform } from '@/utils/misc';
import {
  discoverNativeServer,
  normalizeServerUrl,
  parseNativeServerConfig,
  readNativeServerConfig,
  restartAfterNativeServerChange,
  saveNativeServerConfig,
} from '@/services/nativeServerConfig';

function ServerConnectionForm({ supabaseClient }: { supabaseClient: SupabaseClient }) {
  const _ = useTranslation();
  const [current] = useState(readNativeServerConfig);
  const [address, setAddress] = useState(current?.apiBaseUrl ?? getBaseUrl());
  const [authAddress, setAuthAddress] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError('');
    try {
      const url = normalizeServerUrl(address);
      const config = publicKey.trim()
        ? parseNativeServerConfig(url, {
            supabaseUrl: authAddress.trim() || url,
            supabaseAnonKey: publicKey,
          })
        : await discoverNativeServer(url);
      await supabaseClient.auth.stopAutoRefresh();
      saveNativeServerConfig(config);
      restartAfterNativeServerChange();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '';
      // Parser errors are registered translation keys. Connection failures use
      // an actionable message rather than exposing native networking internals.
      setError(
        message.endsWith('.')
          ? _(message)
          : _('Could not connect. Check the server address and certificate.'),
      );
      setAdvanced(true);
      setPending(false);
    }
  };

  const useDefaultServer = async () => {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await supabaseClient.auth.stopAutoRefresh();
      saveNativeServerConfig();
      restartAfterNativeServerChange();
    } catch {
      setError(_('Could not save the server settings.'));
      setPending(false);
    }
  };

  const inputClass = 'input input-bordered eink-bordered h-11 min-w-0 w-full rounded-lg text-sm';
  return (
    <details className='group border-base-300 eink-bordered w-full rounded-xl border p-3'>
      <summary className='text-base-content flex cursor-pointer items-center justify-between gap-3 text-sm'>
        <span className='flex items-center gap-1.5 font-medium'>
          <IoChevronDown aria-hidden='true' className='shrink-0 text-xs group-open:rotate-180' />
          <span>{_('Server')}</span>
        </span>
        <span className='text-base-content/70 truncate' dir='ltr'>
          {new URL(current?.apiBaseUrl ?? getBaseUrl()).host}
        </span>
      </summary>
      <form className='mt-4 flex flex-col gap-3' onSubmit={connect}>
        <label className='flex flex-col gap-1.5 text-sm'>
          <span>{_('Server address')}</span>
          <input
            className={inputClass}
            dir='ltr'
            inputMode='url'
            placeholder='https://books.example.org'
            autoCapitalize='none'
            autoComplete='off'
            spellCheck={false}
            required
            disabled={pending}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        <p className='text-base-content/70 text-xs leading-relaxed'>
          {_('Changing servers signs you out. Downloaded books stay on this device.')}
        </p>
        {address.trim().startsWith('http://') && (
          <p className='text-sm'>{_('Use HTTPS to protect your sign-in details.')}</p>
        )}
        <details open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)}>
          <summary className='cursor-pointer text-sm'>{_('Advanced configuration')}</summary>
          <div className='mt-3 flex flex-col gap-3'>
            <p className='text-base-content/70 text-xs leading-relaxed'>
              {_('Leave these empty to discover the server settings automatically.')}
            </p>
            <label className='flex flex-col gap-1.5 text-sm'>
              <span>{_('Authentication server address')}</span>
              <input
                className={inputClass}
                dir='ltr'
                inputMode='url'
                autoCapitalize='none'
                autoComplete='off'
                spellCheck={false}
                disabled={pending}
                value={authAddress}
                onChange={(event) => setAuthAddress(event.target.value)}
              />
            </label>
            <label className='flex flex-col gap-1.5 text-sm'>
              <span>{_('Public API key')}</span>
              <input
                className={inputClass}
                dir='ltr'
                autoCapitalize='none'
                autoComplete='off'
                spellCheck={false}
                disabled={pending}
                value={publicKey}
                onChange={(event) => setPublicKey(event.target.value)}
              />
            </label>
          </div>
        </details>
        {error && (
          <p role='alert' className='text-error text-sm'>
            {error}
          </p>
        )}
        <button type='submit' className='btn btn-contrast min-h-11 w-full' disabled={pending}>
          {pending ? _('Connecting…') : _('Connect and restart')}
        </button>
        {current && (
          <button
            type='button'
            className='btn btn-ghost min-h-11 w-full'
            disabled={pending}
            onClick={useDefaultServer}
          >
            {_('Use default server')}
          </button>
        )}
      </form>
    </details>
  );
}

export default function NativeServerSettings(props: { supabaseClient: SupabaseClient }) {
  return process.env['NEXT_PUBLIC_APP_PLATFORM'] === 'tauri' &&
    typeof navigator !== 'undefined' &&
    getOSPlatform() === 'android' ? (
    <ServerConnectionForm {...props} />
  ) : null;
}
