/**
 * React entry. Root (/) = React app. Point cloud when hash #point-cloud or path is /:username.
 * See AGENTS.md for entry points and docs/ARCHITECTURE.md for app surfaces.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { PointCloudApp } from './point-cloud/PointCloudApp';
import './index.css';

const root = createRoot(document.getElementById('root'));

// Point cloud for: #point-cloud or path-based user URL (e.g. /pita-poo)
function isPointCloudRoute() {
  if (window.location.hash === '#point-cloud') return true;
  const path = window.location.pathname.replace(/^\//, '').trim();
  if (!path) return false;
  const segments = path.split('/').filter(Boolean);
  // Single segment = username (point cloud with optional user); exclude reserved paths
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
