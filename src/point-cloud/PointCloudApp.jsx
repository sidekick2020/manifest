/**
 * Point Cloud app — mirrors test-point-cloud.html layout, behavior, and UI.
 * Renders the same DOM (IDs/classes) and runs the extracted scene script so
 * logic and behavior match the prototype exactly.
 */
import './point-cloud.css';
import { useRef, useLayoutEffect } from 'react';
import { init } from './pointCloudScene.js';
import { LoadingScreen } from './LoadingScreen';
import { SearchBar } from './SearchBar';
import { LocationFilter } from './LocationFilter';
import { StarLabel } from './StarLabel';
import { DetailPanel } from './DetailPanel';
import { AdminSidebar } from './AdminSidebar';
import { HelpModal } from './HelpModal';

export function PointCloudApp() {
  const canvasContainerRef = useRef(null);

  useLayoutEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;
    const cleanup = init(container);
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

  return (
    <>
      <button
        type="button"
        id="admin-toggle"
        title="Admin Dashboard (A)"
        aria-label="Toggle admin dashboard"
        onClick={() => window.toggleAdmin?.()}
      >
        ☰
      </button>

      <SearchBar />

      <LocationFilter />

      <button
        type="button"
        id="clear-connections-btn"
        title="Clear all connection lines"
        style={{ display: 'none' }}
        onClick={() => window.clearConnectionLines?.()}
      >
        ✕ Clear connections
      </button>

      <StarLabel />

      <DetailPanel />

      <AdminSidebar />

      <HelpModal />

      <div id="controls-suggestions">
        Drag to rotate · Scroll to zoom · Click points for details
      </div>

      <button
        type="button"
        id="help-btn"
        title="Keyboard shortcuts (?)"
        aria-label="Show keyboard shortcuts"
        onClick={() => window.toggleHelp?.()}
      >
        ?
      </button>

      <LoadingScreen />

      {/* Scene script appends renderer.domElement here; full viewport so canvas is visible */}
      <div
        ref={canvasContainerRef}
        id="point-cloud-canvas-container"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          minWidth: '100%',
          minHeight: '100%',
          zIndex: 0,
          overflow: 'hidden',
        }}
      />
    </>
  );
}
