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
