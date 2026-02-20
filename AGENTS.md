# Manifest — Guide for AI Agents

This file is the **primary entry point for agents** building on or modifying this repo. Read it first, then use the linked docs and rules as needed.

---

## What this project is

- **Manifest**: 4D spacetime visualization of a recovery community — members as stars, posts as planets, Back4App as data source.
- **Two app surfaces**:
  1. **Point Cloud (vanilla)** — `public/test-point-cloud.html`: single-file, self-contained Three.js app. **Source of truth** for the live product. Served as a static file at `/test-point-cloud.html` (no JS transform).
  2. **React app** — `src/main.jsx` + `App.jsx`: root `/` defaults to the Point Cloud React shell; `/#training` shows the training/dashboard UI (canvas 2D, octree, LOD).

---

## Entry points and where to edit

| Goal | Entry / files |
|------|----------------|
| Run the app | `npm run dev`. Root `/` serves the React app (default = React point-cloud shell). Use `/#training` for training/dashboard. Vanilla point cloud at `http://localhost:5173/test-point-cloud.html`. |
| Change point-cloud UI or 3D behavior | `public/test-point-cloud.html` (vanilla) or `src/point-cloud/*` (React shell). |
| Change training/dashboard React UI | `src/App.jsx`, `src/components/*`, `src/stores/*`. |
| Change spatial layout algorithm | `lib/codec.js` (evolve, createState, DEFAULT_PARAMS). |
| Change data loading / API | `lib/back4app.js` (feedFromBack4App). Used by both HTML app (inline script) and React `universeStore`. |
| Change training pipeline | `training/run.js`, `training/config.js`, `training/load-data.js`, `training/metrics/*`. |
| Add a new shared util or lib | `lib/` (e.g. `lib/vec3.js`, `lib/octree.js`). Use from both HTML and React via script or import. |

---

## Directory layout (concise)

```
manifest-2/
├── AGENTS.md              ← You are here
├── README.md              ← Human-facing setup, deploy, training
├── docs/
│   └── ARCHITECTURE.md    ← Data flow, codec, two apps, training
├── .cursor/rules/         ← Cursor rules (conventions, patterns)
├── public/
│   └── test-point-cloud.html  ← Point cloud app (vanilla, source of truth; served static)
├── index.html             ← React app entry (root #root)
├── src/
│   ├── main.jsx           ← React entry; / default → PointCloudApp; #training → App
│   ├── App.jsx            ← Training/dashboard app (Scene, HUD, panels)
│   ├── point-cloud/       ← React point-cloud shell (migration from HTML)
│   ├── components/       ← React components (Scene, Stars, DetailPanel, …)
│   ├── stores/           ← Zustand: universeStore, trainingStore, predictionStore
│   └── hooks/
├── lib/                   ← Shared JS (no React): codec, back4app, octree, vec3, …
├── training/              ← Node.js: run.js, config.js, load-data.js, metrics/
├── vite.config.js         ← Proxies /parse-api, /parsefiles-proxy; dual build entries
└── package.json
```

---

## Conventions agents should follow

1. **Point Cloud React (`src/point-cloud/`)**: Preserve DOM `id` and `class` values that match `test-point-cloud.html` so legacy script or future wiring can attach. See `src/point-cloud/README.md` for migration phases.
2. **React state**: Use Zustand stores (`src/stores/`) for universe, training, and prediction. Do not add ad-hoc global state for these domains.
3. **Shared logic**: New logic used by both the HTML app and React belongs in `lib/`. The HTML app uses inline script and may not yet import all of `lib/`; when migrating, prefer moving logic into `lib/` and importing from both.
4. **Images from Back4App**: Use `getParseFilesProxyUrl(url)` (or profile-specific helper) for any Parse CDN image URL so localhost works via Vite proxy. See README "CORS and Parse CDN images".
5. **Build**: React app is the only rollup entry (`index.html`). `test-point-cloud.html` lives in `public/` and is copied to `dist/` as-is (no transform). Deploy serves both from `dist/`.

---

## Common tasks (how to)

- **Add a new UI panel in the point cloud**: In vanilla, add markup + handlers in `public/test-point-cloud.html`. In React, add a component in `src/point-cloud/` and render it in `PointCloudApp.jsx`; keep the same `id`/`class` as the HTML for compatibility.
- **Change layout (star positions)**: Edit `lib/codec.js` (e.g. `DEFAULT_PARAMS`, `evolve()`). Training uses the same codec; see `training/run.js` and `training/config.js`.
- **Add a training metric**: Add a module under `training/metrics/` and wire it in `training/run.js`; output goes to `training/output/run-<timestamp>.json`.
- **Add a new npm script**: Add in `package.json` and document in README and here if it’s an entry point for agents.

---

## Further reading

- **Architecture (data flow, codec, apps, training)**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Point Cloud React migration**: [src/point-cloud/README.md](src/point-cloud/README.md)
- **Deploy, CORS, training, API**: [README.md](README.md)
- **Cursor rules**: `.cursor/rules/*.mdc` (applied automatically when relevant files are open).
