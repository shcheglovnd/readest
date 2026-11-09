import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/s3', () => ({
  s3Storage: {
    getDownloadSignedUrl: vi.fn().mockResolvedValue('https://legacy.test/book'),
    getUploadSignedUrl: vi.fn().mockResolvedValue('https://legacy.test/upload'),
    deleteObject: vi.fn(),
    copyObject: vi.fn(),
    headObject: vi.fn(),
  },
}));
vi.mock('@/utils/r2', () => ({ r2Storage: {} }));
vi.mock('@/utils/storage', () => ({ getStorageType: () => 's3' }));
import {
  copyObject,
  deleteObject,
  getDownloadSignedUrl,
  getUploadSignedUrl,
  objectExists,
} from '@/utils/object';
import { s3Storage } from '@/utils/s3';

const key = '11111111-1111-1111-1111-111111111111/books/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/a.epub';
const localUrl = 'https://readest.test/library-files/signed';

describe('optional HDD storage boundary', () => {
  beforeEach(() => {
    vi.stubEnv('LOCAL_LIBRARY_URL', 'http://library:8080');
    vi.stubEnv('LOCAL_LIBRARY_SECRET', 'test-only-secret');
    vi.stubEnv('S3_BUCKET_NAME', 'books');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({ url: localUrl, ok: true, exists: true }),
        }),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  it('downloads an original through the filesystem adapter', async () => {
    expect(await getDownloadSignedUrl(key, 1800)).toBe(localUrl);
    expect(s3Storage.getDownloadSignedUrl).not.toHaveBeenCalled();
  });
  it('routes a standard app key and upload reservation to the HDD', async () => {
    expect(await getUploadSignedUrl(key.replace('/books/', '/Readest/Books/'), 123, 60)).toBe(
      localUrl,
    );
    expect(fetch).toHaveBeenCalledWith(
      'http://library:8080/v1/upload',
      expect.objectContaining({
        body: JSON.stringify({
          fileKey: key.replace('/books/', '/Readest/Books/'),
          contentLength: 123,
          expiresIn: 60,
        }),
      }),
    );
  });
  it('leaves covers, replicas, book data and other buckets in existing storage', async () => {
    for (const fileKey of [
      key.replace('a.epub', 'cover.png'),
      key.replace('/books/', '/Readest/Replicas/'),
      key.replace('a.epub', 'tts/a.epub'),
    ]) {
      expect(await getDownloadSignedUrl(fileKey, 60)).toBe('https://legacy.test/book');
    }
    expect(await getDownloadSignedUrl(key, 60, 'public-images')).toBe('https://legacy.test/book');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('retains upstream behavior when the adapter is disabled', async () => {
    vi.stubEnv('LOCAL_LIBRARY_URL', '');
    expect(await getDownloadSignedUrl(key, 60)).toBe('https://legacy.test/book');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails closed when the HDD service is unavailable', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    await expect(getDownloadSignedUrl(key, 60)).rejects.toThrow('HTTP 503');
    expect(s3Storage.getDownloadSignedUrl).not.toHaveBeenCalled();
  });
  it('keeps existence, deletion and shared imports on the same original', async () => {
    expect(await objectExists(key)).toBe(true);
    await deleteObject(key);
    await copyObject(key, key.replace('11111111', '22222222'));
    expect(s3Storage.headObject).not.toHaveBeenCalled();
    expect(s3Storage.deleteObject).not.toHaveBeenCalled();
    expect(s3Storage.copyObject).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.map((call) => call[0])).toEqual([
      'http://library:8080/v1/exists',
      'http://library:8080/v1/delete',
      'http://library:8080/v1/copy',
    ]);
  });
});
