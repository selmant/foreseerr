/** Normalize only a complete callback for this particular sign-in. */
export const normalizedChatgptCallback = (
  text: string,
  redirectUri: string,
  state: string | null
): string | null => {
  const candidate = /^https?:\/\//i.test(text.trim())
    ? text.trim()
    : `http://${text.trim()}`;
  try {
    const url = new URL(candidate);
    const expected = new URL(redirectUri);
    if (
      url.origin !== expected.origin ||
      url.pathname !== expected.pathname ||
      !state ||
      url.searchParams.get('state') !== state
    )
      return null;
    if (!url.searchParams.get('code') && !url.searchParams.get('error'))
      return null;
    return url.toString();
  } catch {
    return null;
  }
};
