import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowUpCircleIcon,
  BeakerIcon,
  CodeBracketIcon,
  ServerIcon,
} from '@heroicons/react/24/outline';
import type { StatusResponse } from '@server/interfaces/api/settingsInterfaces';
import { useIntl } from 'react-intl';
import { Link } from 'react-router';
import useSWR from 'swr';

const messages = defineMessages('components.Layout.VersionStatus', {
  streamdevelop: 'Foreseerr Develop',
  streamstable: 'Foreseerr Stable',
  streamplugin: 'Foreseerr for Jellyfin',
  outofdate: 'Out of Date',
  commitsbehind:
    '{commitsBehind} {commitsBehind, plural, one {commit} other {commits}} behind',
});

interface VersionStatusProps {
  onClick?: () => void;
}

const VersionStatus = ({ onClick }: VersionStatusProps) => {
  const settings = useSettings();
  const intl = useIntl();
  const { data } = useSWR<StatusResponse>(
    `/api/v1/status?checkUpdateAvailable=${settings.currentSettings.versionCheck}`,
    {
      refreshInterval: 60 * 1000,
    }
  );

  if (!data) {
    return null;
  }

  // Plugin builds are compiled binaries, which report a local commit.
  const pluginMode = !!settings.currentSettings.pluginMode;
  const isLocal = data.commitTag === 'local' && !pluginMode;
  const versionStream = pluginMode
    ? intl.formatMessage(messages.streamplugin)
    : isLocal
      ? 'Keep it up! 👍'
      : data.version.startsWith('develop-')
        ? intl.formatMessage(messages.streamdevelop)
        : intl.formatMessage(messages.streamstable);

  return (
    <Link
      to="/settings/about"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && onClick) {
          onClick();
        }
      }}
      role="button"
      tabIndex={0}
      className={`flex items-center rounded-lg p-2 text-xs ring-1 ring-gray-700 transition duration-300 ${
        data.updateAvailable
          ? 'bg-yellow-500 text-white hover:bg-yellow-400'
          : 'bg-gray-900 text-gray-300 hover:bg-gray-800'
      }`}
    >
      {isLocal ? (
        <CodeBracketIcon className="h-6 w-6" />
      ) : data.version.startsWith('develop-') ? (
        <BeakerIcon className="h-6 w-6" />
      ) : (
        <ServerIcon className="h-6 w-6" />
      )}
      <div className="flex min-w-0 flex-1 flex-col truncate px-2 last:pr-0">
        <span className="font-bold">{versionStream}</span>
        {pluginMode && data.commitsBehind === undefined && (
          <code className="truncate bg-transparent p-0">{data.version}</code>
        )}
        {data.commitsBehind !== undefined && (
          <span className="truncate">
            {isLocal ? (
              '(⌐■_■)'
            ) : data.commitsBehind > 0 ? (
              intl.formatMessage(messages.commitsbehind, {
                commitsBehind: data.commitsBehind,
              })
            ) : data.commitsBehind === -1 ? (
              intl.formatMessage(messages.outofdate)
            ) : (
              <code className="bg-transparent p-0">
                {data.version.replace('develop-', '')}
              </code>
            )}
          </span>
        )}
      </div>
      {data.updateAvailable && <ArrowUpCircleIcon className="h-6 w-6" />}
    </Link>
  );
};

export default VersionStatus;
