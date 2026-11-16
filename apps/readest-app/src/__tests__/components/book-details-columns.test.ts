import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useMetadataEdit } from '@/components/metadata/useMetadataEdit';
import type { BookMetadata } from '@/libs/document';
const metadata: BookMetadata = {
  title: 'Book',
  author: 'Author',
  language: 'en',
  calibreColumns: [
    { label: 'rating', name: 'Rating', datatype: 'float', value: 3 },
    { label: 'categories', name: 'Categories', datatype: 'text', value: ['Science'] },
    { label: 'finished', name: 'Finished on', datatype: 'datetime', value: '2021-01-01' },
    { label: 'reviewed', name: 'Reviewed', datatype: 'bool', value: false },
  ],
};
const tags: string[] = [];
describe('editable custom library metadata', () => {
  it('preserves typed columns and unrelated metadata through the normal editor', () => {
    const { result } = renderHook(() => useMetadataEdit(metadata, tags));
    act(() => result.current.handleFieldChange('calibre:rating', '4.5'));
    expect(result.current.editedMeta.calibreColumns?.[0]?.value).toBe(4.5);
    act(() => result.current.handleFieldChange('calibre:categories', 'Science; Favorites'));
    expect(result.current.editedMeta.calibreColumns?.[1]?.value).toEqual(['Science', 'Favorites']);
    act(() => result.current.handleFieldChange('calibre:reviewed', 'true'));
    expect(result.current.editedMeta.calibreColumns?.[3]?.value).toBe(true);
    expect(result.current.editedMeta.title).toBe('Book');
    expect(result.current.editedMeta.calibreColumns?.[2]?.value).toBe('2021-01-01');
    expect(metadata.calibreColumns?.[0]?.value).toBe(3);
  });
  it('keeps the saved value and blocks invalid dates and numbers', () => {
    const { result } = renderHook(() => useMetadataEdit(metadata, tags));
    act(() => result.current.handleFieldChange('calibre:rating', 'invalid'));
    expect(result.current.fieldErrors['calibre:rating']).toBeTruthy();
    expect(result.current.editedMeta.calibreColumns?.[0]?.value).toBe(3);
    act(() => result.current.handleFieldChange('calibre:finished', 'not a date'));
    expect(result.current.fieldErrors['calibre:finished']).toBeTruthy();
    act(() => result.current.handleFieldChange('calibre:rating', '2'));
    expect(result.current.fieldErrors['calibre:rating']).toBeUndefined();
  });
});
