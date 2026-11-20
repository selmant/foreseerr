import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import type {
  PlayerSetting,
  PlayerSettingsPage,
  PlayerSettingsSchema,
} from '@app/context/foreseerrPlayer';
import {
  PLAYER_NOT_PAIRED,
  foreseerrPlayerHost,
  getPlayerSettings,
  pairPlayer,
  setPlayerSetting,
} from '@app/context/foreseerrPlayer';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserPlayerSettings',
  {
    title: 'Player',
    description:
      'How videos play in this app. These settings belong to the app on this device.',
    unavailable: 'Player settings are only available in the Foreseerr app.',
    notPaired:
      'The player has not signed in to your media server on this device yet.',
    connect: 'Connect Player',
    connecting: 'Connecting…',
    connectFailed: 'The player could not sign in.',
    loadFailed: 'Could not load the player settings: {error}',
    saveFailed: 'Could not change “{setting}”: {error}',
    search: 'Search player settings',
    noResults: 'No player settings match “{query}”.',
  }
);

const errorText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** Pages and sections keeping only the settings that match [query]. */
const filterPages = (
  pages: PlayerSettingsPage[],
  query: string
): PlayerSettingsPage[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return pages;
  return pages
    .map((page) => ({
      ...page,
      sections: page.sections
        .map((section) => ({
          ...section,
          settings: section.settings.filter((setting) => {
            const text = [
              ...page.path,
              section.title ?? '',
              setting.title,
              setting.description ?? '',
            ]
              .join(' ')
              .toLowerCase();
            return words.every((word) => text.includes(word));
          }),
        }))
        .filter((section) => section.settings.length > 0),
    }))
    .filter((page) => page.sections.length > 0);
};

/** The schema with one setting's value replaced, for an instant update. */
const withValue = (
  schema: PlayerSettingsSchema,
  key: string,
  value: unknown
): PlayerSettingsSchema => ({
  ...schema,
  pages: schema.pages.map((page) => ({
    ...page,
    sections: page.sections.map((section) => ({
      ...section,
      settings: section.settings.map((setting) =>
        setting.key === key ? ({ ...setting, value } as PlayerSetting) : setting
      ),
    })),
  })),
});

const SliderControl = ({
  setting,
  onChange,
}: {
  setting: Extract<PlayerSetting, { type: 'slider' }>;
  onChange: (value: number) => void;
}) => {
  const [draft, setDraft] = useState(setting.value);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => setDraft(setting.value), [setting.value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const label =
    setting.labels?.[String(draft)] ??
    (draft === setting.value ? setting.label : String(draft));
  return (
    <div className="flex max-w-xl items-center gap-4">
      <input
        type="range"
        className="w-full accent-indigo-500"
        min={setting.min}
        max={setting.max}
        step={setting.step}
        value={draft}
        disabled={!setting.enabled}
        aria-label={setting.title}
        onChange={(e) => {
          const value = Number(e.target.value);
          setDraft(value);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => onChange(value), 400);
        }}
      />
      <span className="w-24 shrink-0 text-right text-gray-300">{label}</span>
    </div>
  );
};

const SettingControl = ({
  setting,
  onChange,
}: {
  setting: PlayerSetting;
  onChange: (value: unknown) => void;
}) => {
  switch (setting.type) {
    case 'switch':
      return (
        <div
          className={`sm:mt-2 ${
            setting.enabled ? '' : 'pointer-events-none opacity-50'
          }`}
        >
          <SlideCheckbox
            checked={setting.value}
            onClick={() => onChange(!setting.value)}
          />
        </div>
      );
    case 'choice':
      return (
        <div className="form-input-field">
          <select
            value={String(setting.value ?? '')}
            disabled={!setting.enabled}
            aria-label={setting.title}
            onChange={(e) => {
              const picked = setting.options.find(
                (option) => String(option.value) === e.target.value
              );
              if (picked) onChange(picked.value);
            }}
          >
            {setting.options.map((option) => (
              <option key={String(option.value)} value={String(option.value)}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      );
    case 'multi': {
      const full = setting.max !== null && setting.value.length >= setting.max;
      return (
        <div className="flex max-w-xl flex-wrap gap-x-6 gap-y-2 sm:mt-2">
          {setting.options.map((option) => {
            const value = String(option.value);
            const checked = setting.value.includes(value);
            return (
              <label
                key={value}
                className="flex cursor-pointer items-center gap-2 font-normal text-gray-200"
              >
                <input
                  type="checkbox"
                  className="rounded-md"
                  checked={checked}
                  disabled={!setting.enabled || (!checked && full)}
                  onChange={() =>
                    onChange(
                      checked
                        ? setting.value.filter((v) => v !== value)
                        : [...setting.value, value]
                    )
                  }
                />
                {option.label}
              </label>
            );
          })}
        </div>
      );
    }
    case 'slider':
      return <SliderControl setting={setting} onChange={onChange} />;
  }
};

/**
 * The player app's own settings, drawn from the description the app sends.
 * Nothing here knows any particular setting.
 */
const UserPlayerSettings = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [schema, setSchema] = useState<PlayerSettingsSchema>();
  const [error, setError] = useState<string>();
  const [notPaired, setNotPaired] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [query, setQuery] = useState('');
  const inApp = !!foreseerrPlayerHost();

  const load = useCallback(async () => {
    setError(undefined);
    try {
      setSchema(await getPlayerSettings());
      setNotPaired(false);
    } catch (e) {
      if (errorText(e) === PLAYER_NOT_PAIRED) {
        setNotPaired(true);
      } else {
        setError(errorText(e));
      }
    }
  }, []);

  useEffect(() => {
    if (inApp) void load();
  }, [inApp, load]);

  const change = useCallback(
    async (setting: PlayerSetting, value: unknown) => {
      setSchema((current) =>
        current ? withValue(current, setting.key, value) : current
      );
      try {
        setSchema(await setPlayerSetting(setting.key, value));
      } catch (e) {
        addToast(
          intl.formatMessage(messages.saveFailed, {
            setting: setting.title,
            error: errorText(e),
          }),
          { appearance: 'error', autoDismiss: true }
        );
        void load();
      }
    },
    [addToast, intl, load]
  );

  const connect = async () => {
    setConnecting(true);
    try {
      if (!(await pairPlayer())) {
        addToast(intl.formatMessage(messages.connectFailed), {
          appearance: 'error',
          autoDismiss: true,
        });
      }
      await load();
    } catch (e) {
      addToast(errorText(e), { appearance: 'error', autoDismiss: true });
    } finally {
      setConnecting(false);
    }
  };

  const pages = useMemo(
    () => (schema ? filterPages(schema.pages, query) : []),
    [schema, query]
  );

  const header = (
    <div className="mb-6">
      <h3 className="heading">{intl.formatMessage(messages.title)}</h3>
      <p className="description">{intl.formatMessage(messages.description)}</p>
    </div>
  );

  if (!inApp) {
    return (
      <>
        {header}
        <Alert title={intl.formatMessage(messages.unavailable)} type="info" />
      </>
    );
  }

  if (notPaired) {
    return (
      <>
        {header}
        <Alert title={intl.formatMessage(messages.notPaired)} type="info" />
        <Button
          buttonType="primary"
          disabled={connecting}
          onClick={() => void connect()}
        >
          {intl.formatMessage(
            connecting ? messages.connecting : messages.connect
          )}
        </Button>
      </>
    );
  }

  if (error) {
    return (
      <>
        {header}
        <Alert
          title={intl.formatMessage(messages.loadFailed, { error })}
          type="error"
        />
      </>
    );
  }

  if (!schema) return <LoadingSpinner />;

  return (
    <>
      {header}
      <div className="form-input-field mb-2">
        <input
          type="search"
          value={query}
          placeholder={intl.formatMessage(messages.search)}
          aria-label={intl.formatMessage(messages.search)}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {pages.length === 0 && (
        <p className="description">
          {intl.formatMessage(messages.noResults, { query })}
        </p>
      )}
      {pages.map((page) => (
        <div key={page.path.join('/')} className="section">
          <h4 className="text-xl font-bold leading-7 text-gray-100">
            {page.path.join(' › ')}
          </h4>
          {page.sections.map((section, index) => (
            <div key={`${section.title ?? ''}-${index}`} className="mt-4">
              {section.title && (
                <h5 className="mt-6 text-sm font-semibold uppercase tracking-wide text-gray-400">
                  {section.title}
                </h5>
              )}
              {section.settings.map((setting) => (
                <div key={setting.key} className="form-row">
                  <label className="text-label">
                    {setting.title}
                    {setting.description && (
                      <span className="label-tip">{setting.description}</span>
                    )}
                  </label>
                  <div className="form-input-area">
                    <SettingControl
                      setting={setting}
                      onChange={(value) => void change(setting, value)}
                    />
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </>
  );
};

export default UserPlayerSettings;
