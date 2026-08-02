import axios from 'axios';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

export type NativeRuntimeState =
  | 'web'
  | 'probing'
  | 'authenticating'
  | 'ready'
  | 'degraded'
  | 'playing';

export interface NativePlayTarget {
  provider: 'jellyfin' | 'emby' | 'plex' | 'trailer';
  itemId?: string;
  fallbackUrl: string;
  label: string;
  quality: 'standard' | '4k' | 'trailer';
}

interface NativeRuntimeContextValue {
  state: NativeRuntimeState;
  play: (target: NativePlayTarget) => boolean;
}

const NativeRuntimeContext = createContext<NativeRuntimeContextValue>({
  state: 'web',
  play: () => false,
});

const createRequestId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const NativeRuntimeProvider = ({
  children,
}: React.PropsWithChildren) => {
  const [state, setState] = useState<NativeRuntimeState>('web');

  useEffect(() => {
    const host = window.jelliumHost;
    if (
      !host ||
      host.protocolVersion !== 1 ||
      host.hostName !== 'foreseer-desktop' ||
      !host.capabilities.includes('play-item')
    ) {
      return;
    }

    setState('probing');
    const authRequestId = createRequestId();
    let authInFlight = false;

    const bootstrap = () => {
      if (authInFlight || !host.capabilities.includes('auth-bootstrap')) return;
      authInFlight = true;
      setState('authenticating');
      host.requestAuthChallenge(authRequestId);
    };

    const onNativeEvent = (event: Event) => {
      const detail = (event as CustomEvent<NativeEvent>).detail;
      if (!detail || detail.protocolVersion !== 1) return;
      if (detail.type === 'auth-challenge' && detail.challenge) {
        axios
          .post('/api/v1/desktop/auth-tickets', {
            challenge: detail.challenge,
            protocolVersion: 1,
          })
          .then(({ data }) => {
            host.completeAuth(authRequestId, data.ticket);
          })
          .catch(() => {
            authInFlight = false;
            setState('degraded');
          });
      } else if (detail.type === 'accepted' || detail.type === 'playing') {
        setState('playing');
      } else if (detail.type === 'stopped' || detail.type === 'finished') {
        setState('ready');
      } else if (detail.type === 'ready') {
        authInFlight = false;
        setState('ready');
      } else if (detail.type === 'error') {
        authInFlight = false;
        setState('degraded');
      }
    };
    window.addEventListener('foreseer:native-event', onNativeEvent);
    bootstrap();
    const retry = window.setInterval(() => {
      bootstrap();
    }, 15000);
    return () => {
      window.clearInterval(retry);
      window.removeEventListener('foreseer:native-event', onNativeEvent);
    };
  }, []);

  const value = useMemo<NativeRuntimeContextValue>(
    () => ({
      state,
      play: (target) => {
        if (
          state !== 'ready' ||
          target.provider !== 'jellyfin' ||
          !target.itemId
        ) {
          return false;
        }
        const requestId = createRequestId();
        const admitted =
          window.jelliumHost?.playItem(requestId, target.itemId) ?? false;
        if (admitted) setState('playing');
        return admitted;
      },
    }),
    [state]
  );

  return (
    <NativeRuntimeContext.Provider value={value}>
      {children}
    </NativeRuntimeContext.Provider>
  );
};

export const useNativeRuntime = () => useContext(NativeRuntimeContext);

interface NativeEvent {
  protocolVersion: 1;
  requestId: string;
  type:
    | 'auth-challenge'
    | 'ready'
    | 'accepted'
    | 'resolving'
    | 'starting'
    | 'playing'
    | 'stopped'
    | 'finished'
    | 'canceled'
    | 'error';
  challenge?: string;
}
