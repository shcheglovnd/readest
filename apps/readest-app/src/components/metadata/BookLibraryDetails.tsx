import { useState } from 'react';
import type { Book, ReadingStatus } from '@/types/book';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useLibraryStore } from '@/store/libraryStore';
import { withReadingStatus } from '@/app/library/utils/libraryUtils';
import { BOOKSHELF_FIELDS } from '@/services/bookshelves/fields';
import { readBookshelves } from '@/services/bookshelves/state';
import { bookshelfName } from '@/services/bookshelves/definitions';
import { evaluateBookshelves } from '@/services/bookshelves/evaluate';
import { BoxedList, SettingsRow } from '@/components/settings/primitives';
import { md5Fingerprint } from '@/utils/md5';
import { formatDate } from '@/utils/book';
import { getBookDateRead, isAudiobook } from '@/utils/audiobook';
import { formatDuration } from '@/utils/duration';

export default function BookLibraryDetails({
  book,
  onChange,
}: {
  book: Book;
  onChange: (book: Book) => void;
}) {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { settings } = useSettingsStore();
  const [group, setGroup] = useState(book.groupName || '');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const field = (id: string) => BOOKSHELF_FIELDS.find((f) => f.id === id)!;
  const status = String(field('status').read(book));
  const shelves = evaluateBookshelves([book], readBookshelves(settings)).filter(
    (s) => s.books.length,
  );
  const save = async (patch: { status?: ReadingStatus; group?: string }) => {
    setBusy(true);
    setFailed(false);
    const latest = useLibraryStore.getState().library.find((b) => b.hash === book.hash) ?? book;
    let updated = patch.status ? withReadingStatus(latest, patch.status) : latest;
    if (patch.group !== undefined) {
      const name = patch.group.trim().replace(/^\/+|\/+$/g, '');
      updated = {
        ...updated,
        group: undefined,
        groupName: name || undefined,
        groupId: name ? md5Fingerprint(name) : undefined,
        groupUpdatedAt: Date.now(),
        updatedAt: Date.now(),
      };
    }
    try {
      if (!isAudiobook(latest) && latest.metadata?.readestLastReadAt === undefined) {
        updated = {
          ...updated,
          metadata: {
            ...latest.metadata,
            title: latest.metadata?.title ?? latest.title,
            author: latest.metadata?.author ?? latest.author,
            language: latest.metadata?.language ?? latest.primaryLanguage ?? '',
            readestLastReadAt: getBookDateRead(latest),
          },
        };
      }
      await useLibraryStore.getState().updateBooks(envConfig, [updated]);
      if (patch.group !== undefined) setGroup(updated.groupName || '');
      onChange(updated);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const time = (seconds: number) => formatDuration(Math.floor(seconds / 60), _);
  const audio = isAudiobook(book);
  const position = book.progress;
  const percent =
    position && position[1] > 0
      ? Math.min(100, Math.max(0, (position[0] / position[1]) * 100))
      : null;
  return (
    <div className='my-6 space-y-4'>
      <BoxedList
        title={_('Library and progress')}
        description={_('Status and group changes are saved across devices')}
      >
        <SettingsRow label={_('Reading status')}>
          <select
            aria-label={_('Reading status')}
            value={status}
            disabled={busy}
            className='select eink-bordered max-w-[55%]'
            onChange={(e) => void save({ status: e.target.value as ReadingStatus })}
          >
            {field('status').choices!.map((c) => (
              <option key={c.value} value={c.value}>
                {_(c.label)}
              </option>
            ))}
          </select>
        </SettingsRow>
        <SettingsRow label={_('Group')} align='start'>
          <form
            className='flex min-w-0 max-w-[65%] flex-col gap-2'
            onSubmit={(e) => {
              e.preventDefault();
              void save({ group });
            }}
          >
            <input
              aria-label={_('Group')}
              list='book-detail-groups'
              value={group}
              disabled={busy}
              className='input eink-bordered w-full'
              onChange={(e) => setGroup(e.target.value)}
            />
            <datalist id='book-detail-groups'>
              {Object.values(useLibraryStore.getState().groups).map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <button
              className='btn btn-contrast btn-sm self-end'
              disabled={busy || group === (book.groupName || '')}
            >
              {_('Save Group')}
            </button>
          </form>
        </SettingsRow>
        <SettingsRow label={_('Bookshelves')} align='start'>
          <span className='max-w-[60%] break-words py-3 text-end text-sm'>
            {shelves.map((s) => _(bookshelfName(s.definition))).join(', ') || _('None')}
          </span>
        </SettingsRow>
        <SettingsRow label={_('Reading progress (%)')}>
          <span className='tabular-nums'>
            {percent === null
              ? _('Not recorded')
              : `${percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`}
          </span>
        </SettingsRow>
        <SettingsRow label={audio ? _('Listening position') : _('Current page')}>
          <span className='text-end tabular-nums'>
            {position
              ? audio
                ? `${time(position[0])} / ${time(position[1])}`
                : `${position[0]} / ${position[1]}`
              : _('Not recorded')}
          </span>
        </SettingsRow>
        {position && position[1] > 0 && (
          <SettingsRow label={audio ? _('Audio remaining') : _('Pages remaining')}>
            <span className='tabular-nums'>
              {audio
                ? time(Math.max(0, position[1] - position[0]))
                : Math.max(0, position[1] - position[0]).toLocaleString()}
            </span>
          </SettingsRow>
        )}
        {['mediaType', 'availability', 'downloadStatus'].map((id) => {
          const f = field(id);
          const value = f.read(book);
          if (!value) return null;
          return (
            <SettingsRow key={id} label={_(f.label)}>
              <span className='text-end text-sm'>
                {_(f.choices?.find((c) => c.value === value)?.label ?? String(value))}
              </span>
            </SettingsRow>
          );
        })}
        {!!book.downloadedAt && (
          <SettingsRow label={_('Downloaded on this device')}>
            <span className='text-end text-sm'>{formatDate(book.downloadedAt)}</span>
          </SettingsRow>
        )}
        {!!book.absDownloadedAt && (
          <SettingsRow label={_('Available offline since')}>
            <span className='text-end text-sm'>{formatDate(book.absDownloadedAt)}</span>
          </SettingsRow>
        )}
      </BoxedList>
      {failed && (
        <p role='alert' className='text-error text-sm'>
          {_('Failed to save book details')}
        </p>
      )}
    </div>
  );
}
