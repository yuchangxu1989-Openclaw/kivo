import { runDeduplicateScan } from './dist/esm/cli/mece-governance.js';

process.chdir('/root/.openclaw/workspace/projects/kivo');

console.log('Starting dedup scan with threshold 0.80, auto-merge at 0.90...');
const start = Date.now();

try {
  const report = await runDeduplicateScan({ threshold: 0.80, auto: true });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nCompleted in ${elapsed}s`);
  console.log(`Total entries: ${report.totalEntries}`);
  console.log(`Scanned (with embeddings): ${report.scannedEntries}`);
  console.log(`Duplicate pairs found: ${report.duplicatePairs.length}`);
  console.log(`Auto-merged: ${report.autoMerged}`);
  
  if (report.duplicatePairs.length > 0) {
    console.log('\nTop 20 duplicate pairs:');
    for (const pair of report.duplicatePairs.slice(0, 20)) {
      console.log(`  [${(pair.similarity * 100).toFixed(1)}%] "${pair.entryA.title}" <-> "${pair.entryB.title}"`);
    }
  }
} catch (err) {
  console.error('Error:', err.message);
  console.error(err.stack);
}
