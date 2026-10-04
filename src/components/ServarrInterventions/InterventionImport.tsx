import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import ManualImport from '@app/components/ManageSlideOver/ManualImport';
import type { ServarrContext } from '@app/components/ManageSlideOver/servarrTypes';
import defineMessages from '@app/utils/defineMessages';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages(
  'components.ServarrInterventions.InterventionImport',
  {
    loadFailed: 'Unable to load the import workflow.',
    retry: 'Try again',
    retryDescription:
      'Check the connection to the download service, then try again. Your download has not been changed.',
  }
);

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
  const intl = useIntl();
  const [context, setContext] = useState<ServarrContext>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    setContext(undefined);
    axios
      .get<ServarrContext>(
        `/api/v1/media/${mediaId}/servarr/context?is4k=${is4k}`,
        { signal: controller.signal }
      )
      .then((response) => setContext(response.data))
      .catch((requestError) => {
        if (!controller.signal.aborted)
          setError(
            (axios.isAxiosError(requestError)
              ? requestError.response?.data?.message
              : undefined) ?? intl.formatMessage(messages.loadFailed)
          );
      });
    return () => controller.abort();
  }, [attempt, intl, is4k, mediaId]);

  if (error)
    return (
      <Alert type="error" title={error}>
        <p>{intl.formatMessage(messages.retryDescription)}</p>
        <Button
          className="mt-3 min-h-11"
          onClick={() => setAttempt((value) => value + 1)}
        >
          {intl.formatMessage(messages.retry)}
        </Button>
      </Alert>
    );
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
