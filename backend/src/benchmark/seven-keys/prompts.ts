export interface CurrentDayPromptInput {
  date: string;
  generalDocs: string; // concatenated general docs (may be '')
  methodsDoc: string;
  tpTranscript: string;
  recapTranscript: string;
}

export function currentDayPrompt(i: CurrentDayPromptInput): string {
  const generalBlock = i.generalDocs
    ? `First Read ALL of these general trading-strategy documents — session-agnostic context for how zones are built and traded:\n\n${i.generalDocs}\n\n`
    : '';
  return `You are the current-day Seven-Keys zone analyst for the ${i.date} ES (E-mini S&P 500) session.

${generalBlock}The trade plan worksheet (support/resistance zones) is provided as an attached PDF document. Also use these two session documents:

Trade plan video transcript:
${i.tpTranscript}

Prior-session recap transcript:
${i.recapTranscript}

Seven-Keys methodology (defines the keys you grade against):
${i.methodsDoc}

Keys 1-2 (expectancy; no price confirmation) are trader behaviors and are NOT your job. Assess EVERY support/resistance zone in the trade plan against Keys 3-7:
- key3: the likely approach into the zone (exhaustion, first test vs retest)
- key4: the zone's timeframe significance
- key5: whether a significant prior move launched from it
- key6: alignment with the larger-timeframe bias
- key7: confluence — how many keys stack here

Copy each zone's prices EXACTLY as the trade plan states them (e.g. "7495.25-7502.75") — never round, invent, or merge zones. Grade each zone automatic-fade | strong | moderate | weak, where automatic-fade means several keys stack so strongly that intraday price action gets no weight. The grade is a same-day filter, not an abstract quality ranking: factor in whether the zone can realistically be tested this session — a zone with excellent larger-timeframe pedigree that sits beyond any plausible single-session move grades moderate at best, with the pedigree recorded in its key4/key5 cells rather than the grade. Grades must discriminate at the top: strong and automatic-fade together should mark only the few zones a trader should prioritize today — no more than about a third of the sheet — and moderate is a deliberate middle call, not a default bucket; it is fine for many distant zones to collapse into weak. Also state the day's larger-timeframe bias and any environment/volatility notes (scheduled reports, range vs directional).`;
}

export interface LookbackEntry {
  day: string;
  keysContent: string;
  outcomeRecap: string | null;
}

export function lookbackPrompt(date: string, entries: LookbackEntry[]): string {
  const blocks = entries
    .map(
      (e) =>
        `Day ${e.day} assessment:\n${e.keysContent}\n\n${
          e.outcomeRecap
            ? `Day ${e.day} outcome recap:\n${e.outcomeRecap}`
            : `Day ${e.day}: no outcome recap available.`
        }`,
    )
    .join('\n\n---\n\n');
  return `You are the lookback calibration analyst for the ${date} ES session. Read each prior day's Seven-Keys assessment together with the recap that describes how that day's session ACTUALLY traded:

${blocks}

For each prior day, judge from its outcome recap whether the highly graded zones actually held — flag grades that proved wrong, do not smooth them over (one calibration entry per prior day). Then note continuity: zones recurring across days, bias evolution, and anything that should sharpen today's assessment. You are advisory: today's analyst outranks you.`;
}

export function synthesizePrompt(
  date: string,
  current: unknown,
  lookback: unknown | null,
  sources: string,
): string {
  return `You are the synthesizer producing the ${date} ES Seven-Keys artifact. Do not read any files. Your two inputs:

CURRENT-DAY ANALYSIS (authoritative):
${JSON.stringify(current, null, 2)}

LOOKBACK NOTES (advisory):
${lookback ? JSON.stringify(lookback, null, 2) : 'none — bootstrap'}

Weighting rule: the current-day analysis is authoritative. The lookback may sharpen wording, add calibration history, or annotate — it must NEVER change a zone's prices, add or drop zones, or override a current-day grade unless the current-day evidence itself is ambiguous. Keep every zone's prices EXACTLY as given.

Return the artifact as markdown in exactly this shape (no frontmatter — it is added later):

# Seven Keys — ES ${date}

**Larger-timeframe bias:** <one or two sentences>
**Environment notes:** <one or two sentences>

Keys 1–2 (expectancy; no price confirmation) are trader-behavior keys and remain the responsibility of each persona. Zones below are scored on Keys 3–7.

## Zone scorecard (Keys 3–7)

| Zone (prices) | Side | Key 3 approach | Key 4 timeframe | Key 5 prior launch | Key 6 bias align | Key 7 confluence | Grade |
|---|---|---|---|---|---|---|---|
<one row per zone, cells terse, side values lowercase (support/resistance)>

## Automatic-fade candidates

<bullet list of zones graded automatic-fade, or "- None today.">

## Lookback

Sources: ${sources}

<calibration-aware bullets, including any prior grades that proved wrong, or "- none — bootstrap">`;
}

export function verifyPrompt(date: string, tpTranscript: string, artifact: string): string {
  return `You are a fidelity verifier for the ${date} ES session. The trade plan worksheet is provided as an attached PDF document. Also use the trade plan video transcript:

${tpTranscript}

Below is a synthesized Seven-Keys scorecard. Check EVERY row of its zone table against those documents: the zone's prices and side (support/resistance) must match a zone actually present in the trade plan — no invented zones, no dropped-then-substituted zones, no transposed or rounded prices. Do NOT judge grades, bias, or wording — fidelity to the source zones only. Return pass=true only if every row checks out; otherwise pass=false with one mismatch string per problem row.

ARTIFACT:
${artifact}`;
}
