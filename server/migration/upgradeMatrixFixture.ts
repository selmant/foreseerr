/**
 * Shared fixture/assertions for the upgrade-matrix tests (Phase 4).
 *
 * These simulate upgrading a database created by upstream Seerr at the
 * Phase 0 baseline commit (see `upstreamBaseline.ts`) to the current schema,
 * and assert that data survives — not just that the migration runner exits
 * successfully. They also run real ORM queries against the upgraded schema
 * (not just raw migrations) as a smoke check that entities still match the
 * upgraded table shape.
 *
 * IMPORTANT: SQLite and PostgreSQL variants must live in separate test
 * files (`upgradeMatrix.sqlite.test.ts` / `upgradeMatrix.postgres.test.ts`),
 * each run in its own process. `DbAwareColumn` (see
 * `@server/utils/DbColumnHelper`) bakes the `isPgsql` flag into entity
 * column types the first time an entity module is imported, so the two
 * engines cannot share a process without one of them getting the wrong
 * column types.
 *
 * A previous-Foreseerr-stable fixture should be added here once a stable
 * release exists (see docs/using-seerr/backups.md "Alpha-to-stable" note).
 */
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { UserType } from '@server/constants/user';
import DiscoverSlider from '@server/entity/DiscoverSlider';
import EpisodeRequest from '@server/entity/EpisodeRequest';
import Media from '@server/entity/Media';
import MediaRequest from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { sourceEntityFiles } from '@server/utils/typeormGlobs';
import assert from 'node:assert/strict';
import type { DataSource } from 'typeorm';

export const ENTITIES_GLOB = sourceEntityFiles();

export interface SeededIds {
  adminUserId: number;
  friendUserId: number;
  mediaId: number;
}

/**
 * Seeds data using only columns that existed upstream at the baseline
 * commit, via raw SQL with an explicit column list. This intentionally does
 * not use `repository.save()` or the insert query builder for the
 * baseline-only tables (`media_request`, `user_settings`,
 * `discover_slider`): both build their INSERT from the *current* entity
 * metadata (including columns the baseline schema doesn't have yet, like
 * `ignoreQuota`), which fails against the pre-upgrade table shape. `User`
 * and `Media` are untouched by the Foreseerr-only migrations, so the ORM is
 * safe to use for them.
 */
export async function seedBaselineFixture(
  dataSource: DataSource
): Promise<SeededIds> {
  const admin = await dataSource.getRepository(User).save(
    new User({
      email: 'legacy-admin@seerr.dev',
      username: 'legacy-admin',
      plexId: 1,
      plexToken: 'legacy-token',
      plexUsername: 'legacy-admin',
      userType: UserType.PLEX,
      permissions: 2,
      avatar: '/avatarproxy/legacy',
    })
  );

  const friend = await dataSource.getRepository(User).save(
    new User({
      email: 'legacy-friend@seerr.dev',
      username: 'legacy-friend',
      plexId: 2,
      plexToken: 'legacy-friend-token',
      plexUsername: 'legacy-friend',
      userType: UserType.PLEX,
      permissions: 32,
      avatar: '/avatarproxy/legacy-friend',
    })
  );

  const media = await dataSource.getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 603,
      imdbId: 'tt0133093',
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
      serviceId: 1,
      externalServiceId: 42,
    } as Partial<Media>)
  );

  await dataSource.query(`
    INSERT INTO "media_request"
      ("status", "createdAt", "updatedAt", "type", "mediaId", "requestedById", "modifiedById", "is4k", "serverId", "profileId", "rootFolder", "languageProfileId", "tags", "isAutoRequest")
    VALUES
      (${MediaRequestStatus.APPROVED}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'movie', ${media.id}, ${admin.id}, ${admin.id}, false, 0, 4, '/movies', NULL, NULL, false)
  `);

  await dataSource.query(`
    INSERT INTO "user_settings"
      ("userId", "locale", "discoverRegion", "watchlistSyncMovies")
    VALUES
      (${friend.id}, 'en', 'US', true)
  `);

  await dataSource.query(`
    INSERT INTO "discover_slider"
      ("type", "order", "isBuiltIn", "enabled", "title", "createdAt", "updatedAt")
    VALUES
      (1, 0, true, true, 'Trending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  return { adminUserId: admin.id, friendUserId: friend.id, mediaId: media.id };
}

export async function assertUpgradeIsIntact(
  dataSource: DataSource
): Promise<void> {
  const users = await dataSource
    .getRepository(User)
    .find({ order: { id: 'ASC' } });
  assert.equal(users.length, 2, 'both pre-upgrade users should survive');
  assert.equal(users[0].email, 'legacy-admin@seerr.dev');
  assert.equal(users[1].email, 'legacy-friend@seerr.dev');

  const upgradedMedia = await dataSource
    .getRepository(Media)
    .findOneOrFail({ where: { tmdbId: 603 } });
  assert.equal(upgradedMedia.imdbId, 'tt0133093');
  assert.equal(upgradedMedia.status, MediaStatus.AVAILABLE);

  const upgradedRequest = await dataSource
    .getRepository(MediaRequest)
    .findOneOrFail({ where: { media: { id: upgradedMedia.id } } });
  assert.equal(upgradedRequest.status, MediaRequestStatus.APPROVED);
  assert.equal(upgradedRequest.rootFolder, '/movies');
  assert.equal(
    upgradedRequest.ignoreQuota,
    false,
    'new ignoreQuota column should default to false for pre-existing rows'
  );
  assert.equal(upgradedRequest.tvQuotaUnits, 0);
  assert.equal(await dataSource.getRepository(EpisodeRequest).count(), 0);

  const upgradedSettings = await dataSource
    .getRepository(UserSettings)
    .createQueryBuilder('settings')
    .leftJoinAndSelect('settings.user', 'user')
    .addSelect('settings.traktAccessToken')
    .where('user.email = :email', { email: 'legacy-friend@seerr.dev' })
    .getOneOrFail();
  assert.equal(upgradedSettings.discoverRegion, 'US');
  assert.equal(upgradedSettings.watchlistSyncMovies, true);
  assert.equal(
    upgradedSettings.traktAccessToken ?? null,
    null,
    'new Trakt columns should be nullable and unset for pre-existing rows'
  );
  assert.equal(upgradedSettings.traktUserId ?? null, null);
  assert.equal(
    upgradedSettings.autoCompleteSkippedEpisodeEndings ?? null,
    null,
    'skipped episode cleanup should default to disabled after upgrade'
  );
  assert.equal(
    upgradedSettings.autoCompleteSkippedEpisodeThreshold ?? null,
    null,
    'skipped episode threshold should default to unset after upgrade'
  );
  assert.equal(
    upgradedSettings.watchAheadEpisodeCount ?? null,
    null,
    'watch-ahead default should be unset after upgrade'
  );
  assert.deepEqual(upgradedSettings.discoverFilterDefaults, {});

  const upgradedSlider = await dataSource
    .getRepository(DiscoverSlider)
    .findOneOrFail({ where: { title: 'Trending' } });
  assert.equal(upgradedSlider.sort ?? null, null);

  // Smoke boot: exercise the app's real ORM/entity layer against the
  // upgraded database, not just the migration runner, to catch schema/entity
  // drift that a bare `runMigrations()` call would miss.
  const requestCount = await dataSource.getRepository(MediaRequest).count();
  assert.equal(requestCount, 1);
}
