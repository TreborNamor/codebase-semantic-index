export function formatMoney(amount: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {style: 'currency', currency}).format(amount);
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  const minutes = Math.round((timestamp - now) / 60000);
  return new Intl.RelativeTimeFormat(undefined, {numeric: 'auto'}).format(minutes, 'minute');
}

export function accessibleChartLabel(label: string, value: number, unit: string): string {
  // Supply a textual equivalent to visual chart marks for screen readers.
  return `${label}: ${value} ${unit}`;
}
