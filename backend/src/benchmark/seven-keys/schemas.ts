// Ported from .claude/skills/seven-keys/SKILL.md. The structured-outputs validator
// rejects string `maxLength` and integer `minimum`/`maximum` (see SETUP_SCHEMA); we
// also drop array `minItems` defensively. Only type/enum/required/properties/items/
// additionalProperties are sent.

export const CURRENT_SCHEMA = {
  type: 'object',
  required: ['bias', 'environment', 'zones'],
  properties: {
    bias: { type: 'string' },
    environment: { type: 'string' },
    zones: {
      type: 'array',
      items: {
        type: 'object',
        required: ['prices', 'side', 'key3', 'key4', 'key5', 'key6', 'key7', 'grade'],
        properties: {
          prices: { type: 'string' },
          side: { type: 'string', enum: ['support', 'resistance'] },
          key3: { type: 'string' },
          key4: { type: 'string' },
          key5: { type: 'string' },
          key6: { type: 'string' },
          key7: { type: 'string' },
          grade: { type: 'string', enum: ['automatic-fade', 'strong', 'moderate', 'weak'] },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

export const LOOKBACK_SCHEMA = {
  type: 'object',
  required: ['calibration', 'continuity'],
  properties: {
    calibration: {
      type: 'array',
      items: {
        type: 'object',
        required: ['day', 'verdict'],
        properties: { day: { type: 'string' }, verdict: { type: 'string' } },
        additionalProperties: false,
      },
    },
    continuity: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const;

export const SYNTH_SCHEMA = {
  type: 'object',
  required: ['artifact'],
  properties: { artifact: { type: 'string' } },
  additionalProperties: false,
} as const;

export const VERIFY_SCHEMA = {
  type: 'object',
  required: ['pass', 'mismatches'],
  properties: {
    pass: { type: 'boolean' },
    mismatches: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const;
