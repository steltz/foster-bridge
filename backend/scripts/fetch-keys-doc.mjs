// Usage (from backend/):  node scripts/fetch-keys-doc.mjs <day MMDDYYYY> [lineage=k3]
// Read-only: prints a KEYS dayArtifacts doc's inline content for review.
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const day = process.argv[2];
const lineage = process.argv[3] ?? 'k3';
if (!day) {
  console.error('usage: node scripts/fetch-keys-doc.mjs <day MMDDYYYY> [lineage=k3]');
  process.exit(1);
}

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? 'app-foster-bridge' });
const db = getFirestore();
const doc = await db.collection('dayArtifacts').doc(`${day}__keys__${lineage}`).get();
if (!doc.exists) {
  console.error(`no doc at dayArtifacts/${day}__keys__${lineage}`);
  process.exit(1);
}
const data = doc.data();
process.stderr.write(
  `gcsPath: ${data.gcsPath}\nverified: ${data.verified}\ngeneratedBy: ${data.generatedBy}\ngeneratedAt: ${data.generatedAt}\nlookbackSources: ${JSON.stringify(data.lookbackSources)}\nlookbackMissing: ${JSON.stringify(data.lookbackMissing)}\n\n`,
);
process.stdout.write(data.content ?? '(no inline content field)\n');
