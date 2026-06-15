/** Shared display helpers for the read-only dashboard detail views (#16). */
import type { CheckState } from "./api.ts";

/** Locale date+time, tolerant of an unparseable string. */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Humanise a millisecond span as `Xs`, `Xm`, or `Xh Ym`. */
export function fmtDuration(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Label + pill class for a check's current-state badge. */
export function stateBadge(state: CheckState): { label: string; cls: string } {
  switch (state) {
    case "ok":
      return { label: "Healthy", cls: "pill-ok" };
    case "failing":
      return { label: "Failing", cls: "pill-fail" };
    case "incident":
      return { label: "Incident", cls: "pill-fail" };
    default:
      return { label: "No data", cls: "pill-pending" };
  }
}
