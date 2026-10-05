const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Binary sizes with Explorer-style labels, e.g. 1.4 GB. */
export function bytes(n: number, digits = 1): string {
  if (!n) return "0 B";
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(digits)} ${UNITS[i]}`;
}

export function count(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: n >= 100_000 ? "compact" : "standard" }).format(n);
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function ago(unixSecs: number | null | undefined): string {
  if (!unixSecs) return "unknown";
  const d = (unixSecs * 1000 - Date.now()) / 1000;
  const abs = Math.abs(d);
  if (abs < 3600) return rtf.format(Math.round(d / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(d / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(d / 86400), "day");
  if (abs < 86400 * 365) return rtf.format(Math.round(d / (86400 * 30)), "month");
  return rtf.format(Math.round(d / (86400 * 365)), "year");
}

export function daysSince(unixSecs: number | null | undefined): number {
  if (!unixSecs) return Infinity;
  return (Date.now() / 1000 - unixSecs) / 86400;
}

/** Shortens a path to its last few segments, keeping the root visible. */
export function shortPath(p: string, keep = 3): string {
  const sep = p.includes("\\") ? "\\" : "/";
  const parts = p.split(sep).filter(Boolean);
  if (parts.length <= keep + 1) return p;
  return `${parts[0]}${sep}…${sep}${parts.slice(-keep).join(sep)}`;
}

export function relativeTo(p: string, base: string | null): string {
  if (!base || !p.toLowerCase().startsWith(base.toLowerCase())) return p;
  return p.slice(base.length).replace(/^[\\/]/, "") || ".";
}

export function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}
