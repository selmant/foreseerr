import useSettings from '@app/hooks/useSettings';
import { Helmet } from 'react-helmet-async';

interface PageTitleProps {
  title: string | (string | undefined)[];
}

const PageTitle = ({ title }: PageTitleProps) => {
  const settings = useSettings();

  const appTitle = settings.currentSettings.applicationTitle || 'Foreseerr';
  const titleText = `${
    Array.isArray(title) ? title.filter(Boolean).join(' - ') : title
  } - ${appTitle}`;

  return (
    <Helmet>
      <title>{titleText}</title>
    </Helmet>
  );
};

export default PageTitle;
