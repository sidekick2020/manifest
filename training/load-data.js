/**
 * Load users, posts, comments from Back4App into state + skips.
 * Uses the same feedFromBack4App as the app; run multiple times to accumulate.
 */
import { createState } from '../lib/codec.js';
import { feedFromBack4App, b4a, DEFAULT_CONFIG } from '../lib/back4app.js';

export async function loadBatches(config, state, skips, numBatches = 1) {
  // Don't load SDC in the batch loop — we'll do a targeted load after
  const batchWithoutSDC = { ...config.batch, soberDateChangeLimit: 0 };
  const results = [];
  for (let i = 0; i < numBatches; i++) {
    const { added, epochDate } = await feedFromBack4App(
      { appId: config.appId, restKey: config.restKey },
      state,
      skips,
      batchWithoutSDC
    );
    results.push({ added, epochDate, members: state.members.size, posts: state.posts.size, comments: state.comments.size });
  }
  return results;
}

/**
 * Load SoberDateChange records for the members we've already loaded.
 * Uses GET-based $in queries with small ID batches to avoid URL length limits.
 * Each pointer is ~80 chars encoded, so 15 IDs ≈ 1.2KB in the where clause.
 * Runs up to 8 concurrent requests for speed.
 * Only loads records where setOnDayOne=false (actual resets).
 */
export async function loadSoberDateChanges(config, state) {
  const memberIds = [...state.members.keys()];
  if (memberIds.length === 0) return 0;

  if (!state.soberDateChanges) state.soberDateChanges = new Map();
  let totalLoaded = 0;
  const BATCH_SIZE = 15;    // IDs per query (keep URL short: 15 × ~80 chars ≈ 1.2KB)
  const CONCURRENCY = 8;    // parallel requests
  const PER_PAGE = 1000;    // Parse max results per query

  // Split into batches of IDs
  const batches = [];
  for (let i = 0; i < memberIds.length; i += BATCH_SIZE) {
    batches.push(memberIds.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const chunk = batches.slice(i, i + CONCURRENCY);
    const promises = chunk.map(async (idBatch) => {
      const userPointers = idBatch.map(id => ({
        __type: 'Pointer', className: '_User', objectId: id,
      }));

      let skip = 0;
      let batchLoaded = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const rows = await b4a(config.appId, config.restKey, 'SoberDateChange', {
          where: {
            user: { '$in': userPointers },
            setOnDayOne: false,
          },
          keys: 'objectId,user,date,lastSoberDate,setOnDayOne,daysSince,TotalComments,commentsSince,createdAt',
          limit: PER_PAGE,
          skip,
          order: '-createdAt',
        });

        for (const sdc of rows) {
          if (!state.soberDateChanges.has(sdc.objectId)) {
            state.soberDateChanges.set(sdc.objectId, {
              userId: sdc.user?.objectId || null,
              newDate: sdc.date?.iso ?? null,
              lastSoberDate: sdc.lastSoberDate?.iso ?? null,
              setOnDayOne: false,
              daysSince: sdc.daysSince ?? null,
              totalComments: sdc.TotalComments ?? 0,
              commentsSince: sdc.commentsSince ?? 0,
              created: sdc.createdAt,
            });
            batchLoaded++;
          }
        }

        skip += rows.length;
        if (rows.length < PER_PAGE) break;
      }
      return batchLoaded;
    });

    const results = await Promise.all(promises);
    totalLoaded += results.reduce((a, b) => a + b, 0);

    // Progress logging
    const completed = Math.min(i + CONCURRENCY, batches.length);
    if (completed % 40 === 0 || completed === batches.length) {
      process.stdout.write(`    ${completed}/${batches.length} ID batches queried (${totalLoaded} SDCs so far)\n`);
    }
  }

  return totalLoaded;
}

/**
 * Create fresh state and skips, then load N batches. For training we only need
 * one big load (or chronological steps). Returns { state, skips, batches }.
 */
export async function loadInitialData(config, numBatches = 5) {
  const state = createState();
  const skips = { userSkip: 0, postSkip: 0, commentSkip: 0, sdcSkip: 0 };
  state.userSkip = 0;
  state.postSkip = 0;
  state.commentSkip = 0;
  const batches = await loadBatches(config, state, skips, numBatches);
  return { state, skips, batches };
}
