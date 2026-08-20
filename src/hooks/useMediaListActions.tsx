import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import type { MediaType } from '@server/constants/media';
import axios from 'axios';
import { useCallback, useState, type ReactNode } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('hooks.useMediaListActions', {
  watchlistSuccess: '<strong>{title}</strong> added to watchlist successfully!',
  watchlistDeleted:
    '<strong>{title}</strong> Removed from watchlist successfully!',
  watchlistError: 'Something went wrong. Please try again.',
});

interface UseMediaListActionsOptions {
  tmdbId?: number;
  mediaType: MediaType.MOVIE | MediaType.TV;
  title?: string;
  userId?: number;
  onRevalidate: () => void;
  onBlocklistComplete: () => void;
  initialOnWatchlist?: boolean;
}

const richTitle = (title: string | undefined, content: ReactNode) => (
  <span>
    {content}
    {title ? null : null}
  </span>
);

/** Shared watchlist/blocklist mutations used by movie and TV detail pages. */
const useMediaListActions = ({
  tmdbId,
  mediaType,
  title,
  userId,
  onRevalidate,
  onBlocklistComplete,
  initialOnWatchlist = false,
}: UseMediaListActionsOptions) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isOnWatchlist, setIsOnWatchlist] = useState(initialOnWatchlist);
  const [isWatchlistUpdating, setIsWatchlistUpdating] = useState(false);
  const [isBlocklistUpdating, setIsBlocklistUpdating] = useState(false);

  const formatWatchlistTitle = useCallback(
    (
      message:
        | typeof messages.watchlistSuccess
        | typeof messages.watchlistDeleted
    ) =>
      richTitle(
        title,
        intl.formatMessage(message, {
          title,
          strong: (content: ReactNode) => <strong>{content}</strong>,
        })
      ),
    [intl, title]
  );

  const addToWatchlist = useCallback(async () => {
    setIsWatchlistUpdating(true);
    try {
      await axios.post('/api/v1/watchlist', {
        tmdbId,
        mediaType,
        title,
      });
      addToast(formatWatchlistTitle(messages.watchlistSuccess), {
        appearance: 'success',
        autoDismiss: true,
      });
      setIsOnWatchlist(true);
    } catch {
      addToast(intl.formatMessage(messages.watchlistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsWatchlistUpdating(false);
    }
  }, [addToast, formatWatchlistTitle, intl, mediaType, title, tmdbId]);

  const removeFromWatchlist = useCallback(async () => {
    setIsWatchlistUpdating(true);
    try {
      await axios.delete(`/api/v1/watchlist/${tmdbId}?mediaType=${mediaType}`);
      addToast(formatWatchlistTitle(messages.watchlistDeleted), {
        appearance: 'info',
        autoDismiss: true,
      });
      setIsOnWatchlist(false);
    } catch {
      addToast(intl.formatMessage(messages.watchlistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsWatchlistUpdating(false);
    }
  }, [addToast, formatWatchlistTitle, intl, mediaType, tmdbId]);

  const addToBlocklist = useCallback(async () => {
    setIsBlocklistUpdating(true);
    try {
      const response = await axios.post('/api/v1/blocklist', {
        tmdbId,
        mediaType,
        title,
        user: userId,
      });

      if (response.status === 201 || response.data) {
        addToast(
          <span>
            {intl.formatMessage(globalMessages.blocklistSuccess, {
              title,
              strong: (content: ReactNode) => <strong>{content}</strong>,
            })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );
        onRevalidate();
      }
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 412) {
        addToast(
          <span>
            {intl.formatMessage(globalMessages.blocklistDuplicateError, {
              title,
              strong: (content: ReactNode) => <strong>{content}</strong>,
            })}
          </span>,
          { appearance: 'info', autoDismiss: true }
        );
      } else {
        addToast(intl.formatMessage(globalMessages.blocklistError), {
          appearance: 'error',
          autoDismiss: true,
        });
      }
    } finally {
      setIsBlocklistUpdating(false);
      onBlocklistComplete();
    }
  }, [
    addToast,
    intl,
    mediaType,
    onBlocklistComplete,
    onRevalidate,
    title,
    tmdbId,
    userId,
  ]);

  return {
    addToBlocklist,
    addToWatchlist,
    isBlocklistUpdating,
    isOnWatchlist,
    isWatchlistUpdating,
    removeFromWatchlist,
  };
};

export default useMediaListActions;
