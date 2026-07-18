#!/usr/bin/env node
import { runBacktest } from './run-command.js';
import { runScoreboard } from './scoreboard-command.js';
import { runTranscript } from './transcript-command.js';

const USAGE =
  'Usage: backtest <command> ...\n' +
  'Commands:\n' +
  '  run         Backtest orders against OHLC data (default when flags are given)\n' +
  '  transcript  Fetch a YouTube video transcript as markdown\n' +
  '  scoreboard  Regenerate runs/SCOREBOARD.md from benchmark cells';

try {
  const argv = process.argv.slice(2);
  const [first, ...rest] = argv;
  if (first === 'transcript') {
    await runTranscript(rest);
  } else if (first === 'scoreboard') {
    runScoreboard(rest);
  } else if (first === 'run') {
    runBacktest(rest);
  } else if (first === undefined || first.startsWith('--')) {
    runBacktest(argv); // back-compat: flag-style invocation means "run"
  } else {
    throw new Error(`Unknown command "${first}"\n${USAGE}`);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
