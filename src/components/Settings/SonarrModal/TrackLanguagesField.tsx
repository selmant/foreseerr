import { useIntl } from 'react-intl';
import Select from 'react-select';

/** ISO 639-2/B codes (what the backend compares) and their 639-1 code. */
const LANGUAGES: [code: string, iso1: string][] = [
  ['ara', 'ar'],
  ['chi', 'zh'],
  ['cze', 'cs'],
  ['dan', 'da'],
  ['dut', 'nl'],
  ['eng', 'en'],
  ['fin', 'fi'],
  ['fre', 'fr'],
  ['ger', 'de'],
  ['gre', 'el'],
  ['heb', 'he'],
  ['hin', 'hi'],
  ['hun', 'hu'],
  ['ind', 'id'],
  ['ita', 'it'],
  ['jpn', 'ja'],
  ['kor', 'ko'],
  ['may', 'ms'],
  ['nor', 'no'],
  ['pol', 'pl'],
  ['por', 'pt'],
  ['rum', 'ro'],
  ['rus', 'ru'],
  ['spa', 'es'],
  ['swe', 'sv'],
  ['tha', 'th'],
  ['tur', 'tr'],
  ['ukr', 'uk'],
  ['vie', 'vi'],
];

type Option = { value: string; label: string };

/** The languages in the current locale's names, sorted by name. */
const useLanguageOptions = (): Option[] => {
  const intl = useIntl();
  let names: Intl.DisplayNames | undefined;
  try {
    names = new Intl.DisplayNames([intl.locale], { type: 'language' });
  } catch {
    names = undefined;
  }
  return LANGUAGES.map(([code, iso1]) => ({
    value: code,
    label: names?.of(iso1) ?? code.toUpperCase(),
  })).sort((a, b) => a.label.localeCompare(b.label, intl.locale));
};

/**
 * A multi-select of the languages an imported file's audio or subtitle
 * tracks must include.
 */
const TrackLanguagesField = ({
  id,
  label,
  help,
  placeholder,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  help?: string;
  placeholder: string;
  value: string[];
  disabled: boolean;
  onChange: (codes: string[]) => void;
}) => {
  const options = useLanguageOptions();
  return (
    <div className="form-row">
      <label htmlFor={id} className="text-label">
        {label}
        {help && <span className="label-tip">{help}</span>}
      </label>
      <div className="form-input-area">
        <Select<Option, true>
          inputId={id}
          options={options}
          isMulti
          isDisabled={disabled}
          placeholder={placeholder}
          className="react-select-container"
          classNamePrefix="react-select"
          value={value.map(
            (code) =>
              options.find((option) => option.value === code) ?? {
                value: code,
                label: code.toUpperCase(),
              }
          )}
          onChange={(selected) =>
            onChange(selected.map((option) => option.value))
          }
        />
      </div>
    </div>
  );
};

export default TrackLanguagesField;
