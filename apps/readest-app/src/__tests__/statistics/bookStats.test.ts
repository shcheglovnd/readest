import { describe, expect, it } from 'vitest';
import { summarizeBookEvents } from '@/services/statistics/bookStats';
import type { PageStatEvent } from '@/types/statistics';
const event = (
  page: number,
  startTime: number,
  duration: number,
  totalPages = 100,
): PageStatEvent => ({ bookMd5: 'book', page, startTime, duration, totalPages });
describe('book statistics', () => {
  it('separates recorded visits, distinct pages, repeats and different paginations', () => {
    const stats = summarizeBookEvents([
      event(2, 200, 20),
      event(1, 100, 10),
      event(1, 300, 30),
      event(1, 400, 40, 200),
    ]);
    expect(stats.seconds).toBe(100);
    expect(stats.visits).toBe(4);
    expect(stats.pages.length).toBe(3);
    expect(stats.repeatVisits).toBe(1);
    expect(stats.first).toBe(100000);
    expect(stats.last).toBe(440000);
    expect(stats.pages.find((p) => p.page === 1 && p.totalPages === 100)).toMatchObject({
      seconds: 40,
      visits: 2,
    });
    expect(stats.median).toBeNull();
  });
  it('splits visits at local midnight without losing seconds or counting a visit twice', () => {
    const start = new Date(2026, 10, 10, 23, 59, 30).getTime() / 1000;
    const stats = summarizeBookEvents([event(1, start, 90)]);
    expect(stats.days).toEqual([
      { date: '2026-11-11', seconds: 60 },
      { date: '2026-11-10', seconds: 30 },
    ]);
    expect(stats.visits).toBe(1);
    expect(stats.seconds).toBe(90);
  });
  it('uses the existing recent-50 median pace rule and excludes long imported intervals', () => {
    const stats = summarizeBookEvents(
      [10, 20, 30, 40, 50, 900].map((duration, i) => event(i + 1, 1000 + i * 1000, duration)),
    );
    expect(stats.median).toBe(30);
    expect(stats.seconds).toBe(1050);
    expect(stats.pagesPerHour).toBe(120);
    expect(stats.longestVisit).toBe(900);
  });
  it('does not invent records for empty or invalid history', () => {
    const stats = summarizeBookEvents([event(1, 100, 0), event(2, 0, 30), event(3, 100, NaN)]);
    expect(stats.seconds).toBe(0);
    expect(stats.first).toBeNull();
    expect(stats.last).toBeNull();
    expect(stats.days).toEqual([]);
    expect(stats.pages).toEqual([]);
    expect(stats.median).toBeNull();
  });
});
