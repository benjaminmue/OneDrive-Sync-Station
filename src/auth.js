// Web UI access control.
//
// The UI manages Microsoft sign-ins and can reach every synced file, so it is
// gated behind a password of its own. LAN-only by design; do not expose this to
// the internet without a reverse proxy that adds its own authentication.

import { scrypt, scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { loadSettings, saveSettings } from "./config.js";

const scryptAsync = promisify(scrypt);

const SESSION_COOKIE = "odss_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;

/**
 * Hash a password with a fresh random salt.
 *
 * Synchronous by design: this runs on the two paths that set a password, both
 * of which are one-off actions, and doing it synchronously keeps the callers
 * simple. The hot path, verification, is asynchronous.
 *
 * @param {string} password Plain text password.
 * @returns {string} Encoded hash in the form `scrypt$<salt>$<derived>`.
 */
export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

/**
 * Verify a password against a stored hash in constant time.
 *
 * Asynchronous on purpose: scrypt is deliberately expensive, and the sign-in
 * route is reachable without a session. A synchronous hash there would let
 * anyone on the network stall the whole event loop, and with it every API call,
 * every log stream and the container health check, simply by posting passwords
 * in a loop.
 *
 * @param {string} password Plain text candidate.
 * @param {string|null} stored Encoded hash produced by hashPassword.
 * @returns {Promise<boolean>} True when the password matches.
 */
export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, salt, expected] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const derived = await scryptAsync(String(password ?? ""), salt, 64);
  const expectedBuf = Buffer.from(expected, "hex");
  if (derived.length !== expectedBuf.length) return false;
  return timingSafeEqual(derived, expectedBuf);
}

/**
 * Cookie signing secret, generated once and then persisted.
 * @returns {string} Hex secret.
 */
export function getCookieSecret() {
  const settings = loadSettings();
  if (settings.cookieSecret) return settings.cookieSecret;
  const secret = randomBytes(32).toString("hex");
  saveSettings({ cookieSecret: secret });
  return secret;
}

// In-memory session store, id to expiry timestamp. A single container instance
// needs no shared store; sessions simply drop on restart and the user signs in
// again. The expiry is tracked server side on purpose: the cookie's maxAge is
// only a hint to the browser, so without this a stolen cookie would stay valid
// until the container restarts.
/** @type {Map<string, number>} */
const sessions = new Map();

/**
 * Drop sessions whose expiry has passed.
 *
 * Called on every session check, which is cheap for the handful of sessions a
 * self-hosted station sees and keeps the map from growing without bound as
 * browsers come and go.
 * @returns {void}
 */
function pruneSessions() {
  const now = Date.now();
  for (const [id, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(id);
  }
}

/**
 * Start a session and set the signed session cookie.
 * @param {import("fastify").FastifyReply} reply Reply to set the cookie on.
 * @returns {string} The new session id.
 */
export function createSession(reply) {
  pruneSessions();
  const id = randomBytes(24).toString("hex");
  sessions.set(id, Date.now() + SESSION_MAX_AGE_MS);
  reply.setCookie(SESSION_COOKIE, id, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    signed: true,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return id;
}

/**
 * End the current session and clear the cookie.
 * @param {import("fastify").FastifyRequest} request Incoming request.
 * @param {import("fastify").FastifyReply} reply Reply to clear the cookie on.
 * @returns {void}
 */
export function destroySession(request, reply) {
  const raw = request.cookies[SESSION_COOKIE];
  if (raw) {
    const unsigned = reply.unsignCookie(raw);
    if (unsigned.valid && unsigned.value) sessions.delete(unsigned.value);
  }
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/**
 * Check whether the request carries a valid session.
 * @param {import("fastify").FastifyRequest} request Incoming request.
 * @param {import("fastify").FastifyReply} reply Reply used to unsign the cookie.
 * @returns {boolean} True when authenticated.
 */
export function isAuthed(request, reply) {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return false;
  const unsigned = reply.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return false;
  const expiresAt = sessions.get(unsigned.value);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    sessions.delete(unsigned.value);
    return false;
  }
  return true;
}

/**
 * Drop every active session. Used after a password reset so old browser
 * sessions cannot outlive the credentials they were created with.
 * @returns {void}
 */
export function destroyAllSessions() {
  sessions.clear();
}
