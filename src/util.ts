export const DAY_MS = 24 * 60 * 60 * 1000;

interface Page<T> {
  items: T[] | undefined;
  next: string | undefined;
}

/** Follows next-page tokens until AWS stops returning one. */
export async function collect<T>(fetchPage: (token: string | undefined) => Promise<Page<T>>): Promise<T[]> {
  const all: T[] = [];
  let token: string | undefined;
  do {
    const page = await fetchPage(token);
    all.push(...(page.items ?? []));
    token = page.next;
  } while (token);
  return all;
}

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

export function isoDate(date: Date | undefined): string {
  return date ? date.toISOString().slice(0, 10) : "an unknown date";
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${shown} ${units[unit]}`;
}

/** Runs tasks with at most `limit` in flight, keeping results in input order. */
export async function pool<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** A short reason for a failed AWS call, such as "AccessDenied: User is not authorized...". */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const message = err.message.split("\n")[0] ?? "";
    const short = message.length > 140 ? `${message.slice(0, 137)}...` : message;
    return err.name && err.name !== "Error" ? `${err.name}: ${short}` : short;
  }
  return String(err);
}
