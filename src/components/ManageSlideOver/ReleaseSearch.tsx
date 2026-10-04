import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import SegmentedControl from '@app/components/Common/SegmentedControl';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownTrayIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import Select, { type StylesConfig } from 'react-select';
import { filterReleaseResults, type ReleaseSort } from './releaseResults';

import {
  formatSize,
  type Episode,
  type Release,
  type ServarrContext,
} from './servarrTypes';

const messages = defineMessages('components.ManageSlideOver.ReleaseSearch', {
  searchTarget: 'Search for',
  episode: 'Episode',
  seasonPack: 'Season Pack',
  episodeToSearch: 'Episode to search',
  chooseEpisode: 'Choose an episode',
  seasonToSearch: 'Season pack to search',
  chooseSeason: 'Choose a season',
  season: 'Season {seasonNumber}',
  searchReleases: 'Search Releases',
  searching: 'Searching…',
  searchFailed: 'Release search failed.',
  noReleases: 'No releases found.',
  grab: 'Download release',
  grabAnyway: 'Download anyway',
  sending: 'Sending to {service}…',
  sent: 'Sent to {service}. It may take a moment to appear in the download queue.',
  sentToast: 'Release sent to download client.',
  grabFailed: 'Unable to grab release.',
  unknownQuality: 'Unknown quality',
  seeders: '{count, plural, one {# seeder} other {# seeders}}',
  downloading: 'Downloading',
  queued: 'Queued',
  importing: 'Importing',
  importRequired: 'Import required',
  downloaded: 'Downloaded',
  wanted: 'Wanted',
  notMonitored: 'Not monitored',
  description:
    'Search your indexers, compare releases, then send a chosen download to {service}.',
  seasonHint: 'A season pack can include episodes you already have.',
  episodeHint: 'Type an episode name or number to find it quickly.',
  noEpisodes:
    'No episodes are available to search. Open the series in {service} to check its episode list.',
  results:
    '{shown, number} of {total, plural, one {# release} other {# releases}}',
  filterResults: 'Filter results',
  filterPlaceholder: 'Title, quality or indexer',
  sortResults: 'Sort results',
  defaultOrder: 'Default order',
  newest: 'Newest first',
  smallest: 'Smallest first',
  mostSeeders: 'Most seeders',
  onlyReady: 'Ready to download only',
  ready: 'Ready',
  review: 'Needs review',
  unavailable: 'Download unavailable',
  noMatches: 'No releases match these filters.',
  clearFilters: 'Clear result filters',
  emptyHint:
    'Try another episode or a season pack, or check your indexers in {service}.',
  emptyMovieHint: 'Check your indexers in {service}, then search again.',
  showMore: 'Show more releases ({count})',
  releaseAction: '{action}: {title}',
});

type SelectOption = {
  value: number;
  label: string;
  status?: Episode['queueStatus'] | 'downloaded' | 'wanted' | 'unmonitored';
};
type EpisodeStatus = NonNullable<SelectOption['status']>;

const episodeStatus: Record<
  EpisodeStatus,
  {
    message: keyof typeof messages;
    badgeType: 'default' | 'primary' | 'warning' | 'success' | 'dark';
  }
> = {
  downloading: { message: 'downloading', badgeType: 'primary' },
  queued: { message: 'queued', badgeType: 'primary' },
  importing: { message: 'importing', badgeType: 'success' },
  'manual-import': { message: 'importRequired', badgeType: 'warning' },
  downloaded: { message: 'downloaded', badgeType: 'success' },
  wanted: { message: 'wanted', badgeType: 'default' },
  unmonitored: { message: 'notMonitored', badgeType: 'dark' },
};

const episodeStatusOrder: Record<EpisodeStatus, number> = {
  downloading: 0,
  importing: 1,
  'manual-import': 2,
  queued: 3,
  wanted: 4,
  unmonitored: 5,
  downloaded: 6,
};

// The menu is portalled out of `.react-select-container`, so it needs the
// app's dropdown colors inline.
const selectStyles: StylesConfig<SelectOption, false> = {
  control: (base) => ({ ...base, minHeight: 44 }),
  singleValue: (base) => ({
    ...base,
    whiteSpace: 'normal',
    overflow: 'visible',
    maxWidth: '100%',
  }),
  menuPortal: (base) => ({ ...base, zIndex: 60 }),
  menu: (base) => ({ ...base, backgroundColor: '#374151', color: '#d1d5db' }),
  option: (base, state) => ({
    ...base,
    backgroundColor: state.isFocused ? '#4b5563' : '#374151',
    color: '#fff',
  }),
};

const errorMessage = (error: unknown, fallback: string) =>
  axios.isAxiosError(error)
    ? (error.response?.data?.message ?? fallback)
    : fallback;

const ReleaseSearch = ({
  mediaId,
  is4k,
  context,
  onChanged,
  onGrabbed,
}: {
  mediaId: number;
  is4k: boolean;
  context: ServarrContext;
  onChanged: () => void;
  onGrabbed: () => void;
}) => {
  const intl = useIntl();
  const inputId = useId();
  const { addToast } = useToasts();
  const searchAbortRef = useRef<AbortController | undefined>(undefined);
  const grabAbortRef = useRef<AbortController | undefined>(undefined);
  const [target, setTarget] = useState<'episode' | 'season'>('episode');
  const [episodeId, setEpisodeId] = useState<number>();
  const [seasonNumber, setSeasonNumber] = useState<number>();
  const [releases, setReleases] = useState<Release[]>();
  const [searchError, setSearchError] = useState<string>();
  const [searching, setSearching] = useState(false);
  const [resultQuery, setResultQuery] = useState('');
  const [onlyReady, setOnlyReady] = useState(false);
  const [sort, setSort] = useState<ReleaseSort>('default');
  const [visibleCount, setVisibleCount] = useState(20);
  const [grabbingToken, setGrabbingToken] = useState<string>();
  const [grabFeedback, setGrabFeedback] = useState<{
    kind: 'success' | 'error';
    message: string;
  }>();
  const episodes = useMemo(
    () => context.seasons?.flatMap((season) => season.episodes) ?? [],
    [context.seasons]
  );
  const episodeOptions = useMemo<SelectOption[]>(
    () =>
      episodes
        .map((episode) => ({
          value: episode.id,
          label: `S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')} — ${episode.title}`,
          status: (episode.queueStatus ??
            (episode.hasFile
              ? 'downloaded'
              : episode.monitored
                ? 'wanted'
                : 'unmonitored')) as EpisodeStatus,
          seasonNumber: episode.seasonNumber,
          episodeNumber: episode.episodeNumber,
        }))
        .sort(
          (left, right) =>
            episodeStatusOrder[left.status] -
              episodeStatusOrder[right.status] ||
            left.seasonNumber - right.seasonNumber ||
            left.episodeNumber - right.episodeNumber
        )
        .map(({ value, label, status }) => ({ value, label, status })),
    [episodes]
  );
  const seasonOptions = useMemo<SelectOption[]>(
    () =>
      context.seasons?.map((season) => ({
        value: season.seasonNumber,
        label: intl.formatMessage(messages.season, {
          seasonNumber: season.seasonNumber,
        }),
      })) ?? [],
    [context.seasons, intl]
  );

  useEffect(() => {
    const preferredEpisode = episodes.find(
      (episode) => !episode.hasFile && episode.monitored
    );
    const firstSeason = context.seasons?.[0];
    setSeasonNumber(
      preferredEpisode?.seasonNumber ?? firstSeason?.seasonNumber
    );
    setEpisodeId(preferredEpisode?.id ?? firstSeason?.episodes[0]?.id);
  }, [context.seasons, episodes]);

  useEffect(() => {
    setReleases(undefined);
    setGrabFeedback(undefined);
    setSearchError(undefined);
    setResultQuery('');
    setOnlyReady(false);
    setVisibleCount(20);
  }, [target, episodeId, seasonNumber]);
  useEffect(() => setVisibleCount(20), [resultQuery, onlyReady, sort]);
  const filteredReleases = useMemo(
    () => filterReleaseResults(releases ?? [], resultQuery, onlyReady, sort),
    [releases, resultQuery, onlyReady, sort]
  );
  const canSearch =
    context.mediaType === 'movie' ||
    (target === 'episode'
      ? episodeId !== undefined
      : seasonNumber !== undefined);

  useEffect(
    () => () => {
      searchAbortRef.current?.abort();
      grabAbortRef.current?.abort();
    },
    []
  );

  const search = async () => {
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearching(true);
    setSearchError(undefined);
    try {
      const params = new URLSearchParams({ is4k: String(is4k) });
      if (context.mediaType === 'tv') {
        params.set('target', target);
        if (target === 'episode' && episodeId)
          params.set('episodeId', String(episodeId));
        if (target === 'season' && seasonNumber !== undefined)
          params.set('seasonNumber', String(seasonNumber));
      }
      const response = await axios.get<{ results: Release[] }>(
        `/api/v1/media/${mediaId}/servarr/releases?${params}`,
        { signal: controller.signal }
      );
      if (!controller.signal.aborted) {
        setReleases(response.data.results);
        setVisibleCount(20);
        setGrabFeedback(undefined);
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setSearchError(
          errorMessage(error, intl.formatMessage(messages.searchFailed))
        );
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  };

  const grab = async (release: Release) => {
    grabAbortRef.current?.abort();
    const controller = new AbortController();
    grabAbortRef.current = controller;
    setGrabbingToken(release.token);
    setSearchError(undefined);
    setGrabFeedback(undefined);
    try {
      await axios.post(
        `/api/v1/media/${mediaId}/servarr/releases`,
        { is4k, token: release.token, acknowledgeRejections: release.rejected },
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      setGrabFeedback({
        kind: 'success',
        message: intl.formatMessage(messages.sent, {
          service: context.service.name,
        }),
      });
      addToast(intl.formatMessage(messages.sentToast), {
        appearance: 'success',
        autoDismiss: true,
      });
      onGrabbed();
      onChanged();
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = errorMessage(
        error,
        intl.formatMessage(messages.grabFailed)
      );
      setGrabFeedback({ kind: 'error', message });
      addToast(message, { appearance: 'error', autoDismiss: true });
    } finally {
      if (!controller.signal.aborted) setGrabbingToken(undefined);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-400">
        {intl.formatMessage(messages.description, {
          service: context.service.name,
        })}
      </p>
      {context.mediaType === 'tv' && (
        <div className="space-y-2">
          <SegmentedControl<'episode' | 'season'>
            disabled={searching}
            ariaLabel={intl.formatMessage(messages.searchTarget)}
            value={target}
            onChange={(value) => {
              if (!searching) setTarget(value);
            }}
            options={[
              { value: 'episode', label: intl.formatMessage(messages.episode) },
              {
                value: 'season',
                label: intl.formatMessage(messages.seasonPack),
              },
            ]}
          />
          {target === 'episode' ? (
            <Select<SelectOption, false>
              aria-label={intl.formatMessage(messages.episodeToSearch)}
              className="react-select-container"
              classNamePrefix="react-select"
              isSearchable
              isDisabled={searching}
              maxMenuHeight={250}
              menuPortalTarget={
                typeof document !== 'undefined' ? document.body : undefined
              }
              menuPosition="fixed"
              menuShouldScrollIntoView={false}
              options={episodeOptions}
              placeholder={intl.formatMessage(messages.chooseEpisode)}
              styles={selectStyles}
              formatOptionLabel={(option) => {
                const status = episodeStatus[option.status ?? 'wanted'];
                return (
                  <div className="min-w-0 space-y-1">
                    <span className="block break-words">{option.label}</span>
                    <Badge badgeType={status.badgeType} className="shrink-0">
                      {intl.formatMessage(messages[status.message])}
                    </Badge>
                  </div>
                );
              }}
              value={episodeOptions.find(
                (option) => option.value === episodeId
              )}
              onChange={(option) => setEpisodeId(option?.value)}
            />
          ) : (
            <Select<SelectOption, false>
              aria-label={intl.formatMessage(messages.seasonToSearch)}
              className="react-select-container"
              classNamePrefix="react-select"
              isSearchable={false}
              isDisabled={searching}
              menuPortalTarget={
                typeof document !== 'undefined' ? document.body : undefined
              }
              menuPosition="fixed"
              menuShouldScrollIntoView={false}
              options={seasonOptions}
              placeholder={intl.formatMessage(messages.chooseSeason)}
              styles={selectStyles}
              value={seasonOptions.find(
                (option) => option.value === seasonNumber
              )}
              onChange={(option) => setSeasonNumber(option?.value)}
            />
          )}
          <p className="text-xs text-gray-400">
            {intl.formatMessage(
              canSearch
                ? target === 'episode'
                  ? messages.episodeHint
                  : messages.seasonHint
                : messages.noEpisodes,
              { service: context.service.name }
            )}
          </p>
        </div>
      )}
      <Button
        buttonType="primary"
        className="min-h-11 w-full"
        onClick={search}
        disabled={searching || !canSearch}
        aria-busy={searching}
      >
        <MagnifyingGlassIcon />
        <span>
          {intl.formatMessage(
            searching ? messages.searching : messages.searchReleases
          )}
        </span>
      </Button>
      {searchError && <Alert type="error" title={searchError} />}
      {grabFeedback && (
        <div aria-live="polite" role="status">
          <Alert
            type={grabFeedback.kind === 'success' ? 'info' : 'error'}
            title={grabFeedback.message}
          />
        </div>
      )}
      {releases && releases.length === 0 && (
        <div
          role="status"
          className="space-y-1 rounded-lg border border-gray-700 p-4 text-sm text-gray-400"
        >
          <p className="font-medium text-gray-200">
            {intl.formatMessage(messages.noReleases)}
          </p>
          <p>
            {intl.formatMessage(
              context.mediaType === 'tv'
                ? messages.emptyHint
                : messages.emptyMovieHint,
              { service: context.service.name }
            )}
          </p>
        </div>
      )}
      {releases && releases.length > 0 && (
        <div className="space-y-3">
          <div className="space-y-3 rounded-lg border border-gray-700 bg-gray-900/40 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor={`${inputId}-query`}>
                  {intl.formatMessage(messages.filterResults)}
                </label>
                <input
                  id={`${inputId}-query`}
                  type="search"
                  className="min-h-11 w-full"
                  placeholder={intl.formatMessage(messages.filterPlaceholder)}
                  value={resultQuery}
                  onChange={(e) => setResultQuery(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor={`${inputId}-sort`}>
                  {intl.formatMessage(messages.sortResults)}
                </label>
                <select
                  id={`${inputId}-sort`}
                  className="min-h-11 w-full"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as ReleaseSort)}
                >
                  <option value="default">
                    {intl.formatMessage(messages.defaultOrder)}
                  </option>
                  <option value="newest">
                    {intl.formatMessage(messages.newest)}
                  </option>
                  <option value="smallest">
                    {intl.formatMessage(messages.smallest)}
                  </option>
                  <option value="seeders">
                    {intl.formatMessage(messages.mostSeeders)}
                  </option>
                </select>
              </div>
            </div>
            <label className="mb-0 flex min-h-11 cursor-pointer items-center gap-2 text-sm font-normal text-gray-200">
              <input
                type="checkbox"
                checked={onlyReady}
                onChange={(e) => setOnlyReady(e.target.checked)}
              />
              {intl.formatMessage(messages.onlyReady)}
            </label>
            {(resultQuery || onlyReady) && (
              <Button
                className="min-h-11 w-full"
                onClick={() => {
                  setResultQuery('');
                  setOnlyReady(false);
                }}
              >
                {intl.formatMessage(messages.clearFilters)}
              </Button>
            )}
          </div>
          <p role="status" className="text-sm text-gray-400">
            {intl.formatMessage(messages.results, {
              shown: filteredReleases.length,
              total: releases.length,
            })}
          </p>
          {filteredReleases.length === 0 && (
            <p className="text-sm text-gray-300">
              {intl.formatMessage(messages.noMatches)}
            </p>
          )}
          <ul className="divide-y divide-gray-700 overflow-hidden rounded-md border border-gray-700 shadow">
            {filteredReleases.slice(0, visibleCount).map((release) => (
              <li
                key={release.token}
                className={`space-y-1 px-4 py-3 text-sm ${release.rejected ? 'bg-yellow-500/5' : ''}`}
              >
                <div className="break-all font-medium text-white">
                  {release.title}
                </div>
                <Badge
                  badgeType={
                    release.rejected
                      ? 'warning'
                      : release.downloadAllowed
                        ? 'success'
                        : 'dark'
                  }
                >
                  {intl.formatMessage(
                    release.rejected
                      ? messages.review
                      : release.downloadAllowed
                        ? messages.ready
                        : messages.unavailable
                  )}
                </Badge>
                <div className="break-words text-xs text-gray-400">
                  {[
                    release.quality ??
                      intl.formatMessage(messages.unknownQuality),
                    formatSize(release.size),
                    release.indexer,
                    release.protocol,
                    intl.formatRelativeTime(
                      -Math.round(release.ageHours),
                      'hour',
                      { numeric: 'auto' }
                    ),
                    release.seeders !== undefined
                      ? intl.formatMessage(messages.seeders, {
                          count: release.seeders,
                        })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                {release.rejections.length > 0 && (
                  <div className="break-words text-xs text-yellow-300">
                    {release.rejections.join(' • ')}
                  </div>
                )}
                <div className="pt-1">
                  <Button
                    buttonSize="sm"
                    buttonType={release.rejected ? 'warning' : 'default'}
                    className="min-h-11 w-full sm:w-auto"
                    aria-label={intl.formatMessage(messages.releaseAction, {
                      action: intl.formatMessage(
                        release.rejected ? messages.grabAnyway : messages.grab
                      ),
                      title: release.title,
                    })}
                    aria-busy={grabbingToken === release.token}
                    onClick={() => void grab(release)}
                    disabled={
                      grabbingToken !== undefined ||
                      (!release.downloadAllowed && !release.rejected)
                    }
                  >
                    <ArrowDownTrayIcon />
                    <span>
                      {grabbingToken === release.token
                        ? intl.formatMessage(messages.sending, {
                            service: context.service.name,
                          })
                        : intl.formatMessage(
                            release.rejected
                              ? messages.grabAnyway
                              : messages.grab
                          )}
                    </span>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {filteredReleases.length > visibleCount && (
            <Button
              className="min-h-11 w-full"
              onClick={() => setVisibleCount((count) => count + 20)}
            >
              {intl.formatMessage(messages.showMore, {
                count: filteredReleases.length - visibleCount,
              })}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

export default ReleaseSearch;
