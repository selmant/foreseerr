import { NProgress } from '@tanem/react-nprogress';
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { useLocation } from 'react-router';

interface BarProps {
  progress: number;
  isFinished: boolean;
}

const Bar = ({ progress, isFinished }: BarProps) => {
  return (
    <div
      className={`duration-400 fixed left-0 top-0 z-50 w-full transition-opacity ease-out ${
        isFinished ? 'opacity-0' : 'opacity-100'
      }`}
    >
      <div
        className="bg-indigo-400 transition-width duration-300"
        style={{
          height: '3px',
          width: `${progress * 100}%`,
        }}
      />
    </div>
  );
};

const NProgressBar = ({ loading }: { loading: boolean }) => (
  <NProgress isAnimating={loading}>
    {({ isFinished, progress }) => (
      <Bar progress={progress} isFinished={isFinished} />
    )}
  </NProgress>
);

const MemoizedNProgress = React.memo(NProgressBar);

const LoadingBar = (): React.ReactPortal | null => {
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    setLoading(true);
    const timeout = window.setTimeout(() => setLoading(false), 400);
    return () => window.clearTimeout(timeout);
  }, [location.pathname, location.search]);

  return mounted
    ? ReactDOM.createPortal(
        <MemoizedNProgress loading={loading} />,
        document.body
      )
    : null;
};

export default LoadingBar;
