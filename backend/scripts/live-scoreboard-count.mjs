import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? 'app-foster-bridge' });
const db = getFirestore();
const snap = await db.collection('benchmarkRuns')
  .where('trader', '==', 'keystone-trader')
  .where('modelAlias', '==', 'k3')
  .where('variant', '==', 'seven-keys-scorecard')
  .get();
console.log('live cell count:', snap.size, '/ 565');
const days = new Set(snap.docs.map(d => d.data().day));
console.log('live day count:', days.size, '/ 113');
