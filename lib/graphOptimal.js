/**
 * Force-directed layout on the comment graph.
 * Produces "ground truth" positions for training the hash codec.
 *
 * Algorithm: Fruchterman-Reingold with 3D extension.
 * - Attractive force between connected members (springs)
 * - Repulsive force between all pairs (Coulomb)
 * - Temperature cooling per iteration
 */
import { vec3, v3dist } from './vec3.js';

/**
 * @param {{ members: Map, comments: Map }} state
 * @param {{ iterations?: number, repulsion?: number, attraction?: number, damping?: number, targetRadius?: number }} opts
 * @returns {{ positions: Map<string, {x,y,z}>, convergence: number[] }}
 */
export function computeGraphOptimal(state, opts = {}) {
  const {
    iterations = 150,
    repulsion = 500,
    attraction = 0.01,
    damping = 0.95,
    targetRadius = 40,
  } = opts;

  const { members, comments } = state;
  const ids = Array.from(members.keys());
  const n = ids.length;
  if (n === 0) return { positions: new Map(), convergence: [] };

  // Build adjacency + weights
  const edges = [];
  const edgeMap = {};
  comments.forEach((c) => {
    const a = c.fromMember, b = c.toMember;
    const k = a < b ? a + '|' + b : b + '|' + a;
    if (!edgeMap[k]) {
      edgeMap[k] = { a, b, weight: 0 };
      edges.push(edgeMap[k]);
    }
    edgeMap[k].weight++;
  });

  // Initialize positions randomly on sphere
  const pos = new Map();
  const vel = new Map();
  for (const id of ids) {
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    const r = targetRadius * (0.3 + Math.random() * 0.7);
    pos.set(id, vec3(
      r * Math.sin(ph) * Math.cos(th),
      r * Math.sin(ph) * Math.sin(th),
      r * Math.cos(ph)
    ));
    vel.set(id, vec3());
  }

  const convergence = [];
  let temperature = targetRadius * 0.5;

  for (let iter = 0; iter < iterations; iter++) {
    // Reset forces
    const force = new Map();
    for (const id of ids) force.set(id, vec3());

    // Repulsive forces (all pairs) — use Barnes-Hut approximation for large N
    if (n <= 500) {
      // Exact O(n^2) for small graphs
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const pi = pos.get(ids[i]), pj = pos.get(ids[j]);
          const dx = pi.x - pj.x, dy = pi.y - pj.y, dz = pi.z - pj.z;
          const distSq = dx * dx + dy * dy + dz * dz + 0.01;
          const dist = Math.sqrt(distSq);
          const fr = repulsion / distSq;
          const fx = (dx / dist) * fr, fy = (dy / dist) * fr, fz = (dz / dist) * fr;
          const fi = force.get(ids[i]), fj = force.get(ids[j]);
          fi.x += fx; fi.y += fy; fi.z += fz;
          fj.x -= fx; fj.y -= fy; fj.z -= fz;
        }
      }
    } else {
      // Approximate: only repel nearby nodes (within 3x targetRadius)
      const cutoff = targetRadius * 3;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const pi = pos.get(ids[i]), pj = pos.get(ids[j]);
          const dx = pi.x - pj.x, dy = pi.y - pj.y, dz = pi.z - pj.z;
          const distSq = dx * dx + dy * dy + dz * dz + 0.01;
          if (distSq > cutoff * cutoff) continue;
          const dist = Math.sqrt(distSq);
          const fr = repulsion / distSq;
          const fx = (dx / dist) * fr, fy = (dy / dist) * fr, fz = (dz / dist) * fr;
          const fi = force.get(ids[i]), fj = force.get(ids[j]);
          fi.x += fx; fi.y += fy; fi.z += fz;
          fj.x -= fx; fj.y -= fy; fj.z -= fz;
        }
      }
    }

    // Attractive forces (edges)
    for (const { a, b, weight } of edges) {
      const pa = pos.get(a), pb = pos.get(b);
      if (!pa || !pb) continue;
      const dx = pb.x - pa.x, dy = pb.y - pa.y, dz = pb.z - pa.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz + 0.01);
      const fa = attraction * dist * Math.log2(1 + weight);
      const fx = (dx / dist) * fa, fy = (dy / dist) * fa, fz = (dz / dist) * fa;
      const fA = force.get(a), fB = force.get(b);
      if (fA) { fA.x += fx; fA.y += fy; fA.z += fz; }
      if (fB) { fB.x -= fx; fB.y -= fy; fB.z -= fz; }
    }

    // Apply forces with temperature limiting
    let totalDisplacement = 0;
    for (const id of ids) {
      const f = force.get(id);
      const v = vel.get(id);
      v.x = (v.x + f.x) * damping;
      v.y = (v.y + f.y) * damping;
      v.z = (v.z + f.z) * damping;

      // Limit displacement by temperature
      const mag = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      if (mag > temperature) {
        const scale = temperature / mag;
        v.x *= scale; v.y *= scale; v.z *= scale;
      }

      const p = pos.get(id);
      p.x += v.x; p.y += v.y; p.z += v.z;
      totalDisplacement += Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z);
    }

    temperature *= 0.97; // Cool
    convergence.push(totalDisplacement / n);

    // Early exit if converged
    if (iter > 20 && totalDisplacement / n < 0.01) break;
  }

  // Normalize to target radius scale
  let maxR = 0;
  pos.forEach((p) => {
    const r = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
    if (r > maxR) maxR = r;
  });
  if (maxR > 0) {
    const scale = targetRadius / maxR;
    pos.forEach((p) => {
      p.x *= scale; p.y *= scale; p.z *= scale;
    });
  }

  return { positions: pos, convergence };
}
