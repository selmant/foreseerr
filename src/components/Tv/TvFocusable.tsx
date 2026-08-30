import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import { useFocusable } from '@noriginmedia/norigin-spatial-navigation';
import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';

export type TvFocusRenderArgs = {
  ref: Ref<HTMLElement>;
  focused: boolean;
  className: string;
};

interface TvFocusableProps {
  children: ReactElement | ((args: TvFocusRenderArgs) => ReactNode);
  focusKey?: string;
  onEnterPress?: () => void;
}

const TvFocusableInner = ({
  children,
  focusKey,
  onEnterPress,
}: TvFocusableProps) => {
  const { ref, focused } = useFocusable<Record<string, never>, HTMLElement>({
    focusKey,
    onEnterPress,
    onFocus: (layout) => {
      layout.node?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center',
      });
    },
  });
  const className = ['tv-focus-target', focused ? 'tv-focused' : '']
    .filter(Boolean)
    .join(' ');

  if (typeof children === 'function') {
    return children({ ref, focused, className });
  }
  if (!isValidElement(children)) {
    return children;
  }

  const child = children as ReactElement<{
    ref?: unknown;
    className?: string;
  }>;
  return cloneElement(child, {
    ref,
    className: [child.props.className, className].filter(Boolean).join(' '),
  });
};

const TvFocusable = ({
  children,
  focusKey,
  onEnterPress,
}: TvFocusableProps) => {
  const { isTvShell } = useNativeRuntime();
  if (!isTvShell) {
    if (typeof children === 'function') {
      return children({
        ref: null,
        focused: false,
        className: '',
      });
    }
    return children;
  }
  return (
    <TvFocusableInner focusKey={focusKey} onEnterPress={onEnterPress}>
      {children}
    </TvFocusableInner>
  );
};

export default TvFocusable;
