import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LLM_PROVIDER } from '../llm/llm.constants';
import type { Attribution, StructuredRequest } from '../llm/llm.types';
import { EminiplayerVerifyService } from './eminiplayer-verify.service';
import { IngestValidationError } from './eminiplayer-ingest.errors';

const GOOD_VERDICT = {
  docType: 'recap',
  isEsContent: true,
  referencedWeekday: 'Tuesday',
  confidence: 'high',
};

// 06302026 is a Tuesday
const EXPECTED = { flavor: 'recap' as const, date: '06302026' };
const MARKDOWN = '# Transcript\n\n**00:00** welcome to the recap\n';

async function build(verdict: unknown = GOOD_VERDICT) {
  // Params are declared (rather than `jest.fn(() => ...)`) so `mock.calls[0]`
  // types as the real [request, attribution] tuple the asserts below index into.
  const llm = {
    messageStructured: jest.fn(
      (_req: StructuredRequest, _attribution: Attribution): Promise<unknown> =>
        Promise.resolve(verdict),
    ),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      EminiplayerVerifyService,
      { provide: LLM_PROVIDER, useValue: llm },
      {
        provide: ConfigService,
        useValue: { get: jest.fn(() => 'test-verify-model') },
      },
    ],
  }).compile();
  return { service: moduleRef.get(EminiplayerVerifyService), llm };
}

describe('EminiplayerVerifyService.verifyTranscript', () => {
  it('returns the verdict on a match and passes model + schema + attribution', async () => {
    const { service, llm } = await build();
    await expect(service.verifyTranscript(MARKDOWN, EXPECTED)).resolves.toEqual(GOOD_VERDICT);
    const [req, attribution] = llm.messageStructured.mock.calls[0];
    expect(req.model).toBe('test-verify-model');
    expect(req.schema).toBeDefined();
    expect(req.prompt).toContain('welcome to the recap');
    expect(attribution).toEqual({ operation: 'other' });
  });

  it('accepts referencedWeekday "none" (speaker never names the day)', async () => {
    const verdict = { ...GOOD_VERDICT, referencedWeekday: 'none' };
    const { service } = await build(verdict);
    await expect(service.verifyTranscript(MARKDOWN, EXPECTED)).resolves.toEqual(verdict);
  });

  it.each([
    [{ ...GOOD_VERDICT, docType: 'tradePlan' }, 'classified as tradePlan'],
    [{ ...GOOD_VERDICT, docType: 'other' }, 'classified as other'],
    [{ ...GOOD_VERDICT, isEsContent: false }, 'not ES futures content'],
    [{ ...GOOD_VERDICT, referencedWeekday: 'Friday' }, 'references Friday'],
    [{ ...GOOD_VERDICT, confidence: 'low' }, 'low-confidence'],
  ])('throws IngestValidationError on mismatch %#', async (verdict, messagePart) => {
    const { service } = await build(verdict);
    const err = await service.verifyTranscript(MARKDOWN, EXPECTED).catch((e) => e);
    expect(err).toBeInstanceOf(IngestValidationError);
    expect(err.message).toContain(messagePart);
  });

  it('lets transport errors propagate as plain Error', async () => {
    const { service, llm } = await build();
    llm.messageStructured.mockRejectedValue(new Error('api down'));
    const err = await service.verifyTranscript(MARKDOWN, EXPECTED).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(IngestValidationError);
  });
});
