// Server-only, optional filesystem adapter. Normal upstream storage is unchanged
// unless configured; covers, replicas and per-book data retain their old store.
export const isLocalLibraryBook = (fileKey: string): boolean => {
  const parts = fileKey.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return false;
  if (fileKey.includes('\\') || fileKey.includes('%') || fileKey.includes('\0')) return false;
  const legacy = parts.length === 4 && parts[1] === 'books';
  const standard = parts.length === 5 && parts[1] === 'Readest' && parts[2] === 'Books';
  if (!legacy && !standard) return false;
  return (
    /^[a-f0-9-]{36}$/.test(parts[0]!) &&
    /^[a-f0-9]{32}$/.test(parts[parts.length - 2]!) &&
    /\.(pdf|epub|mobi|azw|azw3|fb2|fbz|cbz|cbr|cb7|txt)$/i.test(parts.at(-1)!)
  );
};

export const localLibraryObject = async <T>(
  operation: string,
  fileKey: string,
  options: Record<string, string | number> = {},
  bucketName?: string,
): Promise<T | undefined> => {
  const endpoint = process.env['LOCAL_LIBRARY_URL'];
  if (!endpoint || !isLocalLibraryBook(fileKey)) return undefined;
  if (bucketName && bucketName !== process.env['S3_BUCKET_NAME']) return undefined;
  const secret = process.env['LOCAL_LIBRARY_SECRET'];
  if (!secret) throw new Error('Local library credentials are missing');
  const response = await fetch(`${endpoint}/v1/${operation}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileKey, ...options }),
    signal: AbortSignal.timeout(30_000),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Local library ${operation}: HTTP ${response.status}`);
  return (await response.json()) as T;
};
