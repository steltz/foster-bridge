import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { FIRESTORE, STORAGE_BUCKET } from '../firebase/firebase.constants';

describe('HealthController', () => {
  function makeDeps(opts: {
    firestoreOk?: boolean;
    bucketOk?: boolean;
  }) {
    const firestore = {
      listCollections: jest.fn(() =>
        opts.firestoreOk === false
          ? Promise.reject(new Error('fs down'))
          : Promise.resolve([]),
      ),
    };
    const bucket = {
      exists: jest.fn(() =>
        opts.bucketOk === false
          ? Promise.reject(new Error('bucket down'))
          : Promise.resolve([true]),
      ),
    };
    return { firestore, bucket };
  }

  async function build(deps: ReturnType<typeof makeDeps>) {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: FIRESTORE, useValue: deps.firestore },
        { provide: STORAGE_BUCKET, useValue: deps.bucket },
      ],
    }).compile();
    return moduleRef.get(HealthController);
  }

  it('liveness returns ok', async () => {
    const controller = await build(makeDeps({}));
    expect(controller.liveness()).toEqual({ status: 'ok' });
  });

  it('readiness reports ok for both dependencies when healthy', async () => {
    const controller = await build(makeDeps({ firestoreOk: true, bucketOk: true }));
    const result = await controller.readiness();
    expect(result.status).toBe('ok');
    expect(result.dependencies.firestore).toBe('ok');
    expect(result.dependencies.storage).toBe('ok');
  });

  it('readiness degrades when a dependency fails', async () => {
    const controller = await build(makeDeps({ firestoreOk: false, bucketOk: true }));
    const result = await controller.readiness();
    expect(result.status).toBe('degraded');
    expect(result.dependencies.firestore).toBe('error');
    expect(result.dependencies.storage).toBe('ok');
  });
});
