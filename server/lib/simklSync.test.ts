import { getRepository } from '@server/datasource';
import { SimklSyncItem } from '@server/entity/SimklSyncItem';
import { SimklSyncState } from '@server/entity/SimklSyncState';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { cachedWatchedCoordinates } from '@server/lib/mediaActions/simklEpisodes';
import { getSettings } from '@server/lib/settings';
import { syncSimklUser } from '@server/lib/simklSync';
import { setupTestDb } from '@server/test/db';
import axios, {
  AxiosError,
  type AxiosAdapter,
  type InternalAxiosRequestConfig,
} from 'axios';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const previousAxiosAdapter = axios.defaults.adapter;

afterEach(() => {
  axios.defaults.adapter = previousAxiosAdapter;
});

setupTestDb();

type Answer = { status: number; data: unknown };

/** Simkl stub; returns each request as path plus its non-identifying query. */
const stubSimkl = (route: (path: string, query: URLSearchParams) => Answer) => {
  const calls: string[] = [];
  axios.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
    const url = new URL(String(config.url), 'https://api.simkl.com');
    for (const key of ['client_id', 'app-name', 'app-version'])
      url.searchParams.delete(key);
    calls.push(`${url.pathname}${url.search}`);
    const { status, data } = route(url.pathname, url.searchParams);
    const response = { status, statusText: '', headers: {}, config, data };
    if (status < 400) return response;
    throw new AxiosError(
      `Request failed with status code ${status}`,
      AxiosError.ERR_BAD_REQUEST,
      config,
      undefined,
      response
    );
  }) as AxiosAdapter;
  return calls;
};

const activities = (all: string, overrides: Record<string, unknown> = {}) => ({
  all,
  settings: { all: '2026-01-01T00:00:00Z' },
  tv_shows: {
    all,
    watching: '2026-01-01T00:00:00Z',
    plantowatch: '2026-01-01T00:00:00Z',
    rated_at: '2026-01-01T00:00:00Z',
    removed_from_list: '2026-01-01T00:00:00Z',
    playback: '2026-01-01T00:00:00Z',
  },
  movies: { all, completed: '2026-01-01T00:00:00Z' },
  anime: { all, watching: '2026-01-01T00:00:00Z' },
  ...overrides,
});

const show = (simkl: number, extra: Record<string, unknown> = {}) => ({
  status: 'watching',
  user_rating: null,
  show: { title: `Show ${simkl}`, ids: { simkl, tmdb: String(simkl + 1000) } },
  ...extra,
});
const movie = (simkl: number, extra: Record<string, unknown> = {}) => ({
  status: 'completed',
  movie: {
    title: `Movie ${simkl}`,
    ids: { simkl, tmdb: String(simkl + 5000) },
  },
  ...extra,
});

const linkedUser = async () => {
  const user = await getRepository(User).findOneOrFail({
    where: { email: 'admin@seerr.dev' },
  });
  const repository = getRepository(UserSettings);
  const settings =
    (await repository.findOne({ where: { user: { id: user.id } } })) ??
    repository.create({ user: { id: user.id } });
  Object.assign(settings, {
    simklAccessToken: 'simkl_at_token',
    simklUserId: '4242',
  });
  await repository.save(settings);
  const simkl = getSettings().simkl;
  getSettings().simkl = { ...simkl, enabled: true, clientId: '' };
  return user.id;
};

const cached = async (userId: number) =>
  (await getRepository(SimklSyncItem).find({ where: { user: { id: userId } } }))
    .map((item) => `${item.simklType}:${item.simklId}:${item.status}`)
    .sort();

/** Runs the first sync: activities at `all`, one show and one movie. */
const initialSync = async (userId: number, all = '2026-05-01T00:00:00Z') => {
  stubSimkl((path) => {
    if (path === '/sync/activities')
      return { status: 200, data: activities(all) };
    if (path === '/sync/all-items/shows')
      return {
        status: 200,
        data: {
          shows: [
            show(1, { seasons: [{ number: 1, episodes: [{ number: 1 }] }] }),
          ],
        },
      };
    if (path === '/sync/all-items/movies')
      return { status: 200, data: { movies: [movie(2)] } };
    return { status: 200, data: {} };
  });
  assert.equal((await syncSimklUser(userId, true)).stale, false);
};

describe('Simkl sync (two-phase, per the Simkl sync guide)', () => {
  it('pulls each type once, sequentially, with episodes for shows and anime', async () => {
    const userId = await linkedUser();
    const calls = stubSimkl((path) =>
      path === '/sync/activities'
        ? { status: 200, data: activities('2026-05-01T00:00:00Z') }
        : path === '/sync/all-items/shows'
          ? {
              status: 200,
              data: {
                shows: [
                  show(1, {
                    seasons: [
                      { number: 1, episodes: [{ number: 1 }, { number: 2 }] },
                    ],
                  }),
                ],
              },
            }
          : { status: 200, data: {} }
    );
    await syncSimklUser(userId, true);
    assert.deepEqual(calls, [
      '/sync/activities',
      '/sync/all-items/shows?extended=full&include_all_episodes=yes',
      '/sync/all-items/movies',
      '/sync/all-items/anime?extended=full&include_all_episodes=yes',
    ]);
    assert.deepEqual(await cachedWatchedCoordinates(userId, 1001), [
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
    ]);
  });

  it('stops after the activity check when nothing changed', async () => {
    const userId = await linkedUser();
    await initialSync(userId);
    const calls = stubSimkl(() => ({
      status: 200,
      data: activities('2026-05-01T00:00:00Z'),
    }));
    await syncSimklUser(userId, true);
    assert.deepEqual(calls, ['/sync/activities']);
  });

  it('fetches nothing when only settings or playback moved', async () => {
    const userId = await linkedUser();
    await initialSync(userId);
    const later = activities('2026-05-02T00:00:00Z', {
      settings: { all: '2026-05-02T00:00:00Z' },
    });
    (later.tv_shows as Record<string, unknown>).playback =
      '2026-05-02T00:00:00Z';
    const calls = stubSimkl(() => ({ status: 200, data: later }));
    await syncSimklUser(userId, true);
    assert.deepEqual(calls, ['/sync/activities']);
  });

  it('merges one all-types delta from the saved `all` when a list moved', async () => {
    const userId = await linkedUser();
    await initialSync(userId);
    const later = activities('2026-05-02T10:00:00Z');
    (later.tv_shows as Record<string, unknown>).watching =
      '2026-05-02T10:00:00Z';
    const calls = stubSimkl((path) =>
      path === '/sync/activities'
        ? { status: 200, data: later }
        : {
            status: 200,
            data: {
              shows: [
                show(1, {
                  status: 'completed',
                  seasons: [{ number: 1, episodes: [{ number: 1 }] }],
                }),
                show(3),
              ],
            },
          }
    );
    await syncSimklUser(userId, true);
    assert.deepEqual(calls, [
      '/sync/activities',
      '/sync/all-items?date_from=2026-05-01T00%3A00%3A00Z&extended=full&include_all_episodes=yes',
    ]);
    assert.deepEqual(await cached(userId), [
      'movie:2:completed',
      'show:1:completed',
      'show:3:watching',
    ]);
    assert.deepEqual(await cachedWatchedCoordinates(userId, 1003), []);
  });

  it('reads rating changes from /sync/ratings, clearing removed ones', async () => {
    const userId = await linkedUser();
    await initialSync(userId);
    await getRepository(SimklSyncItem).update(
      { simklId: '2' },
      { userRating: 8 }
    );
    const later = activities('2026-05-03T00:00:00Z');
    (later.movies as Record<string, unknown>).rated_at = '2026-05-03T00:00:00Z';
    const calls = stubSimkl((path) =>
      path === '/sync/activities'
        ? { status: 200, data: later }
        : {
            status: 200,
            data: {
              movies: [movie(2, { user_rating: null })],
              shows: [show(1, { user_rating: 9 })],
            },
          }
    );
    await syncSimklUser(userId, true);
    assert.deepEqual(calls, [
      '/sync/activities',
      '/sync/ratings?date_from=2026-05-01T00%3A00%3A00Z',
    ]);
    const items = await getRepository(SimklSyncItem).find({
      where: { user: { id: userId } },
    });
    const rating = (id: string) =>
      items.find((item) => item.simklId === id)?.userRating;
    assert.equal(rating('2'), null);
    assert.equal(rating('1'), 9);
    assert.deepEqual(
      await cachedWatchedCoordinates(userId, 1001),
      [{ season: 1, episode: 1 }],
      'a ratings row keeps the episodes'
    );
  });

  it('diffs removals with one ids-only call', async () => {
    const userId = await linkedUser();
    await initialSync(userId);
    const later = activities('2026-05-04T00:00:00Z');
    (later.tv_shows as Record<string, unknown>).removed_from_list =
      '2026-05-04T00:00:00Z';
    const calls = stubSimkl((path) =>
      path === '/sync/activities'
        ? { status: 200, data: later }
        : { status: 200, data: { movies: [{ movie: { ids: { simkl: 2 } } }] } }
    );
    await syncSimklUser(userId, true);
    assert.deepEqual(calls, [
      '/sync/activities',
      '/sync/all-items?extended=simkl_ids_only',
    ]);
    assert.deepEqual(await cached(userId), ['movie:2:completed']);
  });

  it('keeps the saved snapshot when a delta fails', async () => {
    const userId = await linkedUser();
    await initialSync(userId);
    const later = activities('2026-05-05T00:00:00Z');
    (later.anime as Record<string, unknown>).watching = '2026-05-05T00:00:00Z';
    stubSimkl((path) =>
      path === '/sync/activities'
        ? { status: 200, data: later }
        : { status: 503, data: 'down' }
    );
    assert.equal((await syncSimklUser(userId, true)).stale, true);
    const state = await getRepository(SimklSyncState).findOneOrFail({
      where: { user: { id: userId } },
    });
    assert.equal(
      JSON.parse(state.activities ?? '{}').all,
      '2026-05-01T00:00:00Z',
      'the next poll resends the same date_from'
    );
  });

  it('splits a type by status when Simkl answers max_items', async () => {
    const userId = await linkedUser();
    const calls = stubSimkl((path) => {
      if (path === '/sync/activities')
        return { status: 200, data: activities('2026-05-01T00:00:00Z') };
      if (path === '/sync/all-items/shows')
        return {
          status: 400,
          data: { error: 'max_items', message: 'Too many episodes' },
        };
      if (path === '/sync/all-items/shows/watching')
        return { status: 200, data: { shows: [show(1)] } };
      return { status: 200, data: {} };
    });
    assert.equal((await syncSimklUser(userId, true)).stale, false);
    assert.ok(
      calls.includes(
        '/sync/all-items/shows/dropped?extended=full&include_all_episodes=yes'
      )
    );
    assert.deepEqual(await cached(userId), ['show:1:watching']);
  });
});
