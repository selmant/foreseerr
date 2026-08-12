import Button from '@app/components/Common/Button';
import { useMediaActionCapabilities } from '@app/hooks/useMediaActions';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import {
  invalidateMediaActionCaches,
  mediaActionSeasonStatusKey,
} from '@app/utils/mediaActionInvalidation';
import {
  writeSucceeded,
  type MediaActionWriteResponse,
} from '@app/utils/mediaActions';
import { CheckBadgeIcon as CheckBadgeOutline } from '@heroicons/react/24/outline';
import { CheckBadgeIcon as CheckBadgeSolid } from '@heroicons/react/24/solid';
import axios from 'axios';
import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import { mutate as globalMutate } from 'swr';

const messages = defineMessages(
  'components.Library.LibraryEpisodeWatchToggle',
  {
    markWatched: 'Mark episode watched',
    markUnwatched: 'Mark episode unwatched',
    watched: 'Watched',
    notWatched: 'Not watched',
    actionFailed: 'Could not update episode watch status.',
    actionPartial:
      'Updated on one provider, but another provider could not be synchronized.',
  }
);

interface LibraryEpisodeWatchToggleProps {
  tmdbId: number;
  jellyfinItemId: string;
  seasonNumber: number;
  episodeNumber: number;
  watched: boolean;
  episodesKey: string;
  onLocalChange?: (watched: boolean) => void;
}

const LibraryEpisodeWatchToggle = ({
  tmdbId,
  jellyfinItemId,
  seasonNumber,
  episodeNumber,
  watched,
  episodesKey,
  onLocalChange,
}: LibraryEpisodeWatchToggleProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data: capabilities } = useMediaActionCapabilities();
  const [busy, setBusy] = useState(false);
  const [localWatched, setLocalWatched] = useState(watched);

  useEffect(() => {
    setLocalWatched(watched);
  }, [watched]);

  const toggle = useCallback(async () => {
    if (!capabilities?.episode.watched || busy) {
      return;
    }
    const nextWatched = !localWatched;
    const previous = localWatched;
    setLocalWatched(nextWatched);
    onLocalChange?.(nextWatched);
    setBusy(true);
    try {
      const action = nextWatched ? 'watched' : 'unwatched';
      const response = await axios.post<MediaActionWriteResponse>(
        `/api/v1/media-actions/tv/${tmdbId}/seasons/${seasonNumber}/episodes/${episodeNumber}/${action}`,
        { jellyfinItemId }
      );
      if (!writeSucceeded(response.data)) {
        throw new Error('Episode watch update failed');
      }
      if (response.data.outcome === 'partial') {
        addToast(intl.formatMessage(messages.actionPartial), {
          appearance: 'warning',
          autoDismiss: true,
        });
      }
      await globalMutate(episodesKey);
      await invalidateMediaActionCaches({
        mediaType: 'tv',
        tmdbId,
        tvId: tmdbId,
        seasonNumber,
      });
      await globalMutate(mediaActionSeasonStatusKey(tmdbId, seasonNumber));
    } catch {
      setLocalWatched(previous);
      onLocalChange?.(previous);
      addToast(intl.formatMessage(messages.actionFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setBusy(false);
    }
  }, [
    addToast,
    busy,
    capabilities?.episode.watched,
    episodeNumber,
    episodesKey,
    intl,
    jellyfinItemId,
    localWatched,
    onLocalChange,
    seasonNumber,
    tmdbId,
  ]);

  if (!capabilities?.episode.watched) {
    return null;
  }

  return (
    <Button
      buttonType="ghost"
      buttonSize="sm"
      disabled={busy}
      aria-pressed={localWatched}
      aria-label={
        localWatched
          ? intl.formatMessage(messages.markUnwatched)
          : intl.formatMessage(messages.markWatched)
      }
      onClick={toggle}
    >
      {localWatched ? (
        <CheckBadgeSolid className="h-4 w-4 text-emerald-400" />
      ) : (
        <CheckBadgeOutline className="h-4 w-4" />
      )}
      <span className="sr-only">
        {intl.formatMessage(
          localWatched ? messages.watched : messages.notWatched
        )}
      </span>
    </Button>
  );
};

export default LibraryEpisodeWatchToggle;
