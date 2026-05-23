#!/usr/bin/env node
/**
 * FR-FIX-13 AC4: End-to-end onboarding journey test script.
 * Simulates: create knowledge → confirm stored → search verify.
 * Asserts completion within 5 minutes and search hit.
 *
 * Usage: node scripts/test-onboarding-e2e.js [--base-url http://localhost:3721/kivo]
 */

const BASE_URL = process.argv.includes('--base-url')
  ? process.argv[process.argv.indexOf('--base-url') + 1]
  : 'http://localhost:3721/kivo';

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function apiFetch(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const startTime = Date.now();
  console.log(`[onboarding-e2e] Starting test against ${BASE_URL}`);
  console.log(`[onboarding-e2e] Timeout: ${TIMEOUT_MS / 1000}s`);

  // Step 1: Create a knowledge entry
  const testContent = `E2E 测试知识条目 ${Date.now()}`;
  const testTitle = testContent.slice(0, 60);
  console.log(`[onboarding-e2e] Step 1: Creating knowledge entry: "${testTitle}"`);

  const createRes = await apiFetch('/api/v1/knowledge', {
    method: 'POST',
    body: JSON.stringify({
      content: testContent,
      title: testTitle,
      type: 'fact',
      status: 'active',
    }),
  });

  const entryId = createRes.data?.id;
  if (!entryId) {
    throw new Error('Failed to create knowledge entry: no ID returned');
  }
  console.log(`[onboarding-e2e] Step 1 ✓ Created entry: ${entryId}`);

  // Step 2: Confirm stored (verify entry exists)
  console.log(`[onboarding-e2e] Step 2: Confirming entry is stored...`);
  const getRes = await apiFetch(`/api/v1/knowledge/${entryId}`);
  if (!getRes.data || getRes.data.id !== entryId) {
    throw new Error(`Entry ${entryId} not found after creation`);
  }
  console.log(`[onboarding-e2e] Step 2 ✓ Entry confirmed in DB`);

  // Step 3: Search and verify hit (with retry)
  console.log(`[onboarding-e2e] Step 3: Searching for entry...`);
  let hit = false;
  let attempts = 0;
  const maxAttempts = 30; // 30 attempts * 5s = 150s max wait

  while (!hit && attempts < maxAttempts) {
    const elapsed = Date.now() - startTime;
    if (elapsed > TIMEOUT_MS) {
      throw new Error(`Timeout: search did not hit within ${TIMEOUT_MS / 1000}s`);
    }

    attempts++;
    try {
      const searchRes = await apiFetch(`/api/v1/search?q=${encodeURIComponent(testTitle)}&pageSize=10`);
      const results = searchRes.data ?? [];
      hit = results.some((r) => r.id === entryId);
      if (hit) break;
    } catch (err) {
      // Search might fail if index not ready, retry
    }

    if (!hit) {
      console.log(`[onboarding-e2e]   Attempt ${attempts}/${maxAttempts} - not yet hit, waiting 5s...`);
      await sleep(5000);
    }
  }

  const totalTime = Date.now() - startTime;

  if (!hit) {
    console.error(`[onboarding-e2e] ✗ FAILED: Search did not hit entry after ${attempts} attempts (${Math.round(totalTime / 1000)}s)`);
    process.exit(1);
  }

  console.log(`[onboarding-e2e] Step 3 ✓ Search hit confirmed`);
  console.log(`[onboarding-e2e] ✓ PASSED: Onboarding journey completed in ${Math.round(totalTime / 1000)}s`);

  // Assert within 5 minutes
  if (totalTime > TIMEOUT_MS) {
    console.error(`[onboarding-e2e] ✗ WARNING: Completed but exceeded 5-minute target`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(`[onboarding-e2e] ✗ FATAL: ${err.message}`);
  process.exit(1);
});
