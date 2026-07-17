# YouTube Transcript Subcommand — Design Spec

**Date:** 2026-07-17
**Status:** Approved design, pending implementation plan

## Purpose

Add a `transcript` subcommand to the CLI: given a public YouTube video URL (or
bare video id), fetch the video's transcript with the `youtube-transcript` npm
package and print it as timestamped markdown. Complements the Vimeo DevTools
snippet — same output format — for turning trade-plan videos into text.

## Non-goals

- No download of audio/video, no speech-to-text; captions must already exist
  on the video.
- No language selection flag in v1 (package default track only).
- No file output flag; stdout is the interface (`> plan.md` to save).
- No auth/cookies for private, unlisted-restricted, or members-only videos.

## CLI interface

The CLI gains subcommands via a thin dispatcher on `argv[2]`:

```
backtest run --data <chart.csv> --orders <orders.json> [--date ...] [--tz ...] [--multiplier ...] [--json]
backtest transcript <youtube-url-or-id> [--json]
```

- **Back-compat:** if `argv[2]` is absent or starts with `--`, the dispatcher
  treats the invocation as `run` with all arguments, so the existing
  documented form `backtest --data ... --orders ...` keeps working unchanged.
- An unknown subcommand prints a usage error naming `run` and `transcript`
  to stderr and exits 1.
- `transcript` accepts full watch URLs, `youtu.be/...`, `shorts/...`, or a
  bare 11-character video id. Id extraction is delegated to the
  `youtube-transcript` package; the CLI validates only that the argument is
  present and non-empty.
- `--json` on `transcript` prints the raw segment array
  (`[{ text, offset, duration }]`, offsets normalized to seconds) instead of
  markdown, 2-space indented, matching the run command's `--json` convention.

## Dependency amendment

`youtube-transcript` becomes the repo's first runtime dependency (exact
version pinned in package.json, package-lock.json committed; `node_modules/`
already gitignored). The project's zero-dependency rule is hereby retired and
replaced with a minimize-dependencies preference.

Documented risk: the package works by scraping YouTube's internal caption
endpoints, which YouTube changes occasionally. Upstream breakage manifests as
fetch errors at runtime and is resolved by a package update, not by changes to
this repo's logic.

## Module structure

```
src/cli.js                — ~15-line dispatcher: argv[2] → run | transcript | usage error
src/run-command.js        — the existing backtest flow, moved verbatim from cli.js
src/transcript.js         — pure: formatOffset(seconds), transcriptToMarkdown(segments)
src/transcript-command.js — flag parsing, youtube-transcript call (injectable), output
```

The backtest flow moves without logic edits so the diff reads as a pure move.
`src/transcript-command.js` exports its main function with an injectable
fetch dependency (`runTranscript(argv, { fetchTranscript })`) so tests can
mock the network; the default is the real `youtube-transcript` function.

## Output format

Markdown to stdout, identical in shape to the Vimeo snippet's output:

```markdown
# Transcript

**00:00** First caption text
**01:23** Next caption text
```

- `formatOffset(seconds)` renders `MM:SS` (zero-padded), growing to
  `H:MM:SS` at or past one hour (e.g. `1:02:05`).
- Segment order is as returned by the package (chronological).
- Segment text is trimmed; empty segments are skipped. YouTube caption text
  may contain HTML entities (e.g. `&amp;#39;`); the markdown renderer decodes
  the common named/numeric entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`,
  `&#39;`) before output.

**Offset units — implementation verification required:** the
`youtube-transcript` package's `offset` field has historically switched
between seconds and milliseconds across versions. The implementation must pin
an exact package version, verify the unit empirically with one live call
during development, and normalize to seconds at the `transcript-command`
boundary so `src/transcript.js` always receives seconds.

## Error handling

One clear stderr line + exit 1, no partial stdout, for each failure mode:

- Missing/empty URL argument → usage line for the `transcript` subcommand.
- Captions disabled / transcript unavailable / invalid or private video →
  the package's error message wrapped as `Could not fetch transcript: <msg>`.
- Network failure → same wrapper.
- Unknown flags → parseArgs error surfaced as-is (existing CLI behavior).

The `run` subcommand's error behavior is unchanged.

## Testing

- Unit tests (`test/transcript.test.js`): `formatOffset` (zero-pad, minute
  rollover, hour rollover), `transcriptToMarkdown` (header, line format,
  trimming, empty-segment skipping, entity decoding).
- Command tests (`test/transcript-command.test.js`): `runTranscript` with an
  injected mock fetcher — markdown mode, `--json` mode, missing-arg error,
  fetch-error wrapping. No network in any automated test.
- Existing suite (40 tests) must stay green, proving the `run` move and
  back-compat shim broke nothing; the existing cli e2e tests already exercise
  the old flag-style invocation through the new dispatcher.
- Manual: one live `backtest transcript <real public video>` run to verify
  the package works from the user's network and the offset-unit decision.
