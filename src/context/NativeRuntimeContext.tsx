import { useUser } from '@app/hooks/useUser';
import axios from 'axios';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

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
  canQuit: boolean;
  play: (target: NativePlayTarget) => boolean;
  quit: () => boolean;
}

const NativeRuntimeContext = createContext<NativeRuntimeContextValue>({
  state: 'web',
  canQuit: false,
  play: () => false,
  quit: () => false,
});

const createRequestId = () => crypto.randomUUID();

export const NativeRuntimeProvider = ({
  children,
}: React.PropsWithChildren) => {
  const [state, setState] = useState<NativeRuntimeState>('web');
  const [canQuit, setCanQuit] = useState(false);
  const activePlayRequestId = useRef<string | undefined>(undefined);
  const activePlayTimeout = useRef<number | undefined>(undefined);
  const queuedPlayTarget = useRef<NativePlayTarget | undefined>(undefined);
  const { user, error: userError } = useUser();
  const userId = userError ? undefined : user?.id;
  const previousUserId = useRef<number | undefined>(undefined);

  useEffect(() => {
    const host = window.jelliumHost;
    setCanQuit(
      !!host &&
        host.protocolVersion === 1 &&
        host.hostName === 'jellium-desktop' &&
        host.capabilities.includes('quit')
    );
  }, []);

  const quit = useCallback(() => window.jelliumHost?.quit() ?? false, []);

  const admitPlay = useCallback((target: NativePlayTarget) => {
    if (target.provider !== 'jellyfin' || !target.itemId) return false;
    const requestId = createRequestId();
    const admitted =
      window.jelliumHost?.playItem(requestId, target.itemId) ?? false;
    if (admitted) {
      activePlayRequestId.current = requestId;
      window.clearTimeout(activePlayTimeout.current);
      activePlayTimeout.current = window.setTimeout(() => {
        if (activePlayRequestId.current === requestId) {
          activePlayRequestId.current = undefined;
          setState('ready');
        }
      }, 30000);
      setState('playing');
    }
    return admitted;
  }, []);

  useEffect(() => {
    const host = window.jelliumHost;
    if (
      previousUserId.current !== undefined &&
      previousUserId.current !== userId &&
      host?.capabilities.includes('session-reset')
    ) {
      host.clearSession(createRequestId());
      activePlayRequestId.current = undefined;
      queuedPlayTarget.current = undefined;
      window.clearTimeout(activePlayTimeout.current);
      setState(userId ? 'probing' : 'web');
    }
    previousUserId.current = userId;
  }, [userId]);

  useEffect(() => {
    const host = window.jelliumHost;
    if (
      !host ||
      host.protocolVersion !== 1 ||
      host.hostName !== 'jellium-desktop' ||
      !host.capabilities.includes('play-item')
    ) {
      return;
    }
    if (!userId) {
      return;
    }

    setState('probing');
    let authRequestId: string | undefined;
    let authInFlight = false;
    let authReady = false;
    let authTimeout: number | undefined;

    const bootstrap = () => {
      if (authInFlight || authReady) return;
      if (!host.capabilities.includes('auth-bootstrap')) {
        queuedPlayTarget.current = undefined;
        setState('degraded');
        return;
      }
      authRequestId = createRequestId();
      authInFlight = true;
      setState('authenticating');
      if (!host.requestAuthChallenge(authRequestId)) {
        authInFlight = false;
        authRequestId = undefined;
        queuedPlayTarget.current = undefined;
        setState('degraded');
      } else {
        authTimeout = window.setTimeout(() => {
          authInFlight = false;
          authRequestId = undefined;
          queuedPlayTarget.current = undefined;
          setState('degraded');
        }, 30000);
      }
    };

    const clearActivePlay = () => {
      activePlayRequestId.current = undefined;
      window.clearTimeout(activePlayTimeout.current);
      setState((current) =>
        current === 'playing' || current === 'degraded' ? 'ready' : current
      );
    };

    const onNativeEvent = (event: Event) => {
      const detail = (event as CustomEvent<NativeEvent>).detail;
      if (!detail || detail.protocolVersion !== 1) return;
      const isAuthEvent = detail.requestId === authRequestId;
      const isPlayEvent = detail.requestId === activePlayRequestId.current;
      if (
        detail.type === 'auth-challenge' &&
        isAuthEvent &&
        detail.challenge &&
        /^[a-f0-9]{64}$/.test(detail.challenge)
      ) {
        axios
          .post('/api/v1/desktop/auth-tickets', {
            challenge: detail.challenge,
            protocolVersion: 1,
          })
          .then(({ data }) => {
            if (detail.requestId !== authRequestId) return;
            if (!host.completeAuth(detail.requestId, data.ticket)) {
              authInFlight = false;
              authRequestId = undefined;
              queuedPlayTarget.current = undefined;
              window.clearTimeout(authTimeout);
              setState('degraded');
            }
          })
          .catch(() => {
            authInFlight = false;
            authRequestId = undefined;
            queuedPlayTarget.current = undefined;
            window.clearTimeout(authTimeout);
            setState('degraded');
          });
      } else if (
        isPlayEvent &&
        ['accepted', 'resolving', 'starting', 'playing'].includes(detail.type)
      ) {
        if (detail.type === 'playing') {
          window.clearTimeout(activePlayTimeout.current);
        }
        setState('playing');
      } else if (
        ['stopped', 'finished', 'canceled'].includes(detail.type) &&
        (isPlayEvent || activePlayRequestId.current !== undefined)
      ) {
        // Accept terminal events even when request ids race after Video OSD Back.
        clearActivePlay();
      } else if (detail.type === 'ready' && isAuthEvent) {
        authInFlight = false;
        authReady = true;
        authRequestId = undefined;
        window.clearTimeout(authTimeout);
        const queued = queuedPlayTarget.current;
        queuedPlayTarget.current = undefined;
        if (!queued || !admitPlay(queued)) setState('ready');
      } else if (detail.type === 'error' && isAuthEvent) {
        authInFlight = false;
        authReady = false;
        authRequestId = undefined;
        queuedPlayTarget.current = undefined;
        window.clearTimeout(authTimeout);
        setState('degraded');
      } else if (
        detail.type === 'error' &&
        (isPlayEvent || activePlayRequestId.current !== undefined)
      ) {
        clearActivePlay();
      }
    };
    window.addEventListener('jellium:host-event', onNativeEvent);
    bootstrap();
    const retry = window.setInterval(() => {
      bootstrap();
    }, 15000);
    return () => {
      window.clearInterval(retry);
      window.clearTimeout(authTimeout);
      window.removeEventListener('jellium:host-event', onNativeEvent);
    };
  }, [admitPlay, userId]);

  const value = useMemo<NativeRuntimeContextValue>(
    () => ({
      state,
      canQuit,
      quit,
      play: (target) => {
        if (target.provider !== 'jellyfin' || !target.itemId) {
          return false;
        }
        if (state === 'probing' || state === 'authenticating') {
          queuedPlayTarget.current = target;
          return true;
        }
        // ready: normal path. playing/degraded: allow retry after Back/timeout races.
        if (state === 'ready' || state === 'playing' || state === 'degraded') {
          return admitPlay(target);
        }
        return false;
      },
    }),
    [admitPlay, canQuit, quit, state]
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
