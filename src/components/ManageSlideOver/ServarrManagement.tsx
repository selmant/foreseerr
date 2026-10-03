import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import defineMessages from '@app/utils/defineMessages';
import { ServerIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

import ManualImport from './ManualImport';
import ReleaseSearch from './ReleaseSearch';
import { type ServarrContext } from './servarrTypes';

const messages = defineMessages(
  'components.ManageSlideOver.ServarrManagement',
  {
    radarrManagement: 'Radarr Management',
    sonarrManagement: 'Sonarr Management',
    connectionFailed: 'Unable to connect to the mapped Servarr service.',
    openIn: 'Open in {service}',
  }
);

const ServarrPanel = ({
  mediaId,
  is4k,
  onChanged,
  showNativeLink,
}: {
  mediaId: number;
  is4k: boolean;
  onChanged: () => void;
  showNativeLink: boolean;
}) => {
  const intl = useIntl();
  const contextAbortRef = useRef<AbortController | undefined>(undefined);
  const [context, setContext] = useState<ServarrContext>();
  const [contextError, setContextError] = useState<string>();
  const [loadingContext, setLoadingContext] = useState(true);
  const [manualImportRefreshToken, setManualImportRefreshToken] = useState(0);

  useEffect(() => {
    contextAbortRef.current?.abort();
    const controller = new AbortController();
    contextAbortRef.current = controller;
    setLoadingContext(true);
    setContextError(undefined);
    axios
      .get<ServarrContext>(
        `/api/v1/media/${mediaId}/servarr/context?is4k=${is4k}`,
        { signal: controller.signal }
      )
      .then((response) => {
        if (!controller.signal.aborted) setContext(response.data);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setContextError(
            axios.isAxiosError(error)
              ? (error.response?.data?.message ??
                  intl.formatMessage(messages.connectionFailed))
              : intl.formatMessage(messages.connectionFailed)
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingContext(false);
      });
    return () => controller.abort();
  }, [intl, is4k, mediaId]);

  if (loadingContext) return <LoadingSpinner />;
  if (!context) return <Alert type="error" title={contextError} />;

  return (
    <div className="overflow-hidden rounded-md border border-gray-700 shadow">
      <div className="flex items-center justify-between gap-3 border-b border-gray-700 bg-gray-800 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-semibold text-white">
            {context.service.name}
          </span>
          {is4k && <Badge badgeType="warning">4K</Badge>}
        </div>
        {showNativeLink && context.nativeUrl && (
          <Button
            as="a"
            buttonSize="sm"
            buttonType="ghost"
            href={context.nativeUrl}
            rel="noreferrer"
            target="_blank"
          >
            <ServerIcon />
            <span>
              {intl.formatMessage(messages.openIn, {
                service:
                  context.service.type === 'sonarr' ? 'Sonarr' : 'Radarr',
              })}
            </span>
          </Button>
        )}
      </div>
      <div className="space-y-4 p-4">
        <ReleaseSearch
          context={context}
          is4k={is4k}
          mediaId={mediaId}
          onChanged={onChanged}
          onGrabbed={() => setManualImportRefreshToken((token) => token + 1)}
        />
        <ManualImport
          context={context}
          is4k={is4k}
          mediaId={mediaId}
          onChanged={onChanged}
          refreshToken={manualImportRefreshToken}
        />
      </div>
    </div>
  );
};

const ServarrManagement = ({
  mediaId,
  hasStandardMapping,
  has4kMapping,
  mediaType,
  onChanged,
  showStandardLink = true,
  show4kLink = true,
}: {
  mediaId: number;
  hasStandardMapping: boolean;
  has4kMapping: boolean;
  mediaType: 'movie' | 'tv';
  onChanged: () => void;
  /** False when the Media section below already links to the same server. */
  showStandardLink?: boolean;
  show4kLink?: boolean;
}) => {
  const intl = useIntl();
  return (
    <div>
      <h3 className="mb-2 text-xl font-bold">
        {intl.formatMessage(
          mediaType === 'movie'
            ? messages.radarrManagement
            : messages.sonarrManagement
        )}
      </h3>
      <div className="space-y-4">
        {hasStandardMapping && (
          <ServarrPanel
            is4k={false}
            mediaId={mediaId}
            onChanged={onChanged}
            showNativeLink={showStandardLink}
          />
        )}
        {has4kMapping && (
          <ServarrPanel
            is4k
            mediaId={mediaId}
            onChanged={onChanged}
            showNativeLink={show4kLink}
          />
        )}
      </div>
    </div>
  );
};

export default ServarrManagement;
