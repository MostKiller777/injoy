# injoy

A cinema-grade streaming front end with **zero npm dependencies**. It boots on a bare Node 20 install with a hand-picked modern catalog in eight genre rails plus a full series shelf. Every title is resolved server-side, streamed direct through DASH, and cached to the box in the background so the next play comes off local disk — no source picker, no visitor downloads.

```
npm start          # http://127.0.0.1:6967
```

No install step. No build step. No bundler. `node server/index.js` is the whole server.

---

## What it does

**Catalog**
- Curated-only shelf (no key required): 808 films across eight genre rails — Noir, Horror, Sci-Fi, Comedy, Drama, Western, Animation, Documentary — with real posters/backdrops. Search matches titles, directors, years and genres, and survives typos via a five-character prefix pass.
- The newest shelf is the 300 most recent releases in the catalog (late 2025 through this month), frozen from Cinemeta's new-release feed into `server/lib/curated-new.js`. Nothing on it is announced-only: a film has to be out and rated 5.0+ to make the shelf.
- Genre rails are built from the catalog's own genre tags: TMDB names for the seven real genres, plus a local `Noir` tag because TMDB has no noir genre.
- Artwork comes from the TMDB image CDN for the first shelf, the Letterboxd CDN for the middle ones, the Metahub CDN for the newest shelf, and the TVMaze CDN for series; all of it is served through the same `/api/img` proxy.
- Adult and exploitation titles are excluded from the catalog.
- TMDB integration (optional): with a key, detail pages resolve live metadata, cast, crew and trailers for the same ids.

**Adding a film without editing the source**
- Copy `deploy/custom-films.example.json` to `data/custom-films.json` (or `$DATA_DIR/custom-films.json` on a host) and edit the array.
- Minimum useful record:

```json
{
  "tmdbId": 1891,
  "title": "Star Wars: Episode V - The Empire Strikes Back",
  "year": 1980,
  "release": "1980-05-21",
  "runtime": 7440,
  "rating": 8.7,
  "genres": ["Adventure", "Fantasy", "Sci-Fi"],
  "overview": "After the Empire overpowers the Rebel Alliance, Luke begins training with Yoda.",
  "poster": "https://images.metahub.space/poster/medium/tt0080684/img",
  "backdrop": "https://images.metahub.space/background/medium/tt0080684/img",
  "featured": false
}
```

- The example file adds The Empire Strikes Back, which is not in the built-in shelf, so copying it produces a visible new film.
- `runtime` is seconds, `rating` is 0–10, `genres` are display names. `poster`/`backdrop` can be TMDB paths (`/file.jpg`) or full URLs from TMDB, Letterboxd or Metahub.
- `release` controls the Newest shelf order. `featured: true` adds it to the hero shelf.
- A custom record with the same `tmdbId` as a built-in film replaces that record. The id is always `tmdb:<tmdbId>`.
- Restart after editing: `node server/index.js` locally, or `sudo systemctl restart injoy` on the VM. The film then appears in search, Films, Newest, its detail page and playback.
- The file is read once at startup. Invalid JSON is logged and ignored; the catalogue still boots.
- Series are separate: they come from the frozen `server/lib/series-data.js`; there is no custom-series file yet.

**Series**
- 64 shows and 4,178 episodes, frozen from TVMaze into `server/lib/series-data.js`, so season and episode browsing never touches the network at request time.
- Series live in the `tv:<tvmazeId>` namespace, so detail pages, the watchlist and resume points behave exactly like films. Episodes play from `tv:<id>:<season>:<episode>`, which resolves to an IMDb-keyed embed.
- The detail modal carries a season selector plus the full episode list for the chosen season — number, name, airdate, runtime, synopsis, one click to play.
- Opening a series plays it: the next-up episode starts immediately, no episode pick and no source pick. Next-up is the most recently watched episode, advanced to the following one when it was finished; a fresh show starts at S1E1. The panel stays open underneath, so closing playback lands back on the show.
- Because playback opens over the detail sheet, the season browser also lives **inside the player**: an `S1E1`-style button in the control bar opens a drawer with every season as a tab and that season's episodes listed underneath, current episode marked. Choosing one swaps the stream in place — progress is written for the episode being left, the caption list is dropped, and the same player keeps playing.
- The Mentalist leads the home Series row: 7 seasons, 151 episodes.
- `#/show/tv:<id>` is a dedicated browse page: every season expanded at once, a season jump bar, no autoplay, and no player covering the list. The player's episode drawer links to it with **Open full series page**. The catalogue does not rely on that page to play an episode; it just makes all 151 rows reachable without fighting the video layer.

**Playback**
- One source, chosen by the server: the player never shows a picker and the visitor never downloads anything. `/api/play/:id` answers with a local copy when one exists, otherwise a direct stream - DASH, HLS or a progressive file - otherwise one embed.
- **Fast first paint.** List endpoints return only the fields a card paints, and every JSON reply over 1 KB is gzipped. `/api/home` dropped from ~488 KB to ~66 KB raw and ~13 KB on the wire for 238 cards; repeat visits serve the versioned shell from the service worker cache, so the document finishes in about 50 ms locally. List calls are also memoised for 60 seconds in the client, so Home → Films → Home is a render, not another round trip.
- **Card-sized art and a lazy player.** Posters are requested at the size a card paints: TMDB `w342`, Letterboxd `400x600`, Metahub `small` (the Letterboxd original is 190 KB; the card version is 24 KB). The player module, DASH feeder and HLS feeder are imported on the first play, not on the first visit, so the home bundle is just the catalogue, the API client and the UI. Every image response is cacheable for a week and immutable.
- A resolver sniff is the slow part of starting a series. Resolved upstreams are cached for ten minutes, resolved DASH manifests for five, and `/api/play` races the resolver against a **4.5 s deadline**: if the sniff has not finished, the first embed is mounted immediately while the resolver keeps working, so the next press of play gets the direct stream. Local copies bypass the resolver entirely.
- Providers are hedged, not tried one after another: the first page gets a five-second head start, the next joins it, and the first media request wins and cancels the rest. A title only one provider carries is found in seconds instead of after a full timeout per miss. `vidsrc.pm` carries the long tail (Interstellar among them) that vidlink does not.
- DASH streams are one HEVC video track plus one AAC audio track, played through Media Source Extensions with two SourceBuffers, a bounded eight-segment look-ahead and a rebuild on out-of-range seeks - no muxer, no ffmpeg.
- Quality is a menu in the player, not a picker on the page. Every video rendition the manifest declares is ranked (AVC ahead of HEVC, then bandwidth) and opened when the session is created; the whole ladder travels with `/api/play` as `renditions[]`, each entry a ready session. Choosing one is a local swap and a feeder remount at the current playhead - no request at all, which matters because the feeder keeps all six of the browser's HTTP/1.1 connections busy for the length of the film. A stream with one rendition shows no menu. `/api/dash/variant/:sid/:index` and `/api/hls/variant/:sid/:index` remain for sessions opened without a pre-opened ladder.
- HLS streams are muxed, so they get one SourceBuffer: the playlist is parsed once into a segment list with per-segment durations, and the feeder keeps a 40-second read-ahead and remounts on a far seek. MSE refuses a bare `video/mp2t`, so the server reads the codecs out of the PMT in the first segment (`server/lib/tscodec.js`) and sends a candidate list; the first one the browser accepts is used.
- A transport stream does not start at PTS zero, so the buffered range can begin a second or two in. The feeder moves the playhead to the first byte the buffer holds, otherwise the element sits at zero with nothing to play. After a forward seek the new range is the one that matters, not the oldest one still in the buffer.
- A seek outside the buffered window tears the MediaSource down and builds a new one at the target rather than appending across the gap. Chrome rejects a large PTS jump mid-parse with `CHUNK_DEMUXER_ERROR_APPEND_FAILED`, which latches the element's `error` and kills the stream for the rest of the session; a remount costs one buffer rebuild and always works. Remounts are debounced 200 ms so dragging the scrubber does not thrash the demuxer.
- **Every seek goes through the feeder, not the element.** With MSE, `video.seekable` reports the buffered ranges and nothing else, so `video.currentTime = t` outside them is silently clamped to the nearest edge — which is why rewinding past the oldest buffered second used to do nothing at all: the element snapped back to the range edge, the feeder saw a covered position, and the playhead never moved. Each feeder now exposes `seek(time)`: a covered target is a plain seek, anything else rebuilds at that position. The scrubber, the ±10 s buttons, `J`/`L`, the arrow keys and the seek bar's own arrow handling all call one `seekToTime()` in `public/js/player.js`.
- For a raw transport stream the feeder also keeps `basePts`, the media time of the first appended frame. The player asks for a position in film time, the feeder translates it onto the stream's own clock, and `jumpTo` re-opens the byte range for it.
- Progressive files go through a same-origin proxy with Range pass-through, because the CDN wants a Referer the browser cannot set and sends no CORS header.
- If a direct stream fails or the browser cannot decode it, the player falls back to the first embed on its own. No dead ends, no source list. That frame is deliberately **not** sandboxed: providers refuse to start their player inside a sandbox, and a frame that will not play is worse than one that can open a popup.
- An embed can still land on a provider's own landing page or a dead frame, and a cross-origin iframe cannot be inspected to tell. The embed bar carries **Next source**, which cycles every alternative the server returned; the season drawer stays available on every one of them.
- **Captions.** Neither provider ships a text track — the DASH manifests carry video and audio only, the HLS playlists have no `EXT-X-MEDIA` — so subtitles come from the OpenSubtitles index behind Stremio's keyless addon. Every language the film or episode has is listed in the player: the CC pill opens a menu of all of them, one click turns one on and the rest off, and `C` toggles captions. A series episode typically carries 27–29 languages, a film around 10.
- Captions are converted to WebVTT on the server (`server/lib/subtitles.js`) and served same-origin from `/api/subs/<id>/<lang>.vtt`; the browser never reaches the subtitle CDN, and a converted track is cached on disk after the first request. SubRip is what the index hands over, and a browser will not play `.srt` through a `<track>`.
- Before conversion, captions are parsed and repaired: malformed SRT and WebVTT timing lines are accepted, timestamps are normalized, duplicate cues are merged, accidental overlaps are trimmed, blink-and-miss cues are dropped, short dialogue is given a readable minimum, and ASS positioning/font noise is removed without losing the words. The converted file is cached as a versioned track, so an old badly timed cache cannot survive an improvement.
- The addon can have several uploads for one language, and the index labels every row with the requested episode even when the filename is plainly another one (`S07E04` inside the S07E02 list). The server reads the **frame rate from the DASH manifest**, parses `S07E02`/`7x02` out of the release name, and ranks the correct episode above everything else, then the closest frame rate, then encoding and downloads. The VTT endpoint serves exactly the winner the list ranked, so the listed `fps` describes the file the player receives. A wrong episode can no longer win on a convenient runtime.
- Caption size is a three-way control in the same menu — **Small**, **Middle**, **Big** — applied through `::cue` so it multiplies the browser's own cue size and keeps tracking the frame at any window size. The choice is stored with the volume and survives reloads.
- Sync now has **0.1-second** controls as well as half-second jumps. `Auto` means the duration-matched track with no manual nudge. Any correction is stored per title and language, so fixing one episode cannot poison every other caption track; older global settings remain a migration fallback.
- A caption menu with thirty languages gets a search box: type three letters and the list narrows to what matches, so Spanish is two keystrokes instead of a scroll through the alphabet. The filter appears once a title has more than eight tracks.
- **Caption sync** has `-0.5s`, `-0.1s`, a live value, `+0.1s` and `+0.5s`; tapping the value puts the track back on the file's own timing and clears the speed fit. The file's original times are kept on each cue, so repeated nudges never stack. The offset is stored per title and language and applied again the next time a track is turned on. While watching, `[` and `]` nudge by a tenth of a second.
- **Caption speed** is the drift repair. A 25 fps subtitle against a 23.976 fps copy falls a little further behind every minute, and no constant offset can fix that. When both the manifest and the subtitle declare a clock, the exact ratio is applied automatically (`23.976 → 25` becomes `0.959x`); otherwise a runtime ratio that lands on a known frame-rate pair is used. The menu shows the current scale and a **Fit** button for everything else. A manual Fit or reset always wins and is remembered per title and language.
- Player chrome: glass head with title and year, centre play button when paused, buffering spinner on stall, single-click play/pause, double-click fullscreen, and a `?` keyboard panel.
- Progress is written on pause, on close, and on tab hide. Resume is offered automatically past the 20-second mark.

**Downloads**
- Playback also caches: the same resolver run that starts a direct stream hands its tracks to the downloader, which saves every fragment to disk in the background. The next play of that title comes off the disk — `mode: "local"` — with no third-party request at all.
- `POST /api/download/<id>` still exists for the library view and manual re-caching; with no body it resolves and caches the title itself.
- DASH is stored as the provider served it: `data/media/dash/<id>/{video,audio}/init.mp4` plus one `.m4s` per five seconds, described by a `manifest.json`. The client's MSE feeder points at `/api/local-dash/<id>/seg/...` instead of the network, so playback code is identical live and local.
- Provider URLs are signed and a feature-length fetch outlives the signature. On a 401/403/404/410 the job re-resolves the manifest, keeps the fragments already on disk and resumes; a rendition change wipes the partial copy and refetches. A failed job keeps its partials, so the next play of that title picks up where it stopped.
- HLS is handled in full - master-playlist variant selection, `#EXT-X-MAP` init segments, AES-128 keys with explicit or sequence-number IVs, and `#EXT-X-BYTERANGE` sub-ranges.
- HLS lands as **one file per segment** — `data/media/hls/<id>/seg-00000.ts` plus a `manifest.json` — rather than one concatenated file. That is what makes the fetch resumable: a segment already on disk is skipped, so a job that died at 56 of 271, or a server restarted mid-fetch, continues at the first hole instead of refetching the hour. The manifest is written as soon as the playlist is parsed and rewritten at the end with the probed codecs, so an interrupted copy is still inspectable and its finished segments still play.
- Every segment fetch gets four attempts with exponential backoff; only a 401/403/404/410 — a dead link or an expired signature — triggers a playlist re-resolve. A stalled socket costs one segment, not the job.
- The saved HLS copy plays through the same feeder the live proxy feeds, pointed at `/api/local-hls/<id>/<n>` instead of `/api/hls/seg/...`, so there is one playback path for live and local.
- HLS fetches are pipelined three segments ahead and appended in playlist order; a strictly serial fetch→append loop starves, because one connection delivers a four-megabyte segment slower than real time.
- Raw `.ts` downloads play through a Media Source Extensions feeder: a bounded read-ahead window (45 s), a byte↔time checkpoint index for backward seeks, and a byte-offset estimate for forward seeks. The duration comes from a PES timestamp scan (`server/lib/tsprobe.js`), so the scrubber spans the film.
- Files live in `data/media/`, indexed by `data/media.json`; single-file downloads are served by `/api/stream/<id>` with `206` range responses so seeking works.
- Background caching runs one title at a time and stops at `MEDIA_CACHE_GB` (default 40 GB) of stored media. Playback is unaffected when the budget is full — the stream just stays live.
- A cache job yields to a live stream of the same title: the proxy notes every segment it serves, and while that note is fresh (30 s) the job drops to one fetch at a time with a pause between segments. Playback gets the connection; the cache still makes progress.
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

**Instant public URL, no account — `publish\start.ps1`**

```powershell
powershell -ExecutionPolicy Bypass -File publish\start.ps1
```

It fetches `cloudflared` once into `publish\bin\`, starts `node server/index.js` if nothing is answering on the port, opens a quick tunnel, waits for the hostname, and prints it:

```
  injoy is live at  https://<words>.trycloudflare.com
```

The URL is also written to `data/public-url.txt`. `-NoTunnel` starts only the server, `-Port` changes the port, `-Stop` shuts both down. Cloudflare's quick tunnel needs no account, no card and no quota, and the app talks to `127.0.0.1` — the tunnel is the only thing exposed.

Both children start through `Start-NoWindow`, which sets `CreateNoWindow` in `ProcessStartInfo`. That matters: `Start-Process -WindowStyle Hidden` still asks Windows for a console and hides it after creation, so a black window flashes over the desktop every time the watchdog rebuilds the tunnel. `CREATE_NO_WINDOW` stops the window existing at all, so a restart is invisible. `publish\silent.vbs` does the same job one level up, for the task that launches PowerShell.

**Keep it up forever — `publish\autostart.ps1`**

```powershell
powershell -ExecutionPolicy Bypass -File publish\autostart.ps1
powershell -ExecutionPolicy Bypass -File publish\autostart.ps1 -Remove
```

Registers a per-user scheduled task that runs `start.ps1` at every logon, restarts it three times at five-minute intervals if it dies, and never asks for elevation. A second task, `injoy-watch`, runs `publish\watchdog.ps1` every ten minutes: Cloudflare can reclaim a quick tunnel at any moment ("Tunnel not found") and a reclaimed tunnel never re-registers itself, so the watchdog tests the published URL and rebuilds the tunnel when it is dead. That is the whole "free forever" story while the machine is on: the server and the downloaded library stay here, so there is no storage bill, no egress bill and no sleeping free tier — only the tunnel, which is free at any volume.

**Running with this machine switched off**

The tunnel publishes *this* PC. For a site that answers while the PC is off, put the same app on an always-on free VM — Oracle Cloud's Always Free tier gives 4 cores, 24 GB RAM, 200 GB of disk and 10 TB of egress a month, permanently, at no cost.

The fastest path is one paste: at instance creation open **Advanced options → Management → Cloud-init** and paste [`deploy/cloud-init.yaml`](deploy/cloud-init.yaml). The VM clones this public repo and provisions itself on first boot; no SSH key, no push, no process on this PC afterwards. Wait five to ten minutes and open `http://<public-ip>/`.

`push.ps1` is the alternative and the update path once the VM exists:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\push.ps1 -Server <public-ip> -Key <path-to-key>
```

That packs the app, copies it over SSH and provisions the host: Node 22, headless Chrome for the resolver, an `injoy` systemd service on port 80 with `Restart=always`, data in `/var/lib/injoy`. Reboot the VM and it comes back by itself; re-run the command to deploy an update without touching the library. Full walkthrough, the security-list rule, TLS with a domain, and the alternatives table are in [`deploy/README.md`](deploy/README.md).

**A permanent hostname**

A quick tunnel gets a new random hostname each restart. Two free ways to pin one:

```powershell
# 1. Named tunnel — free Cloudflare account plus a domain you already own.
cloudflared tunnel login
cloudflared tunnel create injoy
cloudflared tunnel route dns injoy injoy.example.com
cloudflared tunnel run --url http://127.0.0.1:6967 injoy
```

```powershell
# 2. Tailscale Funnel — free account, no domain, stable <machine>.<tailnet>.ts.net
tailscale funnel 6967
```

Point `start.ps1` at whichever one you settle on (drop the quick-tunnel block and run the named tunnel instead), and `autostart.ps1` keeps it alive across reboots.

**Notes on hosting**

- Direct playback and background caching need Chrome or Edge for the resolver. The Docker image ships neither, so `/api/play/:id` answers with an embed there and nothing is cached. Downloads with an explicit `url` work everywhere — HLS, progressive and DASH segment saving are pure Node.
- The catalog is static files inside the image, so the free tiers of any host serve it fine; only the disk and the resolver care about the plan.
- Cold starts on scale-to-zero hosts cost one Node boot (~200 ms) plus the first rail's cache fill.
- Serving from this machine means visitor bandwidth comes out of your upload. One viewer at 720p is ~3 Mbit/s; the resolver and the cache job already yield to live playback.

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
      curated-new.js    fifth shelf — the 300 newest releases, from Cinemeta
      subtitles.js      caption index, SubRip → WebVTT, language names, caches
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
  publish/
    start.ps1           serve + publish on a free quick tunnel, print the URL
    autostart.ps1       per-user scheduled tasks: publish at logon, watchdog every 10 min
    watchdog.ps1        rebuild the tunnel when the published URL dies
    bin/cloudflared.exe fetched on first run
  deploy/
    bootstrap.sh        provision an always-on Ubuntu host: node, chrome, systemd
    push.ps1            pack this checkout, scp it, run bootstrap over ssh
    README.md           the free-forever host walkthrough
  scripts/
    tunnel.ps1          thin forwarder to publish/start.ps1
  data/library.json     library state, created on first write
  data/media.json       downloaded media index, created on first download
  data/media/           downloaded files
  data/subs/            converted WebVTT tracks + imdb id map
  data/public-url.txt   last published URL, written by publish/start.ps1
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
| GET | `/api/local-hls/:id/:n` | downloaded HLS segment off the disk (index 0 is the init segment on fMP4 playlists) |
| GET | `/api/local` | downloaded titles, active jobs, totals |
| GET/HEAD | `/api/stream/:id` | local single-file download with `206` range support |
| GET | `/api/download/:id` | job status plus the stored media record |
| POST | `/api/download/:id` | `{ url, referer }` downloads a known URL; no body resolves and caches |
| DELETE | `/api/download/:id` | cancel the job and delete the file |
| GET | `/api/random` | surprise pick |
| GET | `/api/subs/:id` | every caption language for a title: `[{ lang, code, label, url }]` |
| GET | `/api/subs/:id/:lang.vtt` | one track as WebVTT, converted once and cached on disk |
| GET | `/api/img?u=` | image proxy, allowlisted to tmdb.org, ltrbxd.com, tvmaze.com, metahub.space, wikimedia.org |
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
