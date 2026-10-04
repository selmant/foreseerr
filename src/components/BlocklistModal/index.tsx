import Modal from '@app/components/Common/Modal';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';

import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LinkButton from '@app/components/Common/LinkButton';
import type { Collection } from '@server/models/Collection';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

interface BlocklistModalProps {
  tmdbId: number;
  type: 'movie' | 'tv' | 'collection';
  show: boolean;
  onComplete?: () => void;
  onCancel?: () => void;
  isUpdating?: boolean;
}

const messages = defineMessages('component.BlocklistModal', {
  blocklisting: 'Blocklisting',
  effect:
    'This title cannot be requested while it is blocklisted. Remove it from Blocklist to allow requests again.',
  collectionEffect:
    'Movies in this collection cannot be requested while they are blocklisted. Remove them from Blocklist to allow requests again.',
  filesUnchanged: 'Existing media files stay on your server.',
  viewBlocklist: 'View Blocklist',
  loadError: 'Could not load the title details. Try again before blocklisting.',
  retry: 'Try again',
});

const isCollection = (
  data: MovieDetails | TvDetails | Collection | null
): data is Collection => {
  return (
    data !== null &&
    data !== undefined &&
    (data as Collection).parts !== undefined
  );
};

const isMovie = (
  movie: MovieDetails | TvDetails | Collection | null
): movie is MovieDetails => {
  if (!movie) return false;
  return (movie as MovieDetails).title !== undefined;
};

const BlocklistModal = ({
  tmdbId,
  type,
  show,
  onComplete,
  onCancel,
  isUpdating,
}: BlocklistModalProps) => {
  const intl = useIntl();
  const [data, setData] = useState<
    TvDetails | MovieDetails | Collection | null
  >(null);
  const [error, setError] = useState<unknown>();
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    if (!show) return;
    const controller = new AbortController();
    setData(null);
    setError(undefined);
    (async () => {
      try {
        const response = await axios.get(`/api/v1/${type}/${tmdbId}`, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setData(response.data);
      } catch (err) {
        if (!controller.signal.aborted) setError(err);
      }
    })();
    return () => controller.abort();
  }, [loadAttempt, show, tmdbId, type]);

  return (
    <Transition
      as="div"
      enter="transition-opacity duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
      show={show}
    >
      <Modal
        stickyActions
        initialFocus="cancel"
        loading={!data && !error}
        backgroundClickable={!isUpdating}
        title={`${intl.formatMessage(globalMessages.blocklist)} ${
          type === 'collection'
            ? intl.formatMessage(globalMessages.collection)
            : type === 'movie'
              ? intl.formatMessage(globalMessages.movie)
              : intl.formatMessage(globalMessages.tvshow)
        }`}
        subTitle={
          isCollection(data)
            ? data.name
            : isMovie(data)
              ? data.title
              : data?.name
        }
        onCancel={onCancel}
        onOk={onComplete}
        okText={
          isUpdating
            ? intl.formatMessage(messages.blocklisting)
            : intl.formatMessage(globalMessages.blocklist)
        }
        okButtonType="danger"
        okDisabled={isUpdating || !data || Boolean(error)}
        cancelButtonProps={{ disabled: isUpdating }}
        backdrop={
          data?.backdropPath
            ? `https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${data.backdropPath}`
            : undefined
        }
      >
        {error ? (
          <div className="space-y-3">
            <Alert
              type="error"
              title={intl.formatMessage(messages.loadError)}
            />
            <Button
              type="button"
              className="min-h-[44px]"
              onClick={() => setLoadAttempt((attempt) => attempt + 1)}
            >
              {intl.formatMessage(messages.retry)}
            </Button>
          </div>
        ) : (
          <div className="space-y-3 text-sm leading-6 text-gray-300">
            <p>
              {intl.formatMessage(
                type === 'collection'
                  ? messages.collectionEffect
                  : messages.effect
              )}
            </p>
            <p className="text-gray-400">
              {intl.formatMessage(messages.filesUnchanged)}
            </p>
            <LinkButton
              to="/blocklist"
              buttonType="ghost"
              className="min-h-[44px]"
            >
              {intl.formatMessage(messages.viewBlocklist)}
            </LinkButton>
          </div>
        )}
      </Modal>
    </Transition>
  );
};

export default BlocklistModal;
