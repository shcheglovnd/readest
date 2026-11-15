import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebDatabaseService } from '@/services/database/webDatabaseService';

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('@readest/turso-database-wasm/webpack', () => ({ connect }));

interface TestConnection {
  ioStep: () => Promise<void>;
  prepare: () => Promise<{
    run: () => Promise<{ changes: number; lastInsertRowid: number }>;
    all: () => Promise<Record<string, unknown>[]>;
  }>;
  exec: () => Promise<void>;
  close: () => Promise<void>;
}

const connection = () => {
  let wake: () => void = () => {};
  const wait = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        wake = resolve;
      }),
  );
  const native: TestConnection = {
    ioStep: wait,
    prepare: async () => ({
      run: async () => {
        await native.ioStep();
        return { changes: 1, lastInsertRowid: 7 };
      },
      all: async () => {
        await native.ioStep();
        return [{ seconds: 123 }];
      },
    }),
    exec: async () => {},
    close: async () => {},
  };
  connect.mockResolvedValue(native);
  return { native, wait, wake: () => wake() };
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('browser database I/O wakeup', () => {
  it('continues a statement when its I/O notification never arrives', async () => {
    vi.useFakeTimers();
    connection();
    const db = await WebDatabaseService.open('stats.sqlite');
    let completed = false;
    const result = db.execute('INSERT INTO history VALUES (?)', [1]).then((value) => {
      completed = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(completed, 'A missing OPFS notification must not block statistics sync forever').toBe(
      true,
    );
    await expect(result).resolves.toEqual({ rowsAffected: 1, lastInsertId: 7 });
  });

  it('uses normal notifications immediately and clears the retry timer', async () => {
    vi.useFakeTimers();
    const binding = connection();
    const db = await WebDatabaseService.open('stats.sqlite');
    const result = db.select('SELECT seconds FROM history');
    await vi.advanceTimersByTimeAsync(0);
    binding.wake();

    await expect(result).resolves.toEqual([{ seconds: 123 }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one notification waiter while retrying several statements', async () => {
    vi.useFakeTimers();
    const binding = connection();
    const db = await WebDatabaseService.open('stats.sqlite');
    let completed = 0;
    const first = db.execute('SELECT 1').then(() => {
      completed++;
    });
    await vi.advanceTimersByTimeAsync(100);
    const second = db.select('SELECT 2').then(() => {
      completed++;
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(completed).toBe(2);
    expect(binding.wait).toHaveBeenCalledTimes(1);
    await Promise.all([first, second]);
    binding.wake();
    await vi.advanceTimersByTimeAsync(0);
    const third = db.execute('SELECT 3');
    await vi.advanceTimersByTimeAsync(0);
    expect(binding.wait).toHaveBeenCalledTimes(2);
    binding.wake();
    await third;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates I/O failures instead of treating them as a retry', async () => {
    vi.useFakeTimers();
    const binding = connection();
    const error = new Error('OPFS unavailable');
    binding.wait.mockRejectedValueOnce(error);
    const db = await WebDatabaseService.open('stats.sqlite');

    await expect(db.execute('SELECT 1')).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });
});
