import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';

const state = vi.hoisted(() => ({
  selfHosted: true,
  importBook: vi.fn(async () => null),
  saveLibraryBooks: vi.fn(async () => {}),
}));
const appService = {
  importBook: state.importBook,
  saveLibraryBooks: state.saveLibraryBooks,
};
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService, envConfig: { getAppService: async () => appService } }),
}));
vi.mock('@/services/runtimeConfig', () => ({
  getRuntimeConfig: () => ({ selfHosted: state.selfHosted }),
}));
vi.mock('@/services/environment', () => ({
  isWebAppPlatform: () => true,
  isTauriAppPlatform: () => false,
}));

const { useDemoBooks } = await import('@/app/library/hooks/useDemoBooks');
const { useLibraryStore } = await import('@/store/libraryStore');
const makeBook = (overrides: Partial<Book> = {}): Book => ({
  hash: 'personal',
  title: 'Hamlet',
  author: 'William Shakespeare',
  format: 'EPUB',
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  state.selfHosted = true;
  useLibraryStore.setState({ library: [], libraryLoaded: false });
});
afterEach(cleanup);

describe('self-hosted starter library', () => {
  it('does not fetch starter books on a fresh self-hosted installation', async () => {
    renderHook(() => useDemoBooks());
    await act(async () => {});
    expect(state.importBook).not.toHaveBeenCalled();
    expect(localStorage.getItem('demoBooksFetched')).toBeNull();
  });

  it('removes only known starter URLs after the saved library loads', async () => {
    const personal = makeBook({ progress: [12, 100], readingStatus: 'reading' });
    const demo = makeBook({
      hash: 'demo',
      url: 'https://cdn.readest.com/books/hamlet.epub',
    });
    renderHook(() => useDemoBooks());
    expect(state.saveLibraryBooks).not.toHaveBeenCalled();
    await act(async () => {
      useLibraryStore.getState().setLibrary([personal, demo]);
    });
    await waitFor(() =>
      expect(state.saveLibraryBooks).toHaveBeenCalledWith([personal], { replace: true }),
    );
    expect(useLibraryStore.getState().library).toEqual([personal]);
  });

  it('keeps the official starter library available outside self-host mode', async () => {
    state.selfHosted = false;
    renderHook(() => useDemoBooks());
    await waitFor(() => expect(state.importBook).toHaveBeenCalledTimes(6));
  });

  it('does not rewrite a self-hosted library that has no starter books', async () => {
    const personal = makeBook();
    useLibraryStore.getState().setLibrary([personal]);
    renderHook(() => useDemoBooks());
    await act(async () => {});
    expect(state.saveLibraryBooks).not.toHaveBeenCalled();
    expect(useLibraryStore.getState().library).toEqual([personal]);
  });
});
