import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import {
  FocusContext,
  init,
  setKeyMap,
  useFocusable,
} from '@noriginmedia/norigin-spatial-navigation';
import { useEffect, type ReactNode } from 'react';

let didInitTvNavigation = false;

const TvNavigationTree = ({ children }: { children: ReactNode }) => {
  const { ref, focusKey, focusSelf } = useFocusable<
    Record<string, never>,
    HTMLDivElement
  >({
    focusKey: 'TV_ROOT',
    saveLastFocusedChild: true,
    trackChildren: true,
  });

  useEffect(() => {
    focusSelf();
  }, [focusSelf]);

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full min-h-full">
        {children}
      </div>
    </FocusContext.Provider>
  );
};

const TvNavigationGate = ({ children }: { children: ReactNode }) => {
  const { isTvShell } = useNativeRuntime();

  if (isTvShell && !didInitTvNavigation) {
    init({
      debug: false,
      visualDebug: false,
      shouldFocusDOMNode: true,
    });
    // Android WebView DPAD keyCodes are 19–23; browsers send 37–40 / Enter.
    setKeyMap({
      left: [21, 37, 'ArrowLeft'],
      up: [19, 38, 'ArrowUp'],
      right: [22, 39, 'ArrowRight'],
      down: [20, 40, 'ArrowDown'],
      enter: [23, 13, 66, 'Enter'],
    });
    didInitTvNavigation = true;
  }

  if (!isTvShell) {
    return children;
  }
  return <TvNavigationTree>{children}</TvNavigationTree>;
};

export default TvNavigationGate;
