import { Test } from '@nestjs/testing';
import { StorageDemoController } from './storage-demo.controller';
import { STORAGE_BUCKET } from '../firebase/firebase.constants';

describe('StorageDemoController', () => {
  const save = jest.fn(() => Promise.resolve());
  const getSignedUrl = jest.fn(() => Promise.resolve(['https://signed.example/url']));
  const file = jest.fn(() => ({ save, getSignedUrl }));
  const getFiles = jest.fn(() =>
    Promise.resolve([[{ name: 'demo/a.txt' }, { name: 'demo/b.txt' }]]),
  );
  const bucket = { file, getFiles };

  async function build() {
    const moduleRef = await Test.createTestingModule({
      controllers: [StorageDemoController],
      providers: [{ provide: STORAGE_BUCKET, useValue: bucket }],
    }).compile();
    return moduleRef.get(StorageDemoController);
  }

  beforeEach(() => {
    save.mockClear();
    file.mockClear();
    getSignedUrl.mockClear();
  });

  it('POST uploads a text object under the demo/ prefix', async () => {
    const controller = await build();
    const result = await controller.upload({ content: 'hello' });
    expect(file).toHaveBeenCalledWith(expect.stringMatching(/^demo\//));
    expect(save).toHaveBeenCalledWith('hello', expect.objectContaining({
      contentType: 'text/plain',
    }));
    expect(result.name).toMatch(/^demo\//);
  });

  it('GET lists objects under the demo/ prefix', async () => {
    const controller = await build();
    const result = await controller.list();
    expect(getFiles).toHaveBeenCalledWith({ prefix: 'demo/' });
    expect(result).toEqual(['demo/a.txt', 'demo/b.txt']);
  });

  it('GET :name/url returns a v4 signed read URL', async () => {
    const controller = await build();
    const result = await controller.signedUrl('a.txt');
    expect(file).toHaveBeenCalledWith('demo/a.txt');
    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({ version: 'v4', action: 'read' }),
    );
    expect(result).toEqual({ url: 'https://signed.example/url' });
  });
});
