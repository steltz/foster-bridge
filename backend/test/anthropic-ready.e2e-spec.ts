import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Anthropic readiness (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /ai/ready -> 200 { configured: false } with no key (app boots keyless)', () => {
    return request(app.getHttpServer())
      .get('/ai/ready')
      .expect(200)
      .expect({ configured: false });
  });
});
