const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export const formatDate = (ms: number) => dateFmt.format(new Date(ms));
export const formatDateTime = (ms: number) => dateTimeFmt.format(new Date(ms));

export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, "0")}`;
}

export function formatRelativeDays(ms: number, now: number): string {
  const d = Math.ceil((ms - now) / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "in 1 day";
  return `in ${d} days`;
}

export function toDateInputValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
