import { Test } from '@nestjs/testing';
import { FirestoreDemoController } from './firestore-demo.controller';
import { FIRESTORE } from '../firebase/firebase.constants';

describe('FirestoreDemoController', () => {
  const add = jest.fn(() => Promise.resolve({ id: 'doc123' }));
  const get = jest.fn(() =>
    Promise.resolve({
      docs: [
        { id: 'doc123', data: () => ({ message: 'hi', createdAt: 1 }) },
      ],
    }),
  );
  const collection = jest.fn(() => ({
    add,
    orderBy: () => ({ limit: () => ({ get }) }),
  }));
  const firestore = { collection };

  async function build() {
    const moduleRef = await Test.createTestingModule({
      controllers: [FirestoreDemoController],
      providers: [{ provide: FIRESTORE, useValue: firestore }],
    }).compile();
    return moduleRef.get(FirestoreDemoController);
  }

  beforeEach(() => {
    add.mockClear();
    collection.mockClear();
  });

  it('POST writes a doc to the demo collection and returns its id', async () => {
    const controller = await build();
    const result = await controller.create({ message: 'hi' });
    expect(collection).toHaveBeenCalledWith('demo');
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'hi' }),
    );
    expect(result).toEqual({ id: 'doc123' });
  });

  it('GET lists recent demo docs', async () => {
    const controller = await build();
    const result = await controller.list();
    expect(result).toEqual([{ id: 'doc123', message: 'hi', createdAt: 1 }]);
  });
});
