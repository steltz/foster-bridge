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

// en-CA locale formats as YYYY-MM-DD.
export function dateForTimestamp(unixSeconds, tz) {
  return formatterFor(tz).format(new Date(unixSeconds * 1000));
}

export function latestDate(candles, tz) {
  return dateForTimestamp(candles[candles.length - 1].time, tz);
}

export function filterDay(candles, date, tz) {
  return candles.filter((c) => dateForTimestamp(c.time, tz) === date);
}
