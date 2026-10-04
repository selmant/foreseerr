import AnilistLogo from '@app/assets/services/anilist.svg';
import MdblistLogo from '@app/assets/services/mdblist.svg';
import SimklLogo from '@app/assets/services/simkl.svg';
import TraktLogo from '@app/assets/services/trakt.svg';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CompactCardGrid from '@app/components/Common/CompactCardGrid';
import Header from '@app/components/Common/Header';
import LinkButton from '@app/components/Common/LinkButton';
import PageTitle from '@app/components/Common/PageTitle';
import {
  discoverSources,
  sourceMessages as messages,
  type DiscoverSource,
  type SourceView,
} from '@app/components/Discover/sourceCatalog';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import { ArrowRightIcon, LinkIcon } from '@heroicons/react/24/outline';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import { Link, useNavigate } from 'react-router';
import useSWR from 'swr';

const logos = {
  trakt: TraktLogo,
  anilist: AnilistLogo,
  simkl: SimklLogo,
  mdblist: MdblistLogo,
};
const viewClass =
  'inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-gray-600 bg-gray-900/50 px-3 py-2 text-sm font-medium text-gray-200 transition hover:border-indigo-400 hover:bg-indigo-500/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400';

const OpenList = ({ source }: { source: 'trakt' | 'mdblist' }) => {
  const intl = useIntl();
  const navigate = useNavigate();
  const [url, setUrl] = useState('');
  const label = intl.formatMessage(messages.listUrl, {
    source: source === 'trakt' ? 'Trakt' : 'MDBList',
  });
  return (
    <form
      className="mt-5 border-t border-gray-700 pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (url.trim())
          navigate(
            `/discover/${source}/list?url=${encodeURIComponent(url.trim())}`
          );
      }}
    >
      <label
        htmlFor={`${source}-list-url`}
        className="mb-2 block text-sm text-gray-300"
      >
        {label}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={`${source}-list-url`}
          type="text"
          required
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby={`${source}-list-hint`}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={
            source === 'trakt'
              ? 'https://trakt.tv/users/…/lists/…'
              : 'https://mdblist.com/lists/…/…'
          }
          className="min-h-[44px] min-w-0 flex-1"
        />
        <Button type="submit" disabled={!url.trim()} className="min-h-[44px]">
          <ArrowRightIcon />
          <span>{intl.formatMessage(messages.openList)}</span>
        </Button>
      </div>
      <p
        id={`${source}-list-hint`}
        className="mt-2 text-sm leading-5 text-gray-400"
      >
        {intl.formatMessage(messages.publicListHint, {
          source: source === 'trakt' ? 'Trakt' : 'MDBList',
        })}
      </p>
    </form>
  );
};

const AnilistLists = () => {
  const intl = useIntl();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const { data, error, mutate, isValidating } = useSWR<{
    results: { name: string; itemCount: number }[];
  }>('/api/v1/discover/anilist/lists');

  useEffect(() => {
    if (data && name && !data.results.some((list) => list.name === name)) {
      setName('');
    }
  }, [data, name]);

  return (
    <div className="mt-5 border-t border-gray-700 pt-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <label htmlFor="anilist-list-name" className="text-sm text-gray-300">
          {intl.formatMessage(messages.customLists)}
        </label>
        <Button
          type="button"
          className="min-h-11"
          buttonSize="sm"
          aria-disabled={isValidating}
          aria-busy={isValidating}
          onClick={() => {
            if (!isValidating) void mutate().catch(() => undefined);
          }}
        >
          {intl.formatMessage(
            isValidating
              ? messages.loadingLists
              : error
                ? messages.retry
                : messages.refreshLists
          )}
        </Button>
      </div>
      {error && (
        <p role="status" className="mb-3 text-sm text-amber-200">
          {intl.formatMessage(
            data ? messages.savedListsError : messages.listsError
          )}
        </p>
      )}
      {!data ? (
        !error && (
          <p role="status" className="py-3 text-sm text-gray-400">
            {intl.formatMessage(messages.loadingLists)}
          </p>
        )
      ) : !data.results.length ? (
        <p role="status" className="text-sm text-gray-400">
          {intl.formatMessage(messages.noLists)}
        </p>
      ) : (
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (name && data.results.some((list) => list.name === name))
              navigate(
                `/discover/anilist/list?name=${encodeURIComponent(name)}`
              );
          }}
        >
          <select
            id="anilist-list-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="min-h-11 min-w-0 flex-1"
            required
          >
            <option value="" disabled>
              {intl.formatMessage(messages.selectList)}
            </option>
            {data.results.map((list) => (
              <option key={list.name} value={list.name}>
                {list.name} ({intl.formatNumber(list.itemCount)})
              </option>
            ))}
          </select>
          <Button type="submit" disabled={!name} className="min-h-11">
            <ArrowRightIcon />
            <span>{intl.formatMessage(messages.openList)}</span>
          </Button>
        </form>
      )}
    </div>
  );
};

const PersonalViews = ({
  source,
  name,
  views,
}: {
  source: Exclude<DiscoverSource, 'mdblist'>;
  name: string;
  views: SourceView[];
}) => {
  const intl = useIntl();
  const { user } = useUser();
  const { data, error, mutate, isValidating } = useSWR<{
    connected: boolean;
    provider?: 'direct' | 'jellyfin';
    pluginState?: string;
    expired?: boolean;
  }>(
    user
      ? `/api/v1/user/${user.id}/settings/linked-accounts/${source}${source === 'trakt' ? '?includePluginStatus=true' : ''}`
      : null
  );
  const connected =
    data?.connected && (!data.pluginState || data.pluginState === 'ready');
  return (
    <div className="mt-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          {intl.formatMessage(messages.personalViews)}
        </h3>
        {data && (
          <Badge badgeType={connected ? 'success' : 'light'}>
            {intl.formatMessage(
              connected ? messages.accountLinked : messages.connectionNeeded
            )}
          </Badge>
        )}
      </div>
      {!data && !error && (
        <p role="status" className="mb-3 text-sm text-gray-400">
          {intl.formatMessage(messages.checkingConnection)}
        </p>
      )}
      {error && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <p role="status" className="text-sm text-amber-200">
            {intl.formatMessage(messages.connectionError)}
          </p>
          <Button
            type="button"
            buttonSize="sm"
            className="min-h-11"
            aria-disabled={isValidating}
            aria-busy={isValidating}
            onClick={() => {
              if (!isValidating) void mutate().catch(() => undefined);
            }}
          >
            {intl.formatMessage(
              isValidating ? messages.checkingConnection : messages.retry
            )}
          </Button>
        </div>
      )}
      {data && !connected && (
        <div className="mb-3 rounded-lg border border-gray-700 bg-gray-900/40 p-3">
          <p className="mb-2 text-sm leading-5 text-gray-300">
            {intl.formatMessage(messages.connectionHint, { source: name })}
          </p>
          <LinkButton
            to="/profile/settings/linked-accounts"
            buttonSize="sm"
            className="min-h-11"
          >
            <LinkIcon />
            <span>
              {intl.formatMessage(messages.reviewConnection, { source: name })}
            </span>
          </LinkButton>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {views.map((view) => (
          <Link key={view.href} to={view.href} className={viewClass}>
            <LinkIcon aria-hidden="true" className="h-4 w-4 text-gray-400" />
            {intl.formatMessage(messages[view.label])}
          </Link>
        ))}
      </div>
      {source === 'anilist' && connected && <AnilistLists />}
    </div>
  );
};

const DiscoverSources = () => {
  const intl = useIntl();
  const { currentSettings } = useSettings();
  const { hasPermission } = useUser();

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.title)} />
      <Header subtext={intl.formatMessage(messages.description)}>
        {intl.formatMessage(messages.title)}
      </Header>
      <div className="my-6 flex flex-col gap-3 rounded-xl border border-gray-700 bg-gray-800/50 p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-gray-300">
          {intl.formatMessage(messages.personalHint)}
        </p>
        <LinkButton
          to="/profile/settings/linked-accounts"
          buttonSize="sm"
          className="min-h-[44px]"
        >
          <LinkIcon />
          <span>{intl.formatMessage(messages.linkedAccounts)}</span>
        </LinkButton>
      </div>
      <nav
        aria-label={intl.formatMessage(messages.sourceShortcuts)}
        className="mb-4 flex flex-wrap gap-2"
      >
        {discoverSources.map((source) => (
          <a
            key={source.id}
            href={`#${source.id}-heading`}
            className={viewClass}
            onClick={() =>
              document
                .getElementById(`${source.id}-heading`)
                ?.focus({ preventScroll: true })
            }
          >
            {source.name}
          </a>
        ))}
      </nav>
      <CompactCardGrid columns="lg:grid-cols-2">
        {discoverSources.map((source) => {
          const configured = currentSettings[source.setting];
          const Logo = logos[source.id];
          return (
            <section
              key={source.id}
              data-source-card
              aria-labelledby={`${source.id}-heading`}
              className="rounded-xl border border-gray-700 bg-gray-800/60 p-4 sm:p-5"
            >
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gray-900/70">
                  <Logo aria-hidden="true" className="h-8 w-8" />
                </div>
                <h2
                  id={`${source.id}-heading`}
                  tabIndex={-1}
                  className="min-w-[5rem] flex-1 scroll-mt-24 rounded text-xl font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                >
                  {source.name}
                </h2>
                <Badge badgeType={configured ? 'success' : 'light'}>
                  {intl.formatMessage(
                    configured ? messages.available : messages.notConfigured
                  )}
                </Badge>
              </div>
              <p className="mt-3 text-sm leading-6 text-gray-400">
                {intl.formatMessage(messages[source.description])}
              </p>
              {configured ? (
                <>
                  {source.views.some((view) => !view.personal) && (
                    <div className="mt-4">
                      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
                        {intl.formatMessage(messages.browseViews)}
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        {source.views
                          .filter((view) => !view.personal)
                          .map((view) => (
                            <Link
                              key={view.href}
                              to={view.href}
                              className={viewClass}
                            >
                              {intl.formatMessage(messages[view.label])}
                            </Link>
                          ))}
                      </div>
                    </div>
                  )}
                  {source.id !== 'mdblist' && (
                    <PersonalViews
                      source={source.id}
                      name={source.name}
                      views={source.views.filter((view) => view.personal)}
                    />
                  )}
                  {(source.id === 'trakt' || source.id === 'mdblist') && (
                    <OpenList source={source.id} />
                  )}
                </>
              ) : (
                <div className="mt-4">
                  {hasPermission(Permission.ADMIN) ? (
                    <LinkButton
                      to="/settings/integrations"
                      buttonSize="sm"
                      className="min-h-11"
                    >
                      {intl.formatMessage(messages.configure)}
                    </LinkButton>
                  ) : (
                    <p className="text-sm text-gray-400">
                      {intl.formatMessage(messages.needsAdmin)}
                    </p>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </CompactCardGrid>
    </>
  );
};

export default DiscoverSources;
