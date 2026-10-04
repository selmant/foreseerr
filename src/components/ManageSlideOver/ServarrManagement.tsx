import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SegmentedControl from '@app/components/Common/SegmentedControl';
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
    releases: 'Find releases',
    imports: 'Import files',
    importsWaiting: 'Import files ({count})',
    workflow: '{service} tools',
    retry: 'Try again',
    description:
      'Find a download or review files waiting to be added to your library.',
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
  const [workflow, setWorkflow] = useState<'releases' | 'imports'>('releases');
  const [sourceCount, setSourceCount] = useState(0);
  const [contextAttempt, setContextAttempt] = useState(0);

  useEffect(() => {
    contextAbortRef.current?.abort();
    const controller = new AbortController();
    contextAbortRef.current = controller;
    setLoadingContext(true);
    setContext(undefined);
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
  }, [contextAttempt, intl, is4k, mediaId]);

  if (loadingContext) return <LoadingSpinner />;
  if (!context)
    return (
      <Alert type="error" title={contextError}>
        <Button
          className="min-h-11"
          onClick={() => setContextAttempt((value) => value + 1)}
        >
          {intl.formatMessage(messages.retry)}
        </Button>
      </Alert>
    );

  return (
    <div className="overflow-hidden rounded-md border border-gray-700 shadow">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-700 bg-gray-800 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="break-words font-semibold text-white">
            {context.service.name}
          </span>
          {is4k && <Badge badgeType="warning">4K</Badge>}
        </div>
        {showNativeLink && context.nativeUrl && (
          <Button
            as="a"
            buttonSize="sm"
            buttonType="ghost"
            className="min-h-11"
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
        <SegmentedControl<'releases' | 'imports'>
          wrapLabels
          ariaLabel={intl.formatMessage(messages.workflow, {
            service: context.service.name,
          })}
          value={workflow}
          onChange={setWorkflow}
          options={[
            { value: 'releases', label: intl.formatMessage(messages.releases) },
            {
              value: 'imports',
              label: intl.formatMessage(
                sourceCount ? messages.importsWaiting : messages.imports,
                { count: sourceCount }
              ),
            },
          ]}
        />
        <div hidden={workflow !== 'releases'}>
          <ReleaseSearch
            context={context}
            is4k={is4k}
            mediaId={mediaId}
            onChanged={onChanged}
            onGrabbed={() => setManualImportRefreshToken((token) => token + 1)}
          />
        </div>
        <div hidden={workflow !== 'imports'}>
          <ManualImport
            context={context}
            is4k={is4k}
            mediaId={mediaId}
            onChanged={onChanged}
            refreshToken={manualImportRefreshToken}
            onSourceCountChanged={setSourceCount}
          />
        </div>
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
  headingId,
}: {
  mediaId: number;
  hasStandardMapping: boolean;
  has4kMapping: boolean;
  mediaType: 'movie' | 'tv';
  onChanged: () => void;
  /** False when the Media section below already links to the same server. */
  showStandardLink?: boolean;
  show4kLink?: boolean;
  headingId?: string;
}) => {
  const intl = useIntl();
  return (
    <div>
      <h3
        id={headingId}
        tabIndex={-1}
        className="mb-2 text-xl font-bold focus:outline-none"
      >
        {intl.formatMessage(
          mediaType === 'movie'
            ? messages.radarrManagement
            : messages.sonarrManagement
        )}
      </h3>
      <p className="mb-3 text-sm text-gray-400">
        {intl.formatMessage(messages.description)}
      </p>
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
