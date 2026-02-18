/**
 * Correlation: connection strength (comment count between pair) vs 3D distance.
 * Negative correlation = stronger connection → closer (good).
 */
import { v3dist } from '../../lib/vec3.js';

function pairKey(a, b) {
  return a < b ? a + '-' + b : b + '-' + a;
}

export function connectionVsDistance(state) {
  const { members, comments, targetPos } = state;
  const pairs = {};
  comments.forEach((c) => {
    const a = c.fromMember, b = c.toMember;
    const k = pairKey(a, b);
    if (!pairs[k]) pairs[k] = { a, b, strength: 0 };
    pairs[k].strength++;
  });

  const points = [];
  for (const k of Object.keys(pairs)) {
    const { a, b, strength } = pairs[k];
    const pa = targetPos.get(a), pb = targetPos.get(b);
    if (!pa || !pb) continue;
    const dist = v3dist(pa, pb);
    points.push({ strength, dist });
  }

  if (points.length < 2) {
    return { correlation: null, pointCount: points.length, message: 'Not enough connected pairs' };
  }

  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.strength, 0);
  const sumY = points.reduce((s, p) => s + p.dist, 0);
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0, denX = 0, denY = 0;
  for (const p of points) {
    const dx = p.strength - meanX, dy = p.dist - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY) || 1;
  const correlation = num / den;

  return {
    correlation,
    pointCount: n,
    meanDistance: meanY,
    meanStrength: meanX,
  };
}
