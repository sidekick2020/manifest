/**
 * Risk-driven spatial layout for Manifest v2.
 *
 * Positions encode meaning:
 *   - Radial distance = risk score (high risk → outer, low risk → core)
 *   - Angular position (theta, phi) = community cluster + identity hash
 *   - Depth modulation = temporal (newer members slightly forward)
 *
 * Deterministic: same data + same risk scores → same positions.
 * No random seeds, no evolution — pure function of (members, risks, neighborhoods).
 */

import { vec3, v3dist } from './vec3.js';
import { hash32, seedToFloat, computeNeighborhoods, computeMass, DEFAULT_PARAMS } from './codec.js';

const TWO_PI = Math.PI * 2;

/**
 * Compute risk-driven positions for all members.
 *
 * @param {object} state - { members, posts, comments }
 * @param {Map<string, { risk: number }>} predictions - risk scores per member
 * @param {{ targetRadius?: number, coreRadius?: number, riskExponent?: number }} opts
 * @returns {{ positions: Map<string, {x,y,z}>, neighborhoods: Map }}
 */
export function computeRiskLayout(state, predictions, opts = {}) {
  const {
    targetRadius = 60,
    coreRadius = 8,       // minimum radius (safest members)
    riskExponent = 1.5,   // >1 pushes high-risk further out
    timeDepth = 0.15,     // how much temporal offset to apply (fraction of radius)
  } = opts;

  const { members } = state;
  if (members.size === 0) return { positions: new Map(), neighborhoods: new Map() };

  // 1. Compute neighborhoods (connected components from comment graph)
  const masterSeed = hash32('risk-layout-v2');
  const nhs = computeNeighborhoods(masterSeed, state);

  // 2. Assign angular positions to neighborhoods (golden angle for even spacing)
  const nhArray = [];
  nhs.forEach((nh, key) => nhArray.push({ key, nh }));
  nhArray.sort((a, b) => b.nh.members.size - a.nh.members.size); // largest first

  const goldenAngle = Math.PI * (3 - Math.sqrt(5)); // ~137.5 degrees
  const nhAngles = new Map();
  for (let i = 0; i < nhArray.length; i++) {
    const theta = (i * goldenAngle) % TWO_PI;
    const phi = Math.acos(1 - 2 * ((i + 0.5) / Math.max(nhArray.length, 1)));
    nhAngles.set(nhArray[i].key, { theta, phi });
  }

  // 3. Find time range for temporal depth
  let earliestJoin = Infinity, latestJoin = 0;
  members.forEach((m) => {
    if (m.created) {
      const t = new Date(m.created).getTime();
      if (t < earliestJoin) earliestJoin = t;
      if (t > latestJoin) latestJoin = t;
    }
  });
  const timeRange = latestJoin - earliestJoin || 1;

  // 4. Place each member
  const positions = new Map();

  members.forEach((m, mid) => {
    const pred = predictions ? predictions.get(mid) : null;
    const risk = pred ? pred.risk : 0.5;

    // Radial distance: risk-driven
    // risk 0 → coreRadius, risk 1 → targetRadius
    const riskFactor = Math.pow(risk, riskExponent);
    const radius = coreRadius + (targetRadius - coreRadius) * riskFactor;

    // Find which neighborhood this member belongs to
    let nhKey = null;
    nhs.forEach((nh, key) => {
      if (nh.members.has(mid)) nhKey = key;
    });

    // Base angle from neighborhood
    const nhAngle = nhAngles.get(nhKey) || { theta: 0, phi: Math.PI / 2 };

    // Member-specific angular offset within neighborhood
    // Hash member ID for deterministic sub-placement
    const memberHash = seedToFloat(mid + ':angle');
    const memberHash2 = seedToFloat(mid + ':phi');

    // Spread within neighborhood based on NH size
    const nhSize = nhKey ? (nhs.get(nhKey)?.members.size || 1) : 1;
    const spreadAngle = Math.min(0.8, 0.15 + nhSize * 0.01); // radians of angular spread

    const theta = nhAngle.theta + (memberHash - 0.5) * spreadAngle * 2;
    const phi = nhAngle.phi + (memberHash2 - 0.5) * spreadAngle;

    // Temporal depth offset (newer members slightly shifted along one axis)
    const joinTime = m.created ? new Date(m.created).getTime() : earliestJoin;
    const timeNorm = (joinTime - earliestJoin) / timeRange; // 0=oldest, 1=newest
    const depthOffset = (timeNorm - 0.5) * targetRadius * timeDepth;

    // Convert spherical to cartesian
    const x = radius * Math.sin(phi) * Math.cos(theta);
    const y = radius * Math.sin(phi) * Math.sin(theta);
    const z = radius * Math.cos(phi) + depthOffset;

    positions.set(mid, vec3(x, y, z));
  });

  // 5. Update neighborhood centers (average of member positions)
  nhs.forEach((nh) => {
    let cx = 0, cy = 0, cz = 0, n = 0;
    nh.members.forEach((mid) => {
      const p = positions.get(mid);
      if (p) { cx += p.x; cy += p.y; cz += p.z; n++; }
    });
    nh.center = n > 0 ? vec3(cx / n, cy / n, cz / n) : vec3();
  });

  return { positions, neighborhoods: nhs };
}

/**
 * Compute a blended layout that transitions between hash-codec positions
 * and risk-driven positions based on a blend factor.
 *
 * @param {Map<string, {x,y,z}>} codecPositions - from hash codec
 * @param {Map<string, {x,y,z}>} riskPositions - from risk layout
 * @param {number} blend - 0 = pure codec, 1 = pure risk
 * @returns {Map<string, {x,y,z}>}
 */
export function blendLayouts(codecPositions, riskPositions, blend) {
  const result = new Map();
  const t = Math.max(0, Math.min(1, blend));

  codecPositions.forEach((cp, mid) => {
    const rp = riskPositions.get(mid);
    if (rp) {
      result.set(mid, vec3(
        cp.x * (1 - t) + rp.x * t,
        cp.y * (1 - t) + rp.y * t,
        cp.z * (1 - t) + rp.z * t,
      ));
    } else {
      result.set(mid, vec3(cp.x, cp.y, cp.z));
    }
  });

  // Add any risk-only positions
  riskPositions.forEach((rp, mid) => {
    if (!result.has(mid)) {
      result.set(mid, vec3(rp.x, rp.y, rp.z));
    }
  });

  return result;
}
