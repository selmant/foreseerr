import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import MultiRangeSlider from '@app/components/Common/MultiRangeSlider';
import PageTitle from '@app/components/Common/PageTitle';
import { genreColorMap } from '@app/components/Discover/constants';
import LanguageSelector from '@app/components/LanguageSelector';
import { GenreSelector } from '@app/components/Selector';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import Datepicker from '@seerr-team/react-tailwindcss-datepicker';
import type { DiscoverFilterDefaults } from '@server/lib/discover/filterDefaults';
import axios from 'axios';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const TV_GENRE_IDS = new Set(
  [10759, 10762, 10763, 10764, 10765, 10766, 10767, 10768].filter(
    (id) => id in genreColorMap
  )
);

const splitGenreDefaults = (genre?: string) => {
  const movie: string[] = [];
  const tv: string[] = [];
  if (!genre) {
    return { movie: '', tv: '' };
  }
  for (const part of genre.split(',')) {
    const id = part.trim();
    if (!id) continue;
    if (TV_GENRE_IDS.has(Number(id))) {
      tv.push(id);
    } else {
      movie.push(id);
    }
  }
  return { movie: movie.join(','), tv: tv.join(',') };
};

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserDiscoverSettings',
  {
    discover: 'Discover',
    discoversettings: 'Discover Filter Defaults',
    discoversettingsTip:
      'These filters apply on Discover pages when you have not set a session override. Clearing filters in Discover turns them off until you open a new browser session.',
    hideWatched: 'Hide watched',
    hideWatchedTip:
      'Uses Jellyfin and Trakt watch history when either is available.',
    hideCollected: 'Hide collected',
    hideWatchlisted: 'Hide watchlisted',
    traktOptions: 'Trakt',
    watchedOptions: 'Watched',
    releaseDate: 'Movie release date',
    firstAirDate: 'Series first air date',
    from: 'From',
    to: 'To',
    genresMovie: 'Movie genres',
    genresTv: 'Series genres',
    originalLanguage: 'Original language',
    tmdbuserscore: 'TMDB user score',
    tmdbuservotecount: 'TMDB user vote count',
    ratingText: 'Ratings between {minValue} and {maxValue}',
    voteCount: 'Number of votes between {minValue} and {maxValue}',
    externalRatings: 'External ratings (MDBList)',
    imdbScore: 'IMDb rating',
    imdbScoreText: 'IMDb between {minValue} and {maxValue}',
    imdbVotes: 'IMDb vote count',
    imdbVotesText: 'IMDb votes between {minValue} and {maxValue}',
    rtCritics: 'RT critics',
    rtCriticsText: 'RT critics between {minValue} and {maxValue}',
    rtAudience: 'RT audience',
    rtAudienceText: 'RT audience between {minValue} and {maxValue}',
    metacritic: 'Metacritic',
    metacriticText: 'Metacritic between {minValue} and {maxValue}',
    traktScore: 'Trakt community',
    traktScoreText: 'Trakt between {minValue} and {maxValue}',
    includeNoRating: 'Keep titles with missing external ratings',
    toastSettingsSuccess: 'Discover defaults saved!',
    toastSettingsFailure:
      'Something went wrong while saving Discover defaults.',
    clearDefaults: 'Clear all defaults',
  }
);

const mergeGenreIds = (
  current: string | undefined,
  next: string | undefined
) => {
  const parts = new Set<string>();
  for (const raw of [current, next]) {
    if (!raw) continue;
    for (const part of raw.split(',')) {
      const id = part.trim();
      if (id) parts.add(id);
    }
  }
  return parts.size ? Array.from(parts).join(',') : undefined;
};

const UserDiscoverSettings = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const router = useRouter();
  const { currentSettings } = useSettings();
  const { user } = useUser({ id: Number(router.query.userId) });
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<DiscoverFilterDefaults>(
    user ? `/api/v1/user/${user.id}/settings/discover` : null
  );
  const [draft, setDraft] = useState<DiscoverFilterDefaults>({});
  const [movieGenres, setMovieGenres] = useState('');
  const [tvGenres, setTvGenres] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (data) {
      setDraft(data);
      const split = splitGenreDefaults(data.genre);
      setMovieGenres(split.movie);
      setTvGenres(split.tv);
    }
  }, [data]);

  useEffect(() => {
    const genre = mergeGenreIds(movieGenres, tvGenres);
    setDraft((prev) => {
      if ((prev.genre ?? '') === (genre ?? '')) {
        return prev;
      }
      const next = { ...prev };
      if (genre) {
        next.genre = genre;
      } else {
        delete next.genre;
      }
      return next;
    });
  }, [movieGenres, tvGenres]);

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!user || error) {
    return <ErrorPage statusCode={500} />;
  }

  const setBool = (key: keyof DiscoverFilterDefaults, value: boolean) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const setString = (key: keyof DiscoverFilterDefaults, value?: string) => {
    setDraft((prev) => {
      const next = { ...prev };
      if (value == null || value === '') {
        delete next[key];
      } else {
        (next as Record<string, string | boolean>)[key] = value;
      }
      return next;
    });
  };

  const save = async (payload: DiscoverFilterDefaults) => {
    setIsSaving(true);
    try {
      await axios.post(`/api/v1/user/${user.id}/settings/discover`, payload);
      await revalidate();
      addToast(intl.formatMessage(messages.toastSettingsSuccess), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.toastSettingsFailure), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.discover),
          intl.formatMessage(globalMessages.usersettings),
          user.displayName,
        ]}
      />
      <div className="mb-6">
        <h3 className="text-2xl font-extrabold text-gray-100">
          {intl.formatMessage(messages.discoversettings)}
        </h3>
        <p className="mt-1 text-sm text-gray-400">
          {intl.formatMessage(messages.discoversettingsTip)}
        </p>
      </div>

      <div className="section space-y-6">
        <div>
          <div className="mb-2 text-lg font-semibold text-gray-100">
            {intl.formatMessage(messages.watchedOptions)}
          </div>
          <div className="flex flex-col gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-200">
              <input
                type="checkbox"
                className="rounded border-gray-500 bg-gray-800 text-indigo-500"
                checked={draft.ignoreWatched === true}
                onChange={(e) => {
                  if (e.target.checked) {
                    setBool('ignoreWatched', true);
                  } else {
                    setDraft((prev) => {
                      const next = { ...prev };
                      delete next.ignoreWatched;
                      return next;
                    });
                  }
                }}
              />
              {intl.formatMessage(messages.hideWatched)}
            </label>
            <p className="text-xs text-gray-400">
              {intl.formatMessage(messages.hideWatchedTip)}
            </p>
          </div>
        </div>

        <div>
          <div className="mb-2 text-lg font-semibold text-gray-100">
            {intl.formatMessage(messages.traktOptions)}
          </div>
          <div className="flex flex-col gap-2">
            {(
              [
                ['ignoreCollected', messages.hideCollected],
                ['ignoreWatchlisted', messages.hideWatchlisted],
              ] as const
            ).map(([key, label]) => (
              <label
                key={key}
                className="flex cursor-pointer items-center gap-2 text-sm text-gray-200"
              >
                <input
                  type="checkbox"
                  className="rounded border-gray-500 bg-gray-800 text-indigo-500"
                  checked={draft[key] === true}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setBool(key, true);
                    } else {
                      setDraft((prev) => {
                        const next = { ...prev };
                        delete next[key];
                        return next;
                      });
                    }
                  }}
                />
                {intl.formatMessage(label)}
              </label>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-2 text-lg font-semibold">
            {intl.formatMessage(messages.releaseDate)}
          </div>
          <div className="relative z-40 flex space-x-2">
            <div className="flex flex-col">
              <div className="mb-2">{intl.formatMessage(messages.from)}</div>
              <Datepicker
                primaryColor="indigo"
                value={{
                  startDate: draft.primaryReleaseDateGte ?? null,
                  endDate: draft.primaryReleaseDateGte ?? null,
                }}
                onChange={(value) =>
                  setString(
                    'primaryReleaseDateGte',
                    value?.startDate ? String(value.startDate) : undefined
                  )
                }
                inputName="moviefrom"
                useRange={false}
                asSingle
                containerClassName="datepicker-wrapper"
                inputClassName="pr-1 sm:pr-4 text-base leading-5"
              />
            </div>
            <div className="flex flex-col">
              <div className="mb-2">{intl.formatMessage(messages.to)}</div>
              <Datepicker
                primaryColor="indigo"
                value={{
                  startDate: draft.primaryReleaseDateLte ?? null,
                  endDate: draft.primaryReleaseDateLte ?? null,
                }}
                onChange={(value) =>
                  setString(
                    'primaryReleaseDateLte',
                    value?.startDate ? String(value.startDate) : undefined
                  )
                }
                inputName="movieto"
                useRange={false}
                asSingle
                containerClassName="datepicker-wrapper"
                inputClassName="pr-1 sm:pr-4 text-base leading-5"
              />
            </div>
          </div>
        </div>

        <div>
          <div className="mb-2 text-lg font-semibold">
            {intl.formatMessage(messages.firstAirDate)}
          </div>
          <div className="relative z-40 flex space-x-2">
            <div className="flex flex-col">
              <div className="mb-2">{intl.formatMessage(messages.from)}</div>
              <Datepicker
                primaryColor="indigo"
                value={{
                  startDate: draft.firstAirDateGte ?? null,
                  endDate: draft.firstAirDateGte ?? null,
                }}
                onChange={(value) =>
                  setString(
                    'firstAirDateGte',
                    value?.startDate ? String(value.startDate) : undefined
                  )
                }
                inputName="tvfrom"
                useRange={false}
                asSingle
                containerClassName="datepicker-wrapper"
                inputClassName="pr-1 sm:pr-4 text-base leading-5"
              />
            </div>
            <div className="flex flex-col">
              <div className="mb-2">{intl.formatMessage(messages.to)}</div>
              <Datepicker
                primaryColor="indigo"
                value={{
                  startDate: draft.firstAirDateLte ?? null,
                  endDate: draft.firstAirDateLte ?? null,
                }}
                onChange={(value) =>
                  setString(
                    'firstAirDateLte',
                    value?.startDate ? String(value.startDate) : undefined
                  )
                }
                inputName="tvto"
                useRange={false}
                asSingle
                containerClassName="datepicker-wrapper"
                inputClassName="pr-1 sm:pr-4 text-base leading-5"
              />
            </div>
          </div>
        </div>

        <span className="text-lg font-semibold">
          {intl.formatMessage(messages.genresMovie)}
        </span>
        <GenreSelector
          type="movie"
          defaultValue={movieGenres || undefined}
          isMulti
          onChange={(value) => {
            setMovieGenres(value?.map((v) => String(v.value)).join(',') ?? '');
          }}
        />

        <span className="text-lg font-semibold">
          {intl.formatMessage(messages.genresTv)}
        </span>
        <GenreSelector
          type="tv"
          defaultValue={tvGenres || undefined}
          isMulti
          onChange={(value) => {
            setTvGenres(value?.map((v) => String(v.value)).join(',') ?? '');
          }}
        />

        <span className="text-lg font-semibold">
          {intl.formatMessage(messages.originalLanguage)}
        </span>
        <LanguageSelector
          value={draft.language}
          serverValue={currentSettings.originalLanguage}
          isUserSettings
          setFieldValue={(_key, value) => setString('language', value)}
        />

        <span className="text-lg font-semibold">
          {intl.formatMessage(messages.tmdbuserscore)}
        </span>
        <div className="relative z-0">
          <MultiRangeSlider
            min={1}
            max={10}
            step={0.1}
            defaultMinValue={
              draft.voteAverageGte ? Number(draft.voteAverageGte) : undefined
            }
            defaultMaxValue={
              draft.voteAverageLte ? Number(draft.voteAverageLte) : undefined
            }
            onUpdateMin={(min) =>
              setString(
                'voteAverageGte',
                min !== 1 && Number(draft.voteAverageLte) !== 10
                  ? min.toFixed(1)
                  : undefined
              )
            }
            onUpdateMax={(max) =>
              setString(
                'voteAverageLte',
                max !== 10 && Number(draft.voteAverageGte) !== 1
                  ? max.toFixed(1)
                  : undefined
              )
            }
            subText={intl.formatMessage(messages.ratingText, {
              minValue: draft.voteAverageGte ?? '1.0',
              maxValue: draft.voteAverageLte ?? '10.0',
            })}
          />
        </div>

        <span className="text-lg font-semibold">
          {intl.formatMessage(messages.tmdbuservotecount)}
        </span>
        <div className="relative z-0">
          <MultiRangeSlider
            min={0}
            max={1000}
            defaultMinValue={
              draft.voteCountGte ? Number(draft.voteCountGte) : undefined
            }
            defaultMaxValue={
              draft.voteCountLte ? Number(draft.voteCountLte) : undefined
            }
            onUpdateMin={(min) =>
              setString(
                'voteCountGte',
                min !== 0 && Number(draft.voteCountLte) !== 1000
                  ? min.toString()
                  : undefined
              )
            }
            onUpdateMax={(max) =>
              setString(
                'voteCountLte',
                max !== 1000 && Number(draft.voteCountGte) !== 0
                  ? max.toString()
                  : undefined
              )
            }
            subText={intl.formatMessage(messages.voteCount, {
              minValue: draft.voteCountGte ?? 0,
              maxValue: draft.voteCountLte ?? 1000,
            })}
          />
        </div>

        <div className="mb-1 text-lg font-semibold">
          {intl.formatMessage(messages.externalRatings)}
        </div>

        {(
          [
            {
              keyGte: 'imdbRatingGte',
              keyLte: 'imdbRatingLte',
              label: messages.imdbScore,
              text: messages.imdbScoreText,
              min: 1,
              max: 10,
              step: 0.1,
            },
            {
              keyGte: 'imdbVotesGte',
              keyLte: 'imdbVotesLte',
              label: messages.imdbVotes,
              text: messages.imdbVotesText,
              min: 0,
              max: 100000,
            },
            {
              keyGte: 'rtCriticsGte',
              keyLte: 'rtCriticsLte',
              label: messages.rtCritics,
              text: messages.rtCriticsText,
              min: 0,
              max: 100,
            },
            {
              keyGte: 'rtAudienceGte',
              keyLte: 'rtAudienceLte',
              label: messages.rtAudience,
              text: messages.rtAudienceText,
              min: 0,
              max: 100,
            },
            {
              keyGte: 'metacriticGte',
              keyLte: 'metacriticLte',
              label: messages.metacritic,
              text: messages.metacriticText,
              min: 0,
              max: 100,
            },
            {
              keyGte: 'traktRatingGte',
              keyLte: 'traktRatingLte',
              label: messages.traktScore,
              text: messages.traktScoreText,
              min: 1,
              max: 10,
              step: 0.1,
            },
          ] as const
        ).map((slider) => (
          <div key={slider.keyGte}>
            <span className="text-lg font-semibold">
              {intl.formatMessage(slider.label)}
            </span>
            <div className="relative z-0">
              <MultiRangeSlider
                min={slider.min}
                max={slider.max}
                step={'step' in slider ? slider.step : undefined}
                defaultMinValue={
                  draft[slider.keyGte]
                    ? Number(draft[slider.keyGte])
                    : undefined
                }
                defaultMaxValue={
                  draft[slider.keyLte]
                    ? Number(draft[slider.keyLte])
                    : undefined
                }
                onUpdateMin={(min) => {
                  const atMin = min === slider.min;
                  const atMax = Number(draft[slider.keyLte]) === slider.max;
                  setString(
                    slider.keyGte,
                    !atMin && !atMax
                      ? 'step' in slider
                        ? min.toFixed(1)
                        : min.toString()
                      : undefined
                  );
                }}
                onUpdateMax={(max) => {
                  const atMax = max === slider.max;
                  const atMin = Number(draft[slider.keyGte]) === slider.min;
                  setString(
                    slider.keyLte,
                    !atMax && !atMin
                      ? 'step' in slider
                        ? max.toFixed(1)
                        : max.toString()
                      : undefined
                  );
                }}
                subText={intl.formatMessage(slider.text, {
                  minValue: draft[slider.keyGte] ?? String(slider.min),
                  maxValue: draft[slider.keyLte] ?? String(slider.max),
                })}
              />
            </div>
          </div>
        ))}

        <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-200">
          <input
            type="checkbox"
            className="rounded border-gray-500 bg-gray-800 text-indigo-500"
            checked={draft.includeNoRating !== false}
            onChange={(e) => {
              if (e.target.checked) {
                setDraft((prev) => {
                  const next = { ...prev };
                  delete next.includeNoRating;
                  return next;
                });
              } else {
                setBool('includeNoRating', false);
              }
            }}
          />
          {intl.formatMessage(messages.includeNoRating)}
        </label>

        <div className="flex flex-col gap-3 pt-4 sm:flex-row">
          <Button
            buttonType="primary"
            disabled={isSaving}
            onClick={() => void save(draft)}
          >
            <ArrowDownOnSquareIcon />
            <span>
              {intl.formatMessage(
                isSaving ? globalMessages.saving : globalMessages.save
              )}
            </span>
          </Button>
          <Button
            buttonType="default"
            disabled={isSaving}
            onClick={() => {
              setDraft({});
              setMovieGenres('');
              setTvGenres('');
              void save({});
            }}
          >
            <span>{intl.formatMessage(messages.clearDefaults)}</span>
          </Button>
        </div>
      </div>
    </>
  );
};

export default UserDiscoverSettings;
