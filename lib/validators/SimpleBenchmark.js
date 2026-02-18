/**
 * MVP Evolution Benchmark - Simple validation with 3 metrics
 */

import { v3dist } from '../vec3.js';

/**
 * Metric 1: Cohesion - Average distance between connected members
 * Lower distance = higher score
 */
export function scoreCohesion(positions, comments) {
  if (!comments || comments.size === 0) return 0;

  const pairs = new Set();
  comments.forEach(c => {
    const key = c.fromMember < c.toMember
      ? `${c.fromMember}:${c.toMember}`
      : `${c.toMember}:${c.fromMember}`;
    pairs.add(key);
  });

  if (pairs.size === 0) return 0;

  let totalDist = 0;
  let count = 0;

  pairs.forEach(pairKey => {
    const [id1, id2] = pairKey.split(':');
    const pos1 = positions.get(id1);
    const pos2 = positions.get(id2);
    if (pos1 && pos2) {
      totalDist += v3dist(pos1, pos2);
      count++;
    }
  });

  return count > 0 ? 1 / (1 + (totalDist / count) * 0.1) : 0;
}

/**
 * Metric 2: Modularity (Newman's Q) - Community structure quality
 * Range: -0.5 to 1.0 (higher = better clustering)
 */
export function computeModularity(comments, neighborhoods) {
  if (!comments || comments.size === 0 || !neighborhoods || neighborhoods.size === 0) return 0;

  const m = comments.size;
  const degrees = new Map();

  // Build degree map
  comments.forEach(c => {
    degrees.set(c.fromMember, (degrees.get(c.fromMember) || 0) + 1);
    degrees.set(c.toMember, (degrees.get(c.toMember) || 0) + 1);
  });

  let Q = 0;
  neighborhoods.forEach(nh => {
    if (!nh.members || nh.members.size === 0) return;

    let eii = 0; // Edges within community
    let ai = 0;  // Fraction of edges touching community

    // Count internal edges
    comments.forEach(c => {
      if (nh.members.has(c.fromMember) && nh.members.has(c.toMember)) {
        eii++;
      }
    });

    // Sum degrees in community
    nh.members.forEach(mid => {
      ai += degrees.get(mid) || 0;
    });

    eii /= (2 * m);
    ai /= (2 * m);
    Q += eii - ai * ai;
  });

  return Q;
}

/**
 * Baseline: Random positions on sphere
 */
export function generateRandomBaseline(members, seed = 12345) {
  const positions = new Map();
  let s = seed;

  members.forEach((_, mid) => {
    // Simple spherical random using seed
    const theta = ((s % 1000) / 1000) * Math.PI * 2;
    const phi = ((s % 500) / 500) * Math.PI;
    s = (s * 1103515245 + 12345) & 0x7fffffff; // LCG

    const r = 60;
    positions.set(mid, {
      x: r * Math.sin(phi) * Math.cos(theta),
      y: r * Math.sin(phi) * Math.sin(theta),
      z: r * Math.cos(phi),
    });
  });

  return positions;
}

/**
 * Run evolution benchmark and print results
 */
export function benchmarkEvolution(state) {
  const { members, comments, targetPos, neighborhoods } = state;

  if (!targetPos || targetPos.size === 0) {
    console.log('\n⚠️  Skipping benchmark: no evolved layout found');
    return null;
  }

  console.log('\n🧪 Evolution Benchmark');
  console.log('━'.repeat(50));

  // Evolved layout (current)
  const evolvedCohesion = scoreCohesion(targetPos, comments);
  const evolvedModularity = computeModularity(comments, neighborhoods);

  console.log('Evolved Layout:');
  console.log(`  Cohesion: ${evolvedCohesion.toFixed(4)}`);
  console.log(`  Modularity: ${evolvedModularity.toFixed(4)}`);

  // Random baseline
  const randomPositions = generateRandomBaseline(members);
  const randomCohesion = scoreCohesion(randomPositions, comments);
  const randomModularity = computeModularity(comments, new Map()); // No neighborhoods

  console.log('\nRandom Baseline:');
  console.log(`  Cohesion: ${randomCohesion.toFixed(4)}`);
  console.log(`  Modularity: ${randomModularity.toFixed(4)}`);

  // Improvement calculations
  const cohesionImprovement = randomCohesion > 0
    ? ((evolvedCohesion - randomCohesion) / randomCohesion * 100)
    : 0;

  const modImprovement = Math.abs(randomModularity) > 0.001
    ? ((evolvedModularity - randomModularity) / Math.abs(randomModularity) * 100)
    : 0;

  console.log('\n📊 Results:');
  console.log(`  Cohesion improvement: ${cohesionImprovement > 0 ? '+' : ''}${cohesionImprovement.toFixed(1)}%`);
  console.log(`  Modularity improvement: ${modImprovement > 0 ? '+' : ''}${modImprovement.toFixed(1)}%`);
  console.log(`  Verdict: Evolution ${cohesionImprovement > 20 ? '✅ PASSES' : '❌ FAILS'} (>20% target)`);
  console.log('━'.repeat(50));

  return {
    evolvedCohesion,
    randomCohesion,
    cohesionImprovement,
    evolvedModularity,
    randomModularity,
    modImprovement
  };
}
