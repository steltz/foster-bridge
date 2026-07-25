const initializeApp = jest.fn((..._args: unknown[]) => ({ name: 'test-app' }));
const getApps = jest.fn(() => [] as unknown[]);
const getApp = jest.fn(() => ({ name: 'test-app' }));

jest.mock('firebase-admin/app', () => ({
  initializeApp: (...args: unknown[]) => initializeApp(...args),
  getApps: () => getApps(),
  getApp: () => getApp(),
}));
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => ({ __type: 'firestore' })),
}));
jest.mock('firebase-admin/storage', () => ({
  getStorage: jest.fn(() => ({ bucket: () => ({ __type: 'bucket' }) })),
}));

import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { FirebaseModule } from './firebase.module';
import { FIRESTORE, STORAGE_BUCKET } from './firebase.constants';
import configuration from '../config/configuration';

describe('FirebaseModule', () => {
  beforeEach(() => {
    initializeApp.mockClear();
    getApps.mockReset().mockReturnValue([]);
  });

  async function build() {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
        FirebaseModule,
      ],
    }).compile();
    return moduleRef;
  }

  it('provides FIRESTORE and STORAGE_BUCKET tokens', async () => {
    const moduleRef = await build();
    expect(moduleRef.get(FIRESTORE)).toEqual({ __type: 'firestore' });
    expect(moduleRef.get(STORAGE_BUCKET)).toEqual({ __type: 'bucket' });
  });

  it('initializes the admin app with projectId + storageBucket and no credential', async () => {
    await build();
    expect(initializeApp).toHaveBeenCalledTimes(1);
    const arg = initializeApp.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.projectId).toBe('app-foster-bridge');
    expect(arg.storageBucket).toBe('app-foster-bridge.firebasestorage.app');
    expect(arg).not.toHaveProperty('credential');
  });

  it('does not re-initialize when an app already exists', async () => {
    getApps.mockReturnValue([{ name: 'existing' }]);
    await build();
    expect(initializeApp).not.toHaveBeenCalled();
  });
});
