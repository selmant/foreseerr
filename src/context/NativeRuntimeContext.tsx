import type { NativeHostEventTypeV1 } from '@app/context/nativeRuntimeProtocol';
import {
  isCurrentNativePlayRequest,
  isNativeHostEventTypeV1,
  isUsableForeseerNative,
  shouldClearNativePlayRequest,
} from '@app/context/nativeRuntimeProtocol';
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
    const host = window.foreseerNative;
    if (isUsableForeseerNative(host)) {
      setCanQuit(host.capabilities.includes('quit'));
      // Native desktop has no browser chrome — share PWA chromeless UI (e.g. Back).
      document.documentElement.classList.add('native-shell');
    } else {
      setCanQuit(false);
      document.documentElement.classList.remove('native-shell');
    }
    return () => {
      document.documentElement.classList.remove('native-shell');
    };
  }, []);

  const quit = useCallback(() => {
    const host = window.foreseerNative;
    if (!isUsableForeseerNative(host) || !host.capabilities.includes('quit')) {
      return false;
    }
    return host.send({ type: 'app.quit', id: createRequestId() });
  }, []);

  const admitPlay = useCallback((target: NativePlayTarget) => {
    if (target.provider !== 'jellyfin' || !target.itemId) return false;
    const host = window.foreseerNative;
    if (!isUsableForeseerNative(host)) return false;
    const requestId = createRequestId();
    const admitted = host.send({
      type: 'play.item',
      id: requestId,
      itemId: target.itemId,
    });
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
    const host = window.foreseerNative;
    if (
      previousUserId.current !== undefined &&
      previousUserId.current !== userId &&
      isUsableForeseerNative(host) &&
      host.capabilities.includes('session-reset')
    ) {
      host.send({ type: 'session.clear', id: createRequestId() });
      activePlayRequestId.current = undefined;
      queuedPlayTarget.current = undefined;
      window.clearTimeout(activePlayTimeout.current);
      setState(userId ? 'probing' : 'web');
    }
    previousUserId.current = userId;
  }, [userId]);

  useEffect(() => {
    const host = window.foreseerNative;
    // No usable protocol-v1 host → stay on ordinary browser playback.
    if (!isUsableForeseerNative(host)) {
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
      if (!host.send({ type: 'auth.challenge', id: authRequestId })) {
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
      if (
        !detail ||
        detail.protocolVersion !== 1 ||
        !isNativeHostEventTypeV1(detail.type)
      )
        return;
      const isAuthEvent = detail.id === authRequestId;
      const isPlayEvent = isCurrentNativePlayRequest(
        activePlayRequestId.current,
        detail.id
      );
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
            if (detail.id !== authRequestId) return;
            if (
              !host.send({
                type: 'auth.complete',
                id: detail.id,
                ticket: data.ticket,
              })
            ) {
              authInFlight = false;
              authRequestId = undefined;
              queuedPlayTarget.current = undefined;
              window.clearTimeout(authTimeout);
              setState('degraded');
            }
          })
          .catch((error) => {
            const status = error?.response?.status;
            const code = error?.response?.data?.code;
            console.error(
              '[ForeseerNative] auth-tickets failed',
              status ?? 'network',
              code ?? error?.message ?? 'unknown'
            );
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
        detail.type !== 'error' &&
        shouldClearNativePlayRequest(
          activePlayRequestId.current,
          detail.id,
          detail.type
        )
      ) {
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
        shouldClearNativePlayRequest(
          activePlayRequestId.current,
          detail.id,
          detail.type
        )
      ) {
        clearActivePlay();
      }
    };
    window.addEventListener('foreseer:native-event', onNativeEvent);
    bootstrap();
    const retry = window.setInterval(() => {
      bootstrap();
    }, 15000);
    return () => {
      window.clearInterval(retry);
      window.clearTimeout(authTimeout);
      window.removeEventListener('foreseer:native-event', onNativeEvent);
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
  id: string;
  type: NativeHostEventTypeV1;
  challenge?: string;
}
