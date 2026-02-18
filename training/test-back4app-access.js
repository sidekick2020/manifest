#!/usr/bin/env node
/**
 * Phase 0 Validation: Test Back4App data access
 * Tests if we can fetch 10K, 100K members and how long it takes
 */

import { b4a, PARSE_CLASS_USER, feedFromBack4App } from '../lib/back4app.js';
import { config } from './config.js';
import { createState } from '../lib/codec.js';

async function testDirectFetch() {
  console.log('\n=== Test 1: Direct fetch (10K members) ===');
  console.time('fetch-10k');

  try {
    const members = await b4a(config.appId, config.restKey, PARSE_CLASS_USER, {
      keys: 'objectId,username',
      limit: 1000, // Back4App max limit per request
      order: '-createdAt',
    });

    console.timeEnd('fetch-10k');
    console.log(`✅ Fetched ${members.length} members`);
    console.log(`   First member: ${members[0]?.username || 'N/A'}`);
    console.log(`   Last member: ${members[members.length - 1]?.username || 'N/A'}`);

    return { success: true, count: members.length };
  } catch (err) {
    console.timeEnd('fetch-10k');
    console.error(`❌ Failed:`, err.message);
    return { success: false, error: err.message };
  }
}

async function testBatchLoading(targetMembers = 10000) {
  const batches = Math.ceil(targetMembers / 500);
  console.log(`\n=== Test 2: Batch loading (${batches} batches, target: ${targetMembers} members) ===`);
  console.time(`load-${targetMembers}`);

  try {
    const state = createState();
    const skips = { userSkip: 0, postSkip: 0, commentSkip: 0 };

    for (let i = 0; i < batches; i++) {
      const result = await feedFromBack4App(config, state, skips, config.batch);
      process.stdout.write(`\r  Batch ${i + 1}/${batches}: ${state.members.size} members, ${state.posts.size} posts, ${state.comments.size} comments`);

      if (result.added === 0) {
        console.log(`\n  ⚠️  No more data after ${i + 1} batches`);
        break;
      }
    }

    console.log(''); // newline
    console.timeEnd(`load-${targetMembers}`);
    console.log(`✅ Loaded ${state.members.size} members, ${state.posts.size} posts, ${state.comments.size} comments`);

    // Estimate time for 100K and 600K
    const timePerBatch = process.hrtime.bigint();
    const batchesFor100K = Math.ceil(100000 / 500);
    const batchesFor600K = Math.ceil(600000 / 500);

    console.log(`\n   Estimated time for 100K members: ${Math.ceil((batchesFor100K / batches) * 60)} minutes`);
    console.log(`   Estimated time for 600K members: ${Math.ceil((batchesFor600K / batches) * 60)} minutes`);

    return { success: true, members: state.members.size, posts: state.posts.size, comments: state.comments.size };
  } catch (err) {
    console.timeEnd(`load-${targetMembers}`);
    console.error(`❌ Failed:`, err.message);
    return { success: false, error: err.message };
  }
}

async function testMaxLimits() {
  console.log('\n=== Test 3: Back4App API limits ===');

  try {
    // Test max limit per request
    console.log('  Testing limit=1000...');
    const test1K = await b4a(config.appId, config.restKey, PARSE_CLASS_USER, {
      keys: 'objectId',
      limit: 1000,
    });
    console.log(`  ✅ limit=1000: ${test1K.length} members`);

    // Test if higher limits work
    console.log('  Testing limit=10000...');
    const test10K = await b4a(config.appId, config.restKey, PARSE_CLASS_USER, {
      keys: 'objectId',
      limit: 10000,
    });
    console.log(`  ✅ limit=10000: ${test10K.length} members (max enforced: ${test10K.length})`);

    return { success: true, maxLimit: test10K.length };
  } catch (err) {
    console.error(`  ❌ Failed:`, err.message);
    return { success: false, error: err.message };
  }
}

async function main() {
  console.log('Phase 0 Validation: Back4App Data Access');
  console.log('=========================================');

  // Test 1: Direct fetch
  const test1 = await testDirectFetch();

  // Test 2: Batch loading (10K target)
  const test2 = await testBatchLoading(10000);

  // Test 3: API limits
  const test3 = await testMaxLimits();

  // Summary
  console.log('\n=========================================');
  console.log('VALIDATION SUMMARY');
  console.log('=========================================');
  console.log(`Test 1 (Direct fetch):  ${test1.success ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Test 2 (Batch loading): ${test2.success ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Test 3 (API limits):    ${test3.success ? '✅ PASS' : '❌ FAIL'}`);

  if (test1.success && test2.success && test3.success) {
    console.log('\n✅ All tests passed! Back4App data access is feasible.');
    console.log(`\nNext steps:`);
    console.log(`  1. Test evolution performance: npm run training`);
    console.log(`  2. Prototype point cloud rendering`);
    console.log(`  3. Build Approach A (simple point cloud)`);
  } else {
    console.log('\n❌ Some tests failed. Review errors above.');
    console.log('   You may need to adjust approach or Back4App credentials.');
  }
}

main().catch(console.error);
