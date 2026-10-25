const ALLOWED = [
  /^(?:[a-z0-9-]+\.)*tmdb\.org$/i,
  /^(?:[a-z0-9-]+\.)*ltrbxd\.com$/i,
  /^(?:[a-z0-9-]+\.)*tvmaze\.com$/i,
];

/**
 * Poster/backdrop URLs are routed through this server so the browser never
 * has to reach image hosts directly (TMDB blocks some referrers, Letterboxd
 * rate-limits hotlinks, and both can be slow).
 */
export function isAllowedImage(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    return ALLOWED.some((pattern) => pattern.test(parsed.hostname));
  } catch {
    return false;
  }
}

export function imgProxy(url) {
  if (!url || !isAllowedImage(url)) return url ?? null;
  return `/api/img?u=${encodeURIComponent(url)}`;
}
