import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Layout from '@app/components/Layout';
import LoadingBar from '@app/components/LoadingBar';
import PWAHeader from '@app/components/PWAHeader';
import ServiceWorkerSetup from '@app/components/ServiceWorkerSetup';
import StatusChecker from '@app/components/StatusChecker';
import TvNavigationGate from '@app/components/Tv/TvNavigationGate';
import { InteractionProvider } from '@app/context/InteractionContext';
import { LanguageContext } from '@app/context/LanguageContext';
import { NativeRuntimeProvider } from '@app/context/NativeRuntimeContext';
import { SettingsProvider } from '@app/context/SettingsContext';
import { UserContext } from '@app/context/UserContext';
import type { User } from '@app/hooks/useUser';
import { Permission, useUser } from '@app/hooks/useUser';
import buildRoutes from '@app/routes';
import '@app/styles/globals.css';
import { polyfillIntl } from '@app/utils/polyfillIntl';
import '@fontsource-variable/inter';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import { DEFAULT_RATING_BADGE_SETTINGS } from '@server/constants/ratingBadges';
import { MediaServerType } from '@server/constants/server';
import type { PublicSettingsResponse } from '@server/interfaces/api/settingsInterfaces';
import type { AvailableLocale } from '@server/types/languages';
import axios from 'axios';
import { useEffect, useMemo, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Toaster } from 'react-hot-toast';
import { IntlProvider } from 'react-intl';
import {
  Outlet,
  RouterProvider,
  createBrowserRouter,
  isRouteErrorResponse,
  useLocation,
  useNavigate,
  useRouteError,
} from 'react-router';
import { SWRConfig } from 'swr';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadLocaleData = (locale: AvailableLocale): Promise<any> => {
  switch (locale) {
    case 'ar':
      return import('./i18n/locale/ar.json');
    case 'bg':
      return import('./i18n/locale/bg.json');
    case 'ca':
      return import('./i18n/locale/ca.json');
    case 'cs':
      return import('./i18n/locale/cs.json');
    case 'da':
      return import('./i18n/locale/da.json');
    case 'de':
      return import('./i18n/locale/de.json');
    case 'el':
      return import('./i18n/locale/el.json');
    case 'es':
      return import('./i18n/locale/es.json');
    case 'es-MX':
      return import('./i18n/locale/es_MX.json');
    case 'et':
      return import('./i18n/locale/et.json');
    case 'fi':
      return import('./i18n/locale/fi.json');
    case 'fr':
      return import('./i18n/locale/fr.json');
    case 'he':
      return import('./i18n/locale/he.json');
    case 'hi':
      return import('./i18n/locale/hi.json');
    case 'hr':
      return import('./i18n/locale/hr.json');
    case 'hu':
      return import('./i18n/locale/hu.json');
    case 'it':
      return import('./i18n/locale/it.json');
    case 'ja':
      return import('./i18n/locale/ja.json');
    case 'ko':
      return import('./i18n/locale/ko.json');
    case 'lb':
      return import('./i18n/locale/lb.json');
    case 'lt':
      return import('./i18n/locale/lt.json');
    case 'nb-NO':
      return import('./i18n/locale/nb_NO.json');
    case 'nl':
      return import('./i18n/locale/nl.json');
    case 'pl':
      return import('./i18n/locale/pl.json');
    case 'pt-BR':
      return import('./i18n/locale/pt_BR.json');
    case 'pt-PT':
      return import('./i18n/locale/pt_PT.json');
    case 'ro':
      return import('./i18n/locale/ro.json');
    case 'ru':
      return import('./i18n/locale/ru.json');
    case 'sq':
      return import('./i18n/locale/sq.json');
    case 'sr':
      return import('./i18n/locale/sr.json');
    case 'sv':
      return import('./i18n/locale/sv.json');
    case 'tr':
      return import('./i18n/locale/tr.json');
    case 'uk':
      return import('./i18n/locale/uk.json');
    case 'vi':
      return import('./i18n/locale/vi.json');
    case 'zh-CN':
      return import('./i18n/locale/zh_Hans.json');
    case 'zh-TW':
      return import('./i18n/locale/zh_Hant.json');
    default:
      return import('./i18n/locale/en.json');
  }
};

const defaultSettings: PublicSettingsResponse = {
  initialized: false,
  applicationTitle: '',
  applicationUrl: '',
  hideAvailable: false,
  hideBlocklisted: false,
  movie4kEnabled: false,
  series4kEnabled: false,
  movieInstantRequestEnabled: true,
  movie4kInstantRequestEnabled: true,
  seriesInstantRequestEnabled: true,
  series4kInstantRequestEnabled: true,
  localLogin: true,
  mediaServerLogin: true,
  discoverRegion: '',
  streamingRegion: '',
  originalLanguage: '',
  mediaServerType: MediaServerType.NOT_CONFIGURED,
  partialRequestsEnabled: true,
  episodeRequestsEnabled: false,
  enableSpecialEpisodes: false,
  cacheImages: false,
  vapidPublic: '',
  enablePushRegistration: false,
  locale: 'en',
  emailEnabled: false,
  newPlexLogin: true,
  youtubeUrl: '',
  versionCheck: true,
  plexClientIdentifier: '',
  traktConfigured: false,
  anilistConfigured: false,
  simklConfigured: false,
  mediaActionsTraktEnabled: true,
  mediaActionsJellyfinEnabled: true,
  mediaActionsAnilistEnabled: true,
  mediaActionsSimklEnabled: true,
  mdblistConfigured: false,
  ratingBadges: { ...DEFAULT_RATING_BADGE_SETTINGS },
};

const isPublicRoute = (pathname: string): boolean =>
  /\/(login|setup|resetpassword)/.test(pathname);

const isSetupExemptRoute = (pathname: string): boolean =>
  /\/(setup|login\/plex)/.test(pathname);

const isLoginExemptRoute = (pathname: string): boolean =>
  /\/(login|setup|resetpassword)/.test(pathname);

const AppShell = ({
  user,
  currentSettings,
  locale,
  messages,
}: {
  user?: User;
  currentSettings: PublicSettingsResponse;
  locale: AvailableLocale;
  messages: Record<string, string>;
}) => {
  const location = useLocation();
  const [loadedMessages, setMessages] = useState(messages);
  const [currentLocale, setLocale] = useState<AvailableLocale>(locale);
  const { hasPermission } = useUser();

  useEffect(() => {
    void loadLocaleData(currentLocale).then(setMessages);
  }, [currentLocale]);

  useEffect(() => {
    const requestsCount = async () => {
      const response = await axios.get('/api/v1/request/count');
      return response.data;
    };

    const newNavigator = navigator as unknown as {
      setAppBadge?: (count: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };

    const handleBadgeUpdate = () => {
      if ('setAppBadge' in newNavigator) {
        if (
          !isPublicRoute(location.pathname) &&
          hasPermission(Permission.ADMIN)
        ) {
          requestsCount().then((data) => {
            if (data.pending > 0) {
              newNavigator.setAppBadge?.(data.pending);
            } else {
              newNavigator.clearAppBadge?.();
            }
          });
        } else {
          newNavigator.clearAppBadge?.();
        }
      }
    };

    handleBadgeUpdate();
    window.addEventListener('focus', handleBadgeUpdate);

    return () => {
      window.removeEventListener('focus', handleBadgeUpdate);
    };
  }, [hasPermission, location.pathname]);

  const content = isPublicRoute(location.pathname) ? (
    <Outlet />
  ) : (
    <Layout>
      <Outlet />
    </Layout>
  );

  return (
    <LanguageContext.Provider value={{ locale: currentLocale, setLocale }}>
      <IntlProvider
        locale={currentLocale}
        defaultLocale="en"
        messages={loadedMessages}
      >
        <LoadingBar />
        <SettingsProvider currentSettings={currentSettings}>
          <InteractionProvider>
            <Helmet>
              <title>{currentSettings.applicationTitle}</title>
              <meta
                name="viewport"
                content="initial-scale=1, viewport-fit=cover, width=device-width"
              />
            </Helmet>
            <PWAHeader applicationTitle={currentSettings.applicationTitle} />
            <StatusChecker />
            <ServiceWorkerSetup />
            <UserContext initialUser={user}>
              <NativeRuntimeProvider>
                <TvNavigationGate>{content}</TvNavigationGate>
              </NativeRuntimeProvider>
            </UserContext>
            <Toaster
              position="top-right"
              toastOptions={{ duration: 4000 }}
              containerStyle={{
                zIndex: 10000,
                paddingTop: 'env(safe-area-inset-top)',
              }}
            />
          </InteractionProvider>
        </SettingsProvider>
      </IntlProvider>
    </LanguageContext.Provider>
  );
};

const Bootstrap = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | undefined>();
  const [currentSettings, setCurrentSettings] =
    useState<PublicSettingsResponse>(defaultSettings);
  const [locale, setLocale] = useState<AvailableLocale>('en');
  const [messages, setMessages] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      await polyfillIntl();

      const settingsResponse = await axios.get<PublicSettingsResponse>(
        '/api/v1/settings/public'
      );
      const settings = settingsResponse.data;

      if (cancelled) {
        return;
      }

      setCurrentSettings(settings);

      if (!settings.initialized) {
        const localeData = await loadLocaleData(
          settings.locale as AvailableLocale
        );
        if (!cancelled) {
          setLocale(settings.locale as AvailableLocale);
          setMessages(localeData.default ?? localeData);
          setReady(true);
        }
        return;
      }

      try {
        const userResponse = await axios.get<User>('/api/v1/auth/me');
        if (cancelled) {
          return;
        }

        setUser(userResponse.data);

        const resolvedLocale = (userResponse.data.settings?.locale ??
          settings.locale) as AvailableLocale;
        const localeData = await loadLocaleData(resolvedLocale);
        if (!cancelled) {
          setLocale(resolvedLocale);
          setMessages(localeData.default ?? localeData);
          setReady(true);
        }
      } catch {
        const localeData = await loadLocaleData(
          settings.locale as AvailableLocale
        );
        if (!cancelled) {
          setLocale(settings.locale as AvailableLocale);
          setMessages(localeData.default ?? localeData);
          setReady(true);
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready) {
      return;
    }

    if (!currentSettings.initialized) {
      if (!isSetupExemptRoute(location.pathname)) {
        navigate('/setup', { replace: true });
      }
      return;
    }

    if (!user && !isLoginExemptRoute(location.pathname)) {
      navigate('/login', { replace: true });
      return;
    }

    if (user && /\/(setup|login)/.test(location.pathname)) {
      navigate('/', { replace: true });
    }
  }, [ready, currentSettings.initialized, user, location.pathname, navigate]);

  if (!ready) {
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <SWRConfig
      value={{
        fetcher: (url) => axios.get(url).then((res) => res.data),
        fallback: user ? { '/api/v1/auth/me': user } : undefined,
      }}
    >
      <AppShell
        user={user}
        currentSettings={currentSettings}
        locale={locale}
        messages={messages}
      />
    </SWRConfig>
  );
};

const AppRouteError = () => {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'Unknown error';

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-900 px-6 text-white">
      <h1 className="text-2xl font-bold">Something went wrong</h1>
      <pre className="mt-4 max-w-xl whitespace-pre-wrap text-sm text-red-300">
        {message}
      </pre>
    </div>
  );
};

const App = () => {
  const router = useMemo(
    () =>
      createBrowserRouter([
        {
          path: '/',
          element: <Bootstrap />,
          HydrateFallback: LoadingSpinner,
          children: [
            {
              errorElement: <AppRouteError />,
              children: buildRoutes(),
            },
          ],
        },
      ]),
    []
  );

  return <RouterProvider router={router} />;
};

export default App;
