/**
 * Manifest spatial hash codec — deterministic layout from members/posts/comments.
 * Same data + seed → same 3D positions. Evolution optimizes cohesion + stability.
 *
 * All tunable constants are in DEFAULT_PARAMS so they can be adjusted during training.
 *
 * Performance optimizations:
 *   - Pre-indexed lookup maps (posts-by-creator, comments-by-member) eliminate O(M*(P+C)) scans
 *   - Seed caching avoids double computation (neighborhoods + positions)
 *   - Member-to-neighborhood index replaces linear scan in encodeWithSeed
 *   - Comment pairs pre-computed once per evolve, shared across all variants
 *   - Mass computed once per evolve using indexed lookups
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
  variantCount: 5,            // candidates per evolution step (fewer = faster, 5 still gives good layout)
  massPostW: 0.5,             // mass formula weights
  massCommentTotalW: 0.2,
  massDirectCommentW: 0.3,
  massServerCommentW: 0.25,   // server TotalComments on _User — more comments = more gravity (pull toward center)
  massBeamW: 0.6,             // unique beam connections weight — users connected to many others get more mass
  cohesionScale: 0.5,        // 1/(1 + avgDist * scale) — sensitive to distance between connected users
  stabilityScale: 0.05,       // 1/(1 + avgDrift * scale)
  pairGravityScale: 4.0,     // more comments from A→B = stronger gravity (pull A and B closer). Weight = log(1+count)*this.
  yEngagementCompression: 0.4, // compress Y (time axis) toward 0 for high-engagement users — keeps hubs vertically central
  attractorStrength: 0.3,     // interpersonal gravity: high-mass neighbors pull connected members toward them (XZ only)
  engagementXZPower: 0.7,     // power curve < 1 = more aggressive horizontal center pull for engaged users
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

// ============================================================
// Pre-indexed lookup maps — built once, reused across all codec ops
// ============================================================

/**
 * Build indexed lookup maps from state for O(1) per-member lookups.
 * Call once per evolve() or feedStep(), reuse for all computations.
 *
 * @param {{ members: Map, posts: Map, comments: Map }} state
 * @returns {{ postsByCreator: Map, commentsByMember: Map, commentPairs: Object, postCountByCreator: Map, commentTotalByCreator: Map, directCommentCount: Map }}
 */
export function buildIndex(state) {
  const { members, posts, comments } = state;

  // Posts indexed by creator
  const postsByCreator = new Map();
  const postCountByCreator = new Map();
  const commentTotalByCreator = new Map();
  posts.forEach((p) => {
    const cid = p.creator;
    if (!postsByCreator.has(cid)) postsByCreator.set(cid, []);
    postsByCreator.get(cid).push(p);
    postCountByCreator.set(cid, (postCountByCreator.get(cid) || 0) + 1);
    commentTotalByCreator.set(cid, (commentTotalByCreator.get(cid) || 0) + (p.commentCount || 0));
  });

  // Comments indexed by member (both directions) + direct comment count
  const commentsByMember = new Map();
  const directCommentCount = new Map();
  // Connected neighbors per member (for seed computation)
  const connectedNeighbors = new Map();

  comments.forEach((c) => {
    const from = c.fromMember, to = c.toMember;
    if (!commentsByMember.has(from)) commentsByMember.set(from, []);
    commentsByMember.get(from).push(c);
    if (from !== to) {
      if (!commentsByMember.has(to)) commentsByMember.set(to, []);
      commentsByMember.get(to).push(c);
    }
    // directCommentCount: matches original computeMass which counts each comment once
    // even for self-comments (from === to), so only increment once per comment
    directCommentCount.set(from, (directCommentCount.get(from) || 0) + 1);
    if (from !== to) {
      directCommentCount.set(to, (directCommentCount.get(to) || 0) + 1);
    }

    // Track unique connected neighbors (exclude self-edges to match original delete connected[mid])
    if (from !== to) {
      if (!connectedNeighbors.has(from)) connectedNeighbors.set(from, new Set());
      if (!connectedNeighbors.has(to)) connectedNeighbors.set(to, new Set());
      connectedNeighbors.get(from).add(to);
      connectedNeighbors.get(to).add(from);
    }
  });

  // Comment pairs: normalized key (smaller id first) → count
  // Used by scoreCohesion — pre-computed once, shared across variants
  const commentPairs = {};
  comments.forEach((c) => {
    const a = c.fromMember, b = c.toMember;
    const k = a < b ? a + '-' + b : b + '-' + a;
    commentPairs[k] = (commentPairs[k] || 0) + 1;
  });

  return {
    postsByCreator,
    postCountByCreator,
    commentTotalByCreator,
    commentsByMember,
    directCommentCount,
    connectedNeighbors,
    commentPairs,
  };
}

// ============================================================
// Member seed (indexed version)
// ============================================================

/**
 * Compute member seed using pre-built index. O(1) per member instead of O(P+C).
 * Results are cached in seedCache to avoid recomputation across neighborhoods + positions.
 *
 * @param {string} mid - member ID
 * @param {*} ms - master seed
 * @param {{ members: Map, metadataHashes: Map, epochDate?: * }} state
 * @param {ReturnType<typeof buildIndex>} index - pre-built index
 * @param {Map} [seedCache] - optional cache to avoid recomputation
 * @returns {string} deterministic seed string
 */
export function computeMemberSeed(mid, ms, state, index = null, seedCache = null) {
  // Check cache first
  if (seedCache) {
    const cacheKey = mid + ':' + ms;
    const cached = seedCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }

  const { members, metadataHashes } = state;
  const m = members.get(mid);
  if (!m) return '0';

  let s = 'm:' + mid + ':' + m.username;
  let pc, cc, connectedKeys;

  if (index) {
    // O(1) lookups using pre-built index
    pc = index.postCountByCreator.get(mid) || 0;
    const memberComments = index.commentsByMember.get(mid);
    cc = memberComments ? memberComments.length : 0;
    const neighbors = index.connectedNeighbors.get(mid);
    connectedKeys = neighbors ? Array.from(neighbors).sort() : [];
  } else {
    // Fallback: full scan (backward compatible)
    const { posts, comments } = state;
    pc = 0;
    cc = 0;
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
  // Deterministic timestamp: use refTime instead of Date.now() for reproducibility
  metadataHashes.set(mid, { hash: hash32(s), encoded, timestamp: refTime });

  // Cache the result
  if (seedCache) {
    seedCache.set(mid + ':' + ms, s);
  }

  return s;
}

// ============================================================
// Mass computation (indexed version)
// ============================================================

/**
 * Compute mass for a single member using pre-built index. O(1) per member.
 */
export function computeMass(mid, state, params = DEFAULT_PARAMS, index = null) {
  const { members } = state;
  let pc, tc, dc, beams;

  if (index) {
    pc = index.postCountByCreator.get(mid) || 0;
    tc = index.commentTotalByCreator.get(mid) || 0;
    dc = index.directCommentCount.get(mid) || 0;
    beams = index.connectedNeighbors.get(mid)?.size || 0;
  } else {
    // Fallback: full scan
    const { posts, comments } = state;
    pc = 0; tc = 0; dc = 0;
    const beamSet = {};
    posts.forEach((p) => {
      if (p.creator === mid) { pc++; tc += p.commentCount || 0; }
    });
    comments.forEach((c) => {
      if (c.fromMember === mid || c.toMember === mid) {
        dc++;
        if (c.fromMember !== mid) beamSet[c.fromMember] = 1;
        if (c.toMember !== mid) beamSet[c.toMember] = 1;
      }
    });
    beams = Object.keys(beamSet).length;
  }

  const m = members.get(mid);
  const serverTc = m && (m.totalComments != null || m.TotalComments != null)
    ? Number(m.totalComments ?? m.TotalComments) || 0
    : 0;
  const serverW = params.massServerCommentW ?? 0.25;
  const beamW = params.massBeamW ?? 0.6;
  return 1 + pc * params.massPostW + tc * params.massCommentTotalW + dc * params.massDirectCommentW + serverTc * serverW + beams * beamW;
}

/**
 * Compute mass for ALL members at once using index. Returns Map<mid, mass>.
 * Much faster than calling computeMass per member.
 */
export function computeAllMasses(state, params = DEFAULT_PARAMS, index = null) {
  const idx = index || buildIndex(state);
  const masses = new Map();
  state.members.forEach((m, mid) => {
    masses.set(mid, computeMass(mid, state, params, idx));
  });
  return masses;
}

/** Build adjacency and connected clusters from comments (no seed). Expensive; cache result per evolve(). */
export function getClusterStructure(state) {
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
  return { clusters };
}

/** Build neighborhoods (with hashes and centers) from precomputed clusters + seed. Uses index + seedCache. */
export function computeNeighborhoodsFromStructure(ms, state, clusterStructure, index = null, seedCache = null) {
  const { clusters } = clusterStructure;
  const nhs = new Map();
  for (let i = 0; i < clusters.length; i++) {
    const seeds = clusters[i].sort().map((id) => computeMemberSeed(id, ms, state, index, seedCache));
    nhs.set('nh_' + i, {
      members: new Set(clusters[i]),
      hash: hash32(seeds.join('|')),
      center: null,
    });
  }
  const nhRadiusBase = DEFAULT_PARAMS.nhRadiusBase ?? 80;
  const nhRadiusScale = DEFAULT_PARAMS.nhRadiusScale ?? 16;
  for (let i = 0; i < clusters.length; i++) {
    const nh = nhs.get('nh_' + i);
    if (nh) {
      nh.center = seedToPos(
        'nh:nh_' + i + ':' + nh.hash + ':' + ms,
        nhRadiusBase + clusters.length * nhRadiusScale
      );
    }
  }
  return nhs;
}

export function computeNeighborhoods(ms, state) {
  const clusterStructure = getClusterStructure(state);
  return computeNeighborhoodsFromStructure(ms, state, clusterStructure);
}

/**
 * Build member-to-neighborhood reverse index for O(1) lookup.
 * @param {Map} nhs - neighborhoods map
 * @returns {Map<string, { center: vec3, size: number }>}
 */
function buildMemberNhIndex(nhs) {
  const memberNh = new Map();
  nhs.forEach((nh) => {
    if (!nh.center) return;
    const entry = { center: nh.center, size: nh.members.size };
    nh.members.forEach((mid) => {
      memberNh.set(mid, entry);
    });
  });
  return memberNh;
}

export function encodeWithSeed(seed, state, params = DEFAULT_PARAMS, predictions = null, precomputedNhs = null, index = null, seedCache = null, precomputedMasses = null) {
  const { members } = state;
  const nhs = precomputedNhs ?? computeNeighborhoods(seed, state);
  const positions = new Map();
  const arr = [];
  nhs.forEach((v, k) => arr.push([k, v]));
  if (!precomputedNhs) {
    for (let i = 0; i < arr.length; i++) {
      arr[i][1].center = seedToPos(
        'nh:' + arr[i][0] + ':' + arr[i][1].hash + ':' + seed,
        params.nhRadiusBase + arr.length * params.nhRadiusScale
      );
    }
  }

  // Build member-to-neighborhood reverse index for O(1) lookup per member
  const memberNh = buildMemberNhIndex(nhs);

  // Derive mass and engagement once per member (used in position + time/engagement pass)
  const massByMember = precomputedMasses || new Map();
  const engagementByMember = new Map();
  let maxEngagement = 1;
  members.forEach((m, mid) => {
    const mass = massByMember.get(mid) ?? computeMass(mid, state, params, index);
    if (!precomputedMasses) massByMember.set(mid, mass);
    const tc = m && (m.totalComments != null || m.TotalComments != null)
      ? Number(m.totalComments ?? m.TotalComments) || 0
      : 0;
    const serverEng = 1 + Math.log(1 + tc);
    const eng = Math.max(mass, serverEng);
    engagementByMember.set(mid, eng);
    if (eng > maxEngagement) maxEngagement = eng;
  });

  members.forEach((_, mid) => {
    const s = computeMemberSeed(mid, seed, state, index, seedCache);
    const mass = massByMember.get(mid) ?? 1;
    // O(1) neighborhood lookup instead of iterating all neighborhoods
    const nhInfo = memberNh.get(mid);
    const nhC = nhInfo ? nhInfo.center : vec3();
    const nhS = nhInfo ? nhInfo.size : 1;
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
  const refTime = state.epochDate ? new Date(state.epochDate).getTime() : Date.now();
  let minJoin = Infinity, maxJoin = -Infinity;
  members.forEach((m, mid) => {
    const jt = m.created ? new Date(m.created).getTime() : refTime;
    if (jt < minJoin) minJoin = jt;
    if (jt > maxJoin) maxJoin = jt;
  });
  const joinRange = Math.max(maxJoin - minJoin, 1);

  const TARGET_RADIUS = 220;

  let maxXZ = 0;
  positions.forEach((p) => {
    const xz = Math.sqrt(p.x * p.x + p.z * p.z);
    if (xz > maxXZ) maxXZ = xz;
  });
  if (maxXZ === 0) maxXZ = 1;

  // Apply time→Y (with engagement compression) and engagement→XZ (with power curve)
  const xzPow = params.engagementXZPower ?? 0.7;
  const yCompressionFactor = params.yEngagementCompression ?? 0.4;
  positions.forEach((p, mid) => {
    const m = members.get(mid);
    const jt = m && m.created ? new Date(m.created).getTime() : refTime;
    const joinT = (jt - minJoin) / joinRange;

    const eng = engagementByMember.get(mid) ?? 1;
    const engT = Math.log(1 + eng) / Math.log(1 + maxEngagement);

    // Y: time axis, compressed toward 0 for high-engagement users
    const yCompress = 1 - engT * yCompressionFactor;
    p.y = (joinT * 2 - 1) * TARGET_RADIUS * yCompress;

    // XZ: power curve pulls high-engagement users more aggressively toward horizontal center
    const pullT = Math.pow(engT, xzPow);
    const targetXZ = (1 - pullT) * TARGET_RADIUS;

    const curXZ = Math.sqrt(p.x * p.x + p.z * p.z) || 1;
    const scale = targetXZ / curXZ;
    p.x *= scale;
    p.z *= scale;
  });

  // --- Interpersonal attractor: high-mass users pull connected members toward them (XZ only) ---
  const aStr = params.attractorStrength ?? 0.3;
  if (index && aStr > 0) {
    const newPositions = new Map();
    positions.forEach((p, mid) => {
      const neighbors = index.connectedNeighbors.get(mid);
      if (!neighbors || neighbors.size === 0) {
        newPositions.set(mid, p);
        return;
      }
      const ownMass = massByMember.get(mid) ?? 1;
      // High-mass members resist being pulled; low-mass members are more susceptible
      const susceptibility = 1 / (1 + ownMass * 0.3);
      let pullX = 0, pullZ = 0, totalW = 0;
      neighbors.forEach((nid) => {
        const np = positions.get(nid);
        if (!np) return;
        const nMass = massByMember.get(nid) ?? 1;
        const w = Math.log(1 + nMass);
        pullX += (np.x - p.x) * w;
        pullZ += (np.z - p.z) * w;
        totalW += w;
      });
      if (totalW > 0) {
        const str = aStr * susceptibility;
        newPositions.set(mid, vec3(
          p.x + (pullX / totalW) * str,
          p.y,
          p.z + (pullZ / totalW) * str
        ));
      } else {
        newPositions.set(mid, p);
      }
    });
    newPositions.forEach((p, mid) => positions.set(mid, p));
  }

  return { positions, neighborhoods: nhs };
}

/**
 * Score cohesion using pre-computed comment pairs.
 * When precomputedPairs is provided, avoids rebuilding the pairs map from comments.
 */
export function scoreCohesion(positions, state, params = DEFAULT_PARAMS, precomputedPairs = null) {
  const pairs = precomputedPairs || (() => {
    const { comments } = state;
    if (comments.size === 0) return null;
    const p = {};
    comments.forEach((c) => {
      const a = c.fromMember, b = c.toMember;
      const k = a < b ? a + '-' + b : b + '-' + a;
      p[k] = (p[k] || 0) + 1;
    });
    return p;
  })();

  if (!pairs) return 1;

  // Weighted mean distance: pairs with more comments get higher weight, so evolution pulls them closer.
  // Log-scale weight prevents a single high-volume pair from dominating the layout.
  let t = 0, n = 0;
  for (const k of Object.keys(pairs)) {
    const [a, b] = k.split('-');
    const pa = positions.get(a), pb = positions.get(b);
    if (pa && pb) {
      const count = pairs[k];
      const w = Math.log(1 + count) * (params.pairGravityScale ?? 1.0);
      t += v3dist(pa, pb) * w;
      n += w;
    }
  }
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
 *
 * Performance: builds index + comment pairs once, shares across all variants.
 * Seed cache prevents double computation of member seeds.
 */
export function evolve(state, params = DEFAULT_PARAMS, predictions = null) {
  const { members, posts, comments, targetPos, masterSeed, fitnessHistory } = state;
  state.sessionCount++;
  const sc = state.sessionCount;
  const temp = getTemp(sc, params);
  const base = hash32('ses:' + sc + ':m' + members.size + ':p' + posts.size + ':c' + comments.size + ':prev' + masterSeed);

  // Build index ONCE for this evolve — all variants reuse it
  const index = buildIndex(state);

  // Pre-compute comment pairs ONCE — shared by scoreCohesion across all variants
  const commentPairs = index.commentPairs;

  // Pre-compute masses ONCE — shared across all variants
  const masses = computeAllMasses(state, params, index);

  // Compute cluster structure once per evolve (expensive BFS); reuse for all variants
  const clusterStructure = getClusterStructure(state);

  const variants = [];
  const vc = params.variantCount;
  for (let i = 0; i < vc; i++) {
    const ms = Math.floor(temp * (0.3 + (i === 0 ? 0 : (i / (vc - 1)) * 2.5)) * 0xffffff);
    const seed = i === 0 ? base : hash32(base + ':mut:' + i + ':ms' + ms + ':sc' + sc);
    // Each variant gets its own seed cache (seeds depend on the variant's seed)
    const seedCache = new Map();
    const nhs = computeNeighborhoodsFromStructure(seed, state, clusterStructure, index, seedCache);
    const r = encodeWithSeed(seed, state, params, predictions, nhs, index, seedCache, masses);
    const c = scoreCohesion(r.positions, state, params, commentPairs);
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
    m.mass = masses.get(id) ?? 1;
    const t = w.positions.get(id);
    // CRITICAL FIX: Reset position to target when target changes
    // This prevents "zoom to wrong place" bug after evolution
    if (t && typeof t.x === 'number' && typeof t.y === 'number' && typeof t.z === 'number') {
      m.position = vec3(t.x, t.y, t.z);
      m.opacity = m.opacity ?? 0.9;
      m.scale = m.scale ?? 1.0;
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
