import Button from '@app/components/Common/Button';
import LibraryEpisodeWatchToggle from '@app/components/Library/LibraryEpisodeWatchToggle';
import defineMessages from '@app/utils/defineMessages';
import {
  MagnifyingGlassIcon,
  PlayIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import type { LibraryEpisode } from '@server/interfaces/api/libraryInterfaces';
import { useRef, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Library.LibraryEpisodeList', {
  search: 'Find an episode…',
  clearSearch: 'Clear episode search',
  hideWatched: 'Hide watched',
  watched: 'Watched',
  watchedCount:
    '{watched, number} of {total, plural, one {# episode watched} other {# episodes watched}}',
  play: 'Play',
  resume: 'Resume',
  playEpisode: '{action}: {episode}',
  upNext: 'Up next',
  inProgress: '{percent, number}% watched',
  noMatches: 'No episodes match your search.',
  allWatched: 'You have watched every episode in this season.',
  showAll: 'Show all episodes',
  showing:
    '{shown, number} of {total, plural, one {# episode shown} other {# episodes shown}}',
});

interface LibraryEpisodeListProps {
  episodes: LibraryEpisode[];
  episodesKey: string;
  tmdbId?: number;
  playItemId?: string;
  onPlay: (
    event: React.MouseEvent<HTMLAnchorElement | HTMLButtonElement>,
    episode: LibraryEpisode
  ) => void;
}

const LibraryEpisodeList = ({
  episodes,
  episodesKey,
  tmdbId,
  playItemId,
  onPlay,
}: LibraryEpisodeListProps) => {
  const intl = useIntl();
  const [query, setQuery] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const episodeList = useRef<HTMLUListElement>(null);
  const [hideWatched, setHideWatched] = useState(false);
  const [watchOverrides, setWatchOverrides] = useState<Map<string, boolean>>(
    new Map()
  );
  const isWatched = (episode: LibraryEpisode) =>
    watchOverrides.get(episode.jellyfinItemId) ?? Boolean(episode.watched);
  const watchedCount = episodes.filter(isWatched).length;
  const visibleEpisodes = episodes.filter(
    (episode) =>
      (!hideWatched || !isWatched(episode)) &&
      `${episode.name} ${episode.subtitle ?? ''}`
        .toLocaleLowerCase(intl.locale)
        .includes(query.trim().toLocaleLowerCase(intl.locale))
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-400">
          {intl.formatMessage(messages.watchedCount, {
            watched: watchedCount,
            total: episodes.length,
          })}
        </p>
        <button
          type="button"
          aria-pressed={hideWatched}
          onClick={() => setHideWatched((value) => !value)}
          className={`min-h-11 rounded-lg border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${hideWatched ? 'border-indigo-500 bg-indigo-500/20 text-indigo-200' : 'border-gray-600 text-gray-300 hover:bg-gray-700'}`}
        >
          {intl.formatMessage(messages.hideWatched)}
        </button>
      </div>
      <div className="relative">
        <MagnifyingGlassIcon
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400"
        />
        <input
          ref={searchInput}
          type="search"
          aria-label={intl.formatMessage(messages.search)}
          placeholder={intl.formatMessage(messages.search)}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-h-11 pl-10 pr-11 [&::-webkit-search-cancel-button]:hidden"
        />
        {query ? (
          <button
            type="button"
            aria-label={intl.formatMessage(messages.clearSearch)}
            onClick={() => {
              setQuery('');
              searchInput.current?.focus();
            }}
            className="absolute right-0 top-0 flex h-full w-11 items-center justify-center rounded-r-md text-gray-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            <XMarkIcon aria-hidden="true" className="h-5 w-5" />
          </button>
        ) : null}
      </div>
      {query.trim() || hideWatched ? (
        <p role="status" className="text-sm text-gray-400">
          {intl.formatMessage(messages.showing, {
            shown: visibleEpisodes.length,
            total: episodes.length,
          })}
        </p>
      ) : null}
      {visibleEpisodes.length ? (
        <ul
          ref={episodeList}
          className="divide-y divide-gray-700 overflow-hidden rounded-lg border border-gray-700"
        >
          {visibleEpisodes.map((episode) => {
            const watched = isWatched(episode);
            const upNext = !watched && episode.jellyfinItemId === playItemId;
            const progress = Math.max(
              0,
              Math.min(100, episode.progressPercent ?? 0)
            );
            const action = intl.formatMessage(
              progress > 0 && progress < 100 && !watched
                ? messages.resume
                : messages.play
            );
            const label = [episode.subtitle, episode.name]
              .filter(Boolean)
              .join(' · ');
            return (
              <li
                key={episode.jellyfinItemId}
                className={`flex items-center gap-2 px-3 py-3 ${upNext ? 'bg-indigo-500/10' : ''}`}
              >
                <div className="min-w-0 flex-1">
                  {upNext ? (
                    <p className="mb-1 text-xs font-medium text-indigo-300">
                      {intl.formatMessage(messages.upNext)}
                    </p>
                  ) : null}
                  <p className="text-sm font-medium text-white">
                    {episode.name}
                  </p>
                  <p className="mt-1 text-xs text-gray-400">
                    {[
                      episode.subtitle,
                      watched
                        ? intl.formatMessage(messages.watched)
                        : progress > 0
                          ? intl.formatMessage(messages.inProgress, {
                              percent: Math.round(progress),
                            })
                          : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {!watched && progress > 0 ? (
                    <div
                      className="mt-2 h-1 overflow-hidden rounded bg-gray-700"
                      aria-hidden="true"
                    >
                      <div
                        className="h-full bg-indigo-500"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  ) : null}
                </div>
                {tmdbId &&
                episode.parentIndexNumber != null &&
                episode.indexNumber != null ? (
                  <LibraryEpisodeWatchToggle
                    tmdbId={tmdbId}
                    jellyfinItemId={episode.jellyfinItemId}
                    seasonNumber={episode.parentIndexNumber}
                    episodeNumber={episode.indexNumber}
                    episodeLabel={label}
                    watched={watched}
                    episodesKey={episodesKey}
                    onLocalChange={(nextWatched) => {
                      if (nextWatched && hideWatched) {
                        const focusedRow =
                          document.activeElement?.closest('li');
                        if (focusedRow?.parentElement === episodeList.current) {
                          const adjacent =
                            focusedRow.nextElementSibling ??
                            focusedRow.previousElementSibling;
                          const nextControl = adjacent?.querySelector<
                            HTMLButtonElement | HTMLAnchorElement
                          >('button, a');
                          (nextControl ?? searchInput.current)?.focus();
                        }
                      }
                      setWatchOverrides((overrides) =>
                        new Map(overrides).set(
                          episode.jellyfinItemId,
                          nextWatched
                        )
                      );
                    }}
                  />
                ) : null}
                {episode.mediaUrl ? (
                  <Button
                    as="a"
                    href={episode.mediaUrl}
                    buttonType="primary"
                    buttonSize="sm"
                    className="min-h-11 shrink-0"
                    aria-label={intl.formatMessage(messages.playEpisode, {
                      action,
                      episode: label,
                    })}
                    onClick={(event) => onPlay(event, episode)}
                  >
                    <PlayIcon />
                    <span>{action}</span>
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="rounded-lg border border-dashed border-gray-600 px-4 py-6 text-center">
          <p className="text-sm text-gray-300" role="status">
            {intl.formatMessage(
              query.trim() ? messages.noMatches : messages.allWatched
            )}
          </p>
          <Button
            className="mt-3 min-h-11"
            onClick={() => {
              setQuery('');
              setHideWatched(false);
              searchInput.current?.focus();
            }}
          >
            {intl.formatMessage(messages.showAll)}
          </Button>
        </div>
      )}
    </div>
  );
};

export default LibraryEpisodeList;
