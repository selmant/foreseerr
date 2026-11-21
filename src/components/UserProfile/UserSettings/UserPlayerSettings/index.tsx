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
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
    saved: 'Player settings saved.',
    discard: 'Discard Changes',
    unsaved:
      '{count, plural, one {# unsaved change} other {# unsaved changes}}',
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

/** The schema as it would be with the unsaved [changes] made. */
const withChanges = (
  schema: PlayerSettingsSchema,
  changes: Map<string, unknown>
): PlayerSettingsSchema => {
  if (changes.size === 0) return schema;
  const change = (setting: PlayerSetting): PlayerSetting => {
    if (!changes.has(setting.key)) return setting;
    const value = changes.get(setting.key);
    if (setting.type === 'slider') {
      const label = setting.labels?.[String(value)] ?? String(value);
      return { ...setting, value: value as number, label };
    }
    return { ...setting, value } as PlayerSetting;
  };
  return {
    ...schema,
    pages: schema.pages.map((page) => ({
      ...page,
      sections: page.sections.map((section) => ({
        ...section,
        settings: section.settings.map(change),
      })),
    })),
  };
};

/** Every setting in [schema] by key. */
const settingsByKey = (
  schema: PlayerSettingsSchema
): Map<string, PlayerSetting> =>
  new Map(
    schema.pages.flatMap((page) =>
      page.sections.flatMap((section) =>
        section.settings.map((setting) => [setting.key, setting] as const)
      )
    )
  );

const sameValue = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

const SliderControl = ({
  setting,
  onChange,
}: {
  setting: Extract<PlayerSetting, { type: 'slider' }>;
  onChange: (value: number) => void;
}) => {
  return (
    <div className="flex max-w-xl items-center gap-4">
      <input
        type="range"
        className="w-full accent-indigo-500"
        min={setting.min}
        max={setting.max}
        step={setting.step}
        value={setting.value}
        disabled={!setting.enabled}
        aria-label={setting.title}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="w-24 shrink-0 text-right text-gray-300">
        {setting.label}
      </span>
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
            onClick={() => {
              // The switch stays focusable, so Enter still reaches here.
              if (setting.enabled) onChange(!setting.value);
            }}
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
  // Unsaved changes, by key, in the order they were made.
  const [changes, setChanges] = useState<Map<string, unknown>>(new Map());
  const [saving, setSaving] = useState(false);
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

  // Not while saving: the save replaces the changes when it is done.
  const change = useCallback(
    (setting: PlayerSetting, value: unknown) =>
      !saving &&
      setChanges((current) => {
        const next = new Map(current);
        next.delete(setting.key);
        const saved = schema && settingsByKey(schema).get(setting.key);
        if (!saved || !sameValue(saved.value, value)) {
          next.set(setting.key, value);
        }
        return next;
      }),
    [saving, schema]
  );

  // Sets the changes one at a time, in the order they were made: one can
  // turn on or change what another offers.
  const save = async () => {
    if (!schema) return;
    setSaving(true);
    let latest = schema;
    const failed = new Map<string, unknown>();
    for (const [key, value] of changes) {
      try {
        latest = await setPlayerSetting(key, value);
      } catch (e) {
        failed.set(key, value);
        addToast(
          intl.formatMessage(messages.saveFailed, {
            setting: settingsByKey(latest).get(key)?.title ?? key,
            error: errorText(e),
          }),
          { appearance: 'error', autoDismiss: true }
        );
      }
    }
    setSchema(latest);
    setChanges(failed);
    setSaving(false);
    if (failed.size === 0) {
      addToast(intl.formatMessage(messages.saved), {
        appearance: 'success',
        autoDismiss: true,
      });
    }
  };

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
    () =>
      schema ? filterPages(withChanges(schema, changes).pages, query) : [],
    [schema, changes, query]
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
                      onChange={(value) => change(setting, value)}
                    />
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
      <div className="actions sticky bottom-0 bg-gray-900 pb-5">
        <div className="flex items-center justify-end">
          {changes.size > 0 && (
            <span className="mr-auto text-sm text-gray-400">
              {intl.formatMessage(messages.unsaved, { count: changes.size })}
            </span>
          )}
          <span className="ml-3 inline-flex rounded-md shadow-sm">
            <Button
              buttonType="default"
              disabled={saving || changes.size === 0}
              onClick={() => setChanges(new Map())}
            >
              <span>{intl.formatMessage(messages.discard)}</span>
            </Button>
          </span>
          <span className="ml-3 inline-flex rounded-md shadow-sm">
            <Button
              buttonType="primary"
              disabled={saving || changes.size === 0}
              onClick={() => void save()}
            >
              <ArrowDownOnSquareIcon />
              <span>
                {intl.formatMessage(
                  saving ? globalMessages.saving : globalMessages.save
                )}
              </span>
            </Button>
          </span>
        </div>
      </div>
    </>
  );
};

export default UserPlayerSettings;
