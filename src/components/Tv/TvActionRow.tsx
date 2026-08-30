import type { PlayButtonLink } from '@app/components/Common/PlayButton';
import TvFocusable from '@app/components/Tv/TvFocusable';
import TvPlayPicker from '@app/components/Tv/TvPlayPicker';
import TvRatingPanel from '@app/components/Tv/TvRatingPanel';
import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import { useMediaActions } from '@app/hooks/useMediaActions';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import {
  quickRequestMovie,
  quickRequestTvSeasons,
} from '@app/utils/quickRequest';
import { MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import { useCallback, useState } from 'react';
import { useIntl } from 'react-intl';
import { useNavigate } from 'react-router';

const messages = defineMessages('components.Tv.TvActionRow', {
  play: 'Play',
  request: 'Request',
  requested: 'Requested',
  markWatched: 'Mark watched',
  markUnwatched: 'Mark unwatched',
  rate: 'Rate',
  back: 'Back',
  actionFailed: 'Could not update. Try again.',
  actionPartial:
    'Updated on one provider, but another provider could not be synchronized.',
  requestSuccess: 'Requested.',
  requestFailed: 'Could not request.',
});

interface TvActionRowProps {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  playLinks: PlayButtonLink[];
  media?: Media;
  tvdbId?: number;
  onUpdate?: () => void;
}

const TvActionRow = ({
  tmdbId,
  mediaType,
  playLinks,
  media,
  tvdbId,
  onUpdate,
}: TvActionRowProps) => {
  const intl = useIntl();
  const navigate = useNavigate();
  const { play } = useNativeRuntime();
  const { addToast } = useToasts();
  const { hasPermission } = useUser();
  const [playOpen, setPlayOpen] = useState(false);
  const [rateOpen, setRateOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);

  const {
    actionsEnabled,
    canWatch,
    canRate,
    data,
    busy,
    statusPending,
    toggleWatched,
    submitRating,
  } = useMediaActions({
    tmdbId,
    mediaType,
    enabled: true,
  });

  const notifyFailure = useCallback(() => {
    addToast(intl.formatMessage(messages.actionFailed), {
      appearance: 'error',
      autoDismiss: true,
    });
  }, [addToast, intl]);

  const notifyPartial = useCallback(() => {
    addToast(intl.formatMessage(messages.actionPartial), {
      appearance: 'warning',
      autoDismiss: true,
    });
  }, [addToast, intl]);

  const activatePlay = (link: PlayButtonLink) => {
    if (
      link.native &&
      play({
        ...link.native,
        fallbackUrl: link.url,
        label: link.text,
      })
    ) {
      return;
    }
    window.open(link.url, '_blank', 'noopener,noreferrer');
  };

  const onPlay = () => {
    if (playLinks.length === 1) {
      activatePlay(playLinks[0]);
      return;
    }
    if (playLinks.length > 1) {
      setPlayOpen(true);
    }
  };

  const onWatched = async () => {
    const outcome = await toggleWatched();
    if (!outcome) {
      notifyFailure();
    } else if (outcome === 'partial') {
      notifyPartial();
    }
  };

  const onRate = async (ratingStars: number) => {
    const outcome = await submitRating(ratingStars);
    setRateOpen(false);
    if (!outcome) {
      notifyFailure();
    } else if (outcome === 'partial') {
      notifyPartial();
    }
  };

  const canRequest =
    hasPermission(Permission.REQUEST) &&
    media?.status !== MediaStatus.AVAILABLE &&
    media?.status !== MediaStatus.PENDING &&
    media?.status !== MediaStatus.PROCESSING;

  const onRequest = async () => {
    if (requesting) {
      return;
    }
    setRequesting(true);
    try {
      if (mediaType === 'movie') {
        await quickRequestMovie({ tmdbId });
      } else {
        await quickRequestTvSeasons({
          tmdbId,
          seasons: 'all',
          tvdbId,
        });
      }
      addToast(intl.formatMessage(messages.requestSuccess), {
        appearance: 'success',
        autoDismiss: true,
      });
      onUpdate?.();
    } catch {
      addToast(intl.formatMessage(messages.requestFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setRequesting(false);
    }
  };

  const watched = Boolean(data?.watched);
  const buttonClass =
    'tv-focus-target min-h-14 min-w-[8rem] rounded-lg bg-gray-800 px-5 text-lg font-medium text-white';

  return (
    <>
      <div className="mb-6 flex flex-wrap gap-3">
        {playLinks.length > 0 ? (
          <TvFocusable onEnterPress={onPlay}>
            <button type="button" className={buttonClass} onClick={onPlay}>
              {intl.formatMessage(messages.play)}
            </button>
          </TvFocusable>
        ) : null}
        {canRequest ? (
          <TvFocusable onEnterPress={() => void onRequest()}>
            <button
              type="button"
              className={buttonClass}
              disabled={requesting}
              onClick={() => void onRequest()}
            >
              {intl.formatMessage(messages.request)}
            </button>
          </TvFocusable>
        ) : media?.status === MediaStatus.PENDING ? (
          <span className="flex min-h-14 items-center px-2 text-gray-400">
            {intl.formatMessage(messages.requested)}
          </span>
        ) : null}
        {actionsEnabled && canWatch ? (
          <TvFocusable onEnterPress={() => void onWatched()}>
            <button
              type="button"
              className={buttonClass}
              disabled={busy || statusPending}
              onClick={() => void onWatched()}
            >
              {intl.formatMessage(
                watched ? messages.markUnwatched : messages.markWatched
              )}
            </button>
          </TvFocusable>
        ) : null}
        {actionsEnabled && canRate ? (
          <TvFocusable onEnterPress={() => setRateOpen(true)}>
            <button
              type="button"
              className={buttonClass}
              onClick={() => setRateOpen(true)}
            >
              {intl.formatMessage(messages.rate)}
            </button>
          </TvFocusable>
        ) : null}
        <TvFocusable onEnterPress={() => navigate(-1)}>
          <button
            type="button"
            className={buttonClass}
            onClick={() => navigate(-1)}
          >
            {intl.formatMessage(messages.back)}
          </button>
        </TvFocusable>
      </div>
      {playOpen ? (
        <TvPlayPicker links={playLinks} onClose={() => setPlayOpen(false)} />
      ) : null}
      {rateOpen ? (
        <TvRatingPanel
          ratingStars={data?.ratingStars ?? null}
          busy={busy}
          onSave={onRate}
          onClose={() => setRateOpen(false)}
        />
      ) : null}
    </>
  );
};

export default TvActionRow;
