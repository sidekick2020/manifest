/**
 * Zustand store for the Manifest universe.
 * Holds codec state (Maps by reference), feed/UI state, and derived metrics.
 * Maps are mutated in place; `version` counter triggers re-renders.
 */
import { create } from 'zustand';
import { createState, evolve, getTemp, DEFAULT_PARAMS } from '../../lib/codec.js';
import { feedFromBack4App, DEFAULT_CONFIG } from '../../lib/back4app.js';
import { v3lerp } from '../../lib/vec3.js';

// Lazy getter for prediction store to avoid circular import
let _getPredictionStore = null;
export function setPredictionStoreGetter(getter) {
  _getPredictionStore = getter;
}

function computeBeamCount(comments) {
  const bs = {};
  comments.forEach((c) => {
    const a = c.fromMember, b = c.toMember;
    bs[a < b ? a + '-' + b : b + '-' + a] = 1;
  });
  return Object.keys(bs).length;
}

function computeHashAccuracy(members, posts, comments, metadataHashes) {
  let tAcc = 0, aCnt = 0;
  metadataHashes.forEach((mh, mid) => {
    if (!members.has(mid)) return;
    let apc = 0, acc = 0;
    const aco = {};
    posts.forEach((p) => { if (p.creator === mid) apc++; });
    comments.forEach((c) => { if (c.fromMember === mid) acc++; });
    comments.forEach((c) => {
      if (c.fromMember === mid) aco[c.toMember] = 1;
      if (c.toMember === mid) aco[c.fromMember] = 1;
    });
    let ma = 0;
    if (mh.encoded.postCount === apc) ma++;
    if (mh.encoded.commentCount === acc) ma++;
    if (mh.encoded.connections === Object.keys(aco).length) ma++;
    tAcc += ma / 3;
    aCnt++;
  });
  return aCnt > 0 ? Math.round((tAcc / aCnt) * 100) : null;
}

export const useUniverseStore = create((set, get) => {
  const codec = createState();

  return {
    // --- Codec state (mutable refs) ---
    members: codec.members,
    posts: codec.posts,
    comments: codec.comments,
    soberDateChanges: codec.soberDateChanges,
    targetPos: codec.targetPos,
    neighborhoods: codec.neighborhoods,
    metadataHashes: codec.metadataHashes,
    sessionCount: 0,
    masterSeed: 0,
    fitnessHistory: [],

    // --- Feed state ---
    skips: { userSkip: 0, postSkip: 0, commentSkip: 0 },
    epochDate: null,
    feeding: false,
    status: 'idle',

    // --- UI ---
    selectedMember: null,
    selectedPost: null,
    running: false,
    intervalId: null,
    performanceMode: false,
    animationEnabled: true,  // Control animation freeze
    zoomToMemberTrigger: null, // Set to member ID to trigger zoom in Scene.jsx

    // --- Derived ---
    beamCount: 0,
    hashAccuracy: null,
    temperature: 1,

    // --- Mutation version (increment to signal change) ---
    version: 0,

    // --- Actions ---

    /** Build codec state object from current store (for passing to lib functions) */
    _codecState() {
      const s = get();
      return {
        members: s.members,
        posts: s.posts,
        comments: s.comments,
        soberDateChanges: s.soberDateChanges,
        targetPos: s.targetPos,
        neighborhoods: s.neighborhoods,
        metadataHashes: s.metadataHashes,
        sessionCount: s.sessionCount,
        masterSeed: s.masterSeed,
        fitnessHistory: s.fitnessHistory,
      };
    },

    async feedStep(params = DEFAULT_PARAMS) {
      const s = get();
      if (s.feeding) return false;

      // OPTIMIZATION: Auto-enable performance mode for large datasets
      if (s.members.size > 10000 && !s.performanceMode) {
        console.log('🚀 Entering performance mode (10K+ members) - disabling expensive features');
        set({ performanceMode: true, status: 'performance mode enabled (10K+ members)' });
      }

      set({ feeding: true, animationEnabled: false, status: 'querying back4app...' });

      const feedState = { members: s.members, posts: s.posts, comments: s.comments, soberDateChanges: s.soberDateChanges };
      const skips = { ...s.skips };

      try {
        const { added, epochDate } = await feedFromBack4App(DEFAULT_CONFIG, feedState, skips, {
          userLimit: 200,       // Load many more users per batch for faster scaling
          postLimit: 200,       // Load many more posts
          commentLimit: 400,    // Load many more comments
          soberDateChangeLimit: 50,
          order: '-createdAt'   // Posts/comments by recent, users by updatedAt (set in back4app.js)
        });

        // Update skips
        set({
          feeding: false,
          animationEnabled: true,  // Re-enable animation after data load
          skips,
          epochDate: epochDate || s.epochDate,
          status: added > 0 ? `+${added} from back4app (${s.members.size} members, ${s.soberDateChanges.size} SDC)` : 'no new data',
        });

        // Evolve if we have data (skip during animation freeze)
        if (s.members.size > 0 && s.animationEnabled) {
          const codecState = get()._codecState();

          // CRITICAL OPTIMIZATION: Skip expensive evolution for large datasets
          // Use simple deterministic positioning instead
          if (s.members.size > 800) {
            // Simple sphere positioning for large datasets (instant, no computation)
            s.members.forEach((m, id) => {
              if (!s.targetPos.has(id)) {
                // Deterministic position based on member ID
                const hash = id.split('').reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0);
                const t = Math.abs(hash) / 2147483647;
                const phi = t * Math.PI * 2;
                const theta = Math.acos(2 * ((hash >>> 16) / 65535) - 1);
                const r = 80 + (Math.abs(hash) % 40); // Radius 80-120

                s.targetPos.set(id, {
                  x: r * Math.sin(theta) * Math.cos(phi),
                  y: r * Math.sin(theta) * Math.sin(phi),
                  z: r * Math.cos(theta)
                });
              }
            });

            set({ version: get().version + 1 });
          } else {
            // Use normal evolution for smaller datasets
            let predictions = null;
            if (_getPredictionStore) {
              const predStore = _getPredictionStore();
              predictions = predStore.active ? predStore.predictions : null;
            }

            const result = evolve(codecState, params, predictions);

            set({
              sessionCount: codecState.sessionCount,
              masterSeed: codecState.masterSeed,
              targetPos: codecState.targetPos,
              neighborhoods: codecState.neighborhoods,
              fitnessHistory: [...codecState.fitnessHistory],
              beamCount: computeBeamCount(s.comments),
              hashAccuracy: computeHashAccuracy(s.members, s.posts, s.comments, s.metadataHashes),
              temperature: getTemp(codecState.sessionCount, params),
              version: get().version + 1,
            });
          }
        }
        return added > 0;
      } catch (err) {
        set({ feeding: false, status: 'API error: ' + (err.message || 'unknown') });
        return false;
      }
    },

    runEvolve(params = DEFAULT_PARAMS) {
      const codecState = get()._codecState();
      // Get predictions from predictionStore if active (lazy to avoid circular import)
      let predictions = null;
      if (_getPredictionStore) {
        const predStore = _getPredictionStore();
        predictions = predStore.active ? predStore.predictions : null;
      }
      const result = evolve(codecState, params, predictions);
      const s = get();
      set({
        sessionCount: codecState.sessionCount,
        masterSeed: codecState.masterSeed,
        targetPos: codecState.targetPos,
        neighborhoods: codecState.neighborhoods,
        fitnessHistory: [...codecState.fitnessHistory],
        beamCount: computeBeamCount(s.comments),
        hashAccuracy: computeHashAccuracy(s.members, s.posts, s.comments, s.metadataHashes),
        temperature: getTemp(codecState.sessionCount, params),
        version: s.version + 1,
      });
      return result;
    },

    tick() {
      const { members, targetPos } = get();
      const t = 0.04;
      let changed = false;
      members.forEach((m, id) => {
        const target = targetPos.get(id);
        if (!target) return;
        if (!m.position) {
          m.position = { x: target.x, y: target.y, z: target.z };
          changed = true;
          return;
        }
        m.position = v3lerp(m.position, target, t);
        m.opacity = (m.opacity ?? 0) + (0.9 - (m.opacity ?? 0)) * 0.03;
        m.scale = (m.scale ?? 0) + (1 - (m.scale ?? 0)) * 0.04;
        changed = true;
      });
      if (changed) set({ version: get().version + 1 });
    },

    toggleRunning() {
      const s = get();
      if (s.running) {
        // Stop immediately - clear interval and update state
        if (s.intervalId) clearInterval(s.intervalId);
        set({ running: false, intervalId: null, status: 'paused — explore' });
      } else {
        // Start running - first feed, then set up interval
        // Don't await to keep UI responsive
        s.feedStep().catch(err => {
          console.error('[toggleRunning] Initial feed error:', err);
          set({ running: false, intervalId: null, status: 'error: ' + err.message });
        });
        // OPTIMIZATION: Slower feed interval for better performance (5 seconds instead of 2.5)
        const id = setInterval(() => {
          get().feedStep().catch(err => {
            console.error('[toggleRunning] Interval feed error:', err);
            // Don't stop on error, just log it
          });
        }, 5000);
        set({ running: true, intervalId: id });
      }
    },

    setSelectedMember(id, options = {}) {
      const shouldZoom = options.zoom !== false; // Default to true
      console.log(`[Store] setSelectedMember(${id ? id.slice(0, 8) + '...' : 'null'}, zoom=${shouldZoom})`);
      set({
        selectedMember: id,
        zoomToMemberTrigger: shouldZoom ? id : null
      });
      console.log(`[Store] zoomToMemberTrigger set to:`, shouldZoom ? id : null);
    },

    setSelectedPost(id) {
      set({ selectedPost: id });
    },

    reset() {
      const s = get();
      if (s.intervalId) clearInterval(s.intervalId);
      const fresh = createState();
      set({
        members: fresh.members,
        posts: fresh.posts,
        comments: fresh.comments,
        soberDateChanges: fresh.soberDateChanges,
        targetPos: fresh.targetPos,
        neighborhoods: fresh.neighborhoods,
        metadataHashes: fresh.metadataHashes,
        sessionCount: 0,
        masterSeed: 0,
        fitnessHistory: [],
        skips: { userSkip: 0, postSkip: 0, commentSkip: 0 },
        epochDate: null,
        feeding: false,
        status: 'reset',
        selectedMember: null,
        selectedPost: null,
        running: false,
        intervalId: null,
        beamCount: 0,
        hashAccuracy: null,
        temperature: 1,
        version: 0,
      });
    },
  };
});
