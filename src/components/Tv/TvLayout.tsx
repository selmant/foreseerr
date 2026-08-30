import TvRail from '@app/components/Tv/TvRail';
import { type ReactNode } from 'react';

const TvLayout = ({ children }: { children: ReactNode }) => (
  <div className="flex h-full min-h-full min-w-0 bg-gray-900">
    <TvRail />
    <main className="min-h-full min-w-0 flex-1 overflow-y-auto px-6 py-6">
      {children}
    </main>
  </div>
);

export default TvLayout;
