import { ArrowPathIcon } from '@heroicons/react/24/outline';
import type { ReactNode } from 'react';

/** Code display shared by the device/PIN linking flows (matches Quick Connect). */
const DeviceCodePanel = ({
  instructions,
  code,
  waitingText,
}: {
  instructions: ReactNode;
  code: string;
  waitingText: string;
}) => (
  <div className="flex flex-col items-center space-y-4">
    <p className="text-center text-gray-300">{instructions}</p>
    <div className="rounded-lg bg-gray-700 px-8 py-4">
      <span className="font-mono text-4xl font-bold tracking-wider text-white">
        {code}
      </span>
    </div>
    <div className="flex items-center space-x-2 text-sm text-gray-400">
      <ArrowPathIcon className="h-4 w-4 animate-spin" />
      <span>{waitingText}</span>
    </div>
  </div>
);

export default DeviceCodePanel;
