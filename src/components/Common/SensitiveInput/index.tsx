import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/solid';
import { Field } from 'formik';
import { useState } from 'react';

type SensitiveInputLabels = {
  revealLabel?: string;
  hideLabel?: string;
};

interface CustomInputProps
  extends React.ComponentProps<'input'>, SensitiveInputLabels {
  as?: 'input';
}

interface CustomFieldProps
  extends React.ComponentProps<typeof Field>, SensitiveInputLabels {
  as?: 'field';
}

type SensitiveInputProps = CustomInputProps | CustomFieldProps;

const SensitiveInput = ({
  as = 'input',
  revealLabel = 'Show sensitive value',
  hideLabel = 'Hide sensitive value',
  ...props
}: SensitiveInputProps) => {
  const [isHidden, setHidden] = useState(true);
  const Component = as === 'input' ? 'input' : Field;
  const componentProps =
    as === 'input'
      ? props
      : {
          ...props,
          as: props.type === 'textarea' ? 'textarea' : undefined,
        };
  return (
    <>
      <Component
        autoComplete="off"
        data-form-type="other"
        data-1pignore="true"
        data-lpignore="true"
        {...componentProps}
        className={`rounded-l-only ${componentProps.className ?? ''}`}
        type={
          props.type === 'textarea'
            ? undefined
            : isHidden
              ? 'password'
              : props.type !== 'password'
                ? (props.type ?? 'text')
                : 'text'
        }
        style={
          props.type === 'textarea' && isHidden
            ? { WebkitTextSecurity: 'disc', ...props.style }
            : props.style
        }
      />
      <button
        onClick={(e) => {
          e.preventDefault();
          setHidden(!isHidden);
        }}
        type="button"
        aria-label={isHidden ? revealLabel : hideLabel}
        title={isHidden ? revealLabel : hideLabel}
        className="input-action"
      >
        {isHidden ? <EyeSlashIcon /> : <EyeIcon />}
      </button>
    </>
  );
};

export default SensitiveInput;
