import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLM_PROVIDER } from '../llm/llm.constants';
import type { LlmProvider } from '../llm/llm.provider';
import { IngestValidationError } from './eminiplayer-ingest.errors';
import { parseMmddyyyy, VideoFlavor } from './eminiplayer-validation';

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

export interface TranscriptVerdict {
  docType: 'tradePlan' | 'recap' | 'other';
  isEsContent: boolean;
  referencedWeekday: (typeof WEEKDAYS)[number] | 'none';
  confidence: 'high' | 'medium' | 'low';
}

// Every enum property carries an explicit `type` — enum-only properties have
// broken structured output on the moonshot provider before.
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['docType', 'isEsContent', 'referencedWeekday', 'confidence'],
  properties: {
    docType: { type: 'string', enum: ['tradePlan', 'recap', 'other'] },
    isEsContent: { type: 'boolean' },
    referencedWeekday: { type: 'string', enum: [...WEEKDAYS, 'none'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};

const SYSTEM = [
  'You classify a transcript of a trading video. Answer only via the schema.',
  'docType: "tradePlan" if the speaker presents a plan for the UPCOMING session (typical opening: "let\'s go over today\'s trade plan"); "recap" if the speaker reviews a COMPLETED session (typical opening: "welcome to today\'s live recap"); otherwise "other".',
  'isEsContent: true only if the content is about ES / E-mini S&P 500 futures trading.',
  'referencedWeekday: the weekday of the session this video PRIMARILY covers (the session being planned or recapped), only if the speaker states or clearly implies it; otherwise "none". IGNORE mentions of the next or previous session ("tomorrow, Wednesday, watch for..." in a recap refers to the NEXT session, not this one). If both are named, answer with the covered session\'s weekday. Never guess.',
  'confidence: your certainty in docType.',
].join('\n');

/** Only the opening minutes are needed to classify; keeps the call cheap. */
const TRANSCRIPT_SNIPPET_CHARS = 6000;

/**
 * LLM content verification (blocking): the only layer that catches "right
 * slot, wrong content" — e.g. the site embedded Monday's video on Tuesday's
 * page. Verdict mismatch throws IngestValidationError (422, human must look);
 * transport failure propagates as plain Error for the orchestrator to wrap
 * as a retryable 'verify' stage failure.
 */
@Injectable()
export class EminiplayerVerifyService {
  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly config: ConfigService,
  ) {}

  async verifyTranscript(
    markdown: string,
    expected: { flavor: VideoFlavor; date: string },
  ): Promise<TranscriptVerdict> {
    const expectedWeekday = WEEKDAYS[parseMmddyyyy(expected.date).getUTCDay()];
    const verdict = await this.llm.messageStructured<TranscriptVerdict>(
      {
        system: SYSTEM,
        prompt: `Transcript (may be truncated):\n\n${markdown.slice(0, TRANSCRIPT_SNIPPET_CHARS)}`,
        schema: VERDICT_SCHEMA,
        model: this.config.get<string>('eminiplayer.verifyModel'),
        maxTokens: 300,
      },
      { operation: 'other' },
    );
    if (verdict.docType !== expected.flavor) {
      throw new IngestValidationError(
        `llm verification: expected a ${expected.flavor} transcript but it classified as ${verdict.docType}`,
      );
    }
    if (!verdict.isEsContent) {
      throw new IngestValidationError('llm verification: transcript is not ES futures content');
    }
    if (verdict.referencedWeekday !== 'none' && verdict.referencedWeekday !== expectedWeekday) {
      throw new IngestValidationError(
        `llm verification: transcript references ${verdict.referencedWeekday} but ${expected.date} is a ${expectedWeekday}`,
      );
    }
    if (verdict.confidence === 'low') {
      throw new IngestValidationError('llm verification: low-confidence classification');
    }
    return verdict; // recorded as manifest evidence
  }
}
