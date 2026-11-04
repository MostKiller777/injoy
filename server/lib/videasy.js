/**
 * Second direct backend.
 *
 * The vidora endpoint covers most of the catalogue, but a title it does not
 * carry falls all the way back to an iframe, and an iframe's audio belongs to
 * the provider. This backend answers the same question for the titles vidora
 * misses, and it exists only when its host is reachable: a blocked or slow
 * lookup costs one short timeout, never a hang.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://api.videasy.net';
const REFERER = 'https://player.videasy.net/';
const TIMEOUT_MS = 6_000;

async function call(path, title, year, tmdbId, imdbId) {
  const params = new URLSearchParams({ title: title ?? '', mediaType: path, tmdbId: String(tmdbId) });
  if (year) params.set('year', String(year));
  if (imdbId) params.set('imdbId', imdbId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(`${BASE}/cdn/sources-with-title?${params}`, {
      signal: controller.signal,
      headers: { 'user-agent': UA, accept: 'application/json', referer: REFERER, origin: 'https://player.videasy.net' },
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const list = Array.isArray(body?.sources) ? body.sources : [];
    const pick = list.find((entry) => typeof entry?.url === 'string' && /\.(m3u8|mpd)(\?|$)/i.test(entry.url));
    if (!pick) return null;
    return {
      url: pick.url,
      type: /\.mpd(\?|$)/i.test(pick.url) ? 'dash' : 'hls',
      referer: REFERER,
      page: `${REFERER}${path}/${tmdbId}`,
      title: title ?? null,
      year: year ?? null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a film or episode through the second backend.
 *
 * `title` and `year` are optional: without them the endpoint still answers by
 * id, it just has less to match on.
 */
export async function videasyStream({ tmdbId, season = null, episode = null, title = null, year = null, imdbId = null } = {}) {
  const id = Number(tmdbId);
  if (!Number.isFinite(id) || id <= 0) return { error: 'no tmdb id' };

  if (season && episode) {
    const params = new URLSearchParams({
      title: title ?? '',
      mediaType: 'tv',
      tmdbId: String(id),
      seasonId: String(Number(season)),
      episodeId: String(Number(episode)),
    });
    if (year) params.set('year', String(year));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await fetch(`${BASE}/cdn/sources-with-title?${params}`, {
        signal: controller.signal,
        headers: { 'user-agent': UA, accept: 'application/json', referer: REFERER, origin: 'https://player.videasy.net' },
      });
      if (!res.ok) return { error: `videasy ${res.status}` };
      const body = await res.json().catch(() => null);
      const list = Array.isArray(body?.sources) ? body.sources : [];
      const pick = list.find((entry) => typeof entry?.url === 'string' && /\.(m3u8|mpd)(\?|$)/i.test(entry.url));
      if (!pick) return { error: 'videasy had no playable source' };
      return {
        url: pick.url,
        type: /\.mpd(\?|$)/i.test(pick.url) ? 'dash' : 'hls',
        referer: REFERER,
        page: `${REFERER}tv/${id}/${season}/${episode}`,
        title: title ?? null,
        year: year ?? null,
      };
    } catch (err) {
      return { error: err.name === 'AbortError' ? 'videasy timeout' : 'videasy unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  const hit = await call('movie', title, year, id, imdbId);
  return hit ?? { error: 'videasy had no playable source' };
}
