import { describe, expect, it } from 'vitest';
import type { Book, BooksGroup } from '@/types/book';
import { reconcileAbsBooks } from '@/services/audiobookshelf/librarySync';
import { BOOKSHELF_FIELDS } from '@/services/bookshelves/fields';
import { generateBookshelfItems } from '@/services/bookshelves/presentation';
import {
  createBookSorter,
  getBookSortValue,
  getGroupSortValue,
} from '@/app/library/utils/libraryUtils';
import { resolveMetadataMerge } from '@/pages/api/sync';
import { getBookWithUpdatedMetadata } from '@/utils/book';
import { makeAbsFilePath } from '@/utils/audiobook';
import { md5 } from '@/utils/md5';
import { mergeBookMetadata } from '@/services/sync/file/merge';
import { mergeReadingDates } from '@/utils/readingDate';
import { useLibraryStore } from '@/store/libraryStore';

const server = { id: 'recency-server', name: 'Home', url: 'http://abs.local' };
const source = makeAbsFilePath(server.id, 'audio');
const book = (extra: Partial<Book> = {}): Book => ({
  hash: md5(source),
  format: 'ABS',
  filePath: source,
  title: 'Audio',
  author: 'Author',
  duration: 3600,
  createdAt: 100,
  updatedAt: 9000,
  metadata: {
    title: 'Audio',
    author: 'Author',
    language: '',
    absSource: source,
    absDuration: 3600,
    absLastListenedAt: 200,
  },
  ...extra,
});
const audioItem = {
  id: 'audio',
  mediaType: 'book' as const,
  media: {
    metadata: { title: 'Audio', authorName: 'Author' },
    duration: 3600,
    numAudioFiles: 1,
  },
};

describe('Audiobookshelf actual listening recency', () => {
  it('interleaves audiobook history with migrated ebook history instead of synthetic sync clocks', () => {
    const ebook = book({
      hash: 'history',
      format: 'EPUB',
      metadata: {
        title: 'History',
        author: 'Author',
        language: '',
        readestLastReadAt: 150,
      },
    });
    const audio = book();
    expect(
      [ebook, audio].sort(createBookSorter('updated', 'en', 'none', false)).map((b) => b.hash),
    ).toEqual([audio.hash, 'history']);
    const edited = getBookWithUpdatedMetadata(ebook, {
      title: 'Edited',
      author: 'Author',
      language: '',
    });
    expect(getBookSortValue(edited, 'updated')).toBe(150);
  });

  it('advances migrated ebook history when real reader progress is recorded', () => {
    const ebook = book({
      hash: 'history',
      format: 'EPUB',
      metadata: {
        title: 'History',
        author: 'Author',
        language: '',
        readestLastReadAt: 150,
      },
    });
    useLibraryStore.getState().setLibrary([ebook]);
    useLibraryStore.getState().updateBookProgress('history', [5, 100], 'reading');
    expect(useLibraryStore.getState().library[0]?.metadata?.readestLastReadAt).toBeGreaterThan(150);
    useLibraryStore.getState().setLibrary([]);
  });

  it('sorts by listening time instead of a newer import or metadata clock', () => {
    const audio = book();
    const ebook = book({ hash: 'epub', format: 'EPUB', updatedAt: 500 });
    expect(
      [audio, ebook].sort(createBookSorter('updated', 'en', 'none', false)).map((b) => b.hash),
    ).toEqual(['epub', audio.hash]);
    expect(getBookSortValue(audio, 'updated')).toBe(200);
    expect(audio.updatedAt).toBe(9000);
  });

  it('puts unplayed and legacy audiobooks at zero rather than their import date', () => {
    expect(getBookSortValue(book({ metadata: undefined }), 'updated')).toBe(0);
    expect(
      getBookSortValue(
        book({
          metadata: { title: 'Audio', author: 'Author', language: '', absLastListenedAt: 0 },
        }),
        'updated',
      ),
    ).toBe(0);
    expect(
      BOOKSHELF_FIELDS.find((f) => f.id === 'updated')!.read(book({ metadata: undefined })),
    ).toBeUndefined();
  });

  it('uses the same date for groups, folders and shelf filters', () => {
    const audio = book({ groupName: 'Audio' });
    const group = { books: [audio], name: 'Audio' } as BooksGroup;
    expect(getGroupSortValue(group, 'updated')).toBe(200);
    expect(BOOKSHELF_FIELDS.find((f) => f.id === 'updated')!.read(audio)).toBe(200);
    const items = generateBookshelfItems(
      [audio, book({ hash: 'epub', format: 'EPUB', updatedAt: 500 })],
      '',
    );
    expect(items.map((i) => ('books' in i ? i.name : i.hash))).toEqual(['epub', 'Audio']);
  });

  it('leaves ordinary ebook and ABS ebook reading dates unchanged', () => {
    expect(getBookSortValue(book({ format: 'EPUB' }), 'updated')).toBe(9000);
    expect(
      getBookSortValue(
        book({
          absMediaType: 'ebook',
          metadata: { title: 'Audio', author: 'Author', language: '', absMediaType: 'ebook' },
        }),
        'updated',
      ),
    ).toBe(9000);
  });

  it('backfills a legacy audiobook from actual sessions, without backdating its sync clock', () => {
    const result = reconcileAbsBooks({
      server,
      items: [audioItem],
      progress: [],
      library: [
        book({
          metadata: {
            title: 'Audio',
            author: 'Author',
            language: '',
            absSource: source,
            absDuration: 3600,
          },
        }),
      ],
      lastPlayedAtByHash: new Map(),
      lastListenedAtByItem: new Map([['audio', 300]]),
      now: 10000,
    });
    expect(result.upserts[0]?.metadata?.absLastListenedAt).toBe(300);
    expect(result.upserts[0]?.createdAt).toBe(100);
    expect(result.upserts[0]?.updatedAt).toBe(10000);
  });

  it('imports an unplayed audiobook as unplayed even if progress was edited recently', () => {
    const result = reconcileAbsBooks({
      server,
      items: [audioItem],
      progress: [
        {
          libraryItemId: 'audio',
          currentTime: 0,
          duration: 3600,
          isFinished: true,
          lastUpdate: 9900,
        },
      ],
      library: [],
      lastPlayedAtByHash: new Map(),
      lastListenedAtByItem: new Map(),
      now: 10000,
    });
    expect(result.upserts[0]?.metadata?.absLastListenedAt).toBe(0);
  });

  it('recognizes cloud metadata identity even before filePath has been restored', () => {
    const result = reconcileAbsBooks({
      server,
      items: [audioItem],
      progress: [],
      library: [book({ filePath: undefined })],
      lastPlayedAtByHash: new Map(),
      lastListenedAtByItem: new Map([['audio', 200]]),
      now: 10000,
    });
    expect(result.upserts[0]?.createdAt ?? 100).toBe(100);
  });

  it('preserves the newest listening date through an unrelated metadata edit', () => {
    const edited = getBookWithUpdatedMetadata(book(), {
      title: 'Edited',
      author: 'Author',
      language: 'en',
    });
    expect(edited.metadata?.absLastListenedAt).toBe(200);
    const fields = (metadata: object, at: string) => ({
      title: 'Edited',
      author: 'Author',
      tags: [] as string[],
      metadata: JSON.stringify(metadata),
      metadata_updated_at: at,
    });
    const merged = resolveMetadataMerge(
      fields({ title: 'Edited' }, '2026-01-02'),
      fields({ title: 'Audio', absLastListenedAt: 200 }, '2026-01-01'),
      true,
    );
    expect(JSON.parse(merged.metadata!).absLastListenedAt).toBe(200);
    expect(merged.title).toBe('Edited');
  });

  it('keeps newer local listening when merging a late cloud or file-sync metadata row', () => {
    const local = book();
    const remote = book({
      updatedAt: 10000,
      metadataUpdatedAt: 10000,
      metadata: {
        title: 'Edited elsewhere',
        author: 'Author',
        language: '',
        absLastListenedAt: 100,
      },
    });
    expect(mergeBookMetadata(local, remote).metadata?.absLastListenedAt).toBe(200);
    expect(mergeReadingDates(remote.metadata, local.metadata)?.absLastListenedAt).toBe(200);
    expect(mergeReadingDates(remote.metadata, local.metadata)?.title).toBe('Edited elsewhere');
  });

  it('does not discard known listening dates when history fetch fails or lags', () => {
    for (const history of [undefined, new Map<string, number>(), new Map([['audio', 100]])]) {
      const result = reconcileAbsBooks({
        server,
        items: [audioItem],
        progress: [],
        library: [book()],
        lastPlayedAtByHash: new Map(),
        lastListenedAtByItem: history,
        now: 10000,
      });
      expect(result.upserts).toEqual([]);
    }
  });
});
