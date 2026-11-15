import { useEffect, useRef, useState } from 'react';

import { useEnv } from '@/context/EnvContext';
import { Book } from '@/types/book';
import { getUserLang } from '@/utils/misc';
import { isWebAppPlatform } from '@/services/environment';
import { demoLibraries as libraries, isDemoBook } from '@/services/demoBooks';
import { getRuntimeConfig } from '@/services/runtimeConfig';
import { useLibraryStore } from '@/store/libraryStore';

interface DemoBooks {
  library: string[];
}

export const useDemoBooks = () => {
  const { envConfig, appService } = useEnv();
  const libraryLoaded = useLibraryStore((state) => state.libraryLoaded);
  const [books, setBooks] = useState<Book[]>([]);
  const isLoading = useRef(false);

  useEffect(() => {
    if (!getRuntimeConfig()?.selfHosted || !libraryLoaded || !appService) return;
    const { library, setLibrary } = useLibraryStore.getState();
    const personalBooks = library.filter((book) => !isDemoBook(book));
    if (personalBooks.length === library.length) return;
    // Remove the anonymous starter shelf, including cached pre-upgrade rows.
    // Replace deliberately: routine saves retain absent rows as a merge floor.
    // This changes local shelf metadata only; it never deletes book files.
    setLibrary(personalBooks);
    appService.saveLibraryBooks(personalBooks, { replace: true }).catch((error) => {
      console.error('Failed to remove starter books:', error);
    });
  }, [appService, libraryLoaded]);

  useEffect(() => {
    if (getRuntimeConfig()?.selfHosted) return;
    if (isLoading.current) return;
    isLoading.current = true;

    const userLang = getUserLang() as keyof typeof libraries;
    const fetchDemoBooks = async () => {
      try {
        const appService = await envConfig.getAppService();
        const demoBooks = libraries[userLang] || (libraries.en as DemoBooks);
        const books = await Promise.all(
          demoBooks.library.map((url) => appService.importBook(url, [], { saveBook: false })),
        );
        setBooks(books.filter((book) => book !== null) as Book[]);
      } catch (error) {
        console.error('Failed to import demo books:', error);
      }
    };

    const demoBooksFetchedFlag = localStorage.getItem('demoBooksFetched');
    if (isWebAppPlatform() && !demoBooksFetchedFlag) {
      fetchDemoBooks();
      localStorage.setItem('demoBooksFetched', 'true');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return books;
};
