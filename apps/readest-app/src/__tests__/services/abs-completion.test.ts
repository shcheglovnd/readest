import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudiobookController } from '@/services/audiobook/AudiobookController';
import type { AudiobookClock } from '@/services/audiobook/AudiobookClock';
import { reconcileAbsBooks } from '@/services/audiobookshelf/librarySync';
import { AbsProgressSyncer } from '@/services/audiobookshelf/progressSync';
import { useLibraryStore } from '@/store/libraryStore';
import type { ABSLibraryItem, ABSMediaProgress } from '@/types/audiobookshelf';
import type { Book, ReadingStatus } from '@/types/book';
import { getBookDateRead } from '@/utils/audiobook';

const server = { id: 'completion-server', name: 'Home', url: 'http://abs.local' };
const item: ABSLibraryItem = {
  id: 'audio',
  mediaType: 'book',
  media: { metadata: { title: 'Audio', authorName: 'Author' }, duration: 200, numAudioFiles: 2 },
};
const initialBook = (): Book =>
  reconcileAbsBooks({
    server,
    items: [item],
    progress: [],
    library: [],
    lastPlayedAtByHash: new Map(),
    now: 100,
  }).upserts[0]!;
const finished: ABSMediaProgress = {
  libraryItemId: 'audio',
  currentTime: 200,
  duration: 200,
  isFinished: true,
  finishedAt: 1000,
  lastUpdate: 2000,
};
const reconcile = (library: Book[], progress = finished, entry = item) =>
  reconcileAbsBooks({
    server,
    items: [entry],
    progress: [progress],
    library,
    lastPlayedAtByHash: new Map(),
    now: 9000,
  });

describe('Audiobookshelf completion and added dates', () => {
  it('imports completed books as Finished using the actual completion clock', () => {
    expect(reconcile([]).upserts[0]).toMatchObject({
      readingStatus: 'finished',
      readingStatusUpdatedAt: 1000,
      progress: [200, 200],
    });
  });

  it('adopts a status-only completion even when playback position already equals 100%', () => {
    const old = { ...initialBook(), progress: [200, 200] as [number, number] };
    const changed = reconcile([old]).upserts[0]!;
    expect(changed?.readingStatus).toBe('finished');
    expect(changed.progress).toEqual(old.progress);
    expect(old.readingStatus).toBeUndefined();
    expect(reconcile([changed]).upserts).toEqual([]);
  });

  it.each([
    'unread',
    'reading',
    'abandoned',
  ] as ReadingStatus[])('preserves a newer manual %s status despite a routine ABS progress update', (readingStatus) => {
    const old = { ...initialBook(), readingStatus, readingStatusUpdatedAt: 1500 };
    const next = reconcile([old], { ...finished, lastUpdate: 8000 }).upserts[0]!;
    expect(next.readingStatus).toBe(readingStatus);
    expect(next.readingStatusUpdatedAt).toBe(1500);
  });

  it('accepts a genuinely newer completion after an older manual status', () => {
    const old = {
      ...initialBook(),
      readingStatus: 'abandoned' as const,
      readingStatusUpdatedAt: 500,
    };
    expect(reconcile([old]).upserts[0]).toMatchObject({
      readingStatus: 'finished',
      readingStatusUpdatedAt: 1000,
    });
  });

  it('uses the legacy progress clock when finishedAt is absent', () => {
    expect(reconcile([], { ...finished, finishedAt: undefined }).upserts[0]).toMatchObject({
      readingStatus: 'finished',
      readingStatusUpdatedAt: 2000,
    });
  });

  it('preserves a manual status when ABS provides no completion clock or ties its clock', () => {
    const old = {
      ...initialBook(),
      readingStatus: 'unread' as const,
      readingStatusUpdatedAt: 1000,
    };
    for (const progress of [finished, { ...finished, finishedAt: undefined, lastUpdate: 0 }]) {
      expect(reconcile([old], progress).upserts[0]?.readingStatus).toBe('unread');
    }
  });

  it('does not infer completion merely from position or clear an explicit Finished status', () => {
    const unconfirmed = { ...finished, isFinished: false };
    expect(reconcile([], unconfirmed).upserts[0]?.readingStatus).toBeUndefined();
    const old = {
      ...initialBook(),
      readingStatus: 'finished' as const,
      readingStatusUpdatedAt: 5000,
    };
    expect(reconcile([old], { ...unconfirmed, currentTime: 10 }).upserts[0]).toMatchObject({
      readingStatus: 'finished',
      readingStatusUpdatedAt: 5000,
    });
  });

  it('does not mark a whole podcast show finished from episode progress', () => {
    const show: ABSLibraryItem = {
      id: 'audio',
      mediaType: 'podcast',
      media: { metadata: { title: 'Show' }, numEpisodes: 2 },
    };
    expect(
      reconcile([], { ...finished, episodeId: 'episode' }, show).upserts[0]?.readingStatus,
    ).toBeUndefined();
  });

  it('uses ABS addedAt for newly imported books', () => {
    expect(reconcile([], finished, { ...item, addedAt: 50 }).upserts[0]?.createdAt).toBe(50);
  });

  it('repairs existing import dates without changing listening recency or manual status', () => {
    const old = {
      ...initialBook(),
      createdAt: 8000,
      progress: [200, 200] as [number, number],
      readingStatus: 'reading' as const,
      readingStatusUpdatedAt: 5000,
    };
    old.metadata = { ...old.metadata!, absLastListenedAt: 1234 };
    const entry = { ...item, addedAt: 50 };
    const next = reconcile([old], finished, entry).upserts[0]!;
    expect(next?.createdAt).toBe(50);
    expect(getBookDateRead(next)).toBe(1234);
    expect(next.readingStatus).toBe('reading');
    expect(reconcile([next], finished, entry).upserts).toEqual([]);
  });

  it.each([
    undefined,
    null,
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('keeps existing Date Added when ABS provides no valid timestamp (%s)', (addedAt) => {
    const old = { ...initialBook(), createdAt: 777 };
    expect(reconcile([old], finished, { ...item, addedAt }).upserts[0]?.createdAt).toBe(777);
  });
});

class Clock extends EventTarget implements AudiobookClock {
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  async load(_url: string, startAt: number) {
    this.currentTime = startAt;
  }
  async play() {
    this.paused = false;
  }
  pause() {
    this.paused = true;
  }
  destroy() {}
}

describe('actual audiobook playback completion', () => {
  afterEach(() => {
    useLibraryStore.getState().setLibrary([]);
  });

  const setup = (startAt = 0) => {
    const book = initialBook();
    useLibraryStore.getState().setLibrary([book]);
    const client = {
      openPlaybackSession: vi.fn().mockResolvedValue({ id: 'session', currentTime: startAt }),
      getMe: vi.fn().mockResolvedValue({ mediaProgress: [] }),
      syncSession: vi.fn().mockResolvedValue(undefined),
      closeSession: vi.fn().mockResolvedValue(undefined),
    };
    const saveLibraryBooks = vi.fn().mockResolvedValue(undefined);
    const syncer = new AbsProgressSyncer({
      client: client as never,
      itemId: 'audio',
      bookHash: book.hash,
      duration: 200,
      appService: { saveLibraryBooks } as never,
    });
    const clock = new Clock();
    const controller = new AudiobookController(
      {
        itemId: 'audio',
        title: 'Audio',
        author: 'Author',
        chapters: [],
        startAt,
        resolveUrl: (path) => path,
        tracks: [0, 100].map((startOffset, index) => ({
          index,
          startOffset,
          duration: 100,
          contentUrl: `/track/${index}`,
          mimeType: 'audio/mpeg',
        })),
      },
      clock,
      syncer.hooks(),
    );
    return { book, client, controller, clock, syncer, saveLibraryBooks };
  };

  it('persists Finished only after the final track ends, including immediate shutdown', async () => {
    const { book, client, controller, clock, syncer, saveLibraryBooks } = setup();
    await syncer.begin(0, 0);
    await controller.start();
    clock.currentTime = 100;
    clock.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(clock.currentTime).toBe(0));
    expect(useLibraryStore.getState().getBookByHash(book.hash)?.readingStatus).toBeUndefined();
    clock.currentTime = 100;
    clock.dispatchEvent(new Event('ended'));
    await controller.shutdown();
    const next = useLibraryStore.getState().getBookByHash(book.hash)!;
    expect(next.readingStatus).toBe('finished');
    expect(next.readingStatusUpdatedAt).toBeGreaterThan(0);
    expect(saveLibraryBooks.mock.lastCall?.[0][0].readingStatus).toBe('finished');
    expect(client.closeSession).toHaveBeenCalledTimes(1);
  });

  it('does not finish a book when closing early or only seeking to the end', async () => {
    const { book, controller, clock, syncer } = setup();
    await syncer.begin(0, 0);
    await controller.start();
    clock.currentTime = 20;
    await controller.seekToTime(200);
    await controller.shutdown();
    expect(useLibraryStore.getState().getBookByHash(book.hash)?.readingStatus).toBeUndefined();
  });

  it('does not send a fabricated end position or Finished status after a load failure', async () => {
    const { book, client, controller, clock, syncer } = setup();
    await syncer.begin(0, 0);
    clock.load = async () => {
      throw new Error('offline');
    };
    await controller.start();
    expect(useLibraryStore.getState().getBookByHash(book.hash)?.readingStatus).toBeUndefined();
    expect(client.closeSession.mock.lastCall?.[1].currentTime).toBe(0);
    await controller.shutdown();
  });

  it('keeps the resume point and credits no listening when loading a later track fails', async () => {
    const { book, client, controller, clock, syncer } = setup(150);
    await syncer.begin(0, 0);
    clock.load = async () => {
      throw new Error('offline');
    };
    await controller.start();
    expect(client.closeSession.mock.lastCall?.[1]).toMatchObject({
      currentTime: 150,
      timeListened: 0,
    });
    expect(useLibraryStore.getState().getBookByHash(book.hash)?.progress).toEqual([150, 200]);
    expect(useLibraryStore.getState().getBookByHash(book.hash)?.readingStatus).toBeUndefined();
    await controller.shutdown();
  });

  it.each([
    undefined,
    'episode',
  ])('does not finish a podcast show when one episode ends (%s)', async (episodeId) => {
    const { book, client, saveLibraryBooks } = setup();
    useLibraryStore
      .getState()
      .setLibrary([{ ...book, metadata: { ...book.metadata!, absMediaType: 'podcast' } }]);
    const syncer = new AbsProgressSyncer({
      client: client as never,
      itemId: 'audio',
      episodeId,
      bookHash: book.hash,
      duration: 200,
      appService: { saveLibraryBooks } as never,
    });
    await syncer.begin(0, 0);
    syncer.hooks().onEnd?.(200, true);
    expect(useLibraryStore.getState().getBookByHash(book.hash)?.readingStatus).toBeUndefined();
  });
});
