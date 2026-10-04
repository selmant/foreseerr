import Button from '@app/components/Common/Button';
import useClickOutside from '@app/hooks/useClickOutside';
import { forwardRef, useRef, useState, type ButtonHTMLAttributes } from 'react';

interface ConfirmButtonProps extends Pick<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'disabled' | 'aria-busy' | 'aria-describedby'
> {
  onClick: () => void;
  confirmText: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

const ConfirmButton = forwardRef<HTMLButtonElement, ConfirmButtonProps>(
  ({ onClick, children, confirmText, className, ...props }, parentRef) => {
    const ref = useRef(null);
    useClickOutside(ref, () => setIsClicked(false));
    const [isClicked, setIsClicked] = useState(false);
    return (
      <Button
        {...props}
        ref={parentRef}
        buttonType="danger"
        className={`relative overflow-hidden ${className}`}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && isClicked) {
            event.preventDefault();
            event.stopPropagation();
            setIsClicked(false);
          }
        }}
        onClick={(e) => {
          e.preventDefault();

          if (!isClicked) {
            setIsClicked(true);
          } else {
            onClick();
          }
        }}
      >
        <div
          ref={ref}
          aria-hidden={isClicked}
          className={`relative inset-0 flex h-full w-full transform-gpu items-center justify-center transition duration-300 ${
            isClicked
              ? '-translate-y-full opacity-0'
              : 'translate-y-0 opacity-100'
          }`}
        >
          {children}
        </div>
        <div
          ref={ref}
          aria-hidden={!isClicked}
          className={`absolute inset-0 flex h-full w-full transform-gpu items-center justify-center transition duration-300 ${
            isClicked
              ? 'translate-y-0 opacity-100'
              : 'translate-y-full opacity-0'
          }`}
        >
          {confirmText}
        </div>
      </Button>
    );
  }
);

ConfirmButton.displayName = 'ConfirmButton';

export default ConfirmButton;
