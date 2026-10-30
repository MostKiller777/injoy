const ALLOWED = [
  /^(?:[a-z0-9-]+\.)*tmdb\.org$/i,
  /^(?:[a-z0-9-]+\.)*ltrbxd\.com$/i,
  /^(?:[a-z0-9-]+\.)*tvmaze\.com$/i,
  // Cinemeta's art host: the newest shelf has no Letterboxd page yet.
  /^(?:[a-z0-9-]+\.)*metahub\.space$/i,
  // Wikipedia's media host: the only place with art for the titles Letterboxd
  // has no backdrop for.
  /^(?:[a-z0-9-]+\.)*wikimedia\.org$/i,
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

/**
 * Ask the image host for a card-sized rendition.
 *
 * A 1000x1500 Letterboxd poster is 190 KB; the 400x600 version is 24 KB and is
 * what a 200 px card actually needs. The same applies to TMDB's w500 and
 * Metahub's medium posters. Backdrops are left alone: they are the hero, and
 * w1280 is the point.
 */
export function optimizeImageUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;

    if (/(^|\.)tmdb\.org$/i.test(host)) {
      // Only posters use w500; backdrops are w1280 and must stay sharp.
      parsed.pathname = parsed.pathname.replace(/\/t\/p\/w500\//, '/t/p/w342/');
      return parsed.href;
    }

    if (/(^|\.)ltrbxd\.com$/i.test(host)) {
      // 1000x1500 crop is a poster; 1200x675 is a backdrop and does not match.
      parsed.pathname = parsed.pathname.replace(
        /-0-1000-0-1500-crop(\.(?:jpe?g|png|webp))$/i,
        '-0-400-0-600-crop$1',
      );
      return parsed.href;
    }

    if (/(^|\.)metahub\.space$/i.test(host)) {
      parsed.pathname = parsed.pathname.replace('/poster/medium/', '/poster/small/');
      return parsed.href;
    }

    return url;
  } catch {
    return url;
  }
}

export function imgProxy(url) {
  if (!url || !isAllowedImage(url)) return url ?? null;
  return `/api/img?u=${encodeURIComponent(optimizeImageUrl(url))}`;
}
