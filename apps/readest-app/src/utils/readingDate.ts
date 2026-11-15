/** Reading/listening dates are independent of metadata-edit and sync clocks. */
type ReadingDateKey = 'absLastListenedAt' | 'readestLastReadAt';
const dateKeys: ReadingDateKey[] = ['absLastListenedAt', 'readestLastReadAt'];

export const getReadingDate = (
  metadata: unknown,
  key: ReadingDateKey = 'absLastListenedAt',
): number | undefined => {
  if (!metadata || typeof metadata !== 'object') return;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
};

export const mergeReadingDates = <T extends object | null | undefined>(
  metadata: T,
  ...sources: unknown[]
): T => {
  if (!metadata) return metadata;
  let result = metadata;
  for (const key of dateKeys) {
    const latest = Math.max(...[metadata, ...sources].map((m) => getReadingDate(m, key) ?? -1));
    if (latest >= 0 && getReadingDate(result, key) !== latest)
      result = { ...result, [key]: latest };
  }
  return result;
};

/** Keep legacy metadata byte-for-byte unless an actual reading date changes. */
export const mergeSerializedReadingDates = (
  metadata: string | null | undefined,
  ...sources: (string | null | undefined)[]
): string | null | undefined => {
  if (![metadata, ...sources].some((m) => dateKeys.some((key) => m?.includes('"' + key + '"'))))
    return metadata;
  try {
    const current: unknown = JSON.parse(metadata ?? 'null');
    if (!current || typeof current !== 'object' || Array.isArray(current)) return metadata;
    const others = sources.map((m): unknown => JSON.parse(m ?? 'null'));
    const merged = mergeReadingDates(current, ...others);
    return merged === current ? metadata : JSON.stringify(merged);
  } catch {
    // Legacy metadata can be opaque text; date merging must not break sync.
    return metadata;
  }
};
