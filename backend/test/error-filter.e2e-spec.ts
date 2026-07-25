import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { FIRESTORE, STORAGE_BUCKET } from '../src/firebase/firebase.constants';

describe('GoogleErrorFilter (composed app e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Firestore token must resolve, but this test only exercises Storage.
      .overrideProvider(FIRESTORE)
      .useValue({})
      .overrideProvider(STORAGE_BUCKET)
      .useValue({
        // Storage ApiError: `.code` is the HTTP status number.
        getFiles: () =>
          Promise.reject(
            Object.assign(new Error('Permission denied'), { code: 403 }),
          ),
      })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('maps a Storage 403 ApiError to a 403 envelope (filter active in app)', () => {
    return request(app.getHttpServer())
      .get('/demo/storage')
      .expect(403)
      .expect((res) => {
        if (res.body.statusCode !== 403) {
          throw new Error(`expected statusCode 403, got ${res.body.statusCode}`);
        }
        if (res.body.path !== '/demo/storage') {
          throw new Error(`expected path /demo/storage, got ${res.body.path}`);
        }
      });
  });
});
