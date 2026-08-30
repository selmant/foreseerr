import useSettings from '@app/hooks/useSettings';
import { Helmet } from 'react-helmet-async';

interface PageTitleProps {
  title: string | (string | undefined)[];
}

const PageTitle = ({ title }: PageTitleProps) => {
  const settings = useSettings();

  const titleText = `${
    Array.isArray(title) ? title.filter(Boolean).join(' - ') : title
  } - ${settings.currentSettings.applicationTitle}`;

  return (
    <Helmet>
      <title>{titleText}</title>
    </Helmet>
  );
};

export default PageTitle;
