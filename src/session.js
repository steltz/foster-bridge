const formatters = new Map();

function formatterFor(tz) {
  if (!formatters.has(tz)) {
    formatters.set(
      tz,
      new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
    );
  }
  return formatters.get(tz);
}

const timeFormatters = new Map();

function timeFormatterFor(tz) {
  if (!timeFormatters.has(tz)) {
    timeFormatters.set(
      tz,
      new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
    );
  }
  return timeFormatters.get(tz);
}

// en-CA locale formats as YYYY-MM-DD.
export function dateForTimestamp(unixSeconds, tz) {
  return formatterFor(tz).format(new Date(unixSeconds * 1000));
}

// Minutes elapsed since local midnight in the given timezone (0..1439).
export function minutesOfDayForTimestamp(unixSeconds, tz) {
  const parts = timeFormatterFor(tz).formatToParts(new Date(unixSeconds * 1000));
  const hour = Number(parts.find((p) => p.type === 'hour').value);
  const minute = Number(parts.find((p) => p.type === 'minute').value);
  return hour * 60 + minute;
}

export function latestDate(candles, tz) {
  return dateForTimestamp(candles[candles.length - 1].time, tz);
}

export function filterDay(candles, date, tz) {
  return candles.filter((c) => dateForTimestamp(c.time, tz) === date);
}
