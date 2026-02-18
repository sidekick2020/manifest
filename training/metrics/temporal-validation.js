/**
 * Temporal train/test split validation.
 *
 * Splits data by time: features are extracted from the "train" window (early data),
 * and outcomes are evaluated in the "test" window (later data). This validates
 * that the model can predict the FUTURE rather than just describe the present.
 *
 * Split strategy:
 *   - Find the time range of all activity (earliest → latest)
 *   - Train cutoff = earliest + 70% of range
 *   - Features extracted using only data ≤ train cutoff
 *   - Outcomes: uses SoberDateChange ground truth when available, falls back to heuristic
 *
 * Only sobriety resets count as relapse (consistent with labelOutcomes).
 */
import { extractFeatures, computeRelapseRisk, computeStability, topRiskFactors, HIGH_RISK_THRESHOLD, WATCH_THRESHOLD, computeCohortStats, getCohortStatsForMember } from '../../lib/predictions.js';

const DAY_MS = 86400000;

/**
 * @param {object} fullState - Full codec state with all loaded data
 * @param {{ trainRatio?: number }} opts
 * @returns {{ trainCutoff, testStart, trainMembers, testMembers, precision, recall, f1, fpr, specificity, tp, fp, fn, tn, relapseCount, disengagedCount, riskDistribution, perMember }}
 */
export function temporalValidation(fullState, opts = {}) {
  const trainRatio = opts.trainRatio || 0.7;
  const model = opts.model || null;

  // 1. Find time range of all activity
  let earliest = Infinity, latest = 0;
  fullState.posts.forEach((p) => {
    const t = new Date(p.created).getTime();
    if (t < earliest) earliest = t;
    if (t > latest) latest = t;
  });
  fullState.comments.forEach((c) => {
    const t = new Date(c.created).getTime();
    if (t < earliest) earliest = t;
    if (t > latest) latest = t;
  });
  fullState.members.forEach((m) => {
    if (m.created) {
      const t = new Date(m.created).getTime();
      if (t < earliest) earliest = t;
      if (t > latest) latest = t;
    }
  });

  if (earliest >= latest) {
    return { error: 'Insufficient time range for temporal split' };
  }

  const timeRange = latest - earliest;
  const trainCutoff = earliest + timeRange * trainRatio;

  // 2. Build train-window state: only include data created before cutoff
  //    soberDateChanges is passed through so extractFeatures can detect prior resets.
  //    The feature extractor filters by timestamp (sdcTime <= now) so only pre-cutoff
  //    resets are visible during feature extraction at trainCutoff time.
  const trainState = {
    members: new Map(),
    posts: new Map(),
    comments: new Map(),
    targetPos: fullState.targetPos,
    neighborhoods: fullState.neighborhoods,
    soberDateChanges: fullState.soberDateChanges,
  };

  // Include all members who were created before the cutoff
  fullState.members.forEach((m, mid) => {
    if (m.created && new Date(m.created).getTime() <= trainCutoff) {
      trainState.members.set(mid, m);
    }
  });

  // Include posts and comments created before the cutoff
  fullState.posts.forEach((p, pid) => {
    if (new Date(p.created).getTime() <= trainCutoff) {
      trainState.posts.set(pid, p);
    }
  });

  fullState.comments.forEach((c, cid) => {
    if (new Date(c.created).getTime() <= trainCutoff) {
      trainState.comments.set(cid, c);
    }
  });

  // 3. Extract features at train cutoff time
  const cohortData = computeCohortStats(trainState, { now: trainCutoff });
  const predictions = new Map();
  trainState.members.forEach((_, mid) => {
    const cohortStats = getCohortStatsForMember(mid, trainState, cohortData, { now: trainCutoff });
    const features = extractFeatures(mid, trainState, { now: trainCutoff, cohortStats });
    const rawRisk = computeRelapseRisk(features, model);
    const rawStability = computeStability(features);

    const hasData = rawRisk !== null;
    const risk = hasData ? rawRisk : 0.5;
    const stability = hasData ? rawStability : 0.5;
    const riskLevel = !hasData ? 'unknown'
      : risk > HIGH_RISK_THRESHOLD ? 'high'
      : risk > WATCH_THRESHOLD ? 'watch'
      : 'low';
    const riskFactors = topRiskFactors(features);
    predictions.set(mid, { risk, stability, features, riskLevel, riskFactors });
  });

  // 4. Label outcomes using the FULL data (including test window)
  //    Prefer SoberDateChange ground truth when available (same as labelOutcomes).
  //    A member "relapsed" if they have a SoberDateChange record with setOnDayOne=false.
  //    Falls back to sobriety date heuristic when SDC data is not loaded.
  //    A member "disengaged" if they had activity in train window but none in test window.
  const testOutcomes = new Map();
  let relapseCount = 0;
  let disengagedCount = 0;

  // Build ground-truth relapse set from SoberDateChange table.
  // IMPORTANT: For temporal validation, only count resets in the TEST window
  // (after trainCutoff). Resets before the cutoff are visible as features
  // (via hasPriorReset), so counting them as outcomes would be data leakage.
  //
  // Uses `newDate` (the new sobriety start date) as the event time, not `created`
  // (when the DB record was written). The `created` field can be years after the
  // actual relapse event, making it unreliable for temporal splitting.
  const sdcRelapses = new Map();
  const hasSdcData = fullState.soberDateChanges && fullState.soberDateChanges.size > 0;
  if (hasSdcData) {
    fullState.soberDateChanges.forEach((sdc) => {
      if (!sdc.setOnDayOne && sdc.lastSoberDate && sdc.userId) {
        // Use newDate as event time (when the relapse roughly occurred)
        const eventDate = sdc.newDate || sdc.lastSoberDate || sdc.created;
        const eventTime = new Date(eventDate).getTime();
        // Only count resets AFTER the train cutoff (in the test window)
        if (eventTime > trainCutoff) {
          const existing = sdcRelapses.get(sdc.userId);
          if (!existing || eventTime > new Date(existing.eventDate).getTime()) {
            sdcRelapses.set(sdc.userId, {
              relapseDate: sdc.created,
              eventDate: eventDate,
              newDate: sdc.newDate,
              lastSoberDate: sdc.lastSoberDate,
            });
          }
        }
      }
    });
  }

  trainState.members.forEach((m, mid) => {
    // Relapse detection: prefer SoberDateChange ground truth, fall back to heuristic
    let sobrietyReset = false;

    if (hasSdcData) {
      const sdcRelapse = sdcRelapses.get(mid);
      if (sdcRelapse) {
        sobrietyReset = true;
      }
    } else {
      // Fallback heuristic: infer from _User sobriety date vs account creation
      let firstActivity = Infinity;
      fullState.posts.forEach((p) => {
        if (p.creator === mid) {
          const t = new Date(p.created).getTime();
          if (t < firstActivity) firstActivity = t;
        }
      });
      fullState.comments.forEach((c) => {
        if (c.fromMember === mid) {
          const t = new Date(c.created).getTime();
          if (t < firstActivity) firstActivity = t;
        }
      });

      if (m.sobriety && m.created) {
        const sobTime = new Date(m.sobriety).getTime();
        const createdTime = new Date(m.created).getTime();
        const hadActivityBeforeSobriety = firstActivity < Infinity && firstActivity < sobTime;
        if ((sobTime - createdTime > 30 * DAY_MS) && hadActivityBeforeSobriety) {
          sobrietyReset = true;
        }
      }
    }

    // Check disengagement: had activity in train window, none in test window
    let hasTrainActivity = false;
    let hasTestActivity = false;
    let trainActivityCount = 0;

    fullState.posts.forEach((p) => {
      if (p.creator === mid) {
        const t = new Date(p.created).getTime();
        if (t <= trainCutoff) { hasTrainActivity = true; trainActivityCount++; }
        if (t > trainCutoff) hasTestActivity = true;
      }
    });
    fullState.comments.forEach((c) => {
      if (c.fromMember === mid) {
        const t = new Date(c.created).getTime();
        if (t <= trainCutoff) { hasTrainActivity = true; trainActivityCount++; }
        if (t > trainCutoff) hasTestActivity = true;
      }
    });

    const disengaged = hasTrainActivity && trainActivityCount >= 4 && !hasTestActivity;

    let signal = 'none';
    if (sobrietyReset && disengaged) signal = 'both';
    else if (sobrietyReset) signal = 'sobrietyReset';
    else if (disengaged) signal = 'engagementDropout';

    if (sobrietyReset) relapseCount++;
    if (disengaged) disengagedCount++;

    testOutcomes.set(mid, { relapsed: sobrietyReset, disengaged, signal });
  });

  // 5. Compute confusion matrix
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const riskDistribution = { low: 0, watch: 0, high: 0, unknown: 0 };
  let labeledCount = 0;
  const perMember = [];
  const scored = []; // all scored members with labels for threshold sweep

  predictions.forEach((pred, mid) => {
    riskDistribution[pred.riskLevel] = (riskDistribution[pred.riskLevel] || 0) + 1;
    if (pred.riskLevel === 'unknown') return;

    const outcome = testOutcomes.get(mid);
    if (!outcome) return;

    const predictedHigh = pred.riskLevel === 'high';
    const relapsed = outcome.relapsed;

    scored.push({ mid, risk: pred.risk, relapsed });

    if (relapsed) {
      labeledCount++;
      if (predictedHigh) tp++; else fn++;
    } else {
      labeledCount++;
      if (predictedHigh) fp++; else tn++;
    }

    perMember.push({
      mid,
      risk: Math.round(pred.risk * 1000) / 1000,
      stability: Math.round(pred.stability * 1000) / 1000,
      riskLevel: pred.riskLevel,
      relapsed,
      disengaged: outcome.disengaged,
      signal: outcome.signal,
    });
  });

  const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
  const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0;
  const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0;
  const fpr = (fp + tn) > 0 ? fp / (fp + tn) : 0;
  const specificity = 1 - fpr;

  // Optimal threshold analysis — sweep all unique risk scores
  const optimalF2 = findOptimalThreshold(scored, 'f2');

  return {
    trainCutoff: new Date(trainCutoff).toISOString(),
    testStart: new Date(trainCutoff).toISOString(),
    testEnd: new Date(latest).toISOString(),
    timeRangeDays: Math.round(timeRange / DAY_MS),
    trainWindowDays: Math.round((trainCutoff - earliest) / DAY_MS),
    testWindowDays: Math.round((latest - trainCutoff) / DAY_MS),
    trainMembers: trainState.members.size,
    trainPosts: trainState.posts.size,
    trainComments: trainState.comments.size,
    precision: Math.round(precision * 1000) / 1000,
    recall: Math.round(recall * 1000) / 1000,
    f1: Math.round(f1 * 1000) / 1000,
    fpr: Math.round(fpr * 1000) / 1000,
    specificity: Math.round(specificity * 1000) / 1000,
    tp, fp, fn, tn,
    labeledCount,
    relapseCount,
    disengagedCount,
    riskDistribution,
    optimalThresholdF2: optimalF2,
    perMember: perMember.slice(0, 30),
  };
}

/**
 * Sweep thresholds and find optimal for given objective.
 */
function findOptimalThreshold(scored, objective) {
  if (scored.length === 0) return { threshold: HIGH_RISK_THRESHOLD, tp: 0, fp: 0, fn: 0, tn: 0 };

  const thresholds = [...new Set(scored.map((s) => s.risk))].sort((a, b) => a - b);
  const expanded = [];
  for (let i = 0; i < thresholds.length; i++) {
    expanded.push(thresholds[i]);
    if (i < thresholds.length - 1) {
      expanded.push((thresholds[i] + thresholds[i + 1]) / 2);
    }
  }

  let best = { threshold: HIGH_RISK_THRESHOLD, score: -Infinity, tp: 0, fp: 0, fn: 0, tn: 0 };

  for (const t of expanded) {
    let tp2 = 0, fp2 = 0, fn2 = 0, tn2 = 0;
    for (const s of scored) {
      if (s.relapsed) {
        if (s.risk > t) tp2++; else fn2++;
      } else {
        if (s.risk > t) fp2++; else tn2++;
      }
    }
    const prec = (tp2 + fp2) > 0 ? tp2 / (tp2 + fp2) : 0;
    const rec = (tp2 + fn2) > 0 ? tp2 / (tp2 + fn2) : 0;
    const tpr = rec;
    const fprVal = (fp2 + tn2) > 0 ? fp2 / (fp2 + tn2) : 0;

    let objScore;
    if (objective === 'youden') {
      objScore = tpr - fprVal;
    } else if (objective === 'f1') {
      objScore = (prec + rec) > 0 ? 2 * prec * rec / (prec + rec) : 0;
    } else if (objective === 'f2') {
      objScore = (prec + rec) > 0 ? 5 * prec * rec / (4 * prec + rec) : 0;
    } else {
      objScore = tpr - fprVal;
    }

    if (objScore > best.score) {
      best = { threshold: Math.round(t * 1000) / 1000, score: Math.round(objScore * 1000) / 1000, tp: tp2, fp: fp2, fn: fn2, tn: tn2 };
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
