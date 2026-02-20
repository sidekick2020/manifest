/**
 * React entry. Root (/) defaults to React point cloud. Use #training for training/dashboard.
 * Point cloud also at #point-cloud or path /:username.
 * See AGENTS.md for entry points and docs/ARCHITECTURE.md for app surfaces.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { PointCloudApp } from './point-cloud/PointCloudApp';
import './index.css';

const root = createRoot(document.getElementById('root'));

// Training/dashboard only when hash is explicitly #training
function isTrainingRoute() {
  return window.location.hash === '#training';
}

// Point cloud: default at /, or #point-cloud, or path-based user URL (e.g. /pita-poo)
function isPointCloudRoute() {
  if (isTrainingRoute()) return false;
  if (window.location.hash === '#point-cloud') return true;
  const path = window.location.pathname.replace(/^\//, '').trim();
  if (!path) return true; // default at root
  const segments = path.split('/').filter(Boolean);
  // Single segment = username (point cloud); exclude reserved paths
  const reserved = new Set(['assets', 'api', 'index.html', 'test-point-cloud.html']);
  return segments.length === 1 && !reserved.has(segments[0].toLowerCase());
}

function render() {
  const usePointCloud = isPointCloudRoute();
  root.render(
    <StrictMode>
      {usePointCloud ? <PointCloudApp /> : <App />}
    </StrictMode>
  );
}

window.addEventListener('hashchange', render);
window.addEventListener('popstate', render);
render();
