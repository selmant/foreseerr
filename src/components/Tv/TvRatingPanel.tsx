import { starsToTrakt } from '@app/components/MediaActions/RatingStars';
import TvFocusable from '@app/components/Tv/TvFocusable';
import TvOverlay from '@app/components/Tv/TvOverlay';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Tv.TvRatingPanel', {
  title: 'Rate',
  score: '{score}/10',
});

interface TvRatingPanelProps {
  ratingStars: number | null;
  busy?: boolean;
  onSave: (ratingStars: number) => void | Promise<void>;
  onClose: () => void;
}

const TvRatingPanel = ({
  ratingStars,
  busy = false,
  onSave,
  onClose,
}: TvRatingPanelProps) => {
  const intl = useIntl();
  const current = ratingStars != null ? starsToTrakt(ratingStars) : null;

  return (
    <TvOverlay title={intl.formatMessage(messages.title)} onClose={onClose}>
      {Array.from({ length: 10 }, (_, index) => {
        const score = index + 1;
        const stars = score / 2;
        return (
          <TvFocusable
            key={score}
            onEnterPress={() => {
              if (!busy) {
                void onSave(stars);
              }
            }}
          >
            <button
              type="button"
              disabled={busy}
              className={`tv-focus-target min-h-12 w-full rounded-lg px-4 text-left text-lg ${
                current === score
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-800 text-white'
              }`}
              onClick={() => {
                if (!busy) {
                  void onSave(stars);
                }
              }}
            >
              {intl.formatMessage(messages.score, { score })}
            </button>
          </TvFocusable>
        );
      })}
    </TvOverlay>
  );
};

export default TvRatingPanel;
