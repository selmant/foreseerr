import ProgressCircle from '@app/components/Common/ProgressCircle';
import defineMessages from '@app/utils/defineMessages';
import { ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/solid';
import type { QuotaStatus } from '@server/interfaces/api/userInterfaces';
import { useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { Link } from 'react-router';

const messages = defineMessages('components.RequestModal.QuotaDisplay', {
  requestsremaining:
    '{remaining, plural, =0 {No} other {<strong>#</strong>}} {type} {remaining, plural, one {request} other {requests}} remaining',
  movielimit: '{limit, plural, one {movie} other {movies}}',
  seasonlimit: '{limit, plural, one {season} other {seasons}}',
  allowedRequests:
    'You are allowed to request <strong>{limit}</strong> {type}{days, plural, =0 {} one { every day} other { every <strong>{days}</strong> days}}.',
  allowedRequestsUser:
    'This user is allowed to request <strong>{limit}</strong> {type}{days, plural, =0 {} one { every day} other { every <strong>{days}</strong> days}}.',
  quotaLink:
    'You can view a summary of your request limits on your <ProfileLink>profile page</ProfileLink>.',
  quotaLinkUser:
    "You can view a summary of this user's request limits on their <ProfileLink>profile page</ProfileLink>.",
  movie: 'movie',
  season: 'season',
  notenoughseasonrequests: 'Not enough season requests remaining',
  requiredquota:
    'You need to have at least <strong>{seasons}</strong> {seasons, plural, one {season request} other {season requests}} remaining in order to submit a request for this series.',
  requiredquotaUser:
    'This user needs to have at least <strong>{seasons}</strong> {seasons, plural, one {season request} other {season requests}} remaining in order to submit a request for this series.',
});

interface QuotaDisplayProps {
  quota?: QuotaStatus;
  mediaType: 'movie' | 'tv';
  userOverride?: number | null;
  remaining?: number;
  overLimit?: number;
}

const QuotaDisplay = ({
  quota,
  mediaType,
  userOverride,
  remaining,
  overLimit,
}: QuotaDisplayProps) => {
  const intl = useIntl();
  const [showDetails, setShowDetails] = useState(false);
  const detailsId = useId();
  return (
    <div className="my-4 rounded-md border border-gray-700 p-4 backdrop-blur">
      <button
        type="button"
        aria-expanded={showDetails}
        aria-controls={detailsId}
        className="flex min-h-11 w-full items-center whitespace-normal rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        onClick={() => setShowDetails((s) => !s)}
      >
        <ProgressCircle
          className="h-8 w-8 shrink-0"
          progress={Math.round(
            ((remaining ?? quota?.remaining ?? 0) / (quota?.limit ?? 1)) * 100
          )}
          useHeatLevel
        />
        <span
          className={`min-w-0 flex-1 ${
            (remaining ?? quota?.remaining ?? 0) <= 0 || quota?.restricted
              ? 'text-red-500'
              : ''
          }`}
        >
          <span className="ml-2 block !whitespace-normal text-lg">
            {overLimit !== undefined
              ? intl.formatMessage(messages.notenoughseasonrequests)
              : intl.formatMessage(messages.requestsremaining, {
                  remaining: remaining ?? quota?.remaining ?? 0,
                  type: intl.formatMessage(
                    mediaType === 'movie' ? messages.movie : messages.season
                  ),
                  strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
                })}
          </span>
        </span>
        <span aria-hidden className="ml-2 shrink-0">
          {showDetails ? (
            <ChevronUpIcon className="h-6 w-6" />
          ) : (
            <ChevronDownIcon className="h-6 w-6" />
          )}
        </span>
      </button>
      <div id={detailsId} hidden={!showDetails} className="mt-4">
        {overLimit !== undefined && (
          <div className="mb-2">
            {intl.formatMessage(
              userOverride
                ? messages.requiredquotaUser
                : messages.requiredquota,
              {
                seasons: overLimit,
                strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
              }
            )}
          </div>
        )}
        <div>
          {intl.formatMessage(
            userOverride
              ? messages.allowedRequestsUser
              : messages.allowedRequests,
            {
              limit: quota?.limit,
              days: quota?.days,
              type: intl.formatMessage(
                mediaType === 'movie'
                  ? messages.movielimit
                  : messages.seasonlimit,
                { limit: quota?.limit }
              ),
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            }
          )}
        </div>
        <div className="mt-2">
          {intl.formatMessage(
            userOverride ? messages.quotaLinkUser : messages.quotaLink,
            {
              ProfileLink: (msg: React.ReactNode) => (
                <Link
                  to={userOverride ? `/users/${userOverride}` : '/profile'}
                  className="inline-flex min-h-11 items-center rounded text-white underline underline-offset-4 transition duration-300 hover:text-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  {msg}
                </Link>
              ),
            }
          )}
        </div>
      </div>
    </div>
  );
};

export default QuotaDisplay;
