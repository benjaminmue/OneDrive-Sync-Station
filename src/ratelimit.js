// Failed sign-in throttling.
//
// The sign-in route is the one place an unauthenticated caller can make the
// station do expensive work (an scrypt hash). Without a limit, a script on the
// LAN can hammer it both to guess the password and to keep the station busy.
//
// Deliberately simple: an in-memory counter per client address, a lockout once
// a burst of failures accumulates, and a full reset on the first success. No
// storage, no cleanup thread, no dependency. It is a self-hosted station with a
// handful of users, not a public login page.

/** Failures tolerated before a client has to wait. */
const MAX_FAILURES = 8;

/** How long a client stays locked out once it exceeded the limit. */
const LOCKOUT_MS = 60_000;

/** How long a failure counts towards the limit. */
const FAILURE_WINDOW_MS = 15 * 60_000;

/** Upper bound on tracked clients, so a spoofed-address flood cannot grow the map without end. */
const MAX_TRACKED = 1000;

/** @type {Map<string, {failures: number, first: number, lockedUntil: number}>} */
const clients = new Map();

/**
 * Drop entries that are no longer relevant.
 * @param {number} now Current timestamp.
 * @returns {void}
 */
function prune(now) {
  for (const [key, entry] of clients) {
    if (entry.lockedUntil <= now && now - entry.first > FAILURE_WINDOW_MS) {
      clients.delete(key);
    }
  }
  // Under a flood of distinct addresses, forget the oldest entries rather than
  // growing without bound. Losing a counter only means an attacker gets their
  // allowance back, which is the same position as a fresh client.
  if (clients.size > MAX_TRACKED) {
    const excess = clients.size - MAX_TRACKED;
    let removed = 0;
    for (const key of clients.keys()) {
      clients.delete(key);
      if (++removed >= excess) break;
    }
  }
}

/**
 * Check whether a client may attempt a sign-in right now.
 * @param {string} key Client identity, usually the remote address.
 * @returns {{allowed: boolean, retryAfterSeconds: number}} Whether to proceed.
 */
export function check(key) {
  const now = Date.now();
  prune(now);
  const entry = clients.get(key);
  if (!entry || entry.lockedUntil <= now) return { allowed: true, retryAfterSeconds: 0 };
  return {
    allowed: false,
    retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000),
  };
}

/**
 * Record a failed attempt and lock the client out once it exceeds the limit.
 * @param {string} key Client identity.
 * @returns {void}
 */
export function recordFailure(key) {
  const now = Date.now();
  const entry = clients.get(key) ?? { failures: 0, first: now, lockedUntil: 0 };
  // Failures older than the window no longer count, so an occasional typo over
  // the course of a day never adds up to a lockout.
  if (now - entry.first > FAILURE_WINDOW_MS) {
    entry.failures = 0;
    entry.first = now;
  }
  entry.failures += 1;
  if (entry.failures >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCKOUT_MS;
    entry.failures = 0;
    entry.first = now;
  }
  clients.set(key, entry);
}

/**
 * Forget a client's failures after a successful sign-in.
 * @param {string} key Client identity.
 * @returns {void}
 */
export function recordSuccess(key) {
  clients.delete(key);
}

/**
 * Drop all state. Used by tests so one case cannot lock out the next.
 * @returns {void}
 */
export function reset() {
  clients.clear();
}
