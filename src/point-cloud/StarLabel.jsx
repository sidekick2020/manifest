/**
 * Floating username label anchored to selected star.
 * Same structure as test-point-cloud.html #star-label.
 */
export function StarLabel() {
  return (
    <div id="star-label">
      <div className="star-label-name">
        <span className="star-label-pip" id="star-label-pip" />
        <span id="star-label-text" />
      </div>
    </div>
  );
}
