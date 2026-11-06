import "server-only";

// The connector has no sign-in, so these are what stop one anonymous caller from filling a shop's
// calendar with unpaid holds or its dashboard with made-up demand. Counts live in this process, which
// is enough for the one web instance, since a restart only starts a new window. They are per address,
// and an assistant's connector calls come from its provider, so limits are set well above what one
// conversation needs.

export const LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_NEW_HOLDS = 20;
export const MAX_RECORDED_SEARCHES = 60;
const MAX_CALLERS = 10_000;

export type CallerLimits = {
  newHold: () => boolean;
  recordSearch: () => boolean;
};

// Answers whether a caller may do one more. Everyone's count ends together when a window ends, and a
// flood of made-up callers ends it early, so memory stays bounded and no real caller is locked out.
export function createCallerCounter(
  max: number,
  now: () => number = Date.now,
  maxCallers: number = MAX_CALLERS,
): (caller: string) => boolean {
  const counts = new Map<string, number>();
  let windowStart = now();
  return (caller) => {
    const at = now();
    if (at - windowStart >= LIMIT_WINDOW_MS || (counts.size >= maxCallers && !counts.has(caller))) {
      counts.clear();
      windowStart = at;
    }
    const used = counts.get(caller) ?? 0;
    if (used >= max) {
      return false;
    }
    counts.set(caller, used + 1);
    return true;
  };
}

const newHolds = createCallerCounter(MAX_NEW_HOLDS);
const recordedSearches = createCallerCounter(MAX_RECORDED_SEARCHES);

export function limitsFor(caller: string): CallerLimits {
  return {
    newHold: () => newHolds(caller),
    recordSearch: () => recordedSearches(caller),
  };
}

// The edge's own headers replace anything a client sent. x-forwarded-for keeps a client's value at
// the front, so it is only the fallback, and a client that forges it escapes these limits.
export function callerOf(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("true-client-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}
