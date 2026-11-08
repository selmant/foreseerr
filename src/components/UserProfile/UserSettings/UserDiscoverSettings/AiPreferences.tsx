import TasteCard from '@app/components/Ai/TasteCard';
import { aiErrorOf } from '@app/components/Ai/aiError';
import Alert from '@app/components/Common/Alert';
import LinkButton from '@app/components/Common/LinkButton';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import type { AiMe } from '@shared/interfaces/api/aiInterfaces';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserDiscoverSettings.AiPreferences',
  {
    title: 'AI recommendations',
    hint: 'Personalize AI Picks and your AI Discover rows. History changes save immediately.',
    account: 'Manage AI account',
    history: 'Use my watch history',
    historyHint:
      'Include a summary of what you have watched, rated and saved from your media server and linked trackers. Your prompt, taste card and feedback can still be sent to your AI provider when this is off. With web search enabled, searches based on your request and taste are sent through SearXNG.',
    historySince: 'On since {date}.',
    loadFailed: 'Unable to load your AI preferences.',
    disabled: 'AI features are turned off on this server.',
  }
);

/** Personal recommendation preferences, separate from linked credentials. */
const AiPreferences = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<AiMe>('/api/v1/ai/me');
  const [saving, setSaving] = useState(false);

  const saveHistory = async (useHistory: boolean) => {
    setSaving(true);
    try {
      const res = await axios.post<AiMe>('/api/v1/ai/me', { useHistory });
      await mutate(res.data, { revalidate: false });
    } catch (e) {
      addToast(aiErrorOf(e, intl.formatMessage(globalMessages.error)).message, {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setSaving(false);
    }
  };

  if (data && !data.enabled && !data.preferences.useHistory) return null;

  return (
    <section id="ai-preferences" className="section scroll-mt-24">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">
            {intl.formatMessage(messages.title)}
          </h3>
          <p className="description">{intl.formatMessage(messages.hint)}</p>
        </div>
        <LinkButton to="/profile/settings/linked-accounts#ai-account">
          {intl.formatMessage(messages.account)}
        </LinkButton>
      </div>
      {error ? (
        <Alert type="error" title={intl.formatMessage(messages.loadFailed)} />
      ) : null}
      {data ? (
        <div className="space-y-5">
          {!data.enabled ? (
            <Alert type="info" title={intl.formatMessage(messages.disabled)} />
          ) : null}
          <div className="form-row">
            <label htmlFor="ai-history" className="checkbox-label">
              {intl.formatMessage(messages.history)}
              <span className="label-tip">
                {intl.formatMessage(messages.historyHint)}
              </span>
              {data.preferences.useHistory &&
              data.preferences.historyConsentAt ? (
                <span className="label-tip">
                  {intl.formatMessage(messages.historySince, {
                    date: intl.formatDate(data.preferences.historyConsentAt, {
                      dateStyle: 'medium',
                    }),
                  })}
                </span>
              ) : null}
            </label>
            <div className="form-input-area">
              <input
                id="ai-history"
                type="checkbox"
                checked={data.preferences.useHistory}
                disabled={
                  saving || (!data.enabled && !data.preferences.useHistory)
                }
                onChange={(e) => void saveHistory(e.target.checked)}
              />
            </div>
          </div>
          {data.enabled ? <TasteCard /> : null}
        </div>
      ) : null}
    </section>
  );
};

export default AiPreferences;
