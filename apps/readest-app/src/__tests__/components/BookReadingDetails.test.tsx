import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Book } from '@/types/book';
import BookReadingStats from '@/components/metadata/BookReadingStats';
import BookLibraryDetails from '@/components/metadata/BookLibraryDetails';
import { useLibraryStore } from '@/store/libraryStore';
import { md5Fingerprint } from '@/utils/md5';
const h = vi.hoisted(() => ({
  events: vi.fn(),
  save: vi.fn(),
  open: vi.fn(),
  config: vi.fn(),
  settings: {},
}));
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string, args?: Record<string, unknown>) =>
    s.replace(/{{(\w+)}}/g, (_, key: string) => String(args?.[key] ?? '')),
}));
vi.mock('@/context/EnvContext', () => {
  const appService = { loadBookConfig: h.config };
  const envConfig = { getAppService: async () => ({ saveLibraryBooks: h.save }) };
  return { useEnv: () => ({ envConfig, appService }) };
});
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/store/settingsStore', () => ({ useSettingsStore: () => ({ settings: h.settings }) }));
vi.mock('@/services/statistics/statisticsDb', () => ({ StatisticsDb: { open: h.open } }));
vi.mock('@/services/sync/syncCategories', () => ({ isSyncCategoryEnabled: () => false }));
vi.mock('@/components/stats/ReadingTimeChart', () => ({ default: () => <div>daily chart</div> }));
vi.mock('@/components/stats/ReadingHeatmap', () => ({
  default: () => <div>activity calendar</div>,
}));
const book: Book = {
  hash: 'detail',
  title: 'Book',
  author: 'Author',
  format: 'EPUB',
  createdAt: 1000,
  updatedAt: 2000,
  progress: [20, 100],
  metadata: { title: 'Book', author: 'Author', language: 'en', readestLastReadAt: 1500 },
};
beforeEach(() => {
  vi.clearAllMocks();
  h.save.mockResolvedValue(undefined);
  h.events.mockResolvedValue([]);
  h.open.mockResolvedValue({ getBookEvents: h.events });
  h.config.mockResolvedValue({ booknotes: [] });
  useLibraryStore.setState({ library: [book], libraryLoaded: true, groups: {} });
});
afterEach(cleanup);
describe('per-book reading details', () => {
  it('shows exact recorded totals, visits, pace and full paginated history', async () => {
    h.events.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => ({
        bookMd5: 'detail',
        page: i + 1,
        totalPages: 100,
        startTime: 1700000000 + i * 90,
        duration: 60,
      })),
    );
    render(<BookReadingStats book={book} />);
    await screen.findByText('Total reading time');
    expect(
      screen.getByText('Total reading time').parentElement?.parentElement?.textContent,
    ).toContain('30m 0s');
    expect(h.events).toHaveBeenCalledWith('detail');
    expect(screen.getByText('Time per page (30)')).toBeTruthy();
    expect(screen.getByText('Activity log (30)')).toBeTruthy();
    expect(screen.getAllByText('Pages read')).toHaveLength(1);
    const pageHistory = screen.getByText('Time per page (30)').closest('details')!;
    expect(within(pageHistory).queryByText('Page 26 of 100')).toBeNull();
    fireEvent.click(within(pageHistory).getByText('Next'));
    expect(within(pageHistory).getByText('Page 26 of 100')).toBeTruthy();
    expect(within(pageHistory).getByText('Page 30 of 100')).toBeTruthy();
    expect(
      screen.getByText('Typical time per page').parentElement?.parentElement?.textContent,
    ).toContain('1m 0s');
  });
  it('counts only undeleted annotations and distinguishes underline styles', async () => {
    h.config.mockResolvedValue({
      booknotes: [
        { id: '1', type: 'annotation', style: 'underline', note: 'note' },
        { id: '2', type: 'bookmark', note: '' },
        { id: '3', type: 'annotation', deletedAt: 1 },
      ],
    });
    render(<BookReadingStats book={book} />);
    await screen.findByText('No recorded reading activity for this book yet');
    const row = screen.getByText('Total entries').parentElement!.parentElement!;
    expect(within(row as HTMLElement).getByText('2')).toBeTruthy();
    expect(screen.getByText('Underlines').parentElement?.parentElement?.textContent).toContain('1');
  });
  it('shows errors and can retry without changing history', async () => {
    h.open.mockRejectedValueOnce(new Error('database busy'));
    render(<BookReadingStats book={book} />);
    await screen.findByText('Failed to load reading statistics');
    fireEvent.click(screen.getByText('Refresh statistics'));
    await screen.findByText('No recorded reading activity for this book yet');
    expect(h.save).not.toHaveBeenCalled();
  });
  it('does not invent page statistics from an audiobook position', async () => {
    render(<BookReadingStats book={{ ...book, format: 'ABS', progress: [3600, 7200] }} />);
    await screen.findByText(/No page-reading records for this audiobook/);
    expect(screen.queryByText('Pages read')).toBeNull();
  });
  it('ignores a pending result from the previous book', async () => {
    let resolve!: (value: unknown) => void;
    h.events.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const view = render(<BookReadingStats book={book} />);
    await waitFor(() => expect(h.events).toHaveBeenCalledWith('detail'));
    view.rerender(<BookReadingStats book={{ ...book, hash: 'other' }} />);
    await screen.findByText('No recorded reading activity for this book yet');
    resolve([{ bookMd5: 'detail', page: 1, totalPages: 100, startTime: 1000, duration: 600 }]);
    await waitFor(() => expect(screen.queryByText('Total reading time')).toBeNull());
  });
});
describe('book library controls', () => {
  it('saves a manual status with the existing independent clock without changing position or dates', async () => {
    const changed = vi.fn();
    render(<BookLibraryDetails book={book} onChange={changed} />);
    fireEvent.change(screen.getByLabelText('Reading status'), { target: { value: 'finished' } });
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    const saved = h.save.mock.calls[0]![0][0] as Book;
    expect(saved.readingStatus).toBe('finished');
    expect(saved.readingStatusUpdatedAt).toBeGreaterThan(0);
    expect(saved.progress).toEqual(book.progress);
    expect(saved.createdAt).toBe(1000);
    expect(saved.metadata?.readestLastReadAt).toBe(1500);
  });
  it('saves normalized group membership with an independent clock and preserves concurrent progress', async () => {
    const changed = vi.fn();
    render(<BookLibraryDetails book={book} onChange={changed} />);
    useLibraryStore.setState({ library: [{ ...book, progress: [35, 100] }] });
    fireEvent.change(screen.getByLabelText('Group'), { target: { value: '/Science/Physics/' } });
    fireEvent.click(screen.getByText('Save Group'));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    const saved = h.save.mock.calls[0]![0][0] as Book;
    expect(saved.groupName).toBe('Science/Physics');
    expect(saved.groupId).toBe(md5Fingerprint('Science/Physics'));
    expect(saved.groupUpdatedAt).toBeGreaterThan(0);
    expect(saved.progress).toEqual([35, 100]);
  });
  it('reports persistence failures', async () => {
    h.save.mockRejectedValue(new Error('disk full'));
    render(<BookLibraryDetails book={book} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Reading status'), { target: { value: 'unread' } });
    await screen.findByText('Failed to save book details');
  });
});
