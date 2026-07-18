/**
 * Convert UI half-star ratings (0.5–5) to Trakt's 1–10 integer scale.
 */
export function ratingStarsToProvider(ratingStars: number): number {
  if (ratingStars < 0.5 || ratingStars > 5) {
    throw new Error('ratingStars must be between 0.5 and 5');
  }
  return Math.max(1, Math.min(10, Math.round(ratingStars * 2)));
}

/**
 * Convert Trakt 1–10 rating to UI half-stars (0.5–5).
 */
export function providerRatingToStars(
  rating: number | null | undefined
): number | null {
  if (rating == null) {
    return null;
  }
  return rating / 2;
}
