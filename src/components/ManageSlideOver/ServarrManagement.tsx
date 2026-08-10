import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import useToasts from '@app/hooks/useToasts';
import axios from 'axios';
import { useEffect, useMemo, useState } from 'react';

type Episode = {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  hasFile: boolean;
};
type Context = {
  mediaType: 'movie' | 'tv';
  service: { type: string; name: string };
  seasons?: { seasonNumber: number; episodes: Episode[] }[];
};
type Release = {
  token: string;
  title: string;
  quality?: string;
  size: number;
  ageHours: number;
  indexer: string;
  protocol: string;
  seeders?: number;
  rejections: string[];
  rejected: boolean;
  downloadAllowed: boolean;
};
type Candidate = {
  token: string;
  source?: string;
  name: string;
  relativePath?: string;
  folderName?: string;
  size: number;
  quality?: string;
  languages: string[];
  rejections: string[];
  episodes?: Episode[];
};

const formatSize = (size: number) =>
  `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;

const ServarrPanel = ({
  mediaId,
  is4k,
  label,
  onChanged,
}: {
  mediaId: number;
  is4k: boolean;
  label: string;
  onChanged: () => void;
}) => {
  const { addToast } = useToasts();
  const [context, setContext] = useState<Context>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [releases, setReleases] = useState<Release[]>([]);
  const [target, setTarget] = useState<'episode' | 'season'>('episode');
  const [episodeId, setEpisodeId] = useState<number>();
  const [seasonNumber, setSeasonNumber] = useState<number>();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [episodeMappings, setEpisodeMappings] = useState<
    Record<string, number[]>
  >({});
  const [mode, setMode] = useState<'move' | 'copy'>('move');
  const [importStatus, setImportStatus] = useState<string>();
  const episodes = useMemo(
    () => context?.seasons?.flatMap((season) => season.episodes) ?? [],
    [context]
  );

  useEffect(() => {
    setLoading(true);
    axios
      .get<Context>(`/api/v1/media/${mediaId}/servarr/context?is4k=${is4k}`)
      .then((response) => {
        setContext(response.data);
        if (response.data.seasons?.[0]) {
          setSeasonNumber(response.data.seasons[0].seasonNumber);
          setEpisodeId(response.data.seasons[0].episodes[0]?.id);
        }
      })
      .catch((err) =>
        setError(
          err.response?.data?.message ??
            'Unable to connect to the mapped Servarr service.'
        )
      )
      .finally(() => setLoading(false));
  }, [mediaId, is4k]);

  const search = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams({ is4k: String(is4k) });
      if (context?.mediaType === 'tv') {
        params.set('target', target);
        if (target === 'episode' && episodeId)
          params.set('episodeId', String(episodeId));
        if (target === 'season' && seasonNumber !== undefined)
          params.set('seasonNumber', String(seasonNumber));
      }
      const response = await axios.get<{ results: Release[] }>(
        `/api/v1/media/${mediaId}/servarr/releases?${params}`
      );
      setReleases(response.data.results);
    } catch (err) {
      setError(
        axios.isAxiosError(err)
          ? err.response?.data?.message
          : 'Release search failed.'
      );
    } finally {
      setLoading(false);
    }
  };
  const grab = async (release: Release) => {
    const warning = release.rejected
      ? `\n\nServarr rejected this release:\n${release.rejections.join('\n')}`
      : '';
    if (!window.confirm(`Grab "${release.title}"?${warning}`)) return;
    try {
      await axios.post(`/api/v1/media/${mediaId}/servarr/releases/grab`, {
        is4k,
        token: release.token,
        acknowledgeRejections: release.rejected,
      });
      addToast('Release sent to download client.', {
        appearance: 'success',
        autoDismiss: true,
      });
      onChanged();
    } catch (err) {
      setError(
        axios.isAxiosError(err)
          ? err.response?.data?.message
          : 'Unable to grab release.'
      );
    }
  };
  const loadImports = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await axios.get<{ candidates: Candidate[] }>(
        `/api/v1/media/${mediaId}/servarr/imports?is4k=${is4k}`
      );
      setCandidates(response.data.candidates);
    } catch (err) {
      setError(
        axios.isAxiosError(err)
          ? err.response?.data?.message
          : 'Unable to inspect import candidates.'
      );
    } finally {
      setLoading(false);
    }
  };
  const submitImport = async () => {
    const files = candidates.filter((candidate) =>
      selected.includes(candidate.token)
    );
    const warnings = files.flatMap((candidate) => candidate.rejections);
    if (
      !window.confirm(
        `Import ${files.length} file(s) using ${mode}?${warnings.length ? `\n\nWarnings:\n${warnings.join('\n')}` : ''}`
      )
    )
      return;
    try {
      const response = await axios.post(
        `/api/v1/media/${mediaId}/servarr/imports`,
        {
          is4k,
          candidateTokens: selected,
          importMode: mode,
          acknowledgeRejections: warnings.length > 0,
          episodeMappings: Object.entries(episodeMappings)
            .filter(([token]) => selected.includes(token))
            .map(([candidateToken, episodeIds]) => ({
              candidateToken,
              episodeIds,
            })),
        }
      );
      addToast(`Manual import queued (${response.data.status ?? 'queued'}).`, {
        appearance: 'success',
        autoDismiss: true,
      });
      setSelected([]);
      setImportStatus(response.data.status ?? 'queued');
      onChanged();
      const poll = async () => {
        try {
          const status = await axios.get<{ status: string; message?: string }>(
            `/api/v1/media/${mediaId}/servarr/commands/${response.data.commandToken}?is4k=${is4k}`
          );
          setImportStatus(status.data.status);
          if (['completed', 'failed', 'aborted'].includes(status.data.status)) {
            if (status.data.status === 'completed') {
              addToast('Manual import completed.', {
                appearance: 'success',
                autoDismiss: true,
              });
              onChanged();
            } else setError(status.data.message ?? 'Manual import failed.');
            return;
          }
          window.setTimeout(poll, 2000);
        } catch {
          setError('Unable to read manual import status.');
        }
      };
      window.setTimeout(poll, 2000);
    } catch (err) {
      setError(
        axios.isAxiosError(err)
          ? err.response?.data?.message
          : 'Unable to submit manual import.'
      );
    }
  };
  if (loading && !context) return <LoadingSpinner />;
  if (!context) return <div className="text-sm text-red-300">{error}</div>;
  return (
    <div className="space-y-3 rounded-md border border-gray-700 p-3">
      <div className="font-semibold text-white">
        {label} ({context.service.name})
      </div>
      {error && <div className="text-sm text-red-300">{error}</div>}
      {context.mediaType === 'tv' && (
        <div className="flex flex-wrap gap-2">
          <select
            value={target}
            onChange={(event) =>
              setTarget(event.target.value as 'episode' | 'season')
            }
          >
            <option value="episode">Episode</option>
            <option value="season">Season pack</option>
          </select>
          {target === 'episode' ? (
            <select
              value={episodeId}
              onChange={(event) => setEpisodeId(Number(event.target.value))}
            >
              {episodes.map((episode) => (
                <option key={episode.id} value={episode.id}>
                  S{String(episode.seasonNumber).padStart(2, '0')}E
                  {String(episode.episodeNumber).padStart(2, '0')} —{' '}
                  {episode.title}
                  {episode.hasFile ? ' (downloaded)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <select
              value={seasonNumber}
              onChange={(event) => setSeasonNumber(Number(event.target.value))}
            >
              {context.seasons?.map((season) => (
                <option key={season.seasonNumber} value={season.seasonNumber}>
                  Season {season.seasonNumber}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <Button buttonType="primary" onClick={search} disabled={loading}>
          Search Releases
        </Button>
        <Button buttonType="default" onClick={loadImports} disabled={loading}>
          Manual Import
        </Button>
      </div>
      {releases.length > 0 && (
        <div className="space-y-2">
          {releases.map((release) => (
            <div
              key={release.token}
              className={`rounded border p-2 text-sm ${release.rejected ? 'border-yellow-600 bg-yellow-950/20' : 'border-gray-700'}`}
            >
              <div className="break-all font-medium text-white">
                {release.title}
              </div>
              <div>
                {release.quality ?? 'Unknown quality'} ·{' '}
                {formatSize(release.size)} · {release.indexer} ·{' '}
                {release.protocol}
                {release.seeders !== undefined
                  ? ` · ${release.seeders} seeders`
                  : ''}
              </div>
              {release.rejections.length > 0 && (
                <div className="mt-1 text-yellow-300">
                  {release.rejections.join(' • ')}
                </div>
              )}
              <Button
                className="mt-2"
                buttonSize="sm"
                onClick={() => grab(release)}
                disabled={!release.downloadAllowed}
              >
                Grab{release.rejected ? ' anyway' : ''}
              </Button>
            </div>
          ))}
        </div>
      )}
      {importStatus && (
        <div className="text-sm text-gray-300">
          Manual import: {importStatus}
        </div>
      )}
      {candidates.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <select
              value={mode}
              onChange={(event) =>
                setMode(event.target.value as 'move' | 'copy')
              }
            >
              <option value="move">Move files</option>
              <option value="copy">Copy files</option>
            </select>
            <Button
              buttonType="success"
              buttonSize="sm"
              disabled={!selected.length}
              onClick={submitImport}
            >
              Import selected ({selected.length})
            </Button>
          </div>
          {candidates.map((candidate) => (
            <div
              key={candidate.token}
              className="block rounded border border-gray-700 p-2 text-sm"
            >
              <label>
                <input
                  className="mr-2"
                  type="checkbox"
                  checked={selected.includes(candidate.token)}
                  onChange={() =>
                    setSelected((current) =>
                      current.includes(candidate.token)
                        ? current.filter((token) => token !== candidate.token)
                        : [...current, candidate.token]
                    )
                  }
                />
                <span className="font-medium text-white">{candidate.name}</span>
                <span className="ml-2">
                  {formatSize(candidate.size)} ·{' '}
                  {candidate.quality ?? 'Unknown quality'}
                  {candidate.source ? ` · ${candidate.source}` : ''}
                </span>
              </label>
              {context.mediaType === 'tv' &&
                selected.includes(candidate.token) && (
                  <select
                    className="mt-2 block"
                    value={
                      episodeMappings[candidate.token]?.[0] ??
                      candidate.episodes?.[0]?.id ??
                      ''
                    }
                    onChange={(event) =>
                      setEpisodeMappings((current) => ({
                        ...current,
                        [candidate.token]: [Number(event.target.value)],
                      }))
                    }
                  >
                    {episodes.map((episode) => (
                      <option key={episode.id} value={episode.id}>
                        S{String(episode.seasonNumber).padStart(2, '0')}E
                        {String(episode.episodeNumber).padStart(2, '0')} —{' '}
                        {episode.title}
                      </option>
                    ))}
                  </select>
                )}
              {candidate.rejections.length > 0 && (
                <div className="ml-6 mt-1 text-yellow-300">
                  {candidate.rejections.join(' • ')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const ServarrManagement = ({
  mediaId,
  hasStandardMapping,
  has4kMapping,
  mediaType,
  onChanged,
}: {
  mediaId: number;
  hasStandardMapping: boolean;
  has4kMapping: boolean;
  mediaType: 'movie' | 'tv';
  onChanged: () => void;
}) => (
  <div className="space-y-3">
    <h3 className="text-xl font-bold">
      {mediaType === 'movie' ? 'Radarr Management' : 'Sonarr Management'}
    </h3>
    {hasStandardMapping && (
      <ServarrPanel
        mediaId={mediaId}
        is4k={false}
        label="Standard"
        onChanged={onChanged}
      />
    )}
    {has4kMapping && (
      <ServarrPanel mediaId={mediaId} is4k label="4K" onChanged={onChanged} />
    )}
  </div>
);

export default ServarrManagement;
