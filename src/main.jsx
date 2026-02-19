/**
 * React entry. Renders App (training/dashboard) or PointCloudApp (/#point-cloud).
 * See AGENTS.md for entry points and docs/ARCHITECTURE.md for app surfaces.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { PointCloudApp } from './point-cloud/PointCloudApp';
import './index.css';

const root = createRoot(document.getElementById('root'));

// Incremental migration: use hash #point-cloud to run the Point Cloud React shell
// (same layout as test-point-cloud.html). Default route stays the existing App.
function render() {
  const usePointCloud = window.location.hash === '#point-cloud';
  root.render(
    <StrictMode>
      {usePointCloud ? <PointCloudApp /> : <App />}
    </StrictMode>
  );
}

window.addEventListener('hashchange', render);
render();
