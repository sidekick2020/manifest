# Point Cloud (React)

This folder is the React version of `public/test-point-cloud.html`, rebuilt to mirror the prototype’s exact logic, behavior, and UI.

## Current state

- **Scene logic**: The full script from `test-point-cloud.html` lives in `pointCloudScene.js`. It exports `init(containerElement)` and mounts the Three.js canvas into the given container. All behavior (data loading, search, detail panel, beams, planets, URL routing, admin, help) is unchanged.
- **React shell**: `PointCloudApp` renders the same DOM structure and IDs as the HTML so the scene script’s `getElementById` / `querySelector` calls work. Buttons and inputs are wired to `window.*` handlers set by the scene (e.g. `window.toggleAdmin`, `window.closeDetail`, `window.searchMember`).
- **CSS**: `point-cloud.css` matches the HTML styles.
- **Entry**: `/#point-cloud` renders `PointCloudApp`; default route is the training/dashboard `App`.

## How to view

1. Run `npm run dev`.
2. Open `http://localhost:5173/#point-cloud` for the full Point Cloud (React + scene script).
3. Open `http://localhost:5173/test-point-cloud.html` for the standalone HTML version (served from `public/`).

## Files

- `PointCloudApp.jsx` — Root: layout, canvas container ref, `useEffect` calling `init(containerRef.current)`.
- `pointCloudScene.js` — Extracted scene (Three.js, Back4App, codec, search, detail, beams, planets, admin, URL/loading). Same behavior as the HTML.
- `SearchBar.jsx`, `DetailPanel.jsx`, `AdminSidebar.jsx`, `HelpModal.jsx`, `LoadingScreen.jsx`, `StarLabel.jsx` — Same structure/IDs as HTML; click handlers call `window.*`.
- `point-cloud.css` — Point cloud styles (mirrors HTML).
