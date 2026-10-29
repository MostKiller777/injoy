/**
 * Third-party embed endpoints. These are ordinary public iframes; which ones
 * answer changes over time, so the client keeps a picker and auto-cycles the
 * first few if a source never paints.
 */
export const EMBED_PROVIDERS = [
  {
    id: 'vidlink',
    label: 'VidLink',
    url: (id) => `https://vidlink.pro/movie/${id}`,
    quality: 'auto',
  },
  {
    id: 'vidsrc.pm',
    label: 'VidSrc PM',
    url: (id) => `https://vidsrc.pm/embed/movie/${id}`,
    quality: 'auto',
  },
  {
    id: 'vidsrc.to',
    label: 'VidSrc',
    url: (id) => `https://vidsrc.to/embed/movie/${id}`,
    quality: 'auto',
  },
  {
    id: 'vidsrc.cc',
    label: 'VidSrc CC',
    url: (id) => `https://vidsrc.cc/v2/embed/movie/${id}`,
    quality: 'auto',
  },
  {
    id: 'vidsrc.xyz',
    label: 'VidSrc XYZ',
    url: (id) => `https://vidsrc.xyz/embed/movie?tmdb=${id}`,
    quality: 'auto',
  },
  {
    id: 'embed.su',
    label: 'EmbedSU',
    url: (id) => `https://embed.su/embed/movie/${id}`,
    quality: 'auto',
  },
  {
    id: '2embed',
    label: '2Embed',
    url: (id) => `https://www.2embed.cc/embed/${id}`,
    quality: 'auto',
    ads: true,
  },
  {
    id: 'superembed',
    label: 'SuperEmbed',
    url: (id) => `https://multiembed.mov/directstream.php?video_id=${id}&tmdb=1`,
    quality: 'auto',
    ads: true,
  },
  {
    id: 'vidbinge',
    label: 'VidBinge',
    url: (id) => `https://vidbinge.dev/embed/movie/${id}`,
    quality: 'auto',
    ads: true,
  },
  {
    id: 'moviesapi',
    label: 'MoviesAPI',
    url: (id) => `https://moviesapi.club/movie/${id}`,
    quality: 'auto',
    ads: true,
  },
];

/**
 * Ad-heavy hosts sit at the back of the picker so the default source is one
 * that does not open a popunder the moment the frame paints. The flag only
 * orders and labels — every provider stays selectable.
 */
export function orderedProviders() {
  return [...EMBED_PROVIDERS].sort((a, b) => Number(a.ads ?? false) - Number(b.ads ?? false));
}

export function embedSources(tmdbId) {
  if (!tmdbId) return [];
  return orderedProviders().map((provider) => ({
    provider: provider.id,
    label: provider.ads ? `${provider.label} · ads` : provider.label,
    kind: 'embed',
    quality: provider.quality,
    url: provider.url(tmdbId),
  }));
}
