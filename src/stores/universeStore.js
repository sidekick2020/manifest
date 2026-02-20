/**
 * Zustand store for the Manifest universe.
 * Holds codec state (Maps by reference), feed/UI state, and derived metrics.
 * Maps are mutated in place; `version` counter triggers re-renders.
 *
 * Performance optimizations:
 *   - Uses codec buildIndex for O(1) per-member lookups in computeHashAccuracy/computeBeamCount
 *   - Adaptive polling backoff: increases interval when no new data, resets on new data
 *   - API exhaustion tracking: stops fetching entity types that are fully loaded
 *   - Uses pre-computed comment pairs from codec index for beam count
 */
import { create } from 'zustand';
import { createState, evolve, getTemp, buildIndex, DEFAULT_PARAMS } from '../../lib/codec.js';
import { feedFromBack4App, DEFAULT_CONFIG } from '../../lib/back4app.js';
import { v3lerp } from '../../lib/vec3.js';

// Lazy getter for prediction store to avoid circular import
let _getPredictionStore = null;
export function setPredictionStoreGetter(getter) {
  _getPredictionStore = getter;
}

/**
 * Compute beam count using pre-built index comment pairs (O(1) if index provided).
 */
function computeBeamCount(comments, index) {
  if (index && index.commentPairs) {
    return Object.keys(index.commentPairs).length;
  }
  const bs = {};
  comments.forEach((c) => {
    const a = c.fromMember, b = c.toMember;
    bs[a < b ? a + '-' + b : b + '-' + a] = 1;
  });
  return Object.keys(bs).length;
}

/**
 * Compute hash accuracy using pre-built index for O(1) lookups per member.
 */
function computeHashAccuracy(members, metadataHashes, index) {
  let tAcc = 0, aCnt = 0;
  metadataHashes.forEach((mh, mid) => {
    if (!members.has(mid)) return;
    let apc, acc, acoCount;
    if (index) {
      apc = index.postCountByCreator.get(mid) || 0;
      // Count only outgoing comments for accuracy comparison
      let outgoing = 0;
      const memberComments = index.commentsByMember.get(mid);
      if (memberComments) {
        for (const c of memberComments) {
          if (c.fromMember === mid) outgoing++;
        }
      }
      acc = outgoing;
      const neighbors = index.connectedNeighbors.get(mid);
      acoCount = neighbors ? neighbors.size : 0;
    } else {
      // Fallback without index — should not normally be used
      apc = 0; acc = 0;
      const aco = {};
      // These would need posts/comments from state, but this path is just for safety
      acoCount = 0;
    }
    let ma = 0;
    if (mh.encoded.postCount === apc) ma++;
    if (mh.encoded.commentCount === acc) ma++;
    if (mh.encoded.connections === acoCount) ma++;
    tAcc += ma / 3;
    aCnt++;
  });
  return aCnt > 0 ? Math.round((tAcc / aCnt) * 100) : null;
}

// Adaptive polling constants
const BASE_POLL_INTERVAL = 5000;    // 5s base
const MAX_POLL_INTERVAL = 60000;    // 60s max backoff
const BACKOFF_MULTIPLIER = 1.5;     // multiply interval by this on no-data

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

    // --- Polling state ---
    _pollInterval: BASE_POLL_INTERVAL,
    _consecutiveEmpty: 0,

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
        set({ performanceMode: true, status: 'performance mode enabled (10K+ members)' });
      }

      set({ feeding: true, animationEnabled: false, status: 'querying back4app...' });

      const feedState = { members: s.members, posts: s.posts, comments: s.comments, soberDateChanges: s.soberDateChanges };
      const skips = { ...s.skips };
      // Preserve exhaustion tracking across calls
      if (s.skips.exhausted) skips.exhausted = { ...s.skips.exhausted };

      try {
        const { added, epochDate, allExhausted } = await feedFromBack4App(DEFAULT_CONFIG, feedState, skips, {
          userLimit: 200,
          postLimit: 200,
          commentLimit: 400,
          soberDateChangeLimit: 50,
          order: '-createdAt'
        });

        // Adaptive polling: back off when no new data, reset on new data
        let newPollInterval = s._pollInterval;
        let consecutiveEmpty = s._consecutiveEmpty;
        if (added === 0 || allExhausted) {
          consecutiveEmpty++;
          newPollInterval = Math.min(
            s._pollInterval * BACKOFF_MULTIPLIER,
            MAX_POLL_INTERVAL
          );
        } else {
          consecutiveEmpty = 0;
          newPollInterval = BASE_POLL_INTERVAL;
        }

        // Build status message
        let status;
        if (allExhausted) {
          status = `all data loaded (${s.members.size} members)`;
        } else if (added > 0) {
          status = `+${added} from back4app (${s.members.size} members, ${s.soberDateChanges.size} SDC)`;
        } else {
          status = 'no new data';
        }

        set({
          feeding: false,
          animationEnabled: true,
          skips,
          epochDate: epochDate || s.epochDate,
          status,
          _pollInterval: newPollInterval,
          _consecutiveEmpty: consecutiveEmpty,
        });

        // Reschedule interval if backoff changed and we're running
        if (s.running && s.intervalId && newPollInterval !== s._pollInterval) {
          clearInterval(s.intervalId);
          const id = setInterval(() => {
            get().feedStep().catch(err => {
              console.error('[toggleRunning] Interval feed error:', err);
            });
          }, newPollInterval);
          set({ intervalId: id });
        }

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
                const r = 80 + (Math.abs(hash) % 40);

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

            // Build index once for derived metrics
            const index = buildIndex(codecState);

            set({
              sessionCount: codecState.sessionCount,
              masterSeed: codecState.masterSeed,
              targetPos: codecState.targetPos,
              neighborhoods: codecState.neighborhoods,
              fitnessHistory: [...codecState.fitnessHistory],
              beamCount: computeBeamCount(s.comments, index),
              hashAccuracy: computeHashAccuracy(s.members, s.metadataHashes, index),
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

      // Build index once for derived metrics
      const index = buildIndex(codecState);

      set({
        sessionCount: codecState.sessionCount,
        masterSeed: codecState.masterSeed,
        targetPos: codecState.targetPos,
        neighborhoods: codecState.neighborhoods,
        fitnessHistory: [...codecState.fitnessHistory],
        beamCount: computeBeamCount(s.comments, index),
        hashAccuracy: computeHashAccuracy(s.members, s.metadataHashes, index),
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
        s.feedStep().catch(err => {
          console.error('[toggleRunning] Initial feed error:', err);
          set({ running: false, intervalId: null, status: 'error: ' + err.message });
        });
        // Use adaptive poll interval
        const interval = s._pollInterval || BASE_POLL_INTERVAL;
        const id = setInterval(() => {
          get().feedStep().catch(err => {
            console.error('[toggleRunning] Interval feed error:', err);
          });
        }, interval);
        set({ running: true, intervalId: id });
      }
    },

    setSelectedMember(id, options = {}) {
      const shouldZoom = options.zoom !== false;
      set({
        selectedMember: id,
        zoomToMemberTrigger: shouldZoom ? id : null
      });
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
        _pollInterval: BASE_POLL_INTERVAL,
        _consecutiveEmpty: 0,
        beamCount: 0,
        hashAccuracy: null,
        temperature: 1,
        version: 0,
      });
    },
  };
});
