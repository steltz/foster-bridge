// Usage (from backend/):  node scripts/list-keys-days.mjs [lineage=k3]
// Read-only: lists the days with a verified, full-lookback KEYS artifact.
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const lineage = process.argv[2] ?? 'k3';
initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? 'app-foster-bridge' });
const db = getFirestore();
const snap = await db.collection('dayArtifacts').get();
const suffix = `__keys__${lineage}`;
const days = snap.docs
  .filter((d) => d.id.endsWith(suffix))
  .map((d) => ({ day: d.id.slice(0, -suffix.length), data: d.data() }))
  .filter((d) => d.data.verified && !(d.data.lookbackMissing ?? []).length)
  .map((d) => d.day)
  .sort();
console.log(JSON.stringify(days));
console.error(`${days.length} verified, full-lookback days for lineage ${lineage}`);
