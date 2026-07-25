import { Global, Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { App, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { FIRESTORE, STORAGE_BUCKET } from './firebase.constants';

const FIREBASE_APP = Symbol('FIREBASE_APP');

const firebaseAppProvider: Provider = {
  provide: FIREBASE_APP,
  inject: [ConfigService],
  useFactory: (config: ConfigService): App => {
    // No `credential` argument -> firebase-admin resolves Application
    // Default Credentials automatically (gcloud ADC locally, attached
    // service identity in GCP). Idempotent across Nest reloads.
    if (getApps().length > 0) {
      return getApp();
    }
    return initializeApp({
      projectId: config.get<string>('firebase.projectId'),
      storageBucket: config.get<string>('firebase.storageBucket'),
    });
  },
};

const firestoreProvider: Provider = {
  provide: FIRESTORE,
  inject: [FIREBASE_APP],
  useFactory: (app: App) => getFirestore(app),
};

const storageBucketProvider: Provider = {
  provide: STORAGE_BUCKET,
  inject: [FIREBASE_APP],
  useFactory: (app: App) => getStorage(app).bucket(),
};

@Global()
@Module({
  providers: [firebaseAppProvider, firestoreProvider, storageBucketProvider],
  exports: [FIRESTORE, STORAGE_BUCKET],
})
export class FirebaseModule {}
