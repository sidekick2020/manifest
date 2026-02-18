#!/usr/bin/env node
/**
 * Parameter sweep: test codec hyperparameter combinations, find best.
 * Loads data once, then for each param combination:
 *   1. Run N evolution sessions
 *   2. Compute predicted-vs-optimal error
 *   3. Record results
 * Outputs ranked param sets sorted by mean error.
 *
 * Usage: npm run sweep   or   node training/sweep.js
 */
import { config } from './config.js';
import { loadInitialData } from './load-data.js';
import { DEFAULT_PARAMS, createState, evolve } from '../lib/codec.js';
import { computeGraphOptimal } from '../lib/graphOptimal.js';
import { computePredictionError } from '../lib/hashTrainer.js';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

// Param grid: each key maps to array of values to test
const SWEEP_GRID = {
  cohesionWeight: [0.4, 0.5, 0.6, 0.7, 0.8],
  stabilityWeight: [0.2, 0.3, 0.4, 0.5],
  nhRadiusBase: [15, 25, 35],
  nhRadiusScale: [3, 5, 8],
  localRadiusBase: [2, 3, 5],
  gravityFactor: [0.1, 0.15, 0.25, 0.35],   // 0.35 = current tuned value
  annealingRate: [0.6, 0.72, 0.85],
  pairGravityScale: [0.5, 1.0, 1.5, 2.0],  // NEW: comment-count gravity weight
};

const SESSIONS_PER_TEST = 15;

function cloneState(state) {
  const fresh = createState();
  state.members.forEach((v, k) => fresh.members.set(k, { ...v, position: null }));
  state.posts.forEach((v, k) => fresh.posts.set(k, { ...v }));
  state.comments.forEach((v, k) => fresh.comments.set(k, { ...v }));
  return fresh;
}

function testParams(baseState, optimalPositions, params) {
  const testState = cloneState(baseState);
  for (let i = 0; i < SESSIONS_PER_TEST; i++) {
    evolve(testState, params);
  }
  const error = computePredictionError(testState.targetPos, optimalPositions);
  return {
    meanError: error.meanError,
    medianError: error.medianError,
    r2: error.r2,
    fitness: testState.fitnessHistory[testState.fitnessHistory.length - 1] || 0,
  };
}

async function main() {
  console.log('Manifest param sweep\n');

  // Load data
  console.log('Loading data...');
  const { state } = await loadInitialData(config, config.loadBatches ?? 5);
  console.log(`  ${state.members.size} members, ${state.posts.size} posts, ${state.comments.size} comments\n`);

  if (state.members.size === 0) {
    console.log('No data. Exiting.');
    process.exit(1);
  }

  // Compute graph-optimal once (ground truth)
  console.log('Computing graph-optimal positions...');
  const { positions: optimalPositions } = computeGraphOptimal(
    { members: state.members, comments: state.comments },
    { iterations: 200 }
  );
  console.log('  Done.\n');

  // Generate param combinations (1D sweep: vary one param at a time)
  const combos = [];
  for (const [key, values] of Object.entries(SWEEP_GRID)) {
    for (const val of values) {
      combos.push({ ...DEFAULT_PARAMS, [key]: val, _swept: key, _val: val });
    }
  }

  // Also test baseline
  combos.unshift({ ...DEFAULT_PARAMS, _swept: 'baseline', _val: 'default' });

  console.log(`Testing ${combos.length} param combinations (${SESSIONS_PER_TEST} sessions each)...\n`);

  const results = [];
  for (let i = 0; i < combos.length; i++) {
    const params = combos[i];
    const { _swept, _val, ...cleanParams } = params;
    const result = testParams(state, optimalPositions, cleanParams);
    results.push({
      swept: _swept,
      value: _val,
      ...result,
      params: cleanParams,
    });

    if ((i + 1) % 5 === 0 || i === combos.length - 1) {
      console.log(`  ${i + 1}/${combos.length} tested`);
    }
  }

  // Sort by mean error (ascending = best first)
  results.sort((a, b) => a.meanError - b.meanError);

  console.log('\n=== TOP 10 RESULTS ===\n');
  for (let i = 0; i < Math.min(10, results.length); i++) {
    const r = results[i];
    console.log(`  ${i + 1}. [${r.swept}=${r.value}] meanErr=${r.meanError.toFixed(2)} R²=${r.r2.toFixed(3)} fitness=${r.fitness.toFixed(3)}`);
  }

  // Save full report
  const report = {
    timestamp: new Date().toISOString(),
    data: { members: state.members.size, posts: state.posts.size, comments: state.comments.size },
    sessionsPerTest: SESSIONS_PER_TEST,
    totalCombinations: combos.length,
    bestParams: results[0]?.params || null,
    bestError: results[0]?.meanError || null,
    rankings: results.map(({ swept, value, meanError, medianError, r2, fitness }) => ({
      swept, value, meanError, medianError, r2, fitness,
    })),
  };

  try {
    await mkdir(config.outputDir, { recursive: true });
    const outPath = join(config.outputDir, `sweep-${Date.now()}.json`);
    await writeFile(outPath, JSON.stringify(report, null, 2));
    console.log('\nSweep report written to', outPath);
  } catch (e) {
    console.warn('Could not write output:', e.message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
