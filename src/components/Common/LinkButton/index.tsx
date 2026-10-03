import type { ButtonType } from '@app/components/Common/Button/buttonClassName';
import { buttonClassName } from '@app/components/Common/Button/buttonClassName';
import type { LinkProps } from 'react-router';
import { Link } from 'react-router';

type LinkButtonProps = Omit<LinkProps, 'className'> & {
  buttonType?: ButtonType;
  buttonSize?: 'default' | 'lg' | 'md' | 'sm';
  className?: string;
};

/**
 * An in-app route link that looks like a Button. Wrapping `<Button as="a">` in
 * a router `Link` nests one anchor inside another, which is invalid HTML.
 */
const LinkButton = ({
  buttonType,
  buttonSize,
  className,
  children,
  ...props
}: LinkButtonProps) => (
  <Link
    className={buttonClassName({ buttonType, buttonSize, className })}
    {...props}
  >
    <span className="flex items-center">{children}</span>
  </Link>
);

export default LinkButton;
