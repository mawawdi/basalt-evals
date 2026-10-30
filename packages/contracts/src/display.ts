/** Display elapsed measurements only; never predict completion. */
export function elapsedDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60),
    remainder = seconds % 60;
  const parts = [];
  if (hours) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (minutes) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  if (remainder || !parts.length)
    parts.push(`${remainder} ${remainder === 1 ? "second" : "seconds"}`);
  return parts.join(" ");
}
export function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined) return "Not yet known";
  if (value > 0 && value < 0.0001) return "< $0.0001";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

/** The title of one stage of a staged evaluation, for example "Shop · Stage 2 of 3". */
export function stageTitle(title: string, stage: { index: number; count: number }) {
  return stage.count > 1 ? `${title} · Stage ${stage.index} of ${stage.count}` : title;
}
