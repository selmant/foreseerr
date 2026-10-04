import defineMessages from '@app/utils/defineMessages';
import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('hooks.useQuickConnect', {
  errorMessage: 'Failed to initiate Quick Connect. Please try again.',
});

interface UseQuickConnectOptions {
  show: boolean;
  onSuccess: () => void;
  onError?: (error: string) => void;
  authenticate: (secret: string) => Promise<void>;
}

export const useQuickConnect = ({
  show,
  onSuccess,
  onError,
  authenticate,
}: UseQuickConnectOptions) => {
  const intl = useIntl();
  const [code, setCode] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [isExpired, setIsExpired] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const pollingInterval = useRef<NodeJS.Timeout | undefined>(undefined);
  const isMounted = useRef(true);
  const hasInitiated = useRef(false);
  const errorCount = useRef(0);
  const generation = useRef(0);

  useEffect(() => {
    isMounted.current = true;

    return () => {
      isMounted.current = false;
      generation.current += 1;
      hasInitiated.current = false;
      if (pollingInterval.current) {
        clearInterval(pollingInterval.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!show) {
      generation.current += 1;
      hasInitiated.current = false;
      if (pollingInterval.current) {
        clearInterval(pollingInterval.current);
        pollingInterval.current = undefined;
      }
    }
  }, [show]);

  const authenticateWithQuickConnect = useCallback(
    async (secret: string, attempt: number) => {
      if (!isMounted.current || attempt !== generation.current) return;
      try {
        await authenticate(secret);
        if (!isMounted.current || attempt !== generation.current) return;
        onSuccess();
      } catch (error) {
        if (!isMounted.current || attempt !== generation.current) return;

        const errMsg =
          error?.response?.data?.message ||
          intl.formatMessage(messages.errorMessage);
        setErrorMessage(errMsg);
        setHasError(true);
        onError?.(errMsg);

        if (pollingInterval.current) {
          clearInterval(pollingInterval.current);
        }
      }
    },
    [authenticate, intl, onError, onSuccess]
  );

  const startPolling = useCallback(
    (secret: string, attempt: number) => {
      pollingInterval.current = setInterval(async () => {
        try {
          const response = await axios.get(
            '/api/v1/auth/jellyfin/quickconnect/check',
            {
              params: { secret },
            }
          );

          if (!isMounted.current || attempt !== generation.current) return;
          errorCount.current = 0;

          if (response.data.authenticated) {
            if (pollingInterval.current) {
              clearInterval(pollingInterval.current);
            }
            await authenticateWithQuickConnect(secret, attempt);
          }
        } catch (error) {
          if (!isMounted.current || attempt !== generation.current) return;

          if (error?.response?.status === 404) {
            if (pollingInterval.current) {
              clearInterval(pollingInterval.current);
            }
            setIsExpired(true);
          } else {
            errorCount.current++;
            if (errorCount.current >= 5) {
              if (pollingInterval.current) {
                clearInterval(pollingInterval.current);
              }
              setHasError(true);
              const errorMessage = intl.formatMessage(messages.errorMessage);
              setErrorMessage(errorMessage);
              onError?.(errorMessage);
            }
          }
        }
      }, 2000);
    },
    [authenticateWithQuickConnect, intl, onError]
  );

  const initiateQuickConnect = useCallback(async () => {
    const attempt = ++generation.current;
    errorCount.current = 0;
    if (pollingInterval.current) {
      clearInterval(pollingInterval.current);
    }

    setIsLoading(true);
    setHasError(false);
    setIsExpired(false);
    setErrorMessage(null);
    setCode('');

    try {
      const response = await axios.post(
        '/api/v1/auth/jellyfin/quickconnect/initiate'
      );

      if (!isMounted.current || attempt !== generation.current) return;

      setCode(response.data.code);
      setIsLoading(false);
      startPolling(response.data.secret, attempt);
    } catch {
      if (!isMounted.current || attempt !== generation.current) return;

      setHasError(true);
      setIsLoading(false);
      const errMessage = intl.formatMessage(messages.errorMessage);
      setErrorMessage(errMessage);
      onError?.(errMessage);
    }
  }, [startPolling, onError, intl]);

  useEffect(() => {
    if (show && !hasInitiated.current) {
      hasInitiated.current = true;
      initiateQuickConnect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  const cleanup = useCallback(() => {
    generation.current += 1;
    if (pollingInterval.current) {
      clearInterval(pollingInterval.current);
      pollingInterval.current = undefined;
    }
  }, []);

  return {
    code,
    isLoading,
    hasError,
    isExpired,
    errorMessage,
    initiateQuickConnect,
    cleanup,
  };
};
