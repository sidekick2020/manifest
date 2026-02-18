/**
 * Comprehensive quality metrics for universe layout validation.
 * Includes graph-theoretic, spatial quality, and stability metrics.
 */

import { v3dist } from '../vec3.js';

/**
 * Compute all metrics for a given layout
 * @param {Object} state - Universe state with members, comments, neighborhoods
 * @param {Object} layout - Layout with positions, neighborhoods
 * @param {Object} options - Options { previousLayout }
 * @returns {Object} - All metrics
 */
export function computeAllMetrics(state, layout, options = {}) {
  const { previousLayout = null } = options;

  return {
    // Graph-theoretic metrics
    cohesion: scoreCohesion(layout.positions, state),
    modularity: computeModularity(state, layout.neighborhoods),
    clusteringCoefficient: computeClusteringCoefficient(state),
    characteristicPathLength: computePathLength(state),

    // Spatial quality metrics
    densityVariance: computeDensityVariance(layout.positions),
    neighborhoodSeparation: computeNhSeparation(state, layout),
    spreadUtilization: computeSpreadUtilization(layout.positions),

    // Stability metrics
    positionDrift: previousLayout ? computePositionDrift(layout.positions, previousLayout.positions) : 0,
    convergenceRate: layout.convergenceSession || null,
    determinism: 1.0, // Codec is deterministic

    // Meta
    timestamp: Date.now(),
    memberCount: state.members.size,
    edgeCount: state.comments.size,
    neighborhoodCount: layout.neighborhoods ? layout.neighborhoods.size : 0,
  };
}

/**
 * 1. Cohesion Score - Average distance between connected members
 * Lower distance = higher score
 * Range: ~0.001 to ~1.0
 */
export function scoreCohesion(positions, state, cohesionScale = 0.1) {
  const { comments } = state;
  if (!comments || comments.size === 0) return 0;

  // Build unique pairs from comments
  const pairs = new Set();
  comments.forEach(c => {
    const key = c.fromMember < c.toMember
      ? `${c.fromMember}:${c.toMember}`
      : `${c.toMember}:${c.fromMember}`;
    pairs.add(key);
  });

  if (pairs.size === 0) return 0;

  // Compute average distance between connected pairs
  let totalDist = 0;
  let count = 0;

  pairs.forEach(pairKey => {
    const [id1, id2] = pairKey.split(':');
    const pos1 = positions.get(id1);
    const pos2 = positions.get(id2);

    if (pos1 && pos2) {
      totalDist += v3dist(pos1, pos2);
      count++;
    }
  });

  if (count === 0) return 0;

  const avgDist = totalDist / count;
  return 1 / (1 + avgDist * cohesionScale);
}

/**
 * 2. Modularity (Newman's Q) - Community structure quality
 * Measures how well-defined neighborhoods are
 * Range: -0.5 to 1.0 (higher = better clustering)
 */
export function computeModularity(state, neighborhoods) {
  const { comments } = state;
  if (!comments || comments.size === 0) return 0;
  if (!neighborhoods || neighborhoods.size === 0) return 0;

  const m = comments.size; // Total edges
  const degrees = new Map();

  // Build degree map (count edges per member)
  comments.forEach(c => {
    degrees.set(c.fromMember, (degrees.get(c.fromMember) || 0) + 1);
    degrees.set(c.toMember, (degrees.get(c.toMember) || 0) + 1);
  });

  let Q = 0;

  neighborhoods.forEach(nh => {
    if (!nh.members || nh.members.size === 0) return;

    let eii = 0; // Edges within community
    let ai = 0;  // Fraction of edges touching community

    // Count internal edges
    comments.forEach(c => {
      if (nh.members.has(c.fromMember) && nh.members.has(c.toMember)) {
        eii++;
      }
    });

    // Sum degrees in community
    nh.members.forEach(mid => {
      ai += degrees.get(mid) || 0;
    });

    if (m > 0) {
      eii /= (2 * m);
      ai /= (2 * m);
      Q += eii - ai * ai;
    }
  });

  return Q;
}

/**
 * 3. Clustering Coefficient - Fraction of connected triples forming triangles
 * Measures local cohesiveness of neighborhoods
 * Range: 0 to 1 (higher = more triangles)
 */
export function computeClusteringCoefficient(state) {
  const { comments, members } = state;
  if (!comments || comments.size === 0 || !members || members.size === 0) return 0;

  // Build adjacency map
  const adj = new Map();
  comments.forEach(c => {
    if (!adj.has(c.fromMember)) adj.set(c.fromMember, new Set());
    if (!adj.has(c.toMember)) adj.set(c.toMember, new Set());
    adj.get(c.fromMember).add(c.toMember);
    adj.get(c.toMember).add(c.fromMember);
  });

  let totalCoeff = 0;
  let memberCount = 0;

  // Compute local clustering coefficient for each member
  members.forEach((_, mid) => {
    const neighbors = adj.get(mid);
    if (!neighbors || neighbors.size < 2) return;

    const k = neighbors.size;
    let triangles = 0;

    // Count triangles: pairs of neighbors that are connected
    const neighborArray = Array.from(neighbors);
    for (let i = 0; i < neighborArray.length; i++) {
      for (let j = i + 1; j < neighborArray.length; j++) {
        const n1 = neighborArray[i];
        const n2 = neighborArray[j];
        if (adj.get(n1)?.has(n2)) {
          triangles++;
        }
      }
    }

    // Local clustering coefficient: C(v) = 2*triangles / (k * (k-1))
    const localCoeff = (2 * triangles) / (k * (k - 1));
    totalCoeff += localCoeff;
    memberCount++;
  });

  return memberCount > 0 ? totalCoeff / memberCount : 0;
}

/**
 * 4. Characteristic Path Length - Average shortest path in comment graph
 * Measures navigability of the network
 * Lower = more efficient structure
 */
export function computePathLength(state) {
  const { comments, members } = state;
  if (!comments || comments.size === 0 || !members || members.size === 0) return 0;

  // Build adjacency map
  const adj = new Map();
  comments.forEach(c => {
    if (!adj.has(c.fromMember)) adj.set(c.fromMember, new Set());
    if (!adj.has(c.toMember)) adj.set(c.toMember, new Set());
    adj.get(c.fromMember).add(c.toMember);
    adj.get(c.toMember).add(c.fromMember);
  });

  // Sample random members for BFS (computing all-pairs is O(n²))
  const sampleSize = Math.min(50, members.size);
  const memberIds = Array.from(members.keys());
  const samples = [];

  for (let i = 0; i < sampleSize; i++) {
    const idx = Math.floor((i / sampleSize) * memberIds.length);
    samples.push(memberIds[idx]);
  }

  let totalPathLength = 0;
  let pathCount = 0;

  // BFS from each sample
  samples.forEach(start => {
    const distances = new Map();
    distances.set(start, 0);
    const queue = [start];
    let head = 0;

    while (head < queue.length) {
      const current = queue[head++];
      const currentDist = distances.get(current);

      const neighbors = adj.get(current);
      if (!neighbors) continue;

      neighbors.forEach(neighbor => {
        if (!distances.has(neighbor)) {
          distances.set(neighbor, currentDist + 1);
          queue.push(neighbor);
        }
      });
    }

    // Sum distances from this start node
    distances.forEach((dist, target) => {
      if (target !== start && dist > 0) {
        totalPathLength += dist;
        pathCount++;
      }
    });
  });

  return pathCount > 0 ? totalPathLength / pathCount : 0;
}

/**
 * 5. Density Variance - Std dev of member density across spatial grid
 * Lower = more uniform distribution
 */
export function computeDensityVariance(positions) {
  if (!positions || positions.size === 0) return 0;

  // Divide space into 10x10x10 grid
  const gridSize = 10;
  const cellSize = 400 / gridSize; // [-200, 200] space
  const cells = new Map();

  // Count members per cell
  positions.forEach(pos => {
    const cx = Math.floor((pos.x + 200) / cellSize);
    const cy = Math.floor((pos.y + 200) / cellSize);
    const cz = Math.floor((pos.z + 200) / cellSize);
    const key = `${cx},${cy},${cz}`;

    cells.set(key, (cells.get(key) || 0) + 1);
  });

  // Compute variance
  const densities = Array.from(cells.values());
  if (densities.length === 0) return 0;

  const mean = densities.reduce((sum, d) => sum + d, 0) / densities.length;
  const variance = densities.reduce((sum, d) => sum + Math.pow(d - mean, 2), 0) / densities.length;

  return Math.sqrt(variance); // Return std dev
}

/**
 * 6. Neighborhood Separation - Inter-neighborhood distance / intra-neighborhood distance
 * Higher = neighborhoods more distinct from each other
 */
export function computeNhSeparation(state, layout) {
  const { neighborhoods } = layout;
  if (!neighborhoods || neighborhoods.size < 2) return 0;

  const positions = layout.positions;
  if (!positions || positions.size === 0) return 0;

  // Compute average intra-neighborhood distance
  let intraTotal = 0;
  let intraCount = 0;

  neighborhoods.forEach(nh => {
    if (!nh.members || nh.members.size < 2) return;

    const memberArray = Array.from(nh.members);
    for (let i = 0; i < memberArray.length; i++) {
      for (let j = i + 1; j < memberArray.length; j++) {
        const pos1 = positions.get(memberArray[i]);
        const pos2 = positions.get(memberArray[j]);
        if (pos1 && pos2) {
          intraTotal += v3dist(pos1, pos2);
          intraCount++;
        }
      }
    }
  });

  const avgIntra = intraCount > 0 ? intraTotal / intraCount : 0;
  if (avgIntra === 0) return 0;

  // Compute average inter-neighborhood distance (sample)
  const nhArray = Array.from(neighborhoods.values());
  let interTotal = 0;
  let interCount = 0;

  for (let i = 0; i < nhArray.length; i++) {
    for (let j = i + 1; j < nhArray.length; j++) {
      const nh1 = nhArray[i];
      const nh2 = nhArray[j];

      if (!nh1.center || !nh2.center) continue;

      interTotal += v3dist(nh1.center, nh2.center);
      interCount++;
    }
  }

  const avgInter = interCount > 0 ? interTotal / interCount : 0;

  return avgIntra > 0 ? avgInter / avgIntra : 0;
}

/**
 * 7. Spread Utilization - Occupied volume / target sphere volume
 * Measures how well the layout uses available space
 * Range: 0 to 1 (higher = better space usage)
 */
export function computeSpreadUtilization(positions) {
  if (!positions || positions.size === 0) return 0;

  // Compute bounding box
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  positions.forEach(pos => {
    minX = Math.min(minX, pos.x);
    maxX = Math.max(maxX, pos.x);
    minY = Math.min(minY, pos.y);
    maxY = Math.max(maxY, pos.y);
    minZ = Math.min(minZ, pos.z);
    maxZ = Math.max(maxZ, pos.z);
  });

  // Occupied volume (approximate as bounding box)
  const occupiedVolume = (maxX - minX) * (maxY - minY) * (maxZ - minZ);

  // Target volume (sphere with radius 60)
  const targetRadius = 60;
  const targetVolume = (4 / 3) * Math.PI * Math.pow(targetRadius, 3);

  return Math.min(1.0, occupiedVolume / targetVolume);
}

/**
 * 8. Position Drift - Average position change from previous layout
 * Lower = more stable layout
 */
export function computePositionDrift(positions, previousPositions) {
  if (!positions || !previousPositions) return 0;

  let totalDrift = 0;
  let count = 0;

  positions.forEach((pos, id) => {
    const prevPos = previousPositions.get(id);
    if (prevPos) {
      totalDrift += v3dist(pos, prevPos);
      count++;
    }
  });

  return count > 0 ? totalDrift / count : 0;
}

/**
 * Helper: Compute standard deviation (for variance metrics)
 */
function computeStdDev(values) {
  if (values.length === 0) return 0;

  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;

  return Math.sqrt(variance);
}
