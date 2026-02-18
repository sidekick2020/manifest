# Manifest

4D spacetime visualization of the Sober Sidekick recovery community — users as stars, posts as planets, comments as beams. **"You're Never Alone."**

## Quick start

```bash
npm install
npm run dev          # React 3D app at http://localhost:5173
npm run training     # Run hash-vs-reality training pipeline
```

## Structure

- **`lib/`** — Shared codec and Back4App client (used by app + training)
  - `codec.js` — Spatial hash, encode, evolve (deterministic layout)
  - `back4app.js` — REST fetch and feed helpers
  - `vec3.js` — 3D vector helpers
- **`src/`** — React 3D app (Vite + React Three Fiber)
  - Feed live from Back4App, evolve layout, click stars for detail
- **`training/`** — Node pipeline: load data → run sessions → metrics
  - `run.js` — Entry: load data, evolve, hash-vs-reality + connection-vs-distance
  - `metrics/` — Hash accuracy, connection–distance correlation

## Training

Compares **hash vs observable reality**:

- **Hash vs reality** — Encoded metadata (post/comment/connection counts) vs actual; reports accuracy %.
- **Connection vs distance** — Correlation between comment strength (pair) and 3D distance. Negative = stronger connection → closer.

Output: `training/output/run-<timestamp>.json`

Override Back4App credentials with `PARSE_APP_ID` and `PARSE_REST_KEY`.

## Handoff

See project root `MANIFEST-SESSION-HANDOFF.md` for algorithm details, API notes, and next steps.
