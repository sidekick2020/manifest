/**
 * Prediction accuracy metric — retrospective validation.
 * Compares predicted risk scores against labeled outcomes.
 *
 * Only sobriety resets count as true relapse (engagement dropout is separate).
 * This means the confusion matrix evaluates: can we predict who will reset
 * their sobriety date?
 *
 * Includes:
 *   - Confusion matrix at the fixed HIGH_RISK_THRESHOLD
 *   - Optimal threshold via Youden's J statistic (maximizes TPR − FPR)
 *   - Precision-focused optimal threshold (maximizes F1)
 *   - PR curve summary (precision at recall checkpoints)
 */
import { computePredictions, labelOutcomes, HIGH_RISK_THRESHOLD } from '../../lib/predictions.js';

// Re-export HIGH_RISK_THRESHOLD for temporal-validation
export { HIGH_RISK_THRESHOLD };

/**
 * Sweep thresholds across all unique risk scores and return the one that
 * maximizes the given objective ('youden' for TPR−FPR, 'f1' for F1 score,
 * 'f2' for F2 score which weights recall 2x over precision).
 */
function findOptimalThreshold(scored, objective = 'youden') {
  if (scored.length === 0) return { threshold: HIGH_RISK_THRESHOLD, tp: 0, fp: 0, fn: 0, tn: 0 };

  // Collect unique thresholds from actual scores (plus small offsets)
  const thresholds = [...new Set(scored.map((s) => s.risk))].sort((a, b) => a - b);
  // Add midpoints between adjacent scores for finer resolution
  const expanded = [];
  for (let i = 0; i < thresholds.length; i++) {
    expanded.push(thresholds[i]);
    if (i < thresholds.length - 1) {
      expanded.push((thresholds[i] + thresholds[i + 1]) / 2);
    }
  }

  let best = { threshold: HIGH_RISK_THRESHOLD, score: -Infinity, tp: 0, fp: 0, fn: 0, tn: 0 };

  for (const t of expanded) {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const s of scored) {
      if (s.relapsed) {
        if (s.risk > t) tp++; else fn++;
      } else {
        if (s.risk > t) fp++; else tn++;
      }
    }
    const tpr = (tp + fn) > 0 ? tp / (tp + fn) : 0;
    const fprVal = (fp + tn) > 0 ? fp / (fp + tn) : 0;
    const prec = (tp + fp) > 0 ? tp / (tp + fp) : 0;
    const rec = tpr;

    let objScore;
    if (objective === 'youden') {
      objScore = tpr - fprVal;
    } else if (objective === 'f1') {
      objScore = (prec + rec) > 0 ? 2 * prec * rec / (prec + rec) : 0;
    } else if (objective === 'f2') {
      // F2 = (1 + 4) * prec * rec / (4 * prec + rec)
      objScore = (prec + rec) > 0 ? 5 * prec * rec / (4 * prec + rec) : 0;
    } else {
      objScore = tpr - fprVal;
    }

    if (objScore > best.score) {
      best = { threshold: Math.round(t * 1000) / 1000, score: Math.round(objScore * 1000) / 1000, tp, fp, fn, tn };
    }
  }

  const prec = (best.tp + best.fp) > 0 ? best.tp / (best.tp + best.fp) : 0;
  const rec = (best.tp + best.fn) > 0 ? best.tp / (best.tp + best.fn) : 0;
  const fprVal = (best.fp + best.tn) > 0 ? best.fp / (best.fp + best.tn) : 0;
  best.precision = Math.round(prec * 1000) / 1000;
  best.recall = Math.round(rec * 1000) / 1000;
  best.fpr = Math.round(fprVal * 1000) / 1000;
  return best;
}

/**
 * Compute precision at recall checkpoints (PR curve summary).
 */
function prCurveSummary(scored) {
  if (scored.length === 0) return [];
  const sorted = [...scored].sort((a, b) => b.risk - a.risk);
  const totalPositive = scored.filter((s) => s.relapsed).length;
  if (totalPositive === 0) return [];

  const checkpoints = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const results = [];
  let tp = 0, fp = 0;

  let checkIdx = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].relapsed) tp++; else fp++;
    const recall = tp / totalPositive;

    while (checkIdx < checkpoints.length && recall >= checkpoints[checkIdx]) {
      const prec = tp / (tp + fp);
      results.push({
        recall: checkpoints[checkIdx],
        precision: Math.round(prec * 1000) / 1000,
        threshold: Math.round(sorted[i].risk * 1000) / 1000,
        flagged: i + 1,
      });
      checkIdx++;
    }
  }
  return results;
}

/**
 * @param {object} state - Codec state with members, posts, comments, targetPos, neighborhoods
 * @param {{ model?: object }} opts - optional trained model for learned predictions
 * @returns {{ precision, recall, f1, fpr, specificity, tp, fp, fn, tn, riskDistribution, labeledCount, relapseCount, disengagedCount, optimalThresholdYouden, optimalThresholdF1, optimalThresholdF2, prCurve, perMember }}
 */
export function predictionAccuracy(state, opts = {}) {
  // Use the latest data timestamp as "now" so predictions are relative
  // to the data window rather than actual wall clock time
  let latestTime = 0;
  state.posts.forEach((p) => {
    const t = new Date(p.created).getTime();
    if (t > latestTime) latestTime = t;
  });
  state.comments.forEach((c) => {
    const t = new Date(c.created).getTime();
    if (t > latestTime) latestTime = t;
  });
  const now = latestTime || Date.now();

  const model = opts.model || null;
  const predictions = computePredictions(state, { now, model });
  const outcomes = labelOutcomes(state, { now });

  let tp = 0, fp = 0, fn = 0, tn = 0;
  const riskDistribution = { low: 0, watch: 0, high: 0, unknown: 0 };
  let labeledCount = 0;
  let relapseCount = 0;
  let disengagedCount = 0;
  const perMember = [];
  const scored = []; // all scored members with labels for threshold sweep

  predictions.forEach((pred, mid) => {
    riskDistribution[pred.riskLevel] = (riskDistribution[pred.riskLevel] || 0) + 1;

    // Skip unknowns (insufficient data) from precision/recall
    if (pred.riskLevel === 'unknown') return;

    const outcome = outcomes.get(mid);
    if (!outcome) return;

    const predictedHighRisk = pred.riskLevel === 'high';
    const relapsed = outcome.relapsed;       // sobriety reset only
    const disengaged = outcome.disengaged;   // engagement dropout (informational)

    if (disengaged) disengagedCount++;

    scored.push({ mid, risk: pred.risk, relapsed });

    if (relapsed) {
      relapseCount++;
      labeledCount++;
      if (predictedHighRisk) tp++;
      else fn++;
    } else {
      labeledCount++;
      if (predictedHighRisk) fp++;
      else tn++;
    }

    perMember.push({
      mid,
      risk: Math.round(pred.risk * 1000) / 1000,
      stability: Math.round(pred.stability * 1000) / 1000,
      riskLevel: pred.riskLevel,
      relapsed,
      disengaged,
      signal: outcome.signal,
    });
  });

  const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
  const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0;
  const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;

  // FPR = FP / (FP + TN)  — false alarm rate
  // Specificity = TN / (TN + FP) = 1 - FPR — true negative rate
  const fpr = (fp + tn) > 0 ? fp / (fp + tn) : 0;
  const specificity = 1 - fpr;

  // Optimal threshold analysis
  const optimalThresholdYouden = findOptimalThreshold(scored, 'youden');
  const optimalThresholdF1 = findOptimalThreshold(scored, 'f1');
  const optimalThresholdF2 = findOptimalThreshold(scored, 'f2');
  const prCurve = prCurveSummary(scored);

  // Lift analysis — how much better than random is each tier?
  const baseRate = relapseCount / Math.max(labeledCount, 1);
  const liftAtThreshold = precision > 0 ? precision / Math.max(baseRate, 0.001) : 0;

  // Top-K lift: what's the relapse rate in the top N scored members?
  const sortedScored = [...scored].sort((a, b) => b.risk - a.risk);
  const liftByK = [];
  for (const k of [50, 100, 200, 500]) {
    if (k > sortedScored.length) continue;
    const topK = sortedScored.slice(0, k);
    const topKRelapses = topK.filter((s) => s.relapsed).length;
    const topKRate = topKRelapses / k;
    const lift = baseRate > 0 ? topKRate / baseRate : 0;
    liftByK.push({
      k,
      relapses: topKRelapses,
      rate: Math.round(topKRate * 1000) / 1000,
      lift: Math.round(lift * 100) / 100,
    });
  }

  // Feature prevalence analysis — actual lift ratios from this data
  const interactionFeatures = ['activeThenSilent', 'activeThenDeepSilent', 'earlySobrietyAndSilent', 'isolatedAndDeclining', 'lowActivityLongTenure', 'communityEngaged', 'hasPriorReset'];
  const featurePrevalence = [];
  for (const feat of interactionFeatures) {
    let relapsedWith = 0, relapsedTotal = 0, nonRelapsedWith = 0, nonRelapsedTotal = 0;
    predictions.forEach((pred, mid) => {
      if (pred.riskLevel === 'unknown') return;
      const outcome = outcomes.get(mid);
      if (!outcome) return;
      const val = pred.features[feat];
      if (outcome.relapsed) {
        relapsedTotal++;
        if (val) relapsedWith++;
      } else {
        nonRelapsedTotal++;
        if (val) nonRelapsedWith++;
      }
    });
    const relapsedRate = relapsedTotal > 0 ? relapsedWith / relapsedTotal : 0;
    const nonRelapsedRate = nonRelapsedTotal > 0 ? nonRelapsedWith / nonRelapsedTotal : 0;
    const lift = nonRelapsedRate > 0 ? relapsedRate / nonRelapsedRate : (relapsedRate > 0 ? Infinity : 0);
    featurePrevalence.push({
      feature: feat,
      relapsedRate: Math.round(relapsedRate * 1000) / 1000,
      nonRelapsedRate: Math.round(nonRelapsedRate * 1000) / 1000,
      lift: Math.round(lift * 100) / 100,
      relapsedWith, relapsedTotal, nonRelapsedWith, nonRelapsedTotal,
    });
  }

  // Score distribution diagnostic — compare relapsed vs non-relapsed
  const relapsedScores = scored.filter((s) => s.relapsed).map((s) => s.risk).sort((a, b) => a - b);
  const nonRelapsedScores = scored.filter((s) => !s.relapsed).map((s) => s.risk).sort((a, b) => a - b);
  const percentile = (arr, p) => arr.length > 0 ? arr[Math.min(Math.floor(arr.length * p), arr.length - 1)] : 0;
  const scoreDistribution = {
    relapsed: {
      count: relapsedScores.length,
      min: relapsedScores[0] || 0,
      p25: Math.round(percentile(relapsedScores, 0.25) * 1000) / 1000,
      median: Math.round(percentile(relapsedScores, 0.5) * 1000) / 1000,
      p75: Math.round(percentile(relapsedScores, 0.75) * 1000) / 1000,
      max: relapsedScores[relapsedScores.length - 1] || 0,
    },
    nonRelapsed: {
      count: nonRelapsedScores.length,
      min: nonRelapsedScores[0] || 0,
      p25: Math.round(percentile(nonRelapsedScores, 0.25) * 1000) / 1000,
      median: Math.round(percentile(nonRelapsedScores, 0.5) * 1000) / 1000,
      p75: Math.round(percentile(nonRelapsedScores, 0.75) * 1000) / 1000,
      max: nonRelapsedScores[nonRelapsedScores.length - 1] || 0,
    },
  };

  return {
    precision: Math.round(precision * 1000) / 1000,
    recall: Math.round(recall * 1000) / 1000,
    f1: Math.round(f1 * 1000) / 1000,
    fpr: Math.round(fpr * 1000) / 1000,
    specificity: Math.round(specificity * 1000) / 1000,
    tp, fp, fn, tn,
    riskDistribution,
    labeledCount,
    relapseCount,
    disengagedCount,
    optimalThresholdYouden,
    optimalThresholdF1,
    optimalThresholdF2,
    featurePrevalence,
    baseRate: Math.round(baseRate * 1000) / 1000,
    liftAtThreshold: Math.round(liftAtThreshold * 100) / 100,
    liftByK,
    prCurve,
    scoreDistribution,
    perMember: perMember.slice(0, 30),
  };
}
