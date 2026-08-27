export interface MediaActionProviderResult {
  provider: string;
  ok: boolean;
  watched: boolean;
  rating: number | null;
  ratingStars: number | null;
  error?: string;
}

export interface MediaActionWriteResponse {
  outcome: 'success' | 'partial' | 'failure';
  watched: boolean;
  providers: MediaActionProviderResult[];
}

export const MEDIA_ACTION_PROVIDER_LABELS: Record<string, string> = {
  trakt: 'Trakt',
  jellyfin: 'Jellyfin',
  anilist: 'AniList',
  simkl: 'Simkl',
};

export function failedProviderLabels(
  providers: MediaActionProviderResult[]
): string {
  return providers
    .filter((provider) => !provider.ok)
    .map(
      (provider) =>
        MEDIA_ACTION_PROVIDER_LABELS[provider.provider] ?? provider.provider
    )
    .join(', ');
}

/** True when at least one provider applied the write (success or partial). */
export function writeSucceeded(response: MediaActionWriteResponse): boolean {
  if (response.outcome === 'failure') {
    return false;
  }
  if (response.providers.length === 0) {
    return false;
  }
  return response.providers.some((provider) => provider.ok);
}
