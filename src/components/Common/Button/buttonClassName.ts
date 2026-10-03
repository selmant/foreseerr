import { twMerge } from 'tailwind-merge';

export type ButtonType =
  | 'default'
  | 'primary'
  | 'danger'
  | 'warning'
  | 'success'
  | 'ghost';

export const buttonClassName = ({
  buttonType = 'default',
  buttonSize = 'default',
  className,
}: {
  buttonType?: ButtonType;
  buttonSize?: 'default' | 'lg' | 'md' | 'sm';
  className?: string;
}) => {
  const buttonStyle = [
    'inline-flex items-center justify-center border leading-5 font-medium rounded-md focus:outline-none transition ease-in-out duration-150 cursor-pointer disabled:opacity-50 whitespace-nowrap',
  ];
  switch (buttonType) {
    case 'primary':
      buttonStyle.push(
        'text-white border border-indigo-500 bg-indigo-600/80 hover:bg-indigo-600 hover:border-indigo-500 focus:border-indigo-700 focus:ring-indigo active:bg-indigo-600 active:border-indigo-700'
      );
      break;
    case 'danger':
      buttonStyle.push(
        'text-white bg-red-600/80 border-red-500 hover:bg-red-600 hover:border-red-500 focus:border-red-700 focus:ring-red active:bg-red-700 active:border-red-700'
      );
      break;
    case 'warning':
      buttonStyle.push(
        'text-white border border-yellow-500 bg-yellow-500/80 hover:bg-yellow-500 hover:border-yellow-400 focus:border-yellow-700 focus:ring-yellow active:bg-yellow-500 active:border-yellow-700'
      );
      break;
    case 'success':
      buttonStyle.push(
        'text-white bg-green-500/80 border-green-500 hover:bg-green-500 hover:border-green-400 focus:border-green-700 focus:ring-green active:bg-green-500 active:border-green-700'
      );
      break;
    case 'ghost':
      buttonStyle.push(
        'text-white bg-transparent border-gray-600 hover:border-gray-200 focus:border-gray-100 active:border-gray-100'
      );
      break;
    default:
      buttonStyle.push(
        'text-gray-200 bg-gray-800/80 border-gray-600 hover:text-white hover:bg-gray-700 hover:border-gray-600 group-hover:text-white group-hover:bg-gray-700 group-hover:border-gray-600 focus:border-blue-300 focus:ring-blue active:text-gray-200 active:bg-gray-700 active:border-gray-600'
      );
  }

  switch (buttonSize) {
    case 'sm':
      buttonStyle.push('px-2.5 py-1.5 text-xs button-sm');
      break;
    case 'lg':
      buttonStyle.push('px-6 py-3 text-base button-lg');
      break;
    case 'md':
    default:
      buttonStyle.push('px-4 py-2 text-sm button-md');
  }

  buttonStyle.push(className ?? '');

  return twMerge(buttonStyle);
};
