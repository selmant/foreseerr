import {
  DiscoverSliderType,
  repairedDiscoverSliderType,
} from '@server/constants/discover';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('repairedDiscoverSliderType', () => {
  it('maps custom Trakt watchlist rows with owner/slug data to Trakt list', () => {
    assert.equal(
      repairedDiscoverSliderType({
        type: DiscoverSliderType.TRAKT_WATCHLIST,
        isBuiltIn: false,
        data: 'asoslica/trending-anime',
      }),
      DiscoverSliderType.TRAKT_LIST
    );
  });

  it('maps custom AniList next-season rows with MDBList slugs to MDBList', () => {
    assert.equal(
      repairedDiscoverSliderType({
        type: DiscoverSliderType.ANILIST_NEXT_SEASON,
        isBuiltIn: false,
        data: 'saab51/isekai',
      }),
      DiscoverSliderType.MDBLIST_LIST
    );
  });

  it('leaves built-in watchlist and next-season rows alone', () => {
    assert.equal(
      repairedDiscoverSliderType({
        type: DiscoverSliderType.TRAKT_WATCHLIST,
        isBuiltIn: true,
        data: null,
      }),
      DiscoverSliderType.TRAKT_WATCHLIST
    );
    assert.equal(
      repairedDiscoverSliderType({
        type: DiscoverSliderType.ANILIST_NEXT_SEASON,
        isBuiltIn: true,
      }),
      DiscoverSliderType.ANILIST_NEXT_SEASON
    );
  });

  it('leaves rows without list-shaped data alone', () => {
    assert.equal(
      repairedDiscoverSliderType({
        type: DiscoverSliderType.TRAKT_WATCHLIST,
        isBuiltIn: false,
        data: '',
      }),
      DiscoverSliderType.TRAKT_WATCHLIST
    );
  });
});
