export function zonedToday(timezone: string, date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function isOverdue(dueDate: string | undefined, timezone: string): boolean {
  return Boolean(dueDate && dueDate < zonedToday(timezone));
}

export function dueSoon(dueDate: string | undefined, timezone: string): boolean {
  if (!dueDate) return false;
  const today = new Date(`${zonedToday(timezone)}T00:00:00`);
  const due = new Date(`${dueDate}T00:00:00`);
  const days = (due.getTime() - today.getTime()) / 86_400_000;
  return days >= 0 && days <= 2;
}

export function minutesUntilMidnight(timezone: string, now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0");
  const elapsed = get("hour") * 3600 + get("minute") * 60 + get("second");
  return Math.ceil((86400 - elapsed) / 60);
}
