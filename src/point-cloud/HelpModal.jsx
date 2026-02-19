/**
 * Keyboard shortcuts help modal. Same structure as test-point-cloud.html #help.
 */
export function HelpModal() {
  return (
    <div id="help">
      <h2>Manifest Point Cloud — Controls</h2>

      <div className="shortcuts">
        <div className="key">Drag</div>
        <div className="desc">Rotate camera around universe</div>

        <div className="key">Scroll</div>
        <div className="desc">Zoom in/out</div>

        <div className="key">Click</div>
        <div className="desc">Select member (show details)</div>

        <div className="key">R</div>
        <div className="desc">Toggle auto-rotation</div>

        <div className="key">H</div>
        <div className="desc">Reset camera to home position</div>

        <div className="key">F</div>
        <div className="desc">Focus on random cluster</div>

        <div className="key">A</div>
        <div className="desc">Toggle admin dashboard</div>

        <div className="key">/</div>
        <div className="desc">Focus search box</div>

        <div className="key">ESC</div>
        <div className="desc">Close panels</div>

        <div className="key">?</div>
        <div className="desc">Toggle this help screen</div>
      </div>

      <button type="button" onClick={() => window.toggleHelp?.()}>
        Got it!
      </button>
    </div>
  );
}
