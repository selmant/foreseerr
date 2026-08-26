import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import axios from 'axios';
import { useEffect, useRef, useState } from 'react';

import ManualImport from './ManualImport';
import ReleaseSearch from './ReleaseSearch';
import { type ServarrContext } from './servarrTypes';

const ServarrPanel = ({
  mediaId,
  is4k,
  label,
  onChanged,
  interventionId,
}: {
  mediaId: number;
  is4k: boolean;
  label: string;
  onChanged: () => void;
  interventionId?: number;
}) => {
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
                  'Unable to connect to the mapped Servarr service.')
              : 'Unable to connect to the mapped Servarr service.'
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingContext(false);
      });
    return () => controller.abort();
  }, [is4k, mediaId]);

  if (loadingContext) return <LoadingSpinner />;
  if (!context)
    return <div className="text-sm text-red-300">{contextError}</div>;

  return (
    <div className="space-y-3 rounded-md border border-gray-700 p-3">
      <div className="font-semibold text-white">
        {label} ({context.service.name})
      </div>
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
        interventionId={interventionId}
      />
      {context.nativeUrl && (
        <a
          className="text-primary-400 hover:text-primary-300 text-sm"
          href={context.nativeUrl}
          rel="noreferrer"
          target="_blank"
        >
          Open in {context.service.type === 'sonarr' ? 'Sonarr' : 'Radarr'}
        </a>
      )}
    </div>
  );
};

const ServarrManagement = ({
  mediaId,
  hasStandardMapping,
  has4kMapping,
  mediaType,
  onChanged,
}: {
  mediaId: number;
  hasStandardMapping: boolean;
  has4kMapping: boolean;
  mediaType: 'movie' | 'tv';
  onChanged: () => void;
}) => (
  <div className="space-y-3">
    <h3 className="text-xl font-bold">
      {mediaType === 'movie' ? 'Radarr Management' : 'Sonarr Management'}
    </h3>
    {hasStandardMapping && (
      <ServarrPanel
        is4k={false}
        label="Standard"
        mediaId={mediaId}
        onChanged={onChanged}
      />
    )}
    {has4kMapping && (
      <ServarrPanel is4k label="4K" mediaId={mediaId} onChanged={onChanged} />
    )}
  </div>
);

export default ServarrManagement;
