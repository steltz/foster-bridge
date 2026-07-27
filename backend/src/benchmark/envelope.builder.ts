import { Injectable } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import { CachedContext } from '../anthropic/anthropic.service';
import { Variant } from './benchmark.types';

export interface DayBundle {
  date: string;
  anthropicFileId: string;
  tpTranscript: string;
  recapTranscript: string;
}

export interface VariantSpec {
  variant: Variant;
  featureBlock?: string; // the feature's prompt body (base: undefined)
  methodsDoc?: string; // seven-keys-method's staticDoc content
  artifact?: string; // seven-keys-scorecard's KEYS content (substituted into ${ARTIFACT})
}

// Constant task/schema framing. M4: this + the general docs form Tier 1, which
// now lives in the FIRST USER MESSAGE tier (not `system`), so the batch's
// output_config.format does not invalidate the cached prefix and the
// max_tokens:0 warm (which may not carry format) still aligns byte-for-byte.
const TASK_FRAMING = [
  'You are a futures trading persona on an independent benchmark run.',
  'Commit to exactly ONE trade for the ES (E-mini S&P 500) session: long or short.',
  'Anchor entry, stop loss, and take profit to the support/resistance zones in the trade plan.',
  'Prices are ES index points in quarter-point increments (e.g. 7530.25).',
  'A long requires stopLoss < entry < takeProfit; a short requires takeProfit < entry < stopLoss.',
  'Include a rationale of at most 50 words citing the plan level(s) used, a primaryZone',
  '(the specific price zone anchored to, e.g. "7481.75-7495.75"), a confidence integer 1-5,',
  'and, only if you seriously weighed a different zone or side, a rejectedAlternative',
  '(at most 30 words). Respond only with JSON matching the required schema.',
].join('\n');

export const TRAILING_PROMPT = 'Produce your single setup now as JSON matching the schema.';

@Injectable()
export class EnvelopeBuilder {
  private generalText(generalDocs: string): string {
    return [
      'General trading-strategy documents (session-agnostic guidance that constrains every trade):',
      generalDocs,
      '',
      TASK_FRAMING,
    ].join('\n');
  }

  // Tier 1: general docs + task framing, as a single cached user text block.
  // Typed against the BETA content-block param — see CachedContext.userTiers
  // (Task 6): the day tier's file-backed document block is only valid there,
  // so every tier in this builder shares that type for consistency.
  private generalTier(generalDocs: string): { blocks: Anthropic.Beta.BetaContentBlockParam[] } {
    return { blocks: [{ type: 'text', text: this.generalText(generalDocs) }] };
  }

  // Tier 2: the day bundle — PDF document block (by file_id) + both transcripts.
  private dayTier(bundle: DayBundle): { blocks: Anthropic.Beta.BetaContentBlockParam[] } {
    return {
      blocks: [
        {
          type: 'document',
          source: { type: 'file', file_id: bundle.anthropicFileId },
        } as Anthropic.Beta.BetaContentBlockParam,
        {
          type: 'text',
          text: `Trade plan video transcript for the ${bundle.date} ES session:\n${bundle.tpTranscript}`,
        },
        {
          type: 'text',
          text: `Prior-session recap transcript:\n${bundle.recapTranscript}`,
        },
      ],
    };
  }

  /** Tiers 1-2 (general + day bundle) — the shared, cheap-to-warm prefix. */
  dayBundleContext(generalDocs: string, bundle: DayBundle): CachedContext {
    return { userTiers: [this.generalTier(generalDocs), this.dayTier(bundle)] };
  }

  /** Full 3-tier (base) or 4-tier (feature) envelope for a single cell. */
  fullEnvelope(generalDocs: string, bundle: DayBundle, persona: string, spec: VariantSpec): CachedContext {
    const tiers: Array<{ blocks: Anthropic.Beta.BetaContentBlockParam[] }> = [
      this.generalTier(generalDocs),
      this.dayTier(bundle),
      { blocks: [{ type: 'text', text: `Adopt this trading persona fully:\n${persona}` }] },
    ];
    if (spec.variant === 'seven-keys-scorecard') {
      // Scorecard: substitute BOTH placeholders into the feature block.
      if (spec.artifact == null || spec.artifact === '') {
        throw new Error(
          `Variant "${spec.variant}" requires a KEYS artifact to substitute into \${ARTIFACT}`,
        );
      }
      if (spec.methodsDoc == null || spec.methodsDoc === '') {
        throw new Error(
          `Variant "${spec.variant}" requires a methods doc to substitute into \${DOC}`,
        );
      }
      // Single-pass substitution with a function replacer: this avoids the
      // two-pass split/join clobbering a literal "${ARTIFACT}" that happens
      // to appear inside methodsDoc once it's been substituted in for ${DOC},
      // and function replacements (unlike string replacements) never
      // interpret $-sequences (e.g. $&, $1, $$) in the returned value.
      const featureText = (spec.featureBlock ?? '')
        .replace(/\$\{DOC\}|\$\{ARTIFACT\}/g, (token) =>
          token === '${DOC}' ? spec.methodsDoc! : spec.artifact!,
        )
        .trim();
      if (!featureText) {
        throw new Error(`Variant "${spec.variant}" produced an empty feature tier`);
      }
      tiers.push({ blocks: [{ type: 'text', text: featureText }] });
    } else if (spec.variant !== 'base') {
      const featureText = [spec.featureBlock ?? '', spec.methodsDoc ? `\n\n${spec.methodsDoc}` : '']
        .join('')
        .trim();
      if (!featureText) {
        // Task 6's buildCachedRequest stamps one cache breakpoint per tier
        // regardless of content, so an empty feature tier would waste a
        // breakpoint (or risk an API rejection on an empty block) for no
        // benefit — fail loudly instead.
        throw new Error(
          `Non-base variant "${spec.variant}" requires a feature block or methods doc`,
        );
      }
      tiers.push({ blocks: [{ type: 'text', text: featureText }] });
    }
    return { userTiers: tiers };
  }
}
