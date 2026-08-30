import PageTitle from '@app/components/Common/PageTitle';
import defineMessages from '@app/utils/defineMessages';
import { ArrowRightCircleIcon } from '@heroicons/react/24/outline';
import { useIntl } from 'react-intl';
import { Link } from 'react-router';

interface ErrorProps {
  statusCode?: number;
}

const messages = defineMessages('pages', {
  errormessagewithcode: '{statusCode} - {error}',
  internalservererror: 'Internal Server Error',
  serviceunavailable: 'Service Unavailable',
  somethingwentwrong: 'Something Went Wrong',
  oops: 'Oops',
  returnHome: 'Return Home',
});

const ErrorPage = ({ statusCode }: ErrorProps) => {
  const intl = useIntl();

  const getErrorMessage = (statusCode?: number) => {
    switch (statusCode) {
      case 500:
        return intl.formatMessage(messages.internalservererror);
      case 503:
        return intl.formatMessage(messages.serviceunavailable);
      default:
        return statusCode
          ? intl.formatMessage(messages.somethingwentwrong)
          : intl.formatMessage(messages.oops);
    }
  };
  return (
    <div className="error-message">
      <PageTitle title={getErrorMessage(statusCode)} />
      <div className="text-4xl">
        {statusCode
          ? intl.formatMessage(messages.errormessagewithcode, {
              statusCode,
              error: getErrorMessage(statusCode),
            })
          : getErrorMessage(statusCode)}
      </div>
      <Link to="/" className="mt-2 flex">
        {intl.formatMessage(messages.returnHome)}
        <ArrowRightCircleIcon className="ml-2 h-6 w-6" />
      </Link>
    </div>
  );
};

export default ErrorPage;
