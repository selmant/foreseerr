import Dropdown from '@app/components/Common/Dropdown';
import { withProperties } from '@app/utils/typeHelpers';
import { Menu } from '@headlessui/react';
import { ChevronDownIcon } from '@heroicons/react/24/solid';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from 'react';

type ButtonWithDropdownProps = {
  text: React.ReactNode;
  dropdownIcon?: React.ReactNode;
  buttonType?: 'primary' | 'ghost';
  /**
   * When set (and no menu children), chevron runs this directly.
   * Useful inside overflow-hidden parents where a Menu would be clipped.
   */
  dropdownAction?: ButtonHTMLAttributes<HTMLButtonElement>['onClick'];
} & (
  | ({ as?: 'button' } & ButtonHTMLAttributes<HTMLButtonElement>)
  | ({ as: 'a' } & AnchorHTMLAttributes<HTMLAnchorElement>)
);

const ButtonWithDropdown = ({
  text,
  children,
  dropdownIcon,
  dropdownAction,
  className,
  buttonType = 'primary',
  ...props
}: ButtonWithDropdownProps) => {
  const styleClasses = {
    mainButtonClasses: 'button-md text-white border',
    dropdownSideButtonClasses: 'button-md border',
  };

  switch (buttonType) {
    case 'ghost':
      styleClasses.mainButtonClasses +=
        ' bg-transparent border-gray-600 hover:border-gray-200 focus:border-gray-100 active:border-gray-100';
      styleClasses.dropdownSideButtonClasses = styleClasses.mainButtonClasses;
      break;
    default:
      styleClasses.mainButtonClasses +=
        ' bg-indigo-600/80 border-indigo-500 hover:bg-indigo-600 hover:border-indigo-500 active:bg-indigo-700 active:border-indigo-700 focus:ring-blue';
      styleClasses.dropdownSideButtonClasses +=
        ' bg-indigo-600/80 border-indigo-500 hover:bg-indigo-600 active:bg-indigo-600 focus:ring-blue';
  }

  const TriggerElement = props.as ?? 'button';
  const hasMenu = Boolean(children);
  const hasSideButton = hasMenu || Boolean(dropdownAction);
  const isDisabled = Boolean(
    (props as ButtonHTMLAttributes<HTMLButtonElement>).disabled
  );

  return (
    <Menu as="div" className="relative z-10 inline-flex">
      <TriggerElement
        type="button"
        className={`relative z-10 inline-flex h-full items-center px-4 py-2 text-sm font-medium leading-5 transition duration-150 ease-in-out hover:z-20 focus:z-20 focus:outline-none ${
          styleClasses.mainButtonClasses
        } ${hasSideButton ? 'rounded-l-md' : 'rounded-md'} ${className}`}
        {...(props as Record<string, string>)}
      >
        {text}
      </TriggerElement>
      {hasMenu ? (
        <span className="relative -ml-px block">
          <Menu.Button
            type="button"
            disabled={isDisabled}
            className={`relative z-10 inline-flex h-full items-center rounded-r-md px-2 py-2 text-sm font-medium leading-5 text-white transition duration-150 ease-in-out hover:z-20 focus:z-20 ${styleClasses.dropdownSideButtonClasses}`}
            aria-label="Expand"
          >
            {dropdownIcon ? dropdownIcon : <ChevronDownIcon />}
          </Menu.Button>
          <Dropdown.Items dropdownType={buttonType}>{children}</Dropdown.Items>
        </span>
      ) : dropdownAction ? (
        <span className="relative -ml-px block">
          <button
            type="button"
            disabled={isDisabled}
            className={`relative z-10 inline-flex h-full items-center rounded-r-md px-2 py-2 text-sm font-medium leading-5 text-white transition duration-150 ease-in-out hover:z-20 focus:z-20 disabled:cursor-not-allowed disabled:opacity-50 ${styleClasses.dropdownSideButtonClasses}`}
            aria-label="Request all seasons"
            onClick={dropdownAction}
          >
            {dropdownIcon ? dropdownIcon : <ChevronDownIcon />}
          </button>
        </span>
      ) : null}
    </Menu>
  );
};
export default withProperties(ButtonWithDropdown, { Item: Dropdown.Item });
