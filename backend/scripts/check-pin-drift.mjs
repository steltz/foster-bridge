import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? 'app-foster-bridge' });
const db = getFirestore();
const days = process.argv.slice(2);
for (const day of days) {
  const cellsSnap = await db.collection('benchmarkRuns')
    .where('trader', '==', 'keystone-trader')
    .where('modelAlias', '==', 'k3')
    .where('day', '==', day)
    .where('variant', '==', 'seven-keys-scorecard')
    .get();
  const pinnedHashes = new Set(cellsSnap.docs.map((d) => d.data().artifactSha256));
  const artifactDoc = await db.collection('dayArtifacts').doc(`${day}__keys__k3`).get();
  const currentHash = artifactDoc.exists ? artifactDoc.data().contentHash : '(missing)';
  console.log(day, '-> cell pins:', [...pinnedHashes], '| current artifact contentHash:', currentHash, '| match:', pinnedHashes.has(currentHash));
}
