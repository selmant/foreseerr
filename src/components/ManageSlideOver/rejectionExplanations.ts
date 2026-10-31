import defineMessages from '@app/utils/defineMessages';
import type { IntlShape } from 'react-intl';

// Plain-language explanations of Sonarr 5's typed rejection reasons
// (`DownloadRejectionReason` for releases, `ImportRejectionReason` for
// import candidates). Reasons without one fall back to Sonarr's own text.
export const rejectionMessages = defineMessages(
  'components.ManageSlideOver.Rejections',
  {
    blocklisted: 'Blocklisted: this release failed or was rejected before.',
    multiSeasonRelease:
      "Multi-season pack: {service} won't grab it on its own or import it automatically.",
    fullSeasonNotAired: "Season pack for a season that hasn't finished airing.",
    beforeAirDate: 'Published before the episode aired, so it may be fake.',
    episodeNotMonitored: "The episode isn't monitored in {service}.",
    seriesNotMonitored: "The series isn't monitored in {service}.",
    qualityNotWanted: "The quality profile doesn't allow this quality.",
    belowMinimumSize:
      'Smaller than the quality profile allows for this runtime.',
    aboveMaximumSize:
      'Larger than the quality profile allows for this runtime.',
    maximumSizeExceeded: 'Larger than the maximum size set in {service}.',
    wrongEpisode: 'Holds a different episode than the one searched for.',
    wrongSeason: 'Belongs to a different season than the one searched for.',
    wrongSeries: 'Belongs to a different series.',
    unknownSeries: "{service} couldn't match the name to this series.",
    unknownEpisode: "{service} couldn't tell which episodes it holds.",
    matchesAnotherSeries: 'The name matches another series in {service}.',
    fullSeason: 'Season pack, while a single episode was searched for.',
    notSeasonPack:
      'Single episode of a season that ended long ago: {service} wants a season pack.',
    notUpgrade: 'Not an upgrade over the file you already have.',
    existingFileHasMoreEpisodes:
      'The file you already have holds more episodes than this release.',
    inQueue: 'A release as good or better is already in the download queue.',
    inHistory: 'A release as good or better was grabbed recently.',
    alreadyImported: 'Already grabbed and imported before.',
    minimumSeeders: 'Not enough seeders.',
    minimumAge: "Too new: the indexer's minimum age hasn't passed yet.",
    delayed: '{service} is waiting a while for a better release.',
    maximumAge: "Older than the indexer's retention.",
    customFormatMinimumScore:
      "The custom format score is below the profile's minimum.",
    mustContainMissing: 'Missing a term the release profile requires.',
    mustNotContainPresent: 'Contains a term the release profile excludes.',
    noMatchingTag: "The indexer's tags don't match this series.",
    protocolDisabled: "The delay profile doesn't allow this download protocol.",
    indexerDisabled: 'The indexer is paused after recent failures.',
    minimumFreeSpace: 'Not enough free disk space.',
    sample: 'A sample, not the full episode.',
    raw: 'A raw disc image.',
    splitEpisode: "{service} doesn't support split episode releases.",
    dangerousFile:
      "Potentially dangerous file: Foreseerr won't import it. Remove the download in your download client.",
    executableFile:
      "Executable file: Foreseerr won't import it. Remove the download in your download client.",
    multiSeasonImport:
      "From a multi-season download, which {service} won't import automatically. Pick the episodes this file holds.",
    sampleIndeterminate: "{service} couldn't tell whether this is a sample.",
    unknownEpisodes: "{service} couldn't tell which episodes this file holds.",
    episodeUnexpected:
      "The file doesn't match the episodes this download was grabbed for.",
    episodeAlreadyImported: 'This episode was already imported.',
    fileLocked: 'The file is still in use. Try again later.',
    archiveFile: 'An archive that may need extracting first.',
    noAudio: 'The file has no audio track.',
  }
);

type Explanation = keyof typeof rejectionMessages;

const releaseExplanations = new Map<string, Explanation>([
  ['blocklisted', 'blocklisted'],
  ['multiSeason', 'multiSeasonRelease'],
  ['fullSeasonNotAired', 'fullSeasonNotAired'],
  ['beforeAirDate', 'beforeAirDate'],
  ['episodeNotMonitored', 'episodeNotMonitored'],
  ['seriesNotMonitored', 'seriesNotMonitored'],
  ['qualityNotWanted', 'qualityNotWanted'],
  ['belowMinimumSize', 'belowMinimumSize'],
  ['aboveMaximumSize', 'aboveMaximumSize'],
  ['maximumSizeExceeded', 'maximumSizeExceeded'],
  ['wrongEpisode', 'wrongEpisode'],
  ['wrongSeason', 'wrongSeason'],
  ['wrongSeries', 'wrongSeries'],
  ['unknownSeries', 'unknownSeries'],
  ['unknownEpisode', 'unknownEpisode'],
  ['matchesAnotherSeries', 'matchesAnotherSeries'],
  ['fullSeason', 'fullSeason'],
  ['notSeasonPack', 'notSeasonPack'],
  ['diskCutoffMet', 'notUpgrade'],
  ['diskHigherPreference', 'notUpgrade'],
  ['diskHigherRevision', 'notUpgrade'],
  ['diskCustomFormatCutoffMet', 'notUpgrade'],
  ['diskCustomFormatScore', 'notUpgrade'],
  ['diskCustomFormatScoreIncrement', 'notUpgrade'],
  ['diskUpgradesNotAllowed', 'notUpgrade'],
  ['diskNotUpgrade', 'notUpgrade'],
  ['qualityUpgradesDisabled', 'notUpgrade'],
  ['existingFileHasMoreEpisodes', 'existingFileHasMoreEpisodes'],
  ['queueHigherPreference', 'inQueue'],
  ['queueHigherRevision', 'inQueue'],
  ['queueCutoffMet', 'inQueue'],
  ['queueCustomFormatCutoffMet', 'inQueue'],
  ['queueCustomFormatScore', 'inQueue'],
  ['queueCustomFormatScoreIncrement', 'inQueue'],
  ['queueUpgradesNotAllowed', 'inQueue'],
  ['queuePropersDisabled', 'inQueue'],
  ['historyRecentCutoffMet', 'inHistory'],
  ['historyCdhDisabledCutoffMet', 'inHistory'],
  ['historyHigherPreference', 'inHistory'],
  ['historyHigherRevision', 'inHistory'],
  ['historyCutoffMet', 'inHistory'],
  ['historyCustomFormatCutoffMet', 'inHistory'],
  ['historyCustomFormatScore', 'inHistory'],
  ['historyCustomFormatScoreIncrement', 'inHistory'],
  ['historyUpgradesNotAllowed', 'inHistory'],
  ['alreadyImportedSameHash', 'alreadyImported'],
  ['alreadyImportedSameName', 'alreadyImported'],
  ['minimumSeeders', 'minimumSeeders'],
  ['minimumAge', 'minimumAge'],
  ['minimumAgeDelay', 'delayed'],
  ['maximumAge', 'maximumAge'],
  ['customFormatMinimumScore', 'customFormatMinimumScore'],
  ['mustContainMissing', 'mustContainMissing'],
  ['mustNotContainPresent', 'mustNotContainPresent'],
  ['noMatchingTag', 'noMatchingTag'],
  ['protocolDisabled', 'protocolDisabled'],
  ['indexerDisabled', 'indexerDisabled'],
  ['minimumFreeSpace', 'minimumFreeSpace'],
  ['sample', 'sample'],
  ['raw', 'raw'],
  ['splitEpisode', 'splitEpisode'],
]);

const importExplanations = new Map<string, Explanation>([
  ['dangerousFile', 'dangerousFile'],
  ['executableFile', 'executableFile'],
  ['multiSeason', 'multiSeasonImport'],
  ['unknownSeries', 'unknownSeries'],
  ['sample', 'sample'],
  ['sampleIndeterminate', 'sampleIndeterminate'],
  ['unableToParse', 'unknownEpisodes'],
  ['invalidSeasonOrEpisode', 'unknownEpisodes'],
  ['noEpisodes', 'unknownEpisodes'],
  ['episodeUnexpected', 'episodeUnexpected'],
  ['episodeNotFoundInRelease', 'episodeUnexpected'],
  ['episodeAlreadyImported', 'episodeAlreadyImported'],
  ['notQualityUpgrade', 'notUpgrade'],
  ['notRevisionUpgrade', 'notUpgrade'],
  ['notCustomFormatUpgrade', 'notUpgrade'],
  ['notCustomFormatUpgradeAfterRename', 'notUpgrade'],
  ['existingFileHasMoreEpisodes', 'existingFileHasMoreEpisodes'],
  ['fileLocked', 'fileLocked'],
  ['archiveFile', 'archiveFile'],
  ['noAudio', 'noAudio'],
  ['minimumFreeSpace', 'minimumFreeSpace'],
  ['splitEpisode', 'splitEpisode'],
]);

/**
 * The explanation of a typed rejection, or `undefined` when there is no
 * code (Sonarr 4, Radarr) or none for it, so Sonarr's message is shown.
 */
export const explainRejection = (
  intl: IntlShape,
  kind: 'release' | 'import',
  code: string | undefined,
  service: string
): string | undefined => {
  const explanation =
    code === undefined
      ? undefined
      : (kind === 'release' ? releaseExplanations : importExplanations).get(
          code
        );
  return explanation
    ? intl.formatMessage(rejectionMessages[explanation], { service })
    : undefined;
};

/** One rejection as the UI lists it: the explanation and the Arr's text. */
export type ExplainedRejection = { text: string; detail?: string };

export const explainRejections = (
  intl: IntlShape,
  kind: 'release' | 'import',
  rejections: { message: string; code?: string }[],
  service: string
): ExplainedRejection[] =>
  rejections.map(({ message, code }) => {
    const text = explainRejection(intl, kind, code, service);
    return text && text !== message
      ? { text, detail: message }
      : { text: message };
  });
