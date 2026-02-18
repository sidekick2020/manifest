# Manifest

4D spacetime visualization of the Sober Sidekick recovery community — users as stars, posts as orbiting planets, profile pictures rendered as sprites on a Three.js WebGL canvas.

> **"You're Never Alone."**

---

## Launching the app

**Source of truth:** `test-point-cloud.html` — the single self-contained app. No build step required.

### Option 1 — Vite dev server (recommended)

From the project root (e.g. Cursor terminal with this folder as cwd):

```bash
npm install
npm run dev
```

Then open **`http://localhost:5173/`** or **`http://localhost:5173/test-point-cloud.html`** in your browser. The root `/` redirects to the app.

> If port 5173 is taken, Vite will pick the next available port (5174, 5175, …). Check the terminal output for the exact URL.

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
test-point-cloud.html   ← App (source of truth, single file, self-contained)
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
- **Back4App CDN** — Images served from `parsefiles.back4app.com` with `access-control-allow-origin: *`. If the CDN returns a non-200, planets fall back to placeholder gradient sprites.
