import { describe, it, expect } from 'vitest';
import { summarizeListeningSessions } from '@/services/statistics/listeningStats';
const session = {
  id: '1',
  libraryItemId: 'book',
  date: '2021-01-01',
  startedAt: 1000,
  updatedAt: 100000,
  timeListening: 30,
};
describe('listening statistics', () => {
  it('uses recorded listening rather than session wall time or playback position', () => {
    const stats = summarizeListeningSessions([
      session,
      {
        ...session,
        id: '2',
        timeListening: '45',
        date: '2021-01-02',
        startedAt: 200000,
        updatedAt: 250000,
      },
      { ...session, timeListening: 0 },
    ]);
    expect(stats.seconds).toBe(75);
    expect(stats.sessions).toHaveLength(2);
    expect(stats.first).toBe(1000);
    expect(stats.last).toBe(250000);
    expect(stats.days).toEqual([
      { date: '2021-01-02', seconds: 45 },
      { date: '2021-01-01', seconds: 30 },
    ]);
    expect(stats.longest).toBe(45);
  });
  it('leaves absent history empty', () => {
    const stats = summarizeListeningSessions([]);
    expect(stats.first).toBeNull();
    expect(stats.last).toBeNull();
    expect(stats.seconds).toBe(0);
  });
});
