/**
 * Client-side gate: only apply write responses when at least one provider succeeded.
 * Mirrors server writeOutcome classification for the UI path.
 */
export function mediaActionWriteSucceeded(response: {
  outcome?: 'success' | 'partial' | 'failure';
  providers: { ok: boolean }[];
}): boolean {
  if (response.outcome === 'failure') {
    return false;
  }
  if (response.providers.length === 0) {
    return false;
  }
  return response.providers.some((p) => p.ok);
}
