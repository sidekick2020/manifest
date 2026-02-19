/**
 * Continuous LOD system with hysteresis and 4-tier rendering.
 *
 * Tiers:
 *   individual  — full detail, profile pics, breathing animation
 *   representative — show top member per cluster + count badge
 *   cluster     — aggregated centroid with glow sized by count
 *   mega        — large galaxy-blob, very aggressive aggregation
 *
 * Hysteresis prevents popping: the threshold for *entering* a coarser
 * tier is higher than the threshold for *returning* to a finer tier.
 * blendFactor (0-1) indicates cross-fade progress within a transition zone.
 */

// --- Tier definitions ---
// thresholdIn  = camera distance at which we switch INTO this tier (zooming out)
// thresholdOut = camera distance at which we switch BACK to the finer tier (zooming in)
// cellSize     = spatial-hash cell size (0 = no aggregation)
export const LOD_TIERS = [
  { name: 'individual',     thresholdIn: 0,   thresholdOut: 0,   cellSize: 0 },
  { name: 'representative', thresholdIn: 40,  thresholdOut: 32,  cellSize: 15 },
  { name: 'cluster',        thresholdIn: 120, thresholdOut: 95,  cellSize: 35 },
  { name: 'mega',           thresholdIn: 250, thresholdOut: 200, cellSize: 100 },
];

// Transition zone width (units) for cross-fade blending
const BLEND_ZONE = 15;

// Keep backward compat — old 3-level map (used by tests / other imports)
export const LOD_LEVELS = {
  individual: { maxDistance: 50, cellSize: 0 },
  cluster:    { maxDistance: 150, cellSize: 30 },
  mega:       { maxDistance: Infinity, cellSize: 100 },
};

// --- Internal state for hysteresis ---
let _prevTierIndex = 0;

/**
 * Reset hysteresis state (useful for tests or scene resets).
 */
export function resetLODState() {
  _prevTierIndex = 0;
}

/**
 * Get the current LOD tier object for a given camera distance,
 * accounting for hysteresis so rapid zoom jitter doesn't cause popping.
 *
 * @param {number} d — camera distance
 * @returns {{ name: string, cellSize: number, blendFactor: number }}
 */
export function getLODTier(d) {
  let tierIndex = _prevTierIndex;

  // Zooming OUT: check if we should move to a coarser tier
  for (let i = tierIndex + 1; i < LOD_TIERS.length; i++) {
    if (d >= LOD_TIERS[i].thresholdIn) {
      tierIndex = i;
    }
  }

  // Zooming IN: check if we should move to a finer tier
  for (let i = tierIndex; i > 0; i--) {
    if (d < LOD_TIERS[i].thresholdOut) {
      tierIndex = i - 1;
    }
  }

  _prevTierIndex = tierIndex;

  const tier = LOD_TIERS[tierIndex];

  // Compute blend factor (0 = fully in current tier, 1 = at boundary of next coarser)
  let blendFactor = 0;
  if (tierIndex < LOD_TIERS.length - 1) {
    const nextIn = LOD_TIERS[tierIndex + 1].thresholdIn;
    const zoneStart = nextIn - BLEND_ZONE;
    if (d > zoneStart) {
      blendFactor = Math.min(1, (d - zoneStart) / BLEND_ZONE);
    }
  }

  return { name: tier.name, cellSize: tier.cellSize, blendFactor };
}

/**
 * Backward-compatible: get LOD level name.
 */
export function getLODLevel(cameraDistance) {
  return getLODTier(cameraDistance).name;
}

/**
 * Backward-compatible: get cell size for aggregation.
 */
export function getCellSize(cameraDistance) {
  return getLODTier(cameraDistance).cellSize;
}
