// Web UI access control.
//
// The UI manages Microsoft sign-ins and can reach every synced file, so it is
// gated behind a password of its own. LAN-only by design; do not expose this to
// the internet without a reverse proxy that adds its own authentication.

import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { loadSettings, saveSettings } from "./config.js";

const SESSION_COOKIE = "odss_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * Hash a password with a fresh random salt.
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
 * @param {string} password Plain text candidate.
 * @param {string|null} stored Encoded hash produced by hashPassword.
 * @returns {boolean} True when the password matches.
 */
export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, salt, expected] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const derived = scryptSync(password, salt, 64);
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

// In-memory session store. A single container instance needs no shared store;
// sessions simply drop on restart and the user logs in again.
const sessions = new Set();

/**
 * Start a session and set the signed session cookie.
 * @param {import("fastify").FastifyReply} reply Reply to set the cookie on.
 * @returns {string} The new session id.
 */
export function createSession(reply) {
  const id = randomBytes(24).toString("hex");
  sessions.add(id);
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
  return unsigned.valid && unsigned.value ? sessions.has(unsigned.value) : false;
}

/**
 * Drop every active session. Used after a password reset so old browser
 * sessions cannot outlive the credentials they were created with.
 * @returns {void}
 */
export function destroyAllSessions() {
  sessions.clear();
}
