import {
  parseLibraryBrowseQuery,
  serializeLibraryBrowseQuery,
} from '@server/lib/libraryBrowseQuery';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('parseLibraryBrowseQuery', () => {
  it('applies defaults', () => {
    assert.deepEqual(parseLibraryBrowseQuery({}), {
      sort: 'dateAdded',
      order: 'desc',
      take: 24,
      skip: 0,
    });
  });

  it('parses repeated genres and year range', () => {
    const parsed = parseLibraryBrowseQuery({
      genre: ['Action', 'Drama'],
      yearFrom: '1990',
      yearTo: '2024',
      mediaType: 'movie',
      watched: 'inProgress',
      q: ' heat ',
    });
    assert.deepEqual(parsed.genre, ['Action', 'Drama']);
    assert.equal(parsed.yearFrom, 1990);
    assert.equal(parsed.yearTo, 2024);
    assert.equal(parsed.mediaType, 'movie');
    assert.equal(parsed.watched, 'inProgress');
    assert.equal(parsed.q, 'heat');
  });

  it('accepts a single genre string', () => {
    assert.deepEqual(parseLibraryBrowseQuery({ genre: 'Comedy' }).genre, [
      'Comedy',
    ]);
  });

  it('ignores invalid enums', () => {
    const parsed = parseLibraryBrowseQuery({
      sort: 'popularity',
      order: 'sideways',
      mediaType: 'music',
      watched: 'maybe',
    });
    assert.equal(parsed.sort, 'dateAdded');
    assert.equal(parsed.order, 'desc');
    assert.equal(parsed.mediaType, undefined);
    assert.equal(parsed.watched, undefined);
  });

  it('clamps take and skip', () => {
    assert.equal(parseLibraryBrowseQuery({ take: '0' }).take, 1);
    assert.equal(parseLibraryBrowseQuery({ take: '99' }).take, 50);
    assert.equal(parseLibraryBrowseQuery({ skip: '-4' }).skip, 0);
  });

  it('ignores density', () => {
    const parsed = parseLibraryBrowseQuery({ density: 'compact' });
    assert.equal('density' in parsed, false);
  });
});

describe('serializeLibraryBrowseQuery', () => {
  it('omits defaults', () => {
    const params = serializeLibraryBrowseQuery(parseLibraryBrowseQuery({}));
    assert.equal(params.toString(), '');
  });

  it('round-trips non-default filters', () => {
    const original = parseLibraryBrowseQuery({
      q: 'dune',
      mediaType: 'tv',
      watched: 'unwatched',
      genre: ['Sci-Fi', 'Adventure'],
      yearFrom: '2010',
      yearTo: '2020',
      sort: 'title',
      order: 'asc',
      take: '12',
      skip: '24',
    });
    const serialized = serializeLibraryBrowseQuery(original);
    const restored = parseLibraryBrowseQuery(
      Object.fromEntries(serialized.entries())
    );
    restored.genre = serialized.getAll('genre');
    assert.deepEqual(restored, original);
  });
});
