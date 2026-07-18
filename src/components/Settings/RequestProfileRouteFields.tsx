import defineMessages from '@app/utils/defineMessages';
import type { ServiceCommonServerWithDetails } from '@server/interfaces/api/serviceInterfaces';
import type { RequestProfileRoute } from '@server/lib/requestFilters/types';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages(
  'components.Settings.RequestProfileRouteFields',
  {
    server: 'Server',
    profile: 'Quality profile',
    rootFolder: 'Root folder',
    languageProfile: 'Language profile',
    defaultServer: 'Default server',
  }
);

type ArrKind = 'radarr' | 'sonarr';

interface RequestProfileRouteFieldsProps {
  arrKind: ArrKind;
  title: string;
  value: RequestProfileRoute;
  servers: { id: number; name: string; is4k: boolean }[];
  showLanguageProfile?: boolean;
  onChange: (value: RequestProfileRoute) => void;
}

const RequestProfileRouteFields = ({
  arrKind,
  title,
  value,
  servers,
  showLanguageProfile = false,
  onChange,
}: RequestProfileRouteFieldsProps) => {
  const intl = useIntl();
  const [details, setDetails] = useState<ServiceCommonServerWithDetails | null>(
    null
  );

  useEffect(() => {
    if (!value.serverId) {
      setDetails(null);
      return;
    }

    let cancelled = false;
    void axios
      .get<ServiceCommonServerWithDetails>(
        `/api/v1/service/${arrKind}/${value.serverId}`
      )
      .then((response) => {
        if (!cancelled) {
          setDetails(response.data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDetails(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [arrKind, value.serverId]);

  const update = (patch: Partial<RequestProfileRoute>) => {
    onChange({ ...value, ...patch });
  };

  return (
    <div className="rounded-lg bg-gray-800/50 p-4 ring-1 ring-gray-700">
      <h4 className="mb-3 text-sm font-semibold text-white">{title}</h4>
      <div className="space-y-3">
        <label className="block text-sm text-gray-300">
          <span className="mb-1 block">
            {intl.formatMessage(messages.server)}
          </span>
          <select
            className="w-full rounded-md"
            value={value.serverId ?? ''}
            onChange={(e) => {
              const serverId = e.target.value ? Number(e.target.value) : null;
              onChange({
                serverId,
                profileId: null,
                rootFolder: null,
                languageProfileId: null,
              });
            }}
          >
            <option value="">
              {intl.formatMessage(messages.defaultServer)}
            </option>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name} (#{server.id}
                {server.is4k ? ' · 4K' : ''})
              </option>
            ))}
          </select>
        </label>

        {details && (
          <>
            <label className="block text-sm text-gray-300">
              <span className="mb-1 block">
                {intl.formatMessage(messages.profile)}
              </span>
              <select
                className="w-full rounded-md"
                value={value.profileId ?? ''}
                onChange={(e) =>
                  update({
                    profileId: e.target.value ? Number(e.target.value) : null,
                  })
                }
              >
                <option value="">
                  {details.server.activeProfileId
                    ? `Server default (#${details.server.activeProfileId})`
                    : 'Server default'}
                </option>
                {details.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} (#{profile.id})
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-sm text-gray-300">
              <span className="mb-1 block">
                {intl.formatMessage(messages.rootFolder)}
              </span>
              <select
                className="w-full rounded-md"
                value={value.rootFolder ?? ''}
                onChange={(e) =>
                  update({
                    rootFolder: e.target.value || null,
                  })
                }
              >
                <option value="">
                  {details.server.activeDirectory || 'Server default'}
                </option>
                {details.rootFolders.map((folder) => (
                  <option key={folder.id} value={folder.path}>
                    {folder.path}
                  </option>
                ))}
              </select>
            </label>

            {showLanguageProfile && details.languageProfiles && (
              <label className="block text-sm text-gray-300">
                <span className="mb-1 block">
                  {intl.formatMessage(messages.languageProfile)}
                </span>
                <select
                  className="w-full rounded-md"
                  value={value.languageProfileId ?? ''}
                  onChange={(e) =>
                    update({
                      languageProfileId: e.target.value
                        ? Number(e.target.value)
                        : null,
                    })
                  }
                >
                  <option value="">Server default</option>
                  {details.languageProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} (#{profile.id})
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default RequestProfileRouteFields;
