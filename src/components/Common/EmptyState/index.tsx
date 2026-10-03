import type { ComponentType, ReactNode, SVGProps } from 'react';

interface EmptyStateProps {
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

const EmptyState = ({
  icon: Icon,
  title,
  description,
  action,
}: EmptyStateProps) => (
  <div className="rounded-lg border border-dashed border-gray-600 bg-gray-800/40 px-6 py-16 text-center">
    {Icon ? <Icon className="mx-auto h-10 w-10 text-gray-500" /> : null}
    <h2 className={`${Icon ? 'mt-4' : ''}text-lg font-semibold text-white`}>
      {title}
    </h2>
    {description ? (
      <p className="mx-auto mt-2 max-w-md text-sm text-gray-400">
        {description}
      </p>
    ) : null}
    {action ? <div className="mt-5">{action}</div> : null}
  </div>
);

export default EmptyState;
