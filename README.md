# injoy

A cinema-grade streaming front end with **zero npm dependencies**. It boots on a bare Node 20 install with a hand-picked modern catalog in eight genre rails plus a full series shelf, and every title plays through multi-provider embeds — or from disk, once downloaded.

```
npm start          # http://127.0.0.1:6967
```

No install step. No build step. No bundler. `node server/index.js` is the whole server.

---

## What it does

**Catalog**
- Curated-only shelf (no key required): 500 hand-picked films across eight genre rails — Noir, Horror, Sci-Fi, Comedy, Drama, Western, Animation, Documentary — with real posters/backdrops and nine playable sources each. Search matches titles, directors, years and genres, and survives typos via a five-character prefix pass.
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
- Titles fan out across nine public embed providers with a source picker; switching sources never loses your place in the UI, and embeds offer reload plus open-in-new-tab.
- Series episodes fan out across four IMDb-keyed providers, ordered the same way.
- Player chrome: glass head with title and year, centre play button when paused, buffering spinner on stall, single-click play/pause, double-click fullscreen, and a `?` keyboard panel.
- Progress is written on pause, on close, and on tab hide. Resume is offered automatically past the 20-second mark.
- A downloaded title becomes the first source in the picker, so the player opens a local file with native seeking instead of an iframe.

**Downloads**
- `POST /api/download/<id>` with a `url` starts a download; with no body it resolves one first: headless Chrome opens the embed pages, the provider's own JS trades its short-lived token, and the request it makes for a manifest is read back out of Chrome's netlog. The URL is never constructed, only observed.
- HLS is handled in full — master-playlist variant selection, `#EXT-X-MAP` init segments, AES-128 keys with explicit or sequence-number IVs, and `#EXT-X-BYTERANGE` sub-ranges. Segments download six at a time but always write in playlist order.
- Raw `.ts` downloads play through a Media Source Extensions feeder: a bounded read-ahead window (45 s), a byte↔time checkpoint index for backward seeks, and a byte-offset estimate for forward seeks. The duration comes from a PES timestamp scan (`server/lib/tsprobe.js`), so the scrubber spans the film.
- Files live in `data/media/`, indexed by `data/media.json`, served by `/api/stream/<id>` with `206` range responses so seeking works.
- DASH manifests are rejected with a named error rather than saved: their video and audio are separate tracks and joining them needs a muxer this box does not ship.
- Requires Chrome or Edge for the resolver. Downloads are otherwise dependency-free.

**UI**
- Cinematic hero with a daily-rotating pick and slow drift animation.
- Draggable, snap-scrolling rails with arrow controls and edge-aware disabled states.
- Genre rails in catalog order: Noir, Horror, Sci-Fi, Comedy, Drama, Western, Animation, Documentary.
- Dedicated `#/series` page listing every show with its season and episode counts.
- Detail modal: synopsis, facts, cast strip, sources, trailer, episode browser, "more like this".
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

**Notes on hosting**

- Downloads need Chrome or Edge for the resolver. The Docker image ships neither, so `POST /api/download/<id>` without a `url` answers `resolver unavailable` there. Downloads with an explicit `url` work everywhere — HLS and progressive are pure Node.
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
| GET | `/api/sources/:id` | playable sources; `tmdb:550` or `tv:116:1:2` |
| GET | `/api/local` | downloaded files, active jobs, totals |
| GET/HEAD | `/api/stream/:id` | local file with `206` range support |
| GET | `/api/download/:id` | job status plus the stored media record |
| POST | `/api/download/:id` | `{ url, referer }` starts a download; no body resolves one first |
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

- **No media is hosted here.** Every title plays through a third-party embed, or from a file the download pipeline pulled off one. Provider availability is outside this repo's control — that is why the player ships with a source picker.
- The catalog is static metadata files on purpose: TMDB's API needs a key, its image CDN does not, so the site keeps a complete, playable front page with zero configuration. TVMaze is keyless, which is why the series shelf is built from it.
- `data/library.json` and `data/media.json` are the only mutable state. Delete them to reset the library and the download index; `data/media/` holds the files themselves.
- CSP allows `frame-src https:` and `img-src https:` because embeds and artwork are external. Scripts stay same-origin.
- To expose the app beyond localhost, set `HOST=0.0.0.0` — there is no auth layer, so keep it on your LAN or put it behind a proxy.

---

`ofx` — built on the bench, shipped whole.
