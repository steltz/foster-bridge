// Usage (from backend/):  node scripts/fetch-trader-doc.mjs <name>
// Read-only: prints a persona doc's markdown content for review.
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const name = process.argv[2];
if (!name) {
  console.error('usage: node scripts/fetch-trader-doc.mjs <name>');
  process.exit(1);
}
initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? 'app-foster-bridge' });
const db = getFirestore();
const doc = await db.collection('traders').doc(name).get();
if (!doc.exists) {
  console.error(`no doc at traders/${name}`);
  process.exit(1);
}
process.stdout.write(doc.data().content ?? '(no content field)\n');
