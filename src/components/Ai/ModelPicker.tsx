import defineMessages from '@app/utils/defineMessages';
import type { AiModel } from '@shared/interfaces/api/aiInterfaces';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Ai.ModelPicker', {
  otherModel: 'Another model…',
  notListed: '{model} (not listed)',
  chooseFromList: 'Choose from the list',
  typeModel: 'Model name, like gpt-5-mini',
  loadingModels: 'Loading models…',
  noModelsListed:
    "This connection didn't list its models. Type the model's name.",
  pickModel: 'Pick a model',
});

const CUSTOM = '__custom__';

type ModelPickerProps = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  models?: AiModel[];
  loading?: boolean;
  /** Why the list couldn't load; the field becomes free text. */
  listError?: string;
  /** An empty choice, like "Same as Balanced". */
  emptyLabel?: string;
  disabled?: boolean;
};

/**
 * A model choice: the connection's models when it lists them, with a way
 * to type a model it doesn't list (local servers often don't).
 */
const ModelPicker = ({
  id,
  value,
  onChange,
  models,
  loading = false,
  listError,
  emptyLabel,
  disabled = false,
}: ModelPickerProps) => {
  const intl = useIntl();
  const listed = models ?? [];
  const [typing, setTyping] = useState(false);
  const inList = listed.some((m) => m.id === value);

  if (loading && !models) {
    return (
      <select id={id} disabled>
        <option>{intl.formatMessage(messages.loadingModels)}</option>
      </select>
    );
  }

  if (typing || listed.length === 0) {
    return (
      <div className="w-full">
        <input
          id={id}
          type="text"
          value={value}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          placeholder={intl.formatMessage(messages.typeModel)}
          onChange={(e) => onChange(e.target.value)}
        />
        {listed.length > 0 ? (
          <button
            type="button"
            className="mt-2 text-sm text-indigo-300 underline-offset-2 hover:underline"
            onClick={() => setTyping(false)}
          >
            {intl.formatMessage(messages.chooseFromList)}
          </button>
        ) : (
          <p className="mt-2 text-sm text-gray-400">
            {listError ?? intl.formatMessage(messages.noModelsListed)}
          </p>
        )}
      </div>
    );
  }

  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => {
        if (e.target.value === CUSTOM) {
          setTyping(true);
        } else {
          onChange(e.target.value);
        }
      }}
    >
      {emptyLabel !== undefined ? (
        <option value="">{emptyLabel}</option>
      ) : value === '' ? (
        <option value="" disabled>
          {intl.formatMessage(messages.pickModel)}
        </option>
      ) : null}
      {value !== '' && !inList ? (
        <option value={value}>
          {intl.formatMessage(messages.notListed, { model: value })}
        </option>
      ) : null}
      {listed.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
      <option value={CUSTOM}>{intl.formatMessage(messages.otherModel)}</option>
    </select>
  );
};

export default ModelPicker;
