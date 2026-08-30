import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import {
  FocusContext,
  init,
  useFocusable,
} from '@noriginmedia/norigin-spatial-navigation';
import { type ReactNode } from 'react';

let didInitTvNavigation = false;

const TvNavigationTree = ({ children }: { children: ReactNode }) => {
  const { ref, focusKey } = useFocusable<Record<string, never>, HTMLDivElement>(
    {
      focusKey: 'TV_ROOT',
      saveLastFocusedChild: true,
      trackChildren: true,
    }
  );

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
    didInitTvNavigation = true;
  }

  if (!isTvShell) {
    return children;
  }
  return <TvNavigationTree>{children}</TvNavigationTree>;
};

export default TvNavigationGate;
