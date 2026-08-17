// Usage (from backend/, after `pnpm build`):  node scripts/reset-keys-era.mjs [--apply]
// Deletes this lineage's KEYS artifacts AND the cells pinning them, so the
// corpus can be regenerated in strict chronological order.
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { planKeysEraReset, isLineageKeysDoc } from '../dist/benchmark/keys-era-reset.js';
// The repo's own definition of "still needs reconciler attention"
// (benchmark.repository.ts:16) — imported so a future status cannot drift.
import { NON_TERMINAL } from '../dist/benchmark/benchmark.repository.js';

const apply = process.argv.includes('--apply');
const lineage = process.env.KEYS_LINEAGE ?? 'k3';

const nonTerminalBatches = () =>
  db.collection('benchmarkBatches').where('status', 'in', NON_TERMINAL).get();

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? 'app-foster-bridge' });
const db = getFirestore();

// The in-memory BenchmarkRunLock is invisible from this process, so the
// enforceable precondition is the batch check: if a batch is still unreconciled,
// BatchReconciler's cron will re-write pins for the artifacts we just deleted
// within a minute and wedge those days permanently.
const batches = await nonTerminalBatches();
if (!batches.empty) {
  console.error(`ABORT: ${batches.size} non-terminal batch(es) exist. Let them reconcile first —`);
  console.error('otherwise the reconciler re-creates pins for deleted artifacts and wedges those days.');
  process.exit(1);
}

const [artifactSnap, cellSnap] = await Promise.all([
  db.collection('dayArtifacts').get(),
  db.collection('benchmarkRuns').get(),
]);

const plan = planKeysEraReset(
  artifactSnap.docs.map((d) => ({ id: d.id, contentHash: d.data().contentHash ?? null, generatedBy: d.data().generatedBy ?? null })),
  cellSnap.docs.map((d) => ({ id: d.id, artifactSha256: d.data().artifactSha256 ?? null })),
  lineage,
);

console.log(`lineage:                  ${lineage}`);
console.log(`KEYS artifacts to delete: ${plan.artifactIdsToDelete.length}`);
console.log(`pinning cells to delete:  ${plan.cellIdsToDelete.length}`);
console.log(`cells kept (pin nothing or another lineage): ${plan.keptCellCount}`);

if (!apply) {
  console.log('\nDRY RUN — re-run with --apply to execute.');
  process.exit(0);
}

let batch = db.batch();
let queued = 0;
const flush = async () => {
  await batch.commit();
  batch = db.batch();
  queued = 0;
};
for (const id of plan.cellIdsToDelete) {
  batch.delete(db.collection('benchmarkRuns').doc(id));
  if (++queued === 400) await flush(); // Firestore caps a batch at 500
}
for (const id of plan.artifactIdsToDelete) {
  batch.delete(db.collection('dayArtifacts').doc(id));
  if (++queued === 400) await flush();
}
if (queued) await flush();

// TOCTOU check: a batch created between the pre-check and the deletes means a
// concurrent run may pin an artifact we just deleted the moment it reconciles.
// Convert that silent future wedge into an immediate signal.
const batchesAfter = await nonTerminalBatches();
if (!batchesAfter.empty) {
  console.error(`\nWARNING: ${batchesAfter.size} non-terminal batch(es) appeared DURING the reset.`);
  console.error('A concurrent benchmark run may have pinned an artifact that was just deleted.');
  console.error('Check GET /benchmark/keys-backfill and re-run the dry run (no --apply) once the');
  console.error('batches reconcile; any day it reports as still pinned must be investigated.');
  process.exit(1);
}

// Real post-conditions: (a) no surviving KEYS doc for this lineage, and (b) no
// surviving cell pinning a hash that no surviving artifact carries. Counting
// "cells that still have an artifactSha256" would be tautological.
const [afterArtifacts, afterCells] = await Promise.all([
  db.collection('dayArtifacts').get(),
  db.collection('benchmarkRuns').get(),
]);
const survivingHashes = new Set(afterArtifacts.docs.map((d) => d.data().contentHash).filter(Boolean));
const stillLineage = afterArtifacts.docs.filter((d) =>
  isLineageKeysDoc({ id: d.id, generatedBy: d.data().generatedBy ?? null }, lineage),
).length;
const dangling = afterCells.docs.filter((d) => {
  const h = d.data().artifactSha256;
  return h && !survivingHashes.has(h);
}).length;

console.log(`\nDone. Surviving ${lineage} KEYS docs: ${stillLineage} (must be 0).`);
console.log(`Cells pinning a missing artifact: ${dangling} (must be 0).`);
process.exit(stillLineage === 0 && dangling === 0 ? 0 : 1);
