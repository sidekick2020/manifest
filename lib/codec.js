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

// --- Pre-built indices for O(1) lookups (replaces O(posts+comments) scans per member) ---
export function buildIndices(state) {
  const { posts, comments } = state;

  // Post index: per creator → { count, totalCommentCount }
  const postIndex = new Map();
  posts.forEach((p) => {
    const entry = postIndex.get(p.creator);
    if (entry) {
      entry.count++;
      entry.totalCommentCount += p.commentCount || 0;
    } else {
      postIndex.set(p.creator, { count: 1, totalCommentCount: p.commentCount || 0 });
    }
  });

  // Comment index: per member → { count, connected: Set }
  const commentIndex = new Map();
  comments.forEach((c) => {
    const from = c.fromMember, to = c.toMember;
    let fEntry = commentIndex.get(from);
    if (!fEntry) { fEntry = { count: 0, connected: new Set() }; commentIndex.set(from, fEntry); }
    fEntry.count++;
    fEntry.connected.add(to);
    let tEntry = commentIndex.get(to);
    if (!tEntry) { tEntry = { count: 0, connected: new Set() }; commentIndex.set(to, tEntry); }
    tEntry.count++;
    tEntry.connected.add(from);
  });

  // Pairs map for scoreCohesion: pairKey → comment count
  const pairsMap = new Map();
  comments.forEach((c) => {
    const a = c.fromMember, b = c.toMember;
    const k = a < b ? a + '-' + b : b + '-' + a;
    pairsMap.set(k, (pairsMap.get(k) || 0) + 1);
  });

  return { postIndex, commentIndex, pairsMap };
}

// --- Member seed (identity + engagement + connections); writes to state.metadataHashes ---
// When indices is provided, uses O(1) lookups; otherwise falls back to scanning.
export function computeMemberSeed(mid, ms, state, indices) {
  const { members, metadataHashes } = state;
  const m = members.get(mid);
  if (!m) return '0';
  let s = 'm:' + mid + ':' + m.username;
  let pc, cc, connectedKeys;

  if (indices) {
    const pi = indices.postIndex.get(mid);
    pc = pi ? pi.count : 0;
    const ci = indices.commentIndex.get(mid);
    cc = ci ? ci.count : 0;
    connectedKeys = ci ? Array.from(ci.connected).sort() : [];
  } else {
    // Fallback: scan all posts/comments (backward compat for external callers)
    const { posts, comments } = state;
    pc = 0; cc = 0;
    const connected = {};
    posts.forEach((p) => { if (p.creator === mid) pc++; });
    comments.forEach((c) => {
      if (c.fromMember === mid || c.toMember === mid) {
        cc++;
        connected[c.fromMember] = 1;
        connected[c.toMember] = 1;
      }
    });
    delete connected[mid];
    connectedKeys = Object.keys(connected).sort();
  }

  // Use epochDate from state if available to avoid wall-clock non-determinism
  const refTime = state.epochDate ? new Date(state.epochDate).getTime() : Date.now();
  const sobrDays = m.sobriety
    ? Math.floor((refTime - new Date(m.sobriety).getTime()) / 86400000)
    : 0;
  s += ':p' + pc + ':c' + cc + ':sob' + sobrDays + ':n[' + connectedKeys.join(',') + ']:s' + ms;
  const encoded = { postCount: pc, commentCount: cc, connections: connectedKeys.length, sobrietyDays: sobrDays };
  metadataHashes.set(mid, { hash: hash32(s), encoded, timestamp: refTime });
  return s;
}

// When indices is provided, uses O(1) lookups; otherwise falls back to scanning.
export function computeMass(mid, state, params = DEFAULT_PARAMS, indices = null) {
  let pc, tc, dc;

  if (indices) {
    const pi = indices.postIndex.get(mid);
    pc = pi ? pi.count : 0;
    tc = pi ? pi.totalCommentCount : 0;
    const ci = indices.commentIndex.get(mid);
    dc = ci ? ci.count : 0;
  } else {
    // Fallback: scan all posts/comments (backward compat for external callers)
    const { posts, comments } = state;
    pc = 0; tc = 0; dc = 0;
    posts.forEach((p) => {
      if (p.creator === mid) {
        pc++;
        tc += p.commentCount || 0;
      }
    });
    comments.forEach((c) => {
      if (c.fromMember === mid || c.toMember === mid) dc++;
    });
  }

  return 1 + pc * params.massPostW + tc * params.massCommentTotalW + dc * params.massDirectCommentW;
}

export function computeNeighborhoods(ms, state, indices = null) {
  const { members, comments } = state;
  const adj = {};
  members.forEach((_, id) => { adj[id] = {}; });
  comments.forEach((c) => {
    if (adj[c.fromMember] && adj[c.toMember]) {
      adj[c.fromMember][c.toMember] = 1;
      adj[c.toMember][c.fromMember] = 1;
    }
  });
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
      for (const nb of Object.keys(adj[cur] || {})) {
        if (!visited[nb]) q.push(nb);
      }
    }
    clusters.push(cluster);
  });
  const nhs = new Map();
  for (let i = 0; i < clusters.length; i++) {
    const seeds = clusters[i].sort().map((id) => computeMemberSeed(id, ms, state, indices));
    nhs.set('nh_' + i, {
      members: new Set(clusters[i]),
      hash: hash32(seeds.join('|')),
      center: null,
    });
  }
  return nhs;
}

export function encodeWithSeed(seed, state, params = DEFAULT_PARAMS, predictions = null, indices = null) {
  const { members } = state;
  // Build indices once if not provided (O(posts + comments) instead of O(members * (posts + comments)))
  if (!indices) indices = buildIndices(state);
  const nhs = computeNeighborhoods(seed, state, indices);
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
    const s = computeMemberSeed(mid, seed, state, indices);
    const mass = computeMass(mid, state, params, indices);
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
  function engagementScore(mid, m) {
    const mass = computeMass(mid, state, params, indices);
    const tc = m && (m.totalComments != null || m.TotalComments != null)
      ? Number(m.totalComments ?? m.TotalComments) || 0
      : 0;
    // Use at least log(1 + totalComments) so server-side top commenters are never at the edge
    const serverEng = 1 + Math.log(1 + tc);
    return Math.max(mass, serverEng);
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

// pairsMap: pre-built Map<pairKey, count> from buildIndices(). Falls back to scanning comments.
export function scoreCohesion(positions, state, params = DEFAULT_PARAMS, pairsMap = null) {
  // Build pairs if not provided (backward compat)
  if (!pairsMap) {
    const { comments } = state;
    if (comments.size === 0) return 1;
    pairsMap = new Map();
    comments.forEach((c) => {
      const a = c.fromMember, b = c.toMember;
      const k = a < b ? a + '-' + b : b + '-' + a;
      pairsMap.set(k, (pairsMap.get(k) || 0) + 1);
    });
  }
  if (pairsMap.size === 0) return 1;
  // Weighted mean distance: pairs with more comments get higher weight, so evolution pulls them closer.
  // Log-scale weight prevents a single high-volume pair from dominating the layout.
  let t = 0, n = 0;
  pairsMap.forEach((count, k) => {
    const [a, b] = k.split('-');
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

  // Build indices ONCE for all variants (O(posts + comments) instead of O(variants * members * (posts + comments)))
  const indices = buildIndices(state);

  const variants = [];
  const vc = params.variantCount;
  for (let i = 0; i < vc; i++) {
    const ms = Math.floor(temp * (0.3 + (i === 0 ? 0 : (i / (vc - 1)) * 2.5)) * 0xffffff);
    // Deterministic mutation: derive seed from base+index+temperature (no Math.random)
    const seed = i === 0 ? base : hash32(base + ':mut:' + i + ':ms' + ms + ':sc' + sc);
    const r = encodeWithSeed(seed, state, params, predictions, indices);
    const c = scoreCohesion(r.positions, state, params, indices.pairsMap);
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
    m.mass = computeMass(id, state, params, indices);
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
    sessionCount: 0,
    masterSeed: 0,
    fitnessHistory: [],
  };
}
