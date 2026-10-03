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
import { useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import Select, { type StylesConfig } from 'react-select';

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
  grab: 'Grab',
  grabAnyway: 'Grab Anyway',
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
  const { addToast } = useToasts();
  const searchAbortRef = useRef<AbortController | undefined>(undefined);
  const grabAbortRef = useRef<AbortController | undefined>(undefined);
  const [target, setTarget] = useState<'episode' | 'season'>('episode');
  const [episodeId, setEpisodeId] = useState<number>();
  const [seasonNumber, setSeasonNumber] = useState<number>();
  const [releases, setReleases] = useState<Release[]>();
  const [searchError, setSearchError] = useState<string>();
  const [searching, setSearching] = useState(false);
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
  }, [target, episodeId, seasonNumber]);

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
      {context.mediaType === 'tv' && (
        <div className="space-y-2">
          <SegmentedControl<'episode' | 'season'>
            ariaLabel={intl.formatMessage(messages.searchTarget)}
            size="sm"
            value={target}
            onChange={setTarget}
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
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <span className="truncate">{option.label}</span>
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
        </div>
      )}
      <Button
        buttonType="primary"
        className="w-full"
        onClick={search}
        disabled={searching}
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
        <p className="text-sm text-gray-400">
          {intl.formatMessage(messages.noReleases)}
        </p>
      )}
      {releases && releases.length > 0 && (
        <ul className="divide-y divide-gray-700 overflow-hidden rounded-md border border-gray-700 shadow">
          {releases.map((release) => (
            <li
              key={release.token}
              className={`space-y-1 px-4 py-3 text-sm ${release.rejected ? 'bg-yellow-500/5' : ''}`}
            >
              <div className="break-all font-medium text-white">
                {release.title}
              </div>
              <div className="text-xs text-gray-400">
                {[
                  release.quality ??
                    intl.formatMessage(messages.unknownQuality),
                  formatSize(release.size),
                  release.indexer,
                  release.protocol,
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
                <div className="text-xs text-yellow-300">
                  {release.rejections.join(' • ')}
                </div>
              )}
              <div className="pt-1">
                <Button
                  buttonSize="sm"
                  buttonType={release.rejected ? 'warning' : 'default'}
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
                          release.rejected ? messages.grabAnyway : messages.grab
                        )}
                  </span>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default ReleaseSearch;
