import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';

async function build() {
  const service = {
    createTrader: jest.fn().mockResolvedValue({ name: 'context-trader', sha256: 'a'.repeat(64) }),
    createFeature: jest.fn().mockResolvedValue({ id: 'seven-keys-method', sha256: 'b'.repeat(64) }),
    putGeneral: jest.fn().mockResolvedValue({ path: 'knowledge-base/general/zones.md', sha256: 'c'.repeat(64) }),
    putMethods: jest.fn().mockResolvedValue({ path: 'knowledge-base/methods/seven-keys.md', sha256: 'd'.repeat(64) }),
    listTraders: jest.fn().mockResolvedValue([{ name: 'context-trader', origin: null, mutation: null, sha256: 'a'.repeat(64) }]),
    listFeatures: jest.fn().mockResolvedValue([{ id: 'seven-keys-method', name: 'Seven Keys', sha256: 'b'.repeat(64) }]),
    listGeneral: jest.fn().mockResolvedValue([{ path: 'knowledge-base/general/zones.md', sha256: 'c'.repeat(64) }]),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [ContentController],
    providers: [{ provide: ContentService, useValue: service }],
  }).compile();
  return { ctrl: moduleRef.get(ContentController), service };
}

describe('ContentController', () => {
  it('POST /traders delegates the body content to the service', async () => {
    const { ctrl, service } = await build();
    const res = await ctrl.createTrader({ content: '---\nname: context-trader\n---\nbody' });
    expect(service.createTrader).toHaveBeenCalledWith('---\nname: context-trader\n---\nbody');
    expect(res).toEqual({ name: 'context-trader', sha256: 'a'.repeat(64) });
  });

  it('POST /traders rejects a missing/empty content body before touching the service', async () => {
    const { ctrl, service } = await build();
    expect(() => ctrl.createTrader({})).toThrow(BadRequestException);
    expect(() => ctrl.createTrader({ content: '' })).toThrow(BadRequestException);
    expect(service.createTrader).not.toHaveBeenCalled();
  });

  it('GET /traders delegates to listTraders', async () => {
    const { ctrl, service } = await build();
    const res = await ctrl.listTraders();
    expect(service.listTraders).toHaveBeenCalledWith();
    expect(res[0].name).toBe('context-trader');
  });

  it('POST /features delegates the body content to the service', async () => {
    const { ctrl, service } = await build();
    const res = await ctrl.createFeature({ content: '---\nid: seven-keys-method\n---\nblock' });
    expect(service.createFeature).toHaveBeenCalledWith('---\nid: seven-keys-method\n---\nblock');
    expect(res.id).toBe('seven-keys-method');
  });

  it('GET /features delegates to listFeatures', async () => {
    const { ctrl, service } = await build();
    const res = await ctrl.listFeatures();
    expect(service.listFeatures).toHaveBeenCalledWith();
    expect(res[0].id).toBe('seven-keys-method');
  });

  it('PUT /knowledge/general/:name delegates name and content', async () => {
    const { ctrl, service } = await build();
    const res = await ctrl.putGeneral('zones', { content: 'ZONES' });
    expect(service.putGeneral).toHaveBeenCalledWith('zones', 'ZONES');
    expect(res.path).toBe('knowledge-base/general/zones.md');
  });

  it('GET /knowledge/general delegates to listGeneral', async () => {
    const { ctrl, service } = await build();
    const res = await ctrl.listGeneral();
    expect(service.listGeneral).toHaveBeenCalledWith();
    expect(res[0].path).toBe('knowledge-base/general/zones.md');
  });

  it('PUT /knowledge/methods delegates the content', async () => {
    const { ctrl, service } = await build();
    const res = await ctrl.putMethods({ content: 'METHODS' });
    expect(service.putMethods).toHaveBeenCalledWith('METHODS');
    expect(res.path).toBe('knowledge-base/methods/seven-keys.md');
  });
});
