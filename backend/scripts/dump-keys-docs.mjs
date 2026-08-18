// Usage (from backend/):  node scripts/dump-keys-docs.mjs <outDir> [lineage=k3]
// Read-only: writes every generated KEYS artifact's inline content to outDir
// as <day>-<lineage>.md, one file per finalized day.
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2];
const lineage = process.argv[3] ?? 'k3';
if (!outDir) {
  console.error('usage: node scripts/dump-keys-docs.mjs <outDir> [lineage=k3]');
  process.exit(1);
}

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? 'app-foster-bridge' });
const db = getFirestore();
const snap = await db.collection('dayArtifacts').get();
const suffix = `__keys__${lineage}`;
const docs = snap.docs
  .filter((d) => d.id.endsWith(suffix))
  .map((d) => ({ id: d.id, day: d.id.slice(0, -suffix.length), data: d.data() }))
  .sort((a, b) => a.day.localeCompare(b.day));

mkdirSync(outDir, { recursive: true });
for (const { day, data } of docs) {
  if (!data.content) {
    console.error(`skip ${day}: no inline content field`);
    continue;
  }
  const file = path.join(outDir, `keys-${day}-${lineage}.md`);
  writeFileSync(file, data.content);
  console.log(`wrote ${file} (verified=${data.verified}, lookbackMissing=${JSON.stringify(data.lookbackMissing ?? [])})`);
}
console.log(`\n${docs.length} artifacts total for lineage ${lineage}`);
