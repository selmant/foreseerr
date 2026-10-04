import Button from '@app/components/Common/Button';
import defineMessages from '@app/utils/defineMessages';
import { useId, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import type { Episode } from './servarrTypes';

const messages = defineMessages(
  'components.ManageSlideOver.EpisodeAssignmentPicker',
  {
    season: 'Season',
    allSeasons: 'All seasons',
    seasonNumber: 'Season {number}',
    search: 'Find an episode',
    placeholder: 'Episode name or number',
    selected:
      '{count, plural, one {# episode assigned} other {# episodes assigned}}',
    noMatches: 'No episodes match these filters.',
    clearFilters: 'Clear episode filters',
  }
);

const EpisodeAssignmentPicker = ({
  episodes,
  assigned,
  onChange,
  disabled,
}: {
  episodes: Episode[];
  assigned: number[];
  onChange: (ids: number[]) => void;
  disabled: boolean;
}) => {
  const intl = useIntl();
  const inputId = useId();
  const [season, setSeason] = useState('all');
  const [query, setQuery] = useState('');
  const sorted = useMemo(
    () =>
      [...episodes].sort(
        (a, b) =>
          a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber
      ),
    [episodes]
  );
  const seasons = [...new Set(sorted.map((episode) => episode.seasonNumber))];
  const results = sorted.filter((episode) => {
    const number = `S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')}`;
    return (
      (season === 'all' || String(episode.seasonNumber) === season) &&
      `${number} ${episode.episodeNumber} ${episode.title}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase())
    );
  });

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor={`${inputId}-season`}>
            {intl.formatMessage(messages.season)}
          </label>
          <select
            id={`${inputId}-season`}
            className="min-h-11 w-full"
            value={season}
            onChange={(event) => setSeason(event.target.value)}
            disabled={disabled}
          >
            <option value="all">
              {intl.formatMessage(messages.allSeasons)}
            </option>
            {seasons.map((number) => (
              <option key={number} value={number}>
                {intl.formatMessage(messages.seasonNumber, { number })}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${inputId}-query`}>
            {intl.formatMessage(messages.search)}
          </label>
          <input
            id={`${inputId}-query`}
            type="search"
            className="min-h-11 w-full"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            disabled={disabled}
            placeholder={intl.formatMessage(messages.placeholder)}
          />
        </div>
      </div>
      <p role="status" className="text-xs text-gray-400">
        {intl.formatMessage(messages.selected, { count: assigned.length })}
      </p>
      {(query || season !== 'all') && (
        <Button
          className="min-h-11 w-full"
          onClick={() => {
            setQuery('');
            setSeason('all');
          }}
          disabled={disabled}
        >
          {intl.formatMessage(messages.clearFilters)}
        </Button>
      )}
      {!results.length && (
        <p className="text-sm text-gray-400">
          {intl.formatMessage(messages.noMatches)}
        </p>
      )}
      <div className="max-h-52 space-y-1 overflow-y-auto">
        {results.map((episode) => (
          <label
            key={episode.id}
            className="mb-0 flex min-h-11 cursor-pointer items-center gap-2 font-normal text-gray-300"
          >
            <input
              type="checkbox"
              className="flex-none"
              disabled={disabled}
              checked={assigned.includes(episode.id)}
              onChange={() =>
                onChange(
                  assigned.includes(episode.id)
                    ? assigned.filter((id) => id !== episode.id)
                    : [...assigned, episode.id]
                )
              }
            />
            <span className="min-w-0 break-words">
              S{String(episode.seasonNumber).padStart(2, '0')}E
              {String(episode.episodeNumber).padStart(2, '0')} — {episode.title}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
};

export default EpisodeAssignmentPicker;
