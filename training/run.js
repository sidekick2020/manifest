#!/usr/bin/env node
/**
 * Training pipeline: load Back4App data, train logistic regression,
 * compute rolling-window validation, run evolution sessions, compute all metrics.
 *
 * Features:
 *   - Default to recent data (more SoberDateChange ground truth)
 *   - Trains a logistic regression model with class balancing
 *   - Rolling-window temporal validation (multiple eval points)
 *   - Risk-driven spatial layout metrics
 *   - Saves trained model weights for browser/app use
 *
 * Usage: npm run training   or   node training/run.js
 *        node training/run.js --oldest   (for oldest-first data)
 */
import { config } from './config.js';
import { loadInitialData, loadSoberDateChanges } from './load-data.js';
import { runSessions } from './run-sessions.js';
import { hashVsReality } from './metrics/hash-vs-reality.js';
import { connectionVsDistance } from './metrics/connection-vs-distance.js';
import { predictedVsOptimal } from './metrics/predicted-vs-optimal.js';
import { predictionAccuracy } from './metrics/prediction-accuracy.js';
import { temporalValidation } from './metrics/temporal-validation.js';
import {
  extractFeatures, labelOutcomes, computePredictions,
  trainLogisticRegression, computeCohortStats, getCohortStatsForMember,
  FEATURE_NAMES, setThresholds,
} from '../lib/predictions.js';
import { computeRiskLayout } from '../lib/riskLayout.js';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

const DAY_MS = 86400000;

/**
 * Rolling-window temporal validation.
 * Train on window [0, t], predict outcomes in [t, t + windowSize].
 * Slides forward by stepSize each iteration.
 */
function rollingWindowValidation(state, model, opts = {}) {
  const { windowDays = 60, stepDays = 30, minTrainDays = 120 } = opts;

  // Find time range
  let earliest = Infinity, latest = 0;
  state.posts.forEach((p) => {
    const t = new Date(p.created).getTime();
    if (t < earliest) earliest = t;
    if (t > latest) latest = t;
  });
  state.comments.forEach((c) => {
    const t = new Date(c.created).getTime();
    if (t < earliest) earliest = t;
    if (t > latest) latest = t;
  });
  state.members.forEach((m) => {
    if (m.created) {
      const t = new Date(m.created).getTime();
      if (t < earliest) earliest = t;
      if (t > latest) latest = t;
    }
  });

  if (latest - earliest < (minTrainDays + windowDays) * DAY_MS) {
    return { error: 'Insufficient time range for rolling window', windows: [] };
  }

  const hasSdcData = state.soberDateChanges && state.soberDateChanges.size > 0;
  const windows = [];
  const windowMs = windowDays * DAY_MS;
  const stepMs = stepDays * DAY_MS;
  const minTrainMs = minTrainDays * DAY_MS;

  for (let cutoff = earliest + minTrainMs; cutoff + windowMs <= latest; cutoff += stepMs) {
    // Build train state (data before cutoff)
    const trainState = {
      members: new Map(),
      posts: new Map(),
      comments: new Map(),
      targetPos: state.targetPos,
      neighborhoods: state.neighborhoods,
      soberDateChanges: state.soberDateChanges,
    };

    state.members.forEach((m, mid) => {
      if (m.created && new Date(m.created).getTime() <= cutoff) {
        trainState.members.set(mid, m);
      }
    });
    state.posts.forEach((p, pid) => {
      if (new Date(p.created).getTime() <= cutoff) trainState.posts.set(pid, p);
    });
    state.comments.forEach((c, cid) => {
      if (new Date(c.created).getTime() <= cutoff) trainState.comments.set(cid, c);
    });

    if (trainState.members.size < 50) continue;

    // Predict at cutoff time
    const predictions = computePredictions(trainState, { now: cutoff, model });

    // Label outcomes in test window [cutoff, cutoff + windowMs]
    const testEnd = cutoff + windowMs;
    let tp = 0, fp = 0, fn = 0, tn = 0;
    let relapseCount = 0;

    // Build test-window relapse set
    const testRelapses = new Set();
    if (hasSdcData) {
      state.soberDateChanges.forEach((sdc) => {
        if (!sdc.setOnDayOne && sdc.lastSoberDate && sdc.userId) {
          const eventDate = sdc.newDate || sdc.lastSoberDate || sdc.created;
          const eventTime = new Date(eventDate).getTime();
          if (eventTime > cutoff && eventTime <= testEnd) {
            testRelapses.add(sdc.userId);
          }
        }
      });
    }

    predictions.forEach((pred, mid) => {
      if (pred.riskLevel === 'unknown') return;
      const relapsed = testRelapses.has(mid);
      if (relapsed) relapseCount++;
      const predictedHigh = pred.riskLevel === 'high';
      if (relapsed) { if (predictedHigh) tp++; else fn++; }
      else { if (predictedHigh) fp++; else tn++; }
    });

    const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
    const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0;
    const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;
    const fpr = (fp + tn) > 0 ? fp / (fp + tn) : 0;

    windows.push({
      cutoffDate: new Date(cutoff).toISOString().slice(0, 10),
      testEndDate: new Date(testEnd).toISOString().slice(0, 10),
      trainMembers: trainState.members.size,
      relapses: relapseCount,
      tp, fp, fn, tn,
      precision: Math.round(precision * 1000) / 1000,
      recall: Math.round(recall * 1000) / 1000,
      f1: Math.round(f1 * 1000) / 1000,
      fpr: Math.round(fpr * 1000) / 1000,
    });
  }

  // Aggregate across windows
  const validWindows = windows.filter(w => w.relapses > 0);
  const avgF1 = validWindows.length > 0
    ? validWindows.reduce((s, w) => s + w.f1, 0) / validWindows.length : 0;
  const avgRecall = validWindows.length > 0
    ? validWindows.reduce((s, w) => s + w.recall, 0) / validWindows.length : 0;
  const avgPrecision = validWindows.length > 0
    ? validWindows.reduce((s, w) => s + w.precision, 0) / validWindows.length : 0;

  return {
    windowCount: windows.length,
    windowsWithRelapses: validWindows.length,
    avgF1: Math.round(avgF1 * 1000) / 1000,
    avgRecall: Math.round(avgRecall * 1000) / 1000,
    avgPrecision: Math.round(avgPrecision * 1000) / 1000,
    windows,
  };
}


async function main() {
  const dataEra = config.recent ? 'MOST RECENT (newest first)' : 'EARLIEST (oldest first)';
  console.log(`Manifest training — learned logistic regression + risk layout`);
  console.log(`Data loading order: ${dataEra}\n`);

  console.log('Loading data from Back4App...');
  const { state, batches } = await loadInitialData(config, config.loadBatches);
  console.log(`  Loaded ${state.members.size} members, ${state.posts.size} posts, ${state.comments.size} comments over ${batches.length} batches`);

  console.log('Loading SoberDateChange ground truth for loaded members...');
  const sdcCount = await loadSoberDateChanges(config, state);
  console.log(`  Loaded ${sdcCount} sobriety resets (SoberDateChange records) for ${state.members.size} members`);

  // Show data time range
  let earliest = Infinity, latest = 0;
  state.members.forEach(m => {
    if (m.created) {
      const t = new Date(m.created).getTime();
      if (t < earliest) earliest = t;
      if (t > latest) latest = t;
    }
  });
  state.posts.forEach(p => {
    if (p.created) {
      const t = new Date(p.created).getTime();
      if (t < earliest) earliest = t;
      if (t > latest) latest = t;
    }
  });
  if (earliest < Infinity) {
    console.log(`  Data range: ${new Date(earliest).toISOString().slice(0,10)} → ${new Date(latest).toISOString().slice(0,10)} (${Math.round((latest - earliest) / 86400000)}d)\n`);
  } else {
    console.log()
  }

  if (state.members.size === 0) {
    console.log('No data loaded. Check Back4App credentials and network.');
    process.exit(1);
  }

  const now = latest || Date.now();

  // ========================================
  // PHASE 1: Train logistic regression model
  // ========================================
  console.log('=== PHASE 1: Training logistic regression ===');

  // CRITICAL: Proper temporal split to prevent data leakage.
  // Features extracted at trainCutoff time, labels from relapses AFTER trainCutoff.
  // hasPriorReset only counts resets BEFORE trainCutoff (not the ones we're predicting).
  const timeRange = latest - earliest;
  const trainCutoff = earliest + timeRange * 0.7;
  const trainCutoffDate = new Date(trainCutoff).toISOString().slice(0, 10);
  console.log(`  Temporal split: features ≤ ${trainCutoffDate}, labels after`);

  // Build train-window state (only data before cutoff)
  const trainState = {
    members: new Map(),
    posts: new Map(),
    comments: new Map(),
    targetPos: state.targetPos,
    neighborhoods: state.neighborhoods,
    // Only include SoberDateChanges BEFORE cutoff (prevents hasPriorReset data leak)
    soberDateChanges: new Map(),
  };

  state.members.forEach((m, mid) => {
    if (m.created && new Date(m.created).getTime() <= trainCutoff) {
      trainState.members.set(mid, m);
    }
  });
  state.posts.forEach((p, pid) => {
    if (new Date(p.created).getTime() <= trainCutoff) trainState.posts.set(pid, p);
  });
  state.comments.forEach((c, cid) => {
    if (new Date(c.created).getTime() <= trainCutoff) trainState.comments.set(cid, c);
  });
  // Only include SDCs before cutoff as "history" for hasPriorReset feature
  if (state.soberDateChanges) {
    state.soberDateChanges.forEach((sdc, sid) => {
      const eventDate = sdc.newDate || sdc.lastSoberDate || sdc.created;
      if (new Date(eventDate).getTime() <= trainCutoff) {
        trainState.soberDateChanges.set(sid, sdc);
      }
    });
  }
  console.log(`  Train window: ${trainState.members.size} members, ${trainState.posts.size} posts, ${trainState.soberDateChanges.size} SDCs (before cutoff)`);

  // Build FUTURE relapse labels (relapses after trainCutoff)
  const futureRelapses = new Set();
  if (state.soberDateChanges) {
    state.soberDateChanges.forEach((sdc) => {
      if (!sdc.setOnDayOne && sdc.lastSoberDate && sdc.userId) {
        const eventDate = sdc.newDate || sdc.lastSoberDate || sdc.created;
        if (new Date(eventDate).getTime() > trainCutoff) {
          futureRelapses.add(sdc.userId);
        }
      }
    });
  }
  console.log(`  Future relapses (after cutoff): ${futureRelapses.size}`);

  // Build training samples: features from train window, labels from future
  const cohortData = computeCohortStats(trainState, { now: trainCutoff });
  const samples = [];

  trainState.members.forEach((_, mid) => {
    const cohortStats = getCohortStatsForMember(mid, trainState, cohortData, { now: trainCutoff });
    const features = extractFeatures(mid, trainState, { now: trainCutoff, cohortStats });

    // Only include members with enough data for scoring
    if (features._totalActivity < 1 || features.tenureDays < 7) return;

    samples.push({
      features,
      label: futureRelapses.has(mid) ? 1 : 0,
    });
  });

  const nPositive = samples.filter(s => s.label === 1).length;
  const nNegative = samples.length - nPositive;
  console.log(`  Training samples: ${samples.length} (${nPositive} relapsed, ${nNegative} non-relapsed)`);
  console.log(`  Base rate: ${(nPositive / Math.max(samples.length, 1) * 100).toFixed(2)}%`);

  const model = trainLogisticRegression(samples, config.training);
  console.log(`  Training complete. ${model.history.length} epochs logged.`);
  console.log(`  Final loss: ${model.history[model.history.length - 1]?.loss.toFixed(4)}`);
  console.log(`  Non-zero weights: ${Object.keys(model.weights).length} / ${FEATURE_NAMES.length}`);

  // Show top weights
  const topWeights = Object.entries(model.weights)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 10);
  console.log('  Top 10 feature weights:');
  for (const [name, w] of topWeights) {
    console.log(`    ${name}: ${w > 0 ? '+' : ''}${w.toFixed(4)}`);
  }

  // ========================================
  // PHASE 2: Evaluate with learned model
  // ========================================
  console.log('\n=== PHASE 2: Evaluating learned model ===');

  // Compute predictions using the learned model
  const predMetrics = predictionAccuracy(state, { model });
  console.log(`  Learned model predictions:`);
  console.log(`    Precision: ${predMetrics.precision}`);
  console.log(`    Recall: ${predMetrics.recall}`);
  console.log(`    F1: ${predMetrics.f1}`);
  console.log(`    FPR: ${predMetrics.fpr}`);
  console.log(`    TP=${predMetrics.tp} FP=${predMetrics.fp} FN=${predMetrics.fn} TN=${predMetrics.tn}`);
  if (predMetrics.scoreDistribution) {
    const r = predMetrics.scoreDistribution.relapsed;
    const n = predMetrics.scoreDistribution.nonRelapsed;
    console.log(`    Score dist (relapsed):     min=${r.min} p25=${r.p25} med=${r.median} p75=${r.p75} max=${r.max} (n=${r.count})`);
    console.log(`    Score dist (non-relapsed): min=${n.min} p25=${n.p25} med=${n.median} p75=${n.p75} max=${n.max} (n=${n.count})`);
  }

  // Also run heuristic for comparison
  console.log('\n  Heuristic model comparison:');
  const heuristicMetrics = predictionAccuracy(state, { model: null });
  console.log(`    Precision: ${heuristicMetrics.precision}`);
  console.log(`    Recall: ${heuristicMetrics.recall}`);
  console.log(`    F1: ${heuristicMetrics.f1}`);
  console.log(`    FPR: ${heuristicMetrics.fpr}`);

  // Apply optimal thresholds
  console.log('\n  Applying optimal thresholds:');
  const optimalF1 = predMetrics.optimalThresholdF1;
  if (optimalF1 && optimalF1.threshold) {
    console.log(`    F1-optimal threshold: ${optimalF1.threshold.toFixed(3)} (F1=${optimalF1.f1?.toFixed(3) ?? 'N/A'}, P=${optimalF1.precision?.toFixed(3) ?? 'N/A'}, R=${optimalF1.recall?.toFixed(3) ?? 'N/A'})`);
    setThresholds(optimalF1.threshold, optimalF1.threshold * 0.5); // High=optimal, Watch=half
  }
  const optimalYouden = predMetrics.optimalThresholdYouden;
  if (optimalYouden && optimalYouden.threshold) {
    console.log(`    Youden-optimal threshold: ${optimalYouden.threshold.toFixed(3)} (P=${optimalYouden.precision?.toFixed(3) ?? 'N/A'}, R=${optimalYouden.recall?.toFixed(3) ?? 'N/A'})`);
  }

  // ========================================
  // PHASE 3: Temporal validation
  // ========================================
  console.log('\n=== PHASE 3: Temporal validation ===');

  console.log('  Single 70/30 split:');
  const temporalMetrics = temporalValidation(state, { model });
  if (temporalMetrics.error) {
    console.log('    Error:', temporalMetrics.error);
  } else {
    console.log(`    Train cutoff: ${temporalMetrics.trainCutoff}`);
    console.log(`    Precision: ${temporalMetrics.precision}, Recall: ${temporalMetrics.recall}, F1: ${temporalMetrics.f1}, FPR: ${temporalMetrics.fpr}`);
    console.log(`    TP=${temporalMetrics.tp} FP=${temporalMetrics.fp} FN=${temporalMetrics.fn} TN=${temporalMetrics.tn}`);
    console.log(`    Relapses in test window: ${temporalMetrics.relapseCount}`);
  }

  console.log('\n  Rolling-window validation (60d windows, 30d steps):');
  const rollingMetrics = rollingWindowValidation(state, model, { windowDays: 60, stepDays: 30, minTrainDays: 90 });
  if (rollingMetrics.error) {
    console.log('    Error:', rollingMetrics.error);
  } else {
    console.log(`    Windows: ${rollingMetrics.windowCount} total, ${rollingMetrics.windowsWithRelapses} with relapses`);
    console.log(`    Avg F1: ${rollingMetrics.avgF1}, Avg Recall: ${rollingMetrics.avgRecall}, Avg Precision: ${rollingMetrics.avgPrecision}`);
    for (const w of rollingMetrics.windows) {
      if (w.relapses > 0) {
        console.log(`      ${w.cutoffDate}→${w.testEndDate}: ${w.relapses} relapses, P=${w.precision} R=${w.recall} F1=${w.f1} (${w.trainMembers} members)`);
      }
    }
  }

  // ========================================
  // PHASE 4: Spatial layout + evolution
  // ========================================
  console.log('\n=== PHASE 4: Spatial layout ===');

  // Risk-driven layout
  const riskPredictions = computePredictions(state, { now, model });
  const riskLayoutResult = computeRiskLayout(state, riskPredictions);
  console.log(`  Risk-driven layout: ${riskLayoutResult.positions.size} positions, ${riskLayoutResult.neighborhoods.size} neighborhoods`);

  // Evolution (codec layout)
  const skipEvolution = state.members.size > 50000;
  const baseSessionCount = Math.min(config.maxSessions, 30);
  const numSessions = skipEvolution ? 0
    : state.members.size > 2000 ? Math.min(baseSessionCount, 5)
    : state.members.size > 500 ? Math.min(baseSessionCount, 15)
    : baseSessionCount;

  let snapshots = [];
  let hashMetrics = { accuracyPct: 'N/A (skipped)', memberCount: state.members.size };
  let connMetrics = { correlation: null, message: 'skipped — no evolution' };
  let posMetrics = { meanError: 0, medianError: 0, maxError: 0, r2: 0, memberCount: 0, convergenceSteps: 0, worstMembers: [] };

  if (numSessions > 0) {
    console.log(`  Running ${numSessions} evolution sessions (${state.members.size} members)...`);
    const result = runSessions(state, numSessions);
    snapshots = result.snapshots;
    console.log(`  Final fitness: ${snapshots[snapshots.length - 1]?.fitness?.toFixed(3) ?? '—'}`);

    hashMetrics = hashVsReality(state);
    connMetrics = connectionVsDistance(state);
    posMetrics = predictedVsOptimal(state);
  } else {
    console.log(`  Skipping evolution (${state.members.size} members).`);
  }

  // ========================================
  // EVOLUTION BENCHMARK (MVP)
  // ========================================
  console.log('\n========================================');
  console.log('EVOLUTION BENCHMARK (MVP)');
  console.log('========================================');
  // Use evolved positions if available, otherwise use risk-driven layout
  const positions = (state.targetPos && state.targetPos.size > 0)
    ? state.targetPos
    : riskLayoutResult.positions;

  if (positions && positions.size > 0) {
    const { benchmarkEvolution } = await import('../lib/validators/SimpleBenchmark.js');
    // Create a temporary state with the positions for benchmarking
    const benchState = { ...state, targetPos: positions };
    benchmarkEvolution(benchState);
  } else {
    console.log('Skipping benchmark: no positions available');
  }

  // ========================================
  // BUILD REPORT
  // ========================================
  const report = {
    timestamp: new Date().toISOString(),
    version: 2,
    config: { batch: config.batch, maxSessions: config.maxSessions, loadBatches: config.loadBatches, recent: !!config.recent, training: config.training },
    data: {
      members: state.members.size,
      posts: state.posts.size,
      comments: state.comments.size,
      soberDateChanges: sdcCount,
      dataRange: earliest < Infinity ? { from: new Date(earliest).toISOString(), to: new Date(latest).toISOString(), days: Math.round((latest - earliest) / 86400000) } : null,
    },
    // Trained model (portable — can be loaded in browser)
    trainedModel: {
      weights: model.weights,
      bias: model.bias,
      featureStats: model.featureStats,
      trainStats: model.trainStats,
      trainingLoss: model.history,
      // Optimal thresholds found during training
      optimalThresholds: {
        highRisk: predMetrics.optimalThresholdF1?.threshold || 0.50,
        watch: (predMetrics.optimalThresholdF1?.threshold || 0.50) * 0.5,
        f1Metrics: predMetrics.optimalThresholdF1,
        youdenMetrics: predMetrics.optimalThresholdYouden,
      },
    },
    // Learned model metrics
    learnedModelMetrics: {
      precision: predMetrics.precision,
      recall: predMetrics.recall,
      f1: predMetrics.f1,
      fpr: predMetrics.fpr,
      specificity: predMetrics.specificity,
      tp: predMetrics.tp,
      fp: predMetrics.fp,
      fn: predMetrics.fn,
      tn: predMetrics.tn,
      riskDistribution: predMetrics.riskDistribution,
      labeledCount: predMetrics.labeledCount,
      relapseCount: predMetrics.relapseCount,
      disengagedCount: predMetrics.disengagedCount,
      baseRate: predMetrics.baseRate,
      liftAtThreshold: predMetrics.liftAtThreshold,
      liftByK: predMetrics.liftByK,
      scoreDistribution: predMetrics.scoreDistribution,
      optimalThresholdYouden: predMetrics.optimalThresholdYouden,
      optimalThresholdF1: predMetrics.optimalThresholdF1,
      optimalThresholdF2: predMetrics.optimalThresholdF2,
      prCurve: predMetrics.prCurve,
      featurePrevalence: predMetrics.featurePrevalence,
    },
    // Heuristic comparison
    heuristicModelMetrics: {
      precision: heuristicMetrics.precision,
      recall: heuristicMetrics.recall,
      f1: heuristicMetrics.f1,
      fpr: heuristicMetrics.fpr,
    },
    // Temporal validation
    temporalValidation: temporalMetrics.error ? { error: temporalMetrics.error } : {
      trainCutoff: temporalMetrics.trainCutoff,
      testEnd: temporalMetrics.testEnd,
      timeRangeDays: temporalMetrics.timeRangeDays,
      trainWindowDays: temporalMetrics.trainWindowDays,
      testWindowDays: temporalMetrics.testWindowDays,
      trainMembers: temporalMetrics.trainMembers,
      precision: temporalMetrics.precision,
      recall: temporalMetrics.recall,
      f1: temporalMetrics.f1,
      fpr: temporalMetrics.fpr,
      specificity: temporalMetrics.specificity,
      tp: temporalMetrics.tp,
      fp: temporalMetrics.fp,
      fn: temporalMetrics.fn,
      tn: temporalMetrics.tn,
      relapseCount: temporalMetrics.relapseCount,
      disengagedCount: temporalMetrics.disengagedCount,
    },
    // Rolling window validation
    rollingWindowValidation: rollingMetrics,
    // Spatial metrics
    sessions: snapshots.length,
    hashVsReality: { accuracyPct: hashMetrics.accuracyPct, memberCount: hashMetrics.memberCount },
    connectionVsDistance: connMetrics,
    predictedVsOptimal: {
      meanError: posMetrics.meanError,
      medianError: posMetrics.medianError,
      maxError: posMetrics.maxError,
      r2: posMetrics.r2,
      memberCount: posMetrics.memberCount,
    },
    fitnessHistory: snapshots.map((s) => s.fitness),
  };

  // ========================================
  // PRINT SUMMARY
  // ========================================
  console.log('\n========================================');
  console.log('RESULTS SUMMARY');
  console.log('========================================');
  console.log(`  Data: ${state.members.size} members, ${state.posts.size} posts, ${state.comments.size} comments, ${sdcCount} SDCs`);
  console.log(`  Relapse base rate: ${predMetrics.baseRate} (${predMetrics.relapseCount}/${predMetrics.labeledCount})`);
  console.log('');
  console.log('  LEARNED MODEL:');
  console.log(`    P=${predMetrics.precision} R=${predMetrics.recall} F1=${predMetrics.f1} FPR=${predMetrics.fpr}`);
  console.log(`    TP=${predMetrics.tp} FP=${predMetrics.fp} FN=${predMetrics.fn} TN=${predMetrics.tn}`);
  console.log(`    Lift@top50: ${predMetrics.liftByK?.find(l => l.k === 50)?.lift || '—'}x`);
  console.log('');
  console.log('  HEURISTIC MODEL:');
  console.log(`    P=${heuristicMetrics.precision} R=${heuristicMetrics.recall} F1=${heuristicMetrics.f1} FPR=${heuristicMetrics.fpr}`);
  console.log('');
  const improvement = predMetrics.f1 - heuristicMetrics.f1;
  console.log(`  F1 improvement: ${improvement > 0 ? '+' : ''}${(improvement * 100).toFixed(1)} percentage points`);

  if (rollingMetrics.avgF1) {
    console.log('');
    console.log('  ROLLING WINDOW (generalization):');
    console.log(`    Avg F1: ${rollingMetrics.avgF1}, Avg Recall: ${rollingMetrics.avgRecall}, Avg Precision: ${rollingMetrics.avgPrecision}`);
    console.log(`    Windows tested: ${rollingMetrics.windowsWithRelapses} (with relapses)`);
  }

  // Save report
  try {
    await mkdir(config.outputDir, { recursive: true });
    const outPath = join(config.outputDir, `run-${Date.now()}.json`);
    await writeFile(outPath, JSON.stringify(report, null, 2));
    console.log('\nReport written to', outPath);

    // Also save the trained model separately for easy loading
    const modelPath = join(config.outputDir, 'trained-model.json');
    await writeFile(modelPath, JSON.stringify({
      weights: model.weights,
      bias: model.bias,
      featureStats: model.featureStats,
      trainStats: model.trainStats,
      trainedAt: new Date().toISOString(),
      dataRange: report.data.dataRange,
      metrics: {
        f1: predMetrics.f1,
        precision: predMetrics.precision,
        recall: predMetrics.recall,
        rollingF1: rollingMetrics.avgF1 || null,
      },
    }, null, 2));
    console.log('Trained model saved to', modelPath);
  } catch (e) {
    console.warn('Could not write output file:', e.message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
