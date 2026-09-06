import Settings from '@server/lib/settings';
import type { AllSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clampImageCacheIdleDays,
  IMAGE_CACHE_IDLE_DAYS_DEFAULT,
  resolveImageProxyFetch,
  rewriteCachedImageSrc,
  toImageProxyPath,
} from './imageproxySources';

describe('imageproxySources', () => {
  it('clamps idle days to 1–90 and defaults junk', () => {
    assert.equal(clampImageCacheIdleDays(7), 7);
    assert.equal(clampImageCacheIdleDays(1), 1);
    assert.equal(clampImageCacheIdleDays(90), 90);
    assert.equal(clampImageCacheIdleDays(0), 1);
    assert.equal(clampImageCacheIdleDays(999), 90);
    assert.equal(
      clampImageCacheIdleDays('nope'),
      IMAGE_CACHE_IDLE_DAYS_DEFAULT
    );
  });

  it('rewrites allowlisted TMDB, AniList, and Simkl URLs when caching is on', () => {
    assert.equal(
      rewriteCachedImageSrc(
        'https://image.tmdb.org/t/p/w300_and_h450_face/poster.jpg',
        true
      ),
      '/imageproxy/tmdb/t/p/w300_and_h450_face/poster.jpg'
    );
    assert.equal(
      rewriteCachedImageSrc(
        'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21.jpg',
        true
      ),
      '/imageproxy/anilist/s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21.jpg'
    );
    assert.equal(
      rewriteCachedImageSrc('https://simkl.in/posters/20/205643_w.webp', true),
      '/imageproxy/simkl/simkl.in/posters/20/205643_w.webp'
    );
  });

  it('leaves relative sources and off-mode URLs alone', () => {
    assert.equal(
      rewriteCachedImageSrc(
        '/images/seerr_poster_not_found_logo_top.png',
        true
      ),
      '/images/seerr_poster_not_found_logo_top.png'
    );
    assert.equal(
      rewriteCachedImageSrc('/avatarproxy/abc', true),
      '/avatarproxy/abc'
    );
    assert.equal(
      rewriteCachedImageSrc('https://image.tmdb.org/t/p/w300/x.jpg', false),
      'https://image.tmdb.org/t/p/w300/x.jpg'
    );
  });

  it('unwraps wsrv.nl only for simkl.in posters', () => {
    assert.equal(
      toImageProxyPath(
        'https://wsrv.nl/?url=https://simkl.in/posters/20/205643_w.webp&q=90'
      ),
      '/imageproxy/simkl/simkl.in/posters/20/205643_w.webp'
    );
    assert.equal(
      toImageProxyPath('https://wsrv.nl/?url=https://evil.example/x.jpg'),
      null
    );
  });

  it('rejects unknown hosts and unsafe proxy paths', () => {
    assert.equal(toImageProxyPath('https://evil.example/poster.jpg'), null);
    assert.deepEqual(resolveImageProxyFetch('nope', '/t/p/x.jpg'), {
      error: 'unsupported',
    });
    assert.deepEqual(
      resolveImageProxyFetch('tmdb', '/https://evil.example/x'),
      { error: 'invalid' }
    );
    assert.deepEqual(
      resolveImageProxyFetch('anilist', '/evil.example/file/x.jpg'),
      { error: 'invalid' }
    );
    assert.deepEqual(
      resolveImageProxyFetch(
        'anilist',
        '/s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21.jpg'
      ),
      {
        source: 'anilist',
        fetchUrl:
          'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21.jpg',
      }
    );
  });

  it('defaults imageCacheIdleDays to 7 when loading an old settings object', () => {
    const settings = new Settings({
      main: { cacheImages: true },
    } as AllSettings);
    assert.equal(settings.main.imageCacheIdleDays, 7);
    assert.equal(settings.main.cacheImages, true);

    settings.main = {
      ...settings.main,
      imageCacheIdleDays: 999,
    };
    assert.equal(settings.main.imageCacheIdleDays, 90);
  });
});
