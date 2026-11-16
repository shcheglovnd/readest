import type { ABSListeningSession } from '@/types/audiobookshelf';
import { toDateKey } from './readingStats';
export const summarizeListeningSessions = (input: ABSListeningSession[]) => {
  const sessions = input.filter(
    (s) => Number(s.timeListening) > 0 && Number.isFinite(Number(s.timeListening)),
  );
  const daily = new Map<string, number>();
  let seconds = 0;
  const starts: number[] = [],
    ends: number[] = [];
  for (const s of sessions) {
    seconds += Number(s.timeListening);
    if (Number.isFinite(s.startedAt) && s.startedAt > 0) starts.push(s.startedAt);
    if (Number.isFinite(s.updatedAt) && s.updatedAt > 0) ends.push(s.updatedAt);
    // Listening can be interrupted within a session: do not pretend its
    // accumulated time was continuous or spread it across invented intervals.
    const day = /^\d{4}-\d{2}-\d{2}$/.test(s.date)
      ? s.date
      : s.startedAt > 0
        ? toDateKey(new Date(s.startedAt))
        : null;
    if (day) daily.set(day, (daily.get(day) ?? 0) + Number(s.timeListening));
  }
  return {
    sessions: [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    seconds,
    daily,
    first: starts.length ? Math.min(...starts) : null,
    last: ends.length ? Math.max(...ends) : null,
    days: [...daily]
      .map(([date, seconds]) => ({ date, seconds }))
      .sort((a, b) => b.date.localeCompare(a.date)),
    longest: Math.max(0, ...sessions.map((s) => Number(s.timeListening))),
  };
};
