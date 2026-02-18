/**
 * Training run config. Override with env: PARSE_APP_ID, PARSE_REST_KEY.
 *
 * Back4App has ~688K users, ~378K posts, ~2M comments spanning 7 years.
 * We load aggressively to get enough sobriety resets for meaningful metrics.
 *
 * v2: Default to --recent (newest data first) since recent data has far
 * more SoberDateChange ground-truth records. The first few thousand users
 * (2019-era) have very sparse relapse data.
 *
 * Pass --oldest to load oldest data first (original behavior).
 */
const oldest = process.argv.includes('--oldest');
const recent = !oldest; // Default to recent now

export const config = {
  appId: process.env.PARSE_APP_ID || 'Wuo5quzr8f2vZDeSSskftVcDKPUpm16VHdDLm3by',
  restKey: process.env.PARSE_REST_KEY || 'rNXb9qIR6wrZ3n81OG33HVQkpPsXANUatiOE5HSq',
  batch: {
    userLimit: 500,
    postLimit: 1000,
    commentLimit: 2500,
    soberDateChangeLimit: 1500,
    order: recent ? '-createdAt' : 'createdAt',
  },
  recent,
  loadBatches: 20,     // Load 20 batches to get ~90 days of data (was 5)
  maxSessions: 50,
  // Logistic regression training params
  // Higher L2 regularization prevents over-weighting hasPriorReset
  // Lower LR + more epochs to converge with strong regularization
  training: {
    lr: 0.005,
    epochs: 1500,
    l2: 0.05,
    classWeight: 'balanced',
  },
  outputDir: new URL('./output', import.meta.url).pathname,
};
