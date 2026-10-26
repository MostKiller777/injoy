# injoy

A cinema-grade streaming front end with **zero npm dependencies**. It boots on a bare Node 20 install with a hand-picked modern catalog in eight genre rails plus a full series shelf. Every title is resolved server-side, streamed direct through DASH, and cached to the box in the background so the next play comes off local disk — no source picker, no visitor downloads.

```
npm start          # http://127.0.0.1:6967
```

No install step. No build step. No bundler. `node server/index.js` is the whole server.

---

## What it does

**Catalog**
- Curated-only shelf (no key required): 500 hand-picked films across eight genre rails — Noir, Horror, Sci-Fi, Comedy, Drama, Western, Animation, Documentary — with real posters/backdrops. Search matches titles, directors, years and genres, and survives typos via a five-character prefix pass.
- Genre rails are built from the catalog's own genre tags: TMDB names for the seven real genres, plus a local `Noir` tag because TMDB has no noir genre.
- Artwork comes from the TMDB image CDN for the first shelf, the Letterboxd CDN for the later ones, and the TVMaze CDN for series; all of it is served through the same `/api/img` proxy.
- Adult and exploitation titles are excluded from the catalog.
- TMDB integration (optional): with a key, detail pages resolve live metadata, cast, crew and trailers for the same ids.

**Series**
- 64 shows and 4,178 episodes, frozen from TVMaze into `server/lib/series-data.js`, so season and episode browsing never touches the network at request time.
- Series live in the `tv:<tvmazeId>` namespace, so detail pages, the watchlist and resume points behave exactly like films. Episodes play from `tv:<id>:<season>:<episode>`, which resolves to an IMDb-keyed embed.
- The detail modal carries a season selector plus the full episode list for the chosen season — number, name, airdate, runtime, synopsis, one click to play.
- Opening a series plays it: the next-up episode starts immediately, no episode pick and no source pick. Next-up is the most recently watched episode, advanced to the following one when it was finished; a fresh show starts at S1E1. The panel stays open underneath, so closing playback lands back on the show.
- The Mentalist leads the home Series row: 7 seasons, 151 episodes.

**Playback**
- One source, chosen by the server: the player never shows a picker and the visitor never downloads anything. `/api/play/:id` answers with a local copy when one exists, otherwise a direct stream — DASH, HLS or a progressive file — otherwise one embed.
- Providers are hedged, not tried one after another: the first page gets a five-second head start, the next joins it, and the first media request wins and cancels the rest. A title only one provider carries is found in seconds instead of after a full timeout per miss. `vidsrc.pm` carries the long tail (Interstellar among them) that vidlink does not.
- DASH streams are one HEVC video track plus one AAC audio track, played through Media Source Extensions with two SourceBuffers, a bounded eight-segment look-ahead and a rebuild on out-of-range seeks — no muxer, no ffmpeg.
- HLS streams are muxed, so they get one SourceBuffer: the playlist is parsed once into a segment list with per-segment durations, and the feeder keeps a 40-second read-ahead and restarts the queue on a seek. MSE refuses a bare `video/mp2t`, so the server reads the codecs out of the PMT in the first segment (`server/lib/tscodec.js`) and sends a candidate list; the first one the browser accepts is used.
- A transport stream does not start at PTS zero, so the buffered range can begin a second or two in. The feeder moves the playhead to the first byte the buffer holds, otherwise the element sits at zero with nothing to play.
- Progressive files go through a same-origin proxy with Range pass-through, because the CDN wants a Referer the browser cannot set and sends no CORS header.
- If a direct stream fails or the browser cannot decode it, the player falls back to the first embed on its own. No dead ends, no source list. That frame is deliberately **not** sandboxed: providers refuse to start their player inside a sandbox, and a frame that will not play is worse than one that can open a popup.
- Player chrome: glass head with title and year, centre play button when paused, buffering spinner on stall, single-click play/pause, double-click fullscreen, and a `?` keyboard panel.
- Progress is written on pause, on close, and on tab hide. Resume is offered automatically past the 20-second mark.

**Downloads**
- Playback also caches: the same resolver run that starts a direct stream hands its tracks to the downloader, which saves every fragment to disk in the background. The next play of that title comes off the disk — `mode: "local"` — with no third-party request at all.
- `POST /api/download/<id>` still exists for the library view and manual re-caching; with no body it resolves and caches the title itself.
- DASH is stored as the provider served it: `data/media/dash/<id>/{video,audio}/init.mp4` plus one `.m4s` per five seconds, described by a `manifest.json`. The client's MSE feeder points at `/api/local-dash/<id>/seg/...` instead of the network, so playback code is identical live and local.
- Provider URLs are signed and a feature-length fetch outlives the signature. On a 401/403/404/410 the job re-resolves the manifest, keeps the fragments already on disk and resumes; a rendition change wipes the partial copy and refetches. A failed job keeps its partials, so the next play of that title picks up where it stopped.
- HLS is handled in full - master-playlist variant selection, `#EXT-X-MAP` init segments, AES-128 keys with explicit or sequence-number IVs, and `#EXT-X-BYTERANGE` sub-ranges. Segments download six at a time but always write in playlist order. An expired URL is recovered the same way as DASH: the playlist is resolved again and the fetch continues at the next segment the file does not already hold.
- Raw `.ts` downloads play through a Media Source Extensions feeder: a bounded read-ahead window (45 s), a byte↔time checkpoint index for backward seeks, and a byte-offset estimate for forward seeks. The duration comes from a PES timestamp scan (`server/lib/tsprobe.js`), so the scrubber spans the film.
- Files live in `data/media/`, indexed by `data/media.json`; single-file downloads are served by `/api/stream/<id>` with `206` range responses so seeking works.
- Background caching runs one title at a time and stops at `MEDIA_CACHE_GB` (default 40 GB) of stored media. Playback is unaffected when the budget is full — the stream just stays live.
- Requires Chrome or Edge for the resolver. Downloads are otherwise dependency-free.

**UI**
- Cinematic hero with a daily-rotating pick and slow drift animation.
- Draggable, snap-scrolling rails with arrow controls and edge-aware disabled states.
- Genre rails in catalog order: Noir, Horror, Sci-Fi, Comedy, Drama, Western, Animation, Documentary.
- Dedicated `#/series` page listing every show with its season and episode counts.
- Detail modal: synopsis, facts, cast strip, trailer, episode browser, "more like this".
- Infinite-scroll grids for browse and search.
- Watchlist and resume points mirrored to the server in `data/library.json`, seeded from `localStorage` so the UI stays instant.
- Keyboard: `/` search, `R` random film, `Esc` close, arrows seek, `Space`/`K` play-pause, `M` mute, `F` fullscreen, `?` shortcut panel.
- PWA shell cache, responsive down to 360px, reduced-motion support, focus trapping, skip link, ARIA labelling.

**Server**
- `node:http` router, no framework.
- LRU + TTL cache with in-flight de-duplication.
- Token-bucket rate limit (600 req/min/IP).
- Atomic, debounced JSON persistence (tmp + rename).
- Gzip for text assets with ETag + 304 handling.
- CSP, nosniff, referrer policy, permissions policy.
- Path-traversal guard on the static root.

---

## Configure TMDB (optional)

```bash
cp .env.example .env
# then paste a v3 key or v4 bearer token
TMDB_API_KEY=...
```

Without a key the site runs the **curated catalog**: every rail, search result, genre page and browse filter is served from the local picks, and all of them play through public embeds. The series shelf never needs a key — TVMaze metadata is frozen in the repo.

With a key, detail pages for those same ids pull live TMDB metadata (cast, crew, trailer, runtime) instead of the frozen local copy. The rails stay curated.

`PORT`, `HOST` and `DATA_DIR` are also read from `.env` or the environment. `DATA_DIR` defaults to `./data`; point it at a mounted volume so the library and downloaded files survive a redeploy.

---

## Publish

The app is a single Node process with no dependencies, so every host that can run a container can run it. The image is the repo — there is no build step.

**Docker, anywhere**

```bash
docker build -t injoy .
docker run -p 6967:6967 -v injoy-data:/data injoy
```

`DATA_DIR=/data` is already set in the image, and `/data` is where the volume mounts.

**Render** — push the repo to GitHub, then *New → Blueprint* and pick the repo. `render.yaml` declares the Docker runtime, the `/api/health` check, and a 5 GB disk at `/data`. Disks are a paid-plan feature on Render; drop the `disk:` block for a stateless demo where the library resets on each deploy.

**Fly.io**

```bash
fly launch --no-deploy --copy-config
fly volumes create injoy_data --size 5 --region iad
fly deploy
```

`fly.toml` sets `internal_port = 6967`, mounts `injoy_data` at `/data`, and health-checks `/api/health`.

**Any VPS with Node 20+**

```bash
git clone <repo> injoy && cd injoy
PORT=6967 HOST=0.0.0.0 DATA_DIR=/var/lib/injoy node server/index.js
```

Put nginx or Caddy in front for TLS. There is no auth layer — the watchlist and progress endpoints are open, so a public deployment is a public deployment.

**Instant public URL, no account**

```powershell
.\scripts\tunnel.ps1
```

It fetches `cloudflared` once, starts the server if it is not already up, and prints a `https://<words>.trycloudflare.com` URL. The URL is ephemeral: it lives as long as that window stays open and changes on the next run. Good for showing the site to someone; not a deployment.

**Notes on hosting**

- Direct playback and background caching need Chrome or Edge for the resolver. The Docker image ships neither, so `/api/play/:id` answers with an embed there and nothing is cached. Downloads with an explicit `url` work everywhere — HLS, progressive and DASH segment saving are pure Node.
- The catalog is static files inside the image, so the free tiers of any host serve it fine; only the disk and the resolver care about the plan.
- Cold starts on scale-to-zero hosts cost one Node boot (~200 ms) plus the first rail's cache fill.

---

## Layout

```
injoy/
  server/
    index.js            http server, router, static, API
    lib/
      cache.js          TTL/LRU + in-flight dedupe
      catalog.js        home rails, browse, search, detail, sources, series shelf
      curated.js        film catalog, merged from every shelf
      curated-extra.js  second shelf — noir, western, documentary, horror, comedy, animation
      curated-more.js   third shelf — the wide genre fill
      curated-200.js    fourth shelf — deep cuts, title + exact year validated
      series.js         series normalize, detail, episode sources, search
      series-data.js    frozen TVMaze metadata + full episode lists
      downloader.js     HLS/progressive engine, job map, ordered segment writes
      media.js          local media store + range-serving
      resolver.js       headless Chrome netlog stream sniffer
      tsprobe.js        MPEG-TS duration from PES timestamps
      env.js            .env reader
      http.js           fetch with timeout/retry
      images.js         image proxy allowlist
      providers.js      embed provider registry
      store.js          watchlist + progress persistence
      tmdb.js           TMDB v3/v4 client
  public/
    index.html
    css/app.css
    js/{app,api,state,ui,player}.js
    sw.js               shell cache
    manifest.webmanifest
    icon.svg
  data/library.json     library state, created on first write
  data/media.json       downloaded media index, created on first download
  data/media/           downloaded files
  .env.example
```

---

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | uptime, mode, cache stats, library counts |
| GET | `/api/home` | hero + every rail (10 min cache) |
| GET | `/api/series` | every show with season and episode counts |
| GET | `/api/search?q=&page=` | films and series, title-ranked |
| GET | `/api/browse?genre=&sort=&page=` | paged grid, 36 per page |
| GET | `/api/genres` | the eight genre rails with counts |
| GET | `/api/movie/:id` | full detail; id is `tmdb:550` or `tv:116` |
| GET | `/api/sources/:id` | every source, local first; `tmdb:550` or `tv:116:1:2` |
| GET | `/api/play/:id` | the one source the player should mount (local, DASH, HLS, progressive, or embed) |
| GET | `/api/dash/:id` | resolve a live DASH session (`sid`, tracks, segment count) |
| GET | `/api/dash/seg/:sid/:track/:n` | proxied provider segment |
| GET | `/api/hls/seg/:sid/:n` | proxied HLS segment (decrypted when the playlist says AES-128) |
| GET | `/api/raw/:sid` | progressive file through the proxy, Range pass-through |
| GET | `/api/local-dash/:id/seg/:track/:n` | downloaded segment off the disk |
| GET | `/api/local` | downloaded titles, active jobs, totals |
| GET/HEAD | `/api/stream/:id` | local single-file download with `206` range support |
| GET | `/api/download/:id` | job status plus the stored media record |
| POST | `/api/download/:id` | `{ url, referer }` downloads a known URL; no body resolves and caches |
| DELETE | `/api/download/:id` | cancel the job and delete the file |
| GET | `/api/random` | surprise pick |
| GET | `/api/img?u=` | image proxy, allowlisted to tmdb.org, ltrbxd.com, tvmaze.com |
| GET | `/api/watchlist` | saved items |
| POST | `/api/watchlist` | `{ item }` upsert |
| DELETE | `/api/watchlist/:id` | remove |
| GET | `/api/progress` | all resume points |
| POST | `/api/progress/:id` | `{ t, d }` seconds |
| DELETE | `/api/progress/:id` | clear one |

---

## Notes

- **No media is hosted here.** Every title streams from a public provider, or from the copy this server cached off one. The visitor never sees a source list: `/api/play/:id` picks the path. Provider availability is outside this repo's control.
- Background caching is deliberately bounded: `MEDIA_CACHE_GB` (default `40`) caps the stored bytes, and one download runs at a time so playback keeps the bandwidth it needs.
- The catalog is static metadata files on purpose: TMDB's API needs a key, its image CDN does not, so the site keeps a complete, playable front page with zero configuration. TVMaze is keyless, which is why the series shelf is built from it.
- `data/library.json` and `data/media.json` are the only mutable state. Delete them to reset the library and the download index; `data/media/` holds the files themselves.
- CSP allows `frame-src https:` and `img-src https:` because embeds and artwork are external. Scripts stay same-origin.
- To expose the app beyond localhost, set `HOST=0.0.0.0` — there is no auth layer, so keep it on your LAN or put it behind a proxy.

---

`ofx` — built on the bench, shipped whole.
