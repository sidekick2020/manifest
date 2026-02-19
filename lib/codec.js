/**
 * Manifest spatial hash codec — deterministic layout from members/posts/comments.
 * Same data + seed → same 3D positions. Evolution optimizes cohesion + stability.
 *
 * All tunable constants are in DEFAULT_PARAMS so they can be adjusted during training.
 */

import { vec3, v3dist } from './vec3.js';

// --- Default codec hyperparameters (tunable for training) ---
export const DEFAULT_PARAMS = {
  cohesionWeight: 0.85,      // fitness = cohesion * cW + stability * sW (strong cohesion priority)
  stabilityWeight: 0.15,     // low stability weight — willing to rearrange to achieve cohesion
  nhRadiusBase: 80,           // neighborhood center sphere radius
  nhRadiusScale: 16,          // additional radius per cluster count
  localRadiusBase: 4,         // member offset radius base (small — keep cluster members tight)
  localRadiusScale: 0.05,     // log-scaled below; this is the fallback multiplier (keep tiny)
  gravityFactor: 0.8,        // mass pulls member toward NH center (strong pull)
  annealingRate: 0.72,        // temperature = rate^sessionCount
  variantCount: 7,            // candidates per evolution step
  massPostW: 0.5,             // mass formula weights
  massCommentTotalW: 0.2,
  massDirectCommentW: 0.3,
  cohesionScale: 0.5,        // 1/(1 + avgDist * scale) — sensitive to distance between connected users
  stabilityScale: 0.05,       // 1/(1 + avgDrift * scale)
  pairGravityScale: 4.0,     // more comments from A→B = stronger gravity (pull A and B closer). Weight = log(1+count)*this.
};

// --- Hash primitives (FNV-1a) ---
export function hash32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function seedToFloat(seed) {
  return (hash32(String(seed)) & 0x7fffffff) / 0x7fffffff;
}

export function seedToPos(seed, r) {
  const s1 = seedToFloat(seed);
  const s2 = seedToFloat(seed + '_p');
  const th = s1 * Math.PI * 2;
  const ph = Math.acos(2 * s2 - 1);
  return vec3(
    r * Math.sin(ph) * Math.cos(th),
    r * Math.sin(ph) * Math.sin(th),
    r * Math.cos(ph)
  );
}

// --- Member seed (identity + engagement + connections); writes to state.metadataHashes ---
// Uses precomputed aggregates for O(K·log K) instead of O(P+C) per member.
export function computeMemberSeed(mid, ms, state) {
  const { members, metadataHashes } = state;
  const m = members.get(mid);
  if (!m) return '0';
  const agg = getAggregates(state);
  const ps = agg.postStats.get(mid) || { count: 0 };
  const cs = agg.commentStats.get(mid) || { total: 0 };
  const conns = agg.connectionsByMember.get(mid) || new Set();
  const pc = ps.count;
  const cc = cs.total;
  // Use epochDate from state if available to avoid wall-clock non-determinism
  const refTime = state.epochDate ? new Date(state.epochDate).getTime() : Date.now();
  const sobrDays = m.sobriety
    ? Math.floor((refTime - new Date(m.sobriety).getTime()) / 86400000)
    : 0;
  const s = 'm:' + mid + ':' + m.username + ':p' + pc + ':c' + cc + ':sob' + sobrDays
    + ':n[' + Array.from(conns).sort().join(',') + ']:s' + ms;
  const encoded = { postCount: pc, commentCount: cc, connections: conns.size, sobrietyDays: sobrDays };
  metadataHashes.set(mid, { hash: hash32(s), encoded, timestamp: Date.now() });
  return s;
}

// O(1) per member using precomputed aggregates (was O(P+C)).
export function computeMass(mid, state, params = DEFAULT_PARAMS) {
  const agg = getAggregates(state);
  const ps = agg.postStats.get(mid) || { count: 0, totalCommentCount: 0 };
  const cs = agg.commentStats.get(mid) || { total: 0 };
  return 1 + ps.count * params.massPostW + ps.totalCommentCount * params.massCommentTotalW + cs.total * params.massDirectCommentW;
}

// Uses precomputed BFS clusters from aggregates. Only per-seed hashing is recomputed.
export function computeNeighborhoods(ms, state) {
  const agg = getAggregates(state);
  const nhs = new Map();
  for (let i = 0; i < agg.clusters.length; i++) {
    const cluster = agg.clusters[i];
    const sorted = [...cluster].sort();
    const seeds = sorted.map((id) => computeMemberSeed(id, ms, state));
    nhs.set('nh_' + i, {
      members: new Set(cluster),
      hash: hash32(seeds.join('|')),
      center: null,
    });
  }
  return nhs;
}

export function encodeWithSeed(seed, state, params = DEFAULT_PARAMS, predictions = null) {
  const { members } = state;
  const nhs = computeNeighborhoods(seed, state);
  const positions = new Map();
  const arr = [];
  nhs.forEach((v, k) => arr.push([k, v]));
  for (let i = 0; i < arr.length; i++) {
    arr[i][1].center = seedToPos(
      'nh:' + arr[i][0] + ':' + arr[i][1].hash + ':' + seed,
      params.nhRadiusBase + arr.length * params.nhRadiusScale
    );
  }
  members.forEach((_, mid) => {
    const s = computeMemberSeed(mid, seed, state);
    const mass = computeMass(mid, state, params);
    let nhC = vec3(), nhS = 1;
    nhs.forEach((nh) => {
      if (nh.members.has(mid) && nh.center) {
        nhC = nh.center;
        nhS = nh.members.size;
      }
    });
    // Log-scale local spread: large clusters stay tight rather than exploding linearly.
    const localR = params.localRadiusBase + Math.log(1 + nhS) * params.localRadiusScale * 10;
    const lp = seedToPos(s, localR);

    // Risk-driven gravity: high-risk members drift toward periphery (weaker pull)
    let gravityValue = mass;
    if (predictions) {
      const pred = predictions.get(mid);
      if (pred && pred.riskLevel !== 'unknown') {
        const riskGravity = (1 - pred.risk) * 3;
        gravityValue = mass * 0.3 + riskGravity * 0.7;
      }
    }

    const gp = 1 / (1 + gravityValue * params.gravityFactor);
    positions.set(mid, vec3(nhC.x + lp.x * gp, nhC.y + lp.y * gp, nhC.z + lp.z * gp));
  });

  // --- Time axis (Y) + engagement axis (XZ radius) ---
  // Engagement = mass from posts/comments + server TotalComments when available.
  // Top commenters (high TotalComments) go toward center; low engagement → outskirts.
  const refTime = state.epochDate ? new Date(state.epochDate).getTime() : Date.now();
  let minJoin = Infinity, maxJoin = -Infinity;
  let maxEngagement = 1;
  const _engCache = new Map();
  function engagementScore(mid, m) {
    if (_engCache.has(mid)) return _engCache.get(mid);
    const mass = computeMass(mid, state, params);
    const tc = m && (m.totalComments != null || m.TotalComments != null)
      ? Number(m.totalComments ?? m.TotalComments) || 0
      : 0;
    // Use at least log(1 + totalComments) so server-side top commenters are never at the edge
    const serverEng = 1 + Math.log(1 + tc);
    const result = Math.max(mass, serverEng);
    _engCache.set(mid, result);
    return result;
  }
  members.forEach((m, mid) => {
    const jt = m.created ? new Date(m.created).getTime() : refTime;
    if (jt < minJoin) minJoin = jt;
    if (jt > maxJoin) maxJoin = jt;
    const eng = engagementScore(mid, m);
    if (eng > maxEngagement) maxEngagement = eng;
  });
  const joinRange = Math.max(maxJoin - minJoin, 1);

  const TARGET_RADIUS = 220;

  // First pass: normalize XZ to fit TARGET_RADIUS
  let maxXZ = 0;
  positions.forEach((p) => {
    const xz = Math.sqrt(p.x * p.x + p.z * p.z);
    if (xz > maxXZ) maxXZ = xz;
  });
  if (maxXZ === 0) maxXZ = 1;

  // Second pass: apply time→Y and engagement→XZ radius, preserve cluster angle in XZ
  positions.forEach((p, mid) => {
    const m = members.get(mid);
    const jt = m && m.created ? new Date(m.created).getTime() : refTime;
    // Y: earliest joiners at -TARGET_RADIUS (bottom), newest at +TARGET_RADIUS (top)
    const joinT = (jt - minJoin) / joinRange; // 0=oldest, 1=newest
    p.y = (joinT * 2 - 1) * TARGET_RADIUS;

    // XZ: engagement (mass + server TotalComments) → distance from center.
    // High engagement → small radius (core); low engagement → large radius (outskirts).
    const eng = engagementScore(mid, m);
    const engT = Math.log(1 + eng) / Math.log(1 + maxEngagement); // 0=low, 1=high
    const targetXZ = (1 - engT) * TARGET_RADIUS; // engaged=near center, disengaged=far

    // Preserve the XZ angle from the cluster layout (keeps commenting clusters together)
    const curXZ = Math.sqrt(p.x * p.x + p.z * p.z) || 1;
    const scale = targetXZ / curXZ;
    p.x *= scale;
    p.z *= scale;
  });

  return { positions, neighborhoods: nhs };
}

// Uses precomputed pairCounts from aggregates — no per-call comment scan.
export function scoreCohesion(positions, state, params = DEFAULT_PARAMS) {
  const agg = getAggregates(state);
  if (agg.pairCounts.size === 0) return 1;
  let t = 0, n = 0;
  agg.pairCounts.forEach((count, k) => {
    const sep = k.indexOf('-');
    const a = k.substring(0, sep);
    const b = k.substring(sep + 1);
    const pa = positions.get(a), pb = positions.get(b);
    if (pa && pb) {
      const w = Math.log(1 + count) * (params.pairGravityScale ?? 1.0);
      t += v3dist(pa, pb) * w;
      n += w;
    }
  });
  return n ? 1 / (1 + (t / n) * params.cohesionScale) : 1;
}

export function scoreStability(positions, targetPos, params = DEFAULT_PARAMS) {
  if (targetPos.size === 0) return 1;
  let t = 0, n = 0;
  positions.forEach((p, id) => {
    const prev = targetPos.get(id);
    if (prev) { t += v3dist(prev, p); n++; }
  });
  return n ? 1 / (1 + (t / n) * params.stabilityScale) : 1;
}

export function getTemp(sessionCount, params = DEFAULT_PARAMS) {
  return Math.max(0.03, Math.pow(params.annealingRate, sessionCount));
}

/**
 * Run one evolution step. Mutates state (sessionCount, masterSeed, neighborhoods,
 * targetPos, fitnessHistory, member.position/mass). Returns { winner }.
 */
export function evolve(state, params = DEFAULT_PARAMS, predictions = null) {
  const { members, posts, comments, targetPos, masterSeed, fitnessHistory } = state;
  state.sessionCount++;
  const sc = state.sessionCount;
  const temp = getTemp(sc, params);
  const base = hash32('ses:' + sc + ':m' + members.size + ':p' + posts.size + ':c' + comments.size + ':prev' + masterSeed);
  const variants = [];
  const vc = params.variantCount;
  for (let i = 0; i < vc; i++) {
    const ms = Math.floor(temp * (0.3 + (i === 0 ? 0 : (i / (vc - 1)) * 2.5)) * 0xffffff);
    // Deterministic mutation: derive seed from base+index+temperature (no Math.random)
    const seed = i === 0 ? base : hash32(base + ':mut:' + i + ':ms' + ms + ':sc' + sc);
    const r = encodeWithSeed(seed, state, params, predictions);
    const c = scoreCohesion(r.positions, state, params);
    const s = scoreStability(r.positions, targetPos, params);
    const f = c * params.cohesionWeight + s * params.stabilityWeight;
    variants.push({
      label: String.fromCharCode(65 + i),
      seed,
      positions: r.positions,
      neighborhoods: r.neighborhoods,
      fitness: f,
    });
  }
  variants.sort((a, b) => b.fitness - a.fitness);
  const w = variants[0];
  state.masterSeed = w.seed;
  state.neighborhoods = w.neighborhoods;
  fitnessHistory.push(w.fitness);
  if (fitnessHistory.length > 80) fitnessHistory.shift();
  state.targetPos = w.positions;
  members.forEach((m, id) => {
    m.mass = computeMass(id, state, params);
    const t = w.positions.get(id);
    // CRITICAL FIX: Reset position to target when target changes
    // This prevents "zoom to wrong place" bug after evolution
    // Old behavior: preserved m.position even when targetPos changed
    // New behavior: reset to target so lerp animation starts fresh
    if (t && typeof t.x === 'number' && typeof t.y === 'number' && typeof t.z === 'number') {
      m.position = vec3(t.x, t.y, t.z);
      m.opacity = m.opacity ?? 0.9; // Preserve opacity (don't fade out)
      m.scale = m.scale ?? 1.0;     // Preserve scale (don't shrink)
    }
  });
  return { winner: w };
}

/**
 * Create initial empty state (Maps and counters). Use before feeding data.
 */
export function createState() {
  return {
    members: new Map(),
    posts: new Map(),
    comments: new Map(),
    soberDateChanges: new Map(),
    targetPos: new Map(),
    neighborhoods: new Map(),
    metadataHashes: new Map(),
    aggregates: null,
    sessionCount: 0,
    masterSeed: 0,
    fitnessHistory: [],
  };
}

// --- Precomputed aggregate indices ---

/**
 * Build aggregate indices from posts/comments in a single O(P+C) pass.
 * Eliminates redundant full-collection scans in computeMemberSeed, computeMass,
 * computeNeighborhoods, and scoreCohesion.
 */
export function buildAggregates(state) {
  const { members, posts, comments } = state;

  const postStats = new Map();            // mid -> { count, totalCommentCount }
  const commentStats = new Map();         // mid -> { sent, received, total }
  const connectionsByMember = new Map();  // mid -> Set<mid>
  const pairCounts = new Map();           // "a-b" -> count (a < b)
  const adjacencyGraph = new Map();       // mid -> Set<mid>

  // Initialize for all known members
  members.forEach((_, mid) => {
    postStats.set(mid, { count: 0, totalCommentCount: 0 });
    commentStats.set(mid, { sent: 0, received: 0, total: 0 });
    connectionsByMember.set(mid, new Set());
    adjacencyGraph.set(mid, new Set());
  });

  // Single pass over posts: O(P)
  posts.forEach((p) => {
    const ps = postStats.get(p.creator);
    if (ps) {
      ps.count++;
      ps.totalCommentCount += p.commentCount || 0;
    }
  });

  // Single pass over comments: O(C)
  let beamCount = 0;
  const beamSeen = {};
  comments.forEach((c) => {
    const from = c.fromMember;
    const to = c.toMember;

    // Sent/received counts
    const fs = commentStats.get(from);
    if (fs) fs.sent++;
    const ts = commentStats.get(to);
    if (ts) ts.received++;

    // Total involvement: count once per member per comment (OR semantics)
    if (from === to) {
      // Self-comment: only increment total once (matches original OR logic)
      if (fs) fs.total++;
    } else {
      if (fs) fs.total++;
      if (ts) ts.total++;
    }

    // Connections (bidirectional, excluding self)
    if (from !== to) {
      const cf = connectionsByMember.get(from);
      if (cf) cf.add(to);
      const ct = connectionsByMember.get(to);
      if (ct) ct.add(from);
    }

    // Pair counts (normalized key: smaller ID first)
    const k = from < to ? from + '-' + to : to + '-' + from;
    pairCounts.set(k, (pairCounts.get(k) || 0) + 1);

    // Adjacency graph (for BFS clustering)
    if (from !== to) {
      const af = adjacencyGraph.get(from);
      const at = adjacencyGraph.get(to);
      if (af) af.add(to);
      if (at) at.add(from);
    }

    // Beam count (unique pairs)
    if (!beamSeen[k]) { beamSeen[k] = 1; beamCount++; }
  });

  // BFS clustering: O(M) — seed-independent, depends only on graph topology
  const visited = {};
  const clusters = [];
  members.forEach((_, mid) => {
    if (visited[mid]) return;
    const cluster = [];
    const q = [mid];
    while (q.length) {
      const cur = q.pop();
      if (visited[cur]) continue;
      visited[cur] = 1;
      cluster.push(cur);
      const neighbors = adjacencyGraph.get(cur);
      if (neighbors) {
        neighbors.forEach((nb) => { if (!visited[nb]) q.push(nb); });
      }
    }
    clusters.push(cluster);
  });

  const fingerprint = 'm' + members.size + ':p' + posts.size + ':c' + comments.size;

  state.aggregates = {
    postStats,
    commentStats,
    connectionsByMember,
    pairCounts,
    adjacencyGraph,
    clusters,
    beamCount,
    fingerprint,
  };

  return state.aggregates;
}

/**
 * Get cached aggregates or rebuild if data has changed (fingerprint mismatch).
 */
export function getAggregates(state) {
  const fp = 'm' + state.members.size + ':p' + state.posts.size + ':c' + state.comments.size;
  if (!state.aggregates || state.aggregates.fingerprint !== fp) {
    return buildAggregates(state);
  }
  return state.aggregates;
}
