'use client';

import { useEffect, useState, type ChangeEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from '@/hooks/useTranslation';
import { stubTranslation } from '@/utils/misc';

// Native validation errors are translation keys too. Register them for the
// extractor and keep unexpected native error details out of the sign-in form.
const certificateErrors = new Set([
  stubTranslation('Choose a certificate file smaller than 64 KiB.'),
  stubTranslation('Choose a valid PEM or DER certificate.'),
  stubTranslation('Import certificates only, never private keys.'),
  stubTranslation('Import a CA or self-signed server certificate.'),
  stubTranslation('The certificate is expired or not yet valid.'),
  stubTranslation('At most 16 certificates can be trusted.'),
  stubTranslation('The certificate store exceeds 64 KiB.'),
  stubTranslation('Could not read certificates.'),
  stubTranslation('Could not save certificates.'),
  stubTranslation('Could not read the certificate file.'),
]);
const certificateError = (cause: unknown, fallback: string) =>
  typeof cause === 'string' && certificateErrors.has(cause) ? cause : fallback;

interface CertificateInfo {
  subject: string;
  issuer: string;
  fingerprint: string;
  validFrom: number;
  validUntil: number;
  currentlyValid: boolean;
}

function CertificateDetails({ certificate }: { certificate: CertificateInfo }) {
  const _ = useTranslation();
  return (
    <div className='flex min-w-0 flex-col gap-1 text-xs [overflow-wrap:anywhere]'>
      <strong>{certificate.subject}</strong>
      <span>
        {_('Issuer')}: {certificate.issuer}
      </span>
      <span>
        {_('Valid from')}: {new Date(certificate.validFrom * 1000).toLocaleDateString()}
        {' · '}
        {_('Expires')}: {new Date(certificate.validUntil * 1000).toLocaleDateString()}
      </span>
      {!certificate.currentlyValid && (
        <span className='text-error'>{_('Expired or not yet valid')}</span>
      )}
      <span dir='ltr' className='font-mono'>
        SHA-256: {certificate.fingerprint}
      </span>
    </div>
  );
}

export default function NativeServerCertificates({
  disabled,
  onBusyChange,
}: {
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const _ = useTranslation();
  const [certificates, setCertificates] = useState<CertificateInfo[]>([]);
  const [preview, setPreview] = useState<CertificateInfo[]>([]);
  const [data, setData] = useState<number[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    invoke<CertificateInfo[]>('list_server_certificates').then(
      (certs) => {
        if (active) setCertificates(certs);
      },
      () => {
        if (active) setError('Could not read certificates.');
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || disabled) return;
    setError('');
    setPreview([]);
    setData(undefined);
    if (!file.size || file.size > 65536) {
      setError('Choose a certificate file smaller than 64 KiB.');
      return;
    }
    onBusyChange(true);
    try {
      const bytes = await new Promise<number[]>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(Array.from(new Uint8Array(reader.result as ArrayBuffer)));
        reader.onerror = () => reject(new Error('Could not read the certificate file.'));
        reader.readAsArrayBuffer(file);
      });
      const certs = await invoke<CertificateInfo[]>('inspect_server_certificates', { data: bytes });
      setPreview(certs);
      setData(bytes);
    } catch (cause) {
      setError(certificateError(cause, 'Could not read the certificate file.'));
    } finally {
      onBusyChange(false);
    }
  };

  const update = async (fingerprint?: string) => {
    if (disabled || (!fingerprint && !data)) return;
    onBusyChange(true);
    setError('');
    try {
      const certs = fingerprint
        ? await invoke<CertificateInfo[]>('remove_server_certificate', { fingerprint })
        : await invoke<CertificateInfo[]>('import_server_certificates', { data });
      setCertificates(certs);
      setPreview([]);
      setData(undefined);
    } catch (cause) {
      setError(certificateError(cause, 'Could not save certificates.'));
    } finally {
      onBusyChange(false);
    }
  };

  return (
    <fieldset
      disabled={disabled}
      className='border-base-300 eink-bordered flex min-w-0 flex-col gap-3 rounded-lg border p-3'
    >
      <legend className='px-1 text-sm font-medium'>{_('Trusted certificates')}</legend>
      <p className='text-base-content/70 text-xs leading-relaxed'>
        {_(
          'Optional for private HTTPS servers. Certificates are trusted only inside this app, including sign-in and book downloads.',
        )}
      </p>
      {certificates.map((certificate) => (
        <div
          key={certificate.fingerprint}
          className='border-base-300 flex min-w-0 flex-col gap-2 rounded-lg border p-2'
        >
          <CertificateDetails certificate={certificate} />
          <button
            type='button'
            className='btn btn-ghost btn-sm self-start'
            onClick={() => update(certificate.fingerprint)}
          >
            {_('Remove certificate')}
          </button>
        </div>
      ))}
      <label className='flex min-w-0 flex-col gap-1.5 text-sm'>
        <span>{_('Certificate file')}</span>
        <input
          type='file'
          accept='.pem,.crt,.cer,.der,application/x-x509-ca-cert,application/pkix-cert'
          className='file-input file-input-bordered eink-bordered h-auto min-h-11 w-full min-w-0 py-1 text-xs'
          onChange={pick}
        />
      </label>
      <p className='text-base-content/70 text-xs'>
        {_('PEM or DER (.pem, .crt, .cer, .der). Never import a private key.')}
      </p>
      {preview.length > 0 && (
        <div className='border-base-300 flex min-w-0 flex-col gap-3 rounded-lg border p-2'>
          {preview.map((certificate) => (
            <CertificateDetails key={certificate.fingerprint} certificate={certificate} />
          ))}
          <p className='text-xs leading-relaxed'>
            {_(
              'Check the fingerprint with your server administrator. A trusted CA can authenticate servers inside this app.',
            )}
          </p>
          <div className='flex flex-wrap gap-2'>
            <button type='button' className='btn btn-primary btn-sm' onClick={() => update()}>
              {_('Trust certificate')}
            </button>
            <button
              type='button'
              className='btn btn-ghost btn-sm'
              onClick={() => {
                setPreview([]);
                setData(undefined);
              }}
            >
              {_('Cancel')}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role='alert' className='text-error text-xs'>
          {_(error)}
        </p>
      )}
    </fieldset>
  );
}
