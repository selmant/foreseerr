import { useCallback, useRef, useState } from 'react';

export interface ServarrConnectionTestInput {
  hostname: string;
  port: number;
  apiKey: string;
  baseUrl?: string;
  useSsl?: boolean;
}

interface UseServarrConnectionTestOptions<TResponse> {
  initialValidated: boolean;
  initialResponse: TResponse;
  request: (input: ServarrConnectionTestInput) => Promise<TResponse>;
  onSuccess?: () => void;
  onFailure?: () => void;
}

/**
 * Coordinates the shared test lifecycle used by Radarr and Sonarr settings.
 * The first automatic test on an edit form stays quiet; subsequent manual
 * tests can provide success/failure feedback through the callbacks.
 */
export function useServarrConnectionTest<TResponse>({
  initialValidated,
  initialResponse,
  request,
  onSuccess,
  onFailure,
}: UseServarrConnectionTestOptions<TResponse>) {
  const initialLoad = useRef(false);
  const [isValidated, setIsValidated] = useState(initialValidated);
  const [isTesting, setIsTesting] = useState(false);
  const [testResponse, setTestResponse] = useState(initialResponse);

  const testConnection = useCallback(
    async (input: ServarrConnectionTestInput) => {
      setIsTesting(true);
      try {
        const response = await request(input);
        setIsValidated(true);
        setTestResponse(response);
        if (initialLoad.current) {
          onSuccess?.();
        }
      } catch {
        setIsValidated(false);
        if (initialLoad.current) {
          onFailure?.();
        }
      } finally {
        setIsTesting(false);
        initialLoad.current = true;
      }
    },
    [onFailure, onSuccess, request]
  );

  return {
    isValidated,
    isTesting,
    testResponse,
    testConnection,
    invalidateValidation: () => setIsValidated(false),
  };
}
