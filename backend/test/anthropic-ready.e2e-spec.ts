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

  it('POST /ai/message -> clean 401 with no key (the defining guarantee)', () => {
    // The full request → lazy factory → UnauthorizedException → global filter
    // path must yield a clean 401, not an unhandled construction throw or 500.
    return request(app.getHttpServer())
      .post('/ai/message')
      .send({ prompt: 'hi' })
      .expect(401);
  });
});
