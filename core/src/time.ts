const TZ = "Australia/Melbourne";

const parts = new Intl.DateTimeFormat("en-AU", {
  timeZone: TZ,
  hour: "numeric",
  minute: "2-digit",
  hourCycle: "h12",
});

/** "8:42 am" in Melbourne local time. Built from parts to avoid ICU's narrow no-break space. */
export function formatMelbourneTime(iso: string): string {
  const p = Object.fromEntries(parts.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute} ${String(p.dayPeriod).toLowerCase().replace(/\./g, "")}`;
}

/** Whole minutes until `iso`, floored, never negative. */
export function minutesAway(iso: string, nowMs: number): number {
  return Math.max(0, Math.floor((Date.parse(iso) - nowMs) / 60000));
}
