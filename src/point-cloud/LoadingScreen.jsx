/**
 * Loading overlay — shown when navigating directly to a user via URL.
 * Same structure as test-point-cloud.html #loading-screen.
 */
export function LoadingScreen() {
  return (
    <div id="loading-screen" aria-live="polite" aria-busy="true">
      <div className="loading-content">
        <span className="loading-title">Manifest</span>
        <span className="loading-tagline">You're Never Alone</span>
      </div>
    </div>
  );
}
