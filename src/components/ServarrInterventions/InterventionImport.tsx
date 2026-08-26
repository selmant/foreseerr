import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import ManualImport from '@app/components/ManageSlideOver/ManualImport';
import type { ServarrContext } from '@app/components/ManageSlideOver/servarrTypes';
import axios from 'axios';
import { useEffect, useState } from 'react';

const InterventionImport = ({
  interventionId,
  mediaId,
  is4k,
  onChanged,
}: {
  interventionId: number;
  mediaId: number;
  is4k: boolean;
  onChanged: () => void;
}) => {
  const [context, setContext] = useState<ServarrContext>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    axios
      .get<ServarrContext>(
        `/api/v1/media/${mediaId}/servarr/context?is4k=${is4k}`,
        { signal: controller.signal }
      )
      .then((response) => setContext(response.data))
      .catch((requestError) => {
        if (!controller.signal.aborted)
          setError(
            axios.isAxiosError(requestError)
              ? requestError.response?.data?.message
              : 'Unable to load the import workflow.'
          );
      });
    return () => controller.abort();
  }, [is4k, mediaId]);

  if (error) return <div className="text-sm text-red-300">{error}</div>;
  if (!context) return <LoadingSpinner />;
  return (
    <ManualImport
      mediaId={mediaId}
      is4k={is4k}
      context={context}
      onChanged={onChanged}
      refreshToken={0}
      interventionId={interventionId}
    />
  );
};

export default InterventionImport;
