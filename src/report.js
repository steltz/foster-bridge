const timeFormatters = new Map();

function formatTime(unixSeconds, tz) {
  if (unixSeconds === null) return '-';
  if (!timeFormatters.has(tz)) {
    timeFormatters.set(
      tz,
      new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    );
  }
  return timeFormatters.get(tz).format(new Date(unixSeconds * 1000));
}

export function formatTable({ session, results, summary }, tz) {
  const headers = ['ID', 'SIDE', 'STATUS', 'FILL', 'EXIT', 'EXIT PX', 'PTS', 'USD'];
  const rows = results.map((r) => [
    r.id,
    r.side,
    r.status,
    formatTime(r.fillTime, tz),
    formatTime(r.exitTime, tz),
    r.exitPrice === null ? '-' : String(r.exitPrice),
    r.points === null ? '-' : r.points.toFixed(2),
    r.dollars === null ? '-' : r.dollars.toFixed(2),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();

  return [
    `Session: ${session}`,
    '',
    line(headers),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map(line),
    '',
    `Orders: ${summary.orders}  Filled: ${summary.filled}  Wins: ${summary.wins}  Losses: ${summary.losses}`,
    `Net: ${summary.netPoints.toFixed(2)} pts  $${summary.netDollars.toFixed(2)}`,
  ].join('\n');
}
