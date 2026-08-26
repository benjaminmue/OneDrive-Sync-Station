// HTTP layer: every route of the station.
//
// Kept separate from server.js so tests can build the app and drive it through
// fastify's inject() without opening a port or starting any sync client.
//
// Route conventions:
//   - every /api route except the four public ones requires a session
//   - the `:id` parameter is resolved through instances.requireInstance(), which
//     validates the slug before it is ever used as a directory name
//   - validation failures surface as 400 with the offending field, so the UI can
//     point at the control that needs fixing

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCookie from "@fastify/cookie";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

import { DATA_DIR, loadSettings, saveSettings } from "./config.js";
import {
  hashPassword,
  verifyPassword,
  getCookieSecret,
  createSession,
  destroySession,
  destroyAllSessions,
  isAuthed,
} from "./auth.js";
import * as instances from "./instances.js";
import * as supervisor from "./supervisor.js";
import * as onedrive from "./onedrive.js";
import * as authflow from "./authflow.js";
import * as synclist from "./synclist.js";
import * as validate from "./validate.js";
import { ValidationError } from "./validate.js";
import { log } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

/** Routes reachable without a session. Everything else is gated. */
const PUBLIC_ROUTES = new Set(["/api/health", "/api/state", "/api/setup-password", "/api/login"]);

/**
 * Build the Fastify application with all routes registered.
 * @returns {Promise<import("fastify").FastifyInstance>} The ready application.
 */
export async function createApp() {
  const app = Fastify({ logger: false, trustProxy: true });

  // Tolerate body-less POSTs that still send `Content-Type: application/json`
  // (fetch does this): an empty body parses to {} instead of a 400.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (!body || !body.trim()) return done(null, {});
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      err.statusCode = 400;
      done(err);
    }
  });

  await app.register(fastifyCookie, { secret: getCookieSecret() });
  await app.register(fastifyStatic, { root: join(__dirname, "..", "public"), prefix: "/" });

  // Validation failures are user input problems, not server faults: report them
  // as 400 with the offending field. Anything else is logged and reduced to a
  // generic message so internals never reach the browser.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ValidationError) {
      return reply.code(400).send({ error: error.reason, field: error.field });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    log.error("request failed", { url: request.url, err: error.message });
    return reply.code(500).send({ error: "internal-error" });
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    const path = request.url.split("?")[0];
    if (PUBLIC_ROUTES.has(path)) return;
    if (!isAuthed(request, reply)) reply.code(401).send({ error: "unauthorized" });
  });

  /**
   * Resolve the `:id` route parameter to an instance record.
   * @param {import("fastify").FastifyRequest} request Incoming request.
   * @returns {object} The instance record.
   * @throws {ValidationError} When the id is invalid or unknown.
   */
  const instanceFromRequest = (request) => instances.requireInstance(request.params.id);

  // --- Public ---------------------------------------------------------------

  app.get("/api/health", async () => ({ status: "ok", version: pkg.version }));

  app.get("/api/state", async (request, reply) => {
    const settings = loadSettings();
    const authed = isAuthed(request, reply);
    const client = await onedrive.version();
    return {
      version: pkg.version,
      clientVersion: client.ok ? client.text.split("\n")[0] : null,
      dataDir: DATA_DIR,
      setupNeeded: !settings.guiPasswordHash,
      authed,
      instanceCount: authed ? instances.listInstances().length : undefined,
    };
  });

  app.post("/api/setup-password", async (request, reply) => {
    if (loadSettings().guiPasswordHash) {
      return reply.code(409).send({ error: "already-configured" });
    }
    const password = validate.password(request.body?.password);
    saveSettings({ guiPasswordHash: hashPassword(password) });
    createSession(reply);
    log.info("web ui password set");
    return { ok: true };
  });

  app.post("/api/login", async (request, reply) => {
    const settings = loadSettings();
    if (!verifyPassword(String(request.body?.password ?? ""), settings.guiPasswordHash)) {
      return reply.code(401).send({ error: "invalid-password" });
    }
    createSession(reply);
    return { ok: true };
  });

  // --- Session --------------------------------------------------------------

  app.post("/api/logout", async (request, reply) => {
    destroySession(request, reply);
    return { ok: true };
  });

  app.post("/api/change-password", async (request, reply) => {
    const settings = loadSettings();
    if (!verifyPassword(String(request.body?.currentPassword ?? ""), settings.guiPasswordHash)) {
      return reply.code(401).send({ error: "invalid-password" });
    }
    const next = validate.password(request.body?.newPassword);
    saveSettings({ guiPasswordHash: hashPassword(next) });
    // Every other session was created with the old password; drop them all and
    // keep only the one that just proved knowledge of the new one.
    destroyAllSessions();
    createSession(reply);
    return { ok: true };
  });

  // --- Instances ------------------------------------------------------------

  app.get("/api/instances", async () =>
    instances.listInstances().map((instance) => ({
      ...instances.describeInstance(instance),
      runtime: supervisor.status(instance.id),
    }))
  );

  app.post("/api/instances", async (request) => {
    const instance = instances.createInstance(request.body || {});
    log.info("instance created", { instance: instance.id, type: instance.type });
    return instances.describeInstance(instance);
  });

  app.get("/api/instances/:id", async (request) => {
    const instance = instanceFromRequest(request);
    return {
      ...instances.describeInstance(instance),
      runtime: supervisor.status(instance.id),
      signInPending: authflow.isPending(instance.id),
    };
  });

  app.patch("/api/instances/:id", async (request) => {
    const instance = instanceFromRequest(request);
    const updated = instances.updateInstance(instance.id, request.body || {});
    // Option changes only reach a running client on restart, so a running
    // instance is cycled to keep the UI and the running client in agreement.
    if (supervisor.status(updated.id).running) supervisor.restart(updated);
    return instances.describeInstance(updated);
  });

  app.delete("/api/instances/:id", async (request) => {
    const instance = instanceFromRequest(request);
    authflow.cancel(instance.id);
    supervisor.stop(instance.id);
    supervisor.forget(instance.id);
    instances.deleteInstance(instance.id, {
      deleteData: validate.boolean(request.query?.deleteData),
    });
    log.info("instance deleted", { instance: instance.id });
    return { ok: true };
  });

  // --- Sign-in --------------------------------------------------------------

  app.post("/api/instances/:id/signin/begin", async (request) => {
    const instance = instanceFromRequest(request);
    // A running monitor holds the same config directory; letting a second client
    // authorise into it at the same time would race over the token files.
    supervisor.stop(instance.id);
    return authflow.begin(instance);
  });

  app.post("/api/instances/:id/signin/complete", async (request) => {
    const instance = instanceFromRequest(request);
    const result = await authflow.complete(instance, request.body?.responseUrl);
    const authenticated = instances.isAuthenticated(instance);
    if (authenticated && instance.autoStart) supervisor.start(instance);
    return { ...result, authenticated };
  });

  app.post("/api/instances/:id/signin/cancel", async (request) => {
    const instance = instanceFromRequest(request);
    authflow.cancel(instance.id);
    return { ok: true };
  });

  app.post("/api/instances/:id/signout", async (request) => {
    const instance = instanceFromRequest(request);
    supervisor.stop(instance.id);
    const result = await onedrive.logout(instance);
    return { ...result, authenticated: instances.isAuthenticated(instance) };
  });

  // --- Sync control ---------------------------------------------------------

  app.post("/api/instances/:id/start", async (request, reply) => {
    const instance = instanceFromRequest(request);
    if (!instances.isAuthenticated(instance)) {
      return reply.code(409).send({ error: "not-authenticated" });
    }
    supervisor.start(instance);
    return supervisor.status(instance.id);
  });

  app.post("/api/instances/:id/stop", async (request) => {
    const instance = instanceFromRequest(request);
    supervisor.stop(instance.id);
    return supervisor.status(instance.id);
  });

  app.post("/api/instances/:id/restart", async (request, reply) => {
    const instance = instanceFromRequest(request);
    if (!instances.isAuthenticated(instance)) {
      return reply.code(409).send({ error: "not-authenticated" });
    }
    supervisor.restart(instance, { resync: validate.boolean(request.body?.resync) });
    return supervisor.status(instance.id);
  });

  app.get("/api/instances/:id/logs", async (request) => {
    const instance = instanceFromRequest(request);
    return { lines: supervisor.logs(instance.id) };
  });

  // --- Diagnostics ----------------------------------------------------------

  app.get("/api/instances/:id/status", async (request) =>
    onedrive.displaySyncStatus(instanceFromRequest(request))
  );

  app.get("/api/instances/:id/quota", async (request) =>
    onedrive.displayQuota(instanceFromRequest(request))
  );

  app.get("/api/instances/:id/config", async (request) =>
    onedrive.displayConfig(instanceFromRequest(request))
  );

  app.get("/api/instances/:id/admin-consent-url", async (request) =>
    onedrive.displayAdminConsentUrl(instanceFromRequest(request))
  );

  app.post("/api/instances/:id/dry-run", async (request) =>
    onedrive.dryRun(instanceFromRequest(request))
  );

  // --- sync_list ------------------------------------------------------------

  app.get("/api/instances/:id/synclist", async (request) =>
    synclist.read(instanceFromRequest(request))
  );

  app.put("/api/instances/:id/synclist", async (request) => {
    const instance = instanceFromRequest(request);
    const stored = synclist.write(instance, request.body?.text ?? "");
    // The client only picks up a changed selection after a full resync. Without
    // it the UI would show a rule set the running client is not applying.
    const running = supervisor.status(instance.id).running;
    if (running) supervisor.restart(instance, { resync: true });
    return { ...stored, resyncTriggered: running };
  });

  // --- SharePoint lookup ----------------------------------------------------

  app.post("/api/sharepoint/lookup", async (request, reply) => {
    // The lookup runs as an account that can see the site, so it borrows an
    // instance that is already signed in. Business accounts are the usual source.
    const instance = instances.requireInstance(request.body?.instanceId);
    if (!instances.isAuthenticated(instance)) {
      return reply.code(409).send({ error: "not-authenticated" });
    }
    const site = validate.remotePath(request.body?.site, "site");
    return onedrive.getSharePointDriveId(instance, site);
  });

  // --- Live updates ---------------------------------------------------------

  app.get("/api/events", async (request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // keep reverse proxies from buffering the stream
    });

    const send = (event, payload) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const onLog = (payload) => send("log", payload);
    const onState = (payload) => send("state", payload);
    supervisor.events.on("log", onLog);
    supervisor.events.on("state", onState);

    // Proxies drop idle connections; a comment line keeps the stream warm
    // without showing up as an event in the browser.
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      supervisor.events.off("log", onLog);
      supervisor.events.off("state", onState);
    });
  });

  return app;
}
