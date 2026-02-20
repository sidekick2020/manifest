# Manifest

4D spacetime visualization of the Sober Sidekick recovery community — users as stars, posts as orbiting planets, profile pictures rendered as sprites on a Three.js WebGL canvas.

> **"You're Never Alone."**

---

## For AI agents

**Start here:** [AGENTS.md](./AGENTS.md) — entry points, directory layout, conventions, and common tasks. See also [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for data flow and module roles. Cursor rules in `.cursor/rules/` apply when working in the repo.

---

## Launching the app

**Source of truth:** `test-point-cloud.html` — the single self-contained app. No build step required.

### Option 1 — Vite dev server (recommended)

From the project root (e.g. Cursor terminal with this folder as cwd):

```bash
npm install
npm run dev
```

Then open in your browser:

- **`http://localhost:5174/`** — React app (point-cloud by default; training/dashboard at `/#training`)
- **`http://localhost:5174/test-point-cloud.html`** — Vanilla point cloud app (source of truth)

> Default port is 5174. If it's taken, use `npm run dev -- --port <port>` or check the terminal for the URL.

### Option 2 — Any static file server

```bash
# Python (built into macOS/Linux)
python3 -m http.server 8080
# → open http://localhost:8080/test-point-cloud.html

# Node (npx)
npx serve .
# → open the URL shown in the terminal
```

### Option 3 — Open directly in browser

Double-click `test-point-cloud.html` or drag it into Chrome.

> Note: some Back4App API calls may be blocked by the browser's mixed-content policy when opened as a `file://` URL. Use a local server if data doesn't load.

---

## Deploy

The app is a static frontend. Build once, then deploy the `dist/` folder to any static host.

### Build

```bash
npm install
npm run build
```

Output is in **`dist/`**. The main app is at **`dist/test-point-cloud.html`** (and linked from `/` via redirect on supported hosts).

### Deploy to Vercel (recommended)

1. Push this repo to GitHub.
2. Go to [vercel.com](https://vercel.com) → **Add New** → **Project** → import your repo.
3. Leave **Build Command** as `npm run build` and **Output Directory** as `dist` (or rely on `vercel.json`).
4. Deploy. Root URL will serve the point-cloud app.

### Deploy to Netlify

1. Push to GitHub, then [netlify.com](https://netlify.com) → **Add new site** → **Import from Git**.
2. Build command: `npm run build`, Publish directory: `dist`.
3. Deploy. `netlify.toml` is already set so `/` serves the app.

### Other hosts

Upload the contents of `dist/` to any static host (GitHub Pages, Cloudflare Pages, S3 + CloudFront, etc.). Open **`/test-point-cloud.html`** directly, or configure a redirect from `/` to that file.

> **Back4App:** The app calls `parseapi.back4app.com` from the browser. If your host’s domain is not allowed by Back4App CORS, configure the allowed origins in your Back4App dashboard or use a small server/proxy for the Parse API.

---

## What you'll see

| Element | Represents |
|---|---|
| ✨ Stars (dots) | Community members — colour = risk level |
| 🪐 Orbiting planets | That member's posts — image loaded from Back4App CDN |
| 🔴→🟢 Star colour | Risk gradient: red = high risk, green = low risk |
| 🔭 Click a star | Opens profile panel with posts, stats, and comment threads |
| 🔍 Search bar | Search by username — navigates camera to that member's star |

---

## Controls

| Input | Action |
|---|---|
| Drag | Rotate camera |
| Scroll | Zoom in / out |
| Click a star | Select member |
| `A` | Toggle admin dashboard |
| `?` | Keyboard shortcut reference |
| `ESC` | Close panels |

---

## Project structure

```
public/
  test-point-cloud.html ← Vanilla point cloud app (source of truth); served static, no transform
lib/                    ← Shared JS modules
  back4app.js           ← Back4App REST client
  codec.js              ← Spatial hash encode/evolve
  octree.js             ← Spatial indexing
  predictions.js        ← Risk prediction engine
  vec3.js               ← 3D vector math
  SimpleLOD.js          ← Level-of-detail helper
  renderer/             ← WebGL renderer abstraction
  validators/           ← Metric validation suite
src/                    ← React app (secondary entry point)
  App.jsx / main.jsx
  components/           ← Scene, Stars, Planets, HUD, etc.
  stores/               ← Zustand state (universe, prediction, training)
  hooks/
training/               ← Node.js data pipeline
  run.js                ← Load data → train → output metrics
  sweep.js              ← Hyperparameter sweep
  dashboard.html        ← Training metrics dashboard
  metrics/              ← Metric calculators
package.json
vite.config.js
```

---

## Training pipeline

Compares the spatial hash layout against observable community data:

```bash
npm run training          # Single run
npm run training:recent   # Recent data only
npm run training:dashboard # Serve metrics dashboard at localhost:3001
```

Output written to `training/output/run-<timestamp>.json`.

Metrics computed:
- **Hash vs reality** — encoded position accuracy vs actual member data
- **Connection vs distance** — correlation between comment strength and 3D proximity
- **Temporal validation** — layout stability across time windows

Override Back4App credentials via environment:
```bash
PARSE_APP_ID=xxx PARSE_REST_KEY=yyy npm run training
```

---

## Key technical notes

- **Image loading** — Post images in Back4App are sometimes stored with incorrect file extensions (e.g. `_image.txt` served as `text/plain`). The app fetches them via `fetch()` → `Blob` → `URL.createObjectURL()` to force correct rendering regardless of MIME type.
- **Canvas CORS** — All `<img>` elements and `new Image()` instances that feed into canvas use `crossOrigin="anonymous"` consistently to prevent browser cache poisoning and canvas taint errors.
- **Back4App CDN** — Images are served from `parsefiles.back4app.com`. If the CDN returns a non-200, planets fall back to placeholder gradient sprites.

### CORS and Parse CDN images (localhost)

**Problem:** The Parse file CDN (`parsefiles.back4app.com`) does **not** send `Access-Control-Allow-Origin` headers. When the app runs on `http://localhost:5173` (or similar), the browser blocks direct requests to that CDN as cross-origin, so profile pictures and post images fail to load and the console shows CORS errors.

**Fix:** When the app origin is localhost (or 127.0.0.1), we avoid cross-origin requests by routing all Parse CDN image URLs through a **same-origin proxy**:

1. **Vite dev server** (`vite.config.js`): the path `/parsefiles-proxy` is proxied to `https://parsefiles.back4app.com`. Requests to `http://localhost:5173/parsefiles-proxy/...` are forwarded by Vite to the CDN; the browser only sees a same-origin request.
2. **App code** (`public/test-point-cloud.html`): the helper **`getParseFilesProxyUrl(url)`** rewrites any `https://parsefiles.back4app.com/...` URL to `/parsefiles-proxy/...` when `window.location.origin` is localhost. Use this for **every** place that loads an image from the Parse CDN:
   - Profile pictures (sidebar, star sprites, cache)
   - Post grid thumbnails and expanded post image
   - Orbiting planet textures (`_makePlanetTextureFromImage`, planet image batch)
   - Blob fallback (`_imgBlobFallback`, `loadImageWithBlobFallback` when using fetch)

**Rule:** Any new code that sets `img.src`, `fetch()`, or similar for a URL pointing at `parsefiles.back4app.com` must use `getParseFilesProxyUrl(url)` (or the profile-specific `getProfileImageFetchUrl(url)`) so that on localhost the request goes through the proxy. In production (e.g. Vercel), the app is served from the same host as the page; if you ever serve the app from a different origin and the CDN still doesn’t send CORS, you’d need a similar proxy on that host.

### Codec, beams, and planets — training and performance

**What the codec uses:** The spatial layout (in `lib/codec.js`) is driven by **members**, **posts**, and **comments**. It uses posts for per-member post count and comment-on-post counts (mass); it uses comments for connection graph, neighborhoods, and cohesion. Evolution (`evolve()`) runs during the **load job** and writes positions into state; the app then enriches the point cloud and saves a snapshot so the next load can restore without re-fetching or re-evolving.

**Beams (comments):** Yes — we **do** train the codec with beam data. When you open a member and beams load, comments are cached in `beamDataCache` with a `commentsForCodec` list. The load job merges that cache into `state.comments` before calling `evolve()`, so the next time the job runs (and when it saves a snapshot), the layout reflects those connections. That makes future restores and layouts better for members whose beams have been loaded.

**Planets (posts):** Partially. Posts are only added to `state.posts` by the **batch load** (`feedFromBack4App` with `postLimit`). Posts loaded on demand for the sidebar/planets (`loadUserPosts`) are **not** merged into `state.posts`, so the codec does not see them. Mass and seeds only use posts that came from the batch feed.

**Recommendations to maximize performance:**

1. **Merge on-demand posts into the codec** — Add a `postDataCache` (like `beamDataCache`): when `loadUserPosts` returns, store each post in a format compatible with `state.posts` (e.g. `{ creator, commentCount, created, ... }`). In the load job, before `evolve()`, merge this cache into `state.posts`. Then the codec gets richer post counts and future snapshots/layouts improve without extra API calls.

2. **Re-run evolve only when it pays off** — Evolve is expensive. Today it runs once per load-job batch after merging the beam cache. Options: (a) keep that and rely on snapshot restores for speed; (b) after merging a large amount of new beam/post cache, run `evolve()` once and then `enrichPointCloudData()` + `saveSnapshot()` so the next session is faster; (c) run `evolve()` in a Web Worker so the main thread stays responsive.

3. **Snapshot is the main performance win** — Restore from snapshot avoids re-fetch and re-evolve. Saving the snapshot **after** merging beam (and, if added, post) cache ensures the saved layout reflects all on-demand data we have, so future loads render faster.

4. **Keep beam/post batch sizes modest** — Beams and planets are already batched (e.g. `BEAM_BATCH_SIZE`, `POST_CHUNK`). Tuning these down reduces jank when opening a member; the codec still benefits because merged cache is used on the next load job run.

### Reducing API calls

- **Training:** Each `feedFromBack4App` batch = 3 API calls (users, posts, comments in parallel). In `training/config.js`, use **fewer, larger batches**: e.g. `userLimit`/`postLimit` 1000 and `loadBatches: 8` → 8×3 = **24 calls** instead of 20×3 = 60. The codec only needs enough data for neighborhoods and cohesion; you get similar layout quality with fewer calls.
- **Snapshot first:** Restore from snapshot when available so the app skips re-fetch and re-evolve (0 API calls until the user triggers a refresh or new load).
- **Merge on-demand data:** Merge `beamDataCache` (and, if added, on-demand posts) into `state.comments` / `state.posts` before `evolve()` and before saving the snapshot. Then one load + merge gives the codec everything already fetched; the next session restores from snapshot and doesn’t need to re-request that data.
- **Runtime load job:** Use one or two large batches (e.g. 1000 users, 1000 posts, 2500 comments per batch) instead of many small ones so the initial codec run needs only 3–6 API calls.

- **Fewer API calls while navigating:** The app (e.g. `public/test-point-cloud.html`) reduces navigation API calls by: (1) **Beam cache** — 1‑hour TTL so revisiting a member reuses cached beams; (2) **Per-user post cache** — posts for a member are cached (1‑hour TTL) so reopening that member doesn’t refetch; (3) **Navigation cache persistence** — when the load job saves a snapshot, it also saves the beam and post caches (capped to 60 users) to `universeNavCache`. On restore from snapshot, those caches are repopulated so opening previously visited members uses cache and triggers no API calls.
