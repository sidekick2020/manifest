/**
 * Simple 3-level LOD system for universe rendering
 * MVP implementation with no animation/transitions
 */

// 3 LOD levels (instead of 8 in full plan)
export const LOD_LEVELS = {
  individual: { maxDistance: 50, cellSize: 0 },     // Close up: show all members
  cluster: { maxDistance: 150, cellSize: 30 },      // Medium: aggregate into ~30 unit cells
  mega: { maxDistance: Infinity, cellSize: 100 },   // Far: aggregate into ~100 unit cells
};

/**
 * Get LOD level name for a given camera distance
 */
export function getLODLevel(cameraDistance) {
  if (cameraDistance < 50) return 'individual';
  if (cameraDistance < 150) return 'cluster';
  return 'mega';
}

/**
 * Get cell size for aggregation at a given camera distance
 * Returns 0 for individual rendering (no aggregation)
 */
export function getCellSize(cameraDistance) {
  return LOD_LEVELS[getLODLevel(cameraDistance)].cellSize;
}
