import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? 'app-foster-bridge' });
const db = getFirestore();
const snap = await db.collection('benchmarkRuns')
  .where('trader', '==', 'keystone-trader')
  .where('modelAlias', '==', 'k3')
  .where('variant', '==', 'seven-keys-scorecard')
  .get();
const have = new Set(snap.docs.map(d => `${d.data().day}__run${d.data().runIndex}`));
const days = JSON.parse(process.argv[2]);
const missing = [];
for (const day of days) for (let r = 1; r <= 5; r++) {
  const k = `${day}__run${r}`;
  if (!have.has(k)) missing.push(k);
}
console.log('missing:', missing);
