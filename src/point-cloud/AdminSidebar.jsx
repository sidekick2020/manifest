/**
 * Admin dashboard sidebar. Same structure as test-point-cloud.html #admin-sidebar.
 * Legacy script expects: admin-total, admin-real, admin-synthetic, fps, count,
 * memory, draws, geom, jobs-container, and buttons with specific onclick behavior.
 */
export function AdminSidebar() {
  return (
    <div id="admin-sidebar">
      <span className="close" onClick={() => window.toggleAdmin?.()} aria-label="Close admin" role="button" tabIndex={0}>
        ✕
      </span>
      <h2 style={{ marginTop: 0 }}>Admin Dashboard</h2>
      <div style={{ borderBottom: '1px solid #333', paddingBottom: '10px', marginBottom: '20px' }}>
        <p style={{ margin: '5px 0' }}>
          <strong>Total Members:</strong> <span id="admin-total">0</span>
        </p>
        <p style={{ margin: '5px 0' }}>
          <strong>Real Data Loaded:</strong> <span id="admin-real">0</span>
        </p>
        <p style={{ margin: '5px 0' }}>
          <strong>Synthetic Data:</strong> <span id="admin-synthetic">100,000</span>
        </p>
      </div>

      <h3 style={{ marginTop: '20px' }}>Performance</h3>
      <div style={{ borderBottom: '1px solid #333', paddingBottom: '10px', marginBottom: '20px' }}>
        <p style={{ margin: '5px 0' }}>
          <strong>FPS:</strong> <span id="fps">0</span>
        </p>
        <p style={{ margin: '5px 0' }}>
          <strong>Points:</strong> <span id="count">0</span>
        </p>
        <p style={{ margin: '5px 0' }}>
          <strong>Memory:</strong> <span id="memory">0 MB</span>
        </p>
        <p style={{ margin: '5px 0' }}>
          <strong>Draw Calls:</strong> <span id="draws">0</span>
        </p>
        <p style={{ margin: '5px 0' }}>
          <strong>Geometry:</strong> <span id="geom">0 MB</span>
        </p>
      </div>

      <h3 style={{ marginTop: '20px' }}>Background Jobs</h3>
      <div id="jobs-container" />

      <button type="button" className="btn btn-primary btn-block" style={{ marginTop: '20px' }} onClick={() => window.startLoadRealDataJob?.()}>
        Continue Loading Data
      </button>
      <button type="button" className="btn btn-danger btn-block" style={{ marginTop: '10px' }} onClick={() => window.resetJobState?.()}>
        Reset Job State
      </button>
      <button type="button" className="btn btn-block" style={{ marginTop: '10px' }} onClick={() => window.clearSnapshot?.()}>
        Clear Snapshot Cache
      </button>
      <button type="button" className="btn btn-block" style={{ marginTop: '10px' }} onClick={() => window.clearAllJobs?.()}>
        Clear Job History
      </button>
      <p id="snapshot-status" style={{ fontSize: '11px', color: '#888', marginTop: '8px', textAlign: 'center' }} />
    </div>
  );
}
