import Badge from '@app/components/Common/Badge';
import defineMessages from '@app/utils/defineMessages';
import { ChevronDownIcon } from '@heroicons/react/24/solid';
import { type MessageDescriptor, useIntl } from 'react-intl';

import {
  type Episode,
  type EpisodeTracks,
  type ServarrContext,
} from './servarrTypes';

const messages = defineMessages('components.ManageSlideOver.SeriesFiles', {
  title: 'Files in Sonarr',
  season: 'Season {seasonNumber}',
  specials: 'Specials',
  fileCount: '{files} of {total} episodes',
  stalledCount: '{count, plural, one {# grab stuck} other {# grabs stuck}}',
  audio: 'Audio: {languages}',
  subtitles: 'Subtitles: {languages}',
  noSubtitles: 'No subtitles',
  unknownLanguage: 'Unknown',
  grabStalled: 'Grabbed {time}, not downloaded',
  downloading: 'Downloading',
  queued: 'Queued',
  importing: 'Importing',
  manualImport: 'Waiting for import',
  downloaded: 'Downloaded',
  missing: 'Missing',
  unmonitored: 'Not monitored',
  singleEpisode: 'Single episodes',
  multiEpisode: 'Multi-episode files',
  seasonPack: 'Season pack',
  multiSeasonPack: 'Multi-season pack',
});

const releaseTypeMessages: Record<string, MessageDescriptor | undefined> = {
  singleEpisode: messages.singleEpisode,
  multiEpisode: messages.multiEpisode,
  seasonPack: messages.seasonPack,
  multiSeasonPack: messages.multiSeasonPack,
};

const HOUR = 60 * 60 * 1000;

const SeriesFiles = ({ context }: { context: ServarrContext }) => {
  const intl = useIntl();
  const seasons = (context.seasons ?? []).filter(
    (season) => season.episodes.length > 0
  );
  if (seasons.length === 0) return null;

  const languageList = (codes: string[]) =>
    codes
      .map((code) =>
        code === 'und'
          ? intl.formatMessage(messages.unknownLanguage)
          : code.toUpperCase()
      )
      .join(', ');

  const grabbedAgo = (date: string) => {
    const hours = Math.round((new Date(date).getTime() - Date.now()) / HOUR);
    return hours > -48
      ? intl.formatRelativeTime(hours, 'hour', { numeric: 'auto' })
      : intl.formatRelativeTime(Math.round(hours / 24), 'day', {
          numeric: 'auto',
        });
  };

  const status = (episode: Episode) => {
    if (episode.grabStalled && episode.grabDate)
      return (
        <Badge badgeType="warning">
          {intl.formatMessage(messages.grabStalled, {
            time: grabbedAgo(episode.grabDate),
          })}
        </Badge>
      );
    switch (episode.queueStatus) {
      case 'downloading':
        return (
          <Badge badgeType="primary">
            {intl.formatMessage(messages.downloading)}
          </Badge>
        );
      case 'queued':
        return <Badge>{intl.formatMessage(messages.queued)}</Badge>;
      case 'importing':
        return (
          <Badge badgeType="primary">
            {intl.formatMessage(messages.importing)}
          </Badge>
        );
      case 'manual-import':
        return (
          <Badge badgeType="warning">
            {intl.formatMessage(messages.manualImport)}
          </Badge>
        );
      default:
        break;
    }
    if (episode.hasFile)
      return (
        <Badge badgeType="success">
          {intl.formatMessage(messages.downloaded)}
        </Badge>
      );
    return episode.monitored ? (
      <Badge badgeType="danger">{intl.formatMessage(messages.missing)}</Badge>
    ) : (
      <Badge badgeType="dark">{intl.formatMessage(messages.unmonitored)}</Badge>
    );
  };

  const tracks = (value: EpisodeTracks) => (
    <span className="text-xs text-gray-400">
      {value.audioLanguages.length > 0 &&
        intl.formatMessage(messages.audio, {
          languages: languageList(value.audioLanguages),
        })}
      {value.audioLanguages.length > 0 && ' · '}
      {value.subtitleLanguages.length > 0
        ? intl.formatMessage(messages.subtitles, {
            languages: languageList(value.subtitleLanguages),
          })
        : intl.formatMessage(messages.noSubtitles)}
    </span>
  );

  return (
    <div>
      <h4 className="mb-2 text-sm font-semibold text-gray-200">
        {intl.formatMessage(messages.title)}
      </h4>
      <div className="divide-y divide-gray-700 overflow-hidden rounded-md border border-gray-700">
        {seasons.map((season) => {
          const files = season.episodes.filter((e) => e.hasFile).length;
          const stalled = season.episodes.filter((e) => e.grabStalled).length;
          const releaseTypes = (season.releaseTypes ?? []).flatMap((type) => {
            const message = releaseTypeMessages[type];
            return message ? [intl.formatMessage(message)] : [];
          });
          return (
            <details key={season.seasonNumber} className="group">
              <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-2 bg-gray-800 px-3 py-2 text-sm">
                <ChevronDownIcon className="h-4 w-4 shrink-0 transition group-open:rotate-180" />
                <span className="font-medium text-white">
                  {season.seasonNumber === 0
                    ? intl.formatMessage(messages.specials)
                    : intl.formatMessage(messages.season, {
                        seasonNumber: season.seasonNumber,
                      })}
                </span>
                <span className="text-gray-400">
                  {intl.formatMessage(messages.fileCount, {
                    files,
                    total: season.episodes.length,
                  })}
                </span>
                {season.fileQualities?.map((quality) => (
                  <Badge key={quality} badgeType="light">
                    {quality}
                  </Badge>
                ))}
                {releaseTypes.length > 0 && (
                  <span className="text-xs text-gray-400">
                    {releaseTypes.join(', ')}
                  </span>
                )}
                {stalled > 0 && (
                  <Badge badgeType="warning">
                    {intl.formatMessage(messages.stalledCount, {
                      count: stalled,
                    })}
                  </Badge>
                )}
              </summary>
              <ul className="divide-y divide-gray-800">
                {season.episodes.map((episode) => (
                  <li
                    key={episode.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 break-words text-gray-200">
                      {`E${String(episode.episodeNumber).padStart(2, '0')} — ${episode.title}`}
                    </span>
                    {episode.hasFile &&
                      episode.tracks &&
                      tracks(episode.tracks)}
                    {status(episode)}
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
      </div>
    </div>
  );
};

export default SeriesFiles;
