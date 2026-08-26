// OneDrive Sync Station web UI.
//
// Dependency free by design: the container ships this file as-is, so there is
// no build step, no framework and no external request. The UI is a set of
// small render functions over the JSON API plus a server-sent event stream.
//
// Security rule that everything below follows: any value that comes from the
// API (account names, paths, client output, log lines, error text) is inserted
// with textContent or element properties, never as HTML. innerHTML is not used
// at all.
//
// Rendering model: each account is a card with two regions. The summary region
// (name, status, action buttons) is cheap and rebuilt on every refresh. The
// panels region (sign-in flow, log tail, folder editor, tools) is stateful -
// it holds focus, drafts and scroll positions, and is therefore never touched
// by a refresh. That is what keeps a live state event from wiping a half-typed
// sign-in URL.

"use strict";

// --- Strings ----------------------------------------------------------------

/**
 * Every user-facing string, keyed by dotted id. This is the translation seam:
 * add a second table and switch `strings` to it, nothing else changes.
 * `{name}` style placeholders are filled by t().
 */
export const en = {
  "app.title": "OneDrive Sync Station",
  "app.skipToContent": "Skip to content",
  "app.metaClient": "client {version}",
  "app.unreachable": "Could not reach the station: {error}",
  "app.live": "live",
  "app.reconnecting": "reconnecting…",

  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.working": "Working…",

  "setup.title": "Set a web UI password",
  "setup.hint":
    "This UI can sign in to Microsoft accounts and reaches every synced file, " +
    "so it is password protected. At least 8 characters.",
  "setup.password": "Password",
  "setup.repeat": "Repeat password",
  "setup.submit": "Save password",
  "setup.mismatch": "The two passwords do not match.",
  "setup.tooShort": "The password must be at least 8 characters long.",

  "login.title": "Sign in",
  "login.password": "Password",
  "login.submit": "Sign in",
  "login.wrongPassword": "Wrong password.",

  "accounts.title": "Accounts",
  "accounts.add": "Add account",
  "accounts.countOne": "1 account · data in {dir}",
  "accounts.countMany": "{n} accounts · data in {dir}",

  "empty.title": "No accounts yet",
  "empty.intro":
    "An account is one OneDrive Personal, one OneDrive Business or one SharePoint " +
    "document library. Each gets its own folder below the data volume and syncs " +
    "independently. Three steps:",
  "empty.step1Title": "Add the account.",
  "empty.step1Text": "A display name and the type are enough.",
  "empty.step2Title": "Sign in to Microsoft.",
  "empty.step2Text":
    "The station shows a Microsoft link. You sign in on Microsoft's own pages and " +
    "paste one URL back, your password never touches this UI.",
  "empty.step3Title": "Watch it sync.",
  "empty.step3Text":
    "Syncing starts on its own. The log streams live, and the Folders editor " +
    "limits what is synced if you do not want everything.",
  "empty.add": "Add your first account",

  "type.personal": "Personal",
  "type.business": "Business",
  "type.sharepoint": "SharePoint",
  "type.personalLong": "OneDrive Personal",
  "type.businessLong": "OneDrive Business",
  "type.sharepointLong": "SharePoint library",

  "status.notSignedIn": "Not signed in",
  "status.running": "Running",
  "status.starting": "Starting…",
  "status.retrying": "Failing",
  "status.stopped": "Stopped",
  "status.up": "up {duration}",
  "status.resyncQueued": "resync queued",
  "status.exitCode": "exit code {code}",
  "status.exitSignal": "signal {signal}",
  "account.failingAlert":
    "The sync client keeps exiting right after start ({n} attempts, last {exit}). " +
    "It is retried automatically with increasing delay, check the log.",
  "account.stoppedAfterExit": "Last run ended with {exit}. Check the log before starting again.",

  "action.start": "Start",
  "action.stop": "Stop",
  "action.signIn": "Sign in",
  "action.logs": "Log",
  "action.folders": "Folders",
  "action.tools": "Tools",

  "signin.title": "Sign in to Microsoft",
  "signin.preparing": "Preparing the sign-in…",
  "signin.step1Title": "Open the Microsoft sign-in page.",
  "signin.step1Text":
    "Sign in with the account you want to sync and accept the requested permissions.",
  "signin.open": "Open Microsoft sign-in",
  "signin.copy": "Copy link",
  "signin.copied": "Link copied to the clipboard.",
  "signin.step2Title": "You will land on a blank page, and that is expected.",
  "signin.step2Text":
    "After the sign-in, Microsoft redirects your browser to an empty white page. " +
    "Nothing went wrong: the address of that blank page carries your authorisation " +
    "code, and that address is all the station needs.",
  "signin.step3Title": "Paste the address of that blank page here.",
  "signin.step3Text":
    "Copy the full URL from the browser's address bar. It starts with " +
    "https://login.microsoftonline.com/… and contains code=…",
  "signin.pastePlaceholder": "https://login.microsoftonline.com/common/oauth2/nativeclient?code=…",
  "signin.connect": "Connect",
  "signin.success": "{name} is signed in.",
  "signin.clientRejected": "Microsoft accepted the URL, but the sync client rejected it:",
  "signin.failed": "Sign-in failed: {error}",

  "logs.title": "Log",
  "logs.hint": "Streams live while the sync client runs. Scroll up to pause following.",
  "logs.empty": "No log lines yet.",
  "logs.jump": "Jump to latest",
  "logs.label": "Log of {name}",

  "folders.title": "Folder selection (sync_list)",
  "folders.rule1": "One rule per line. Lines starting with # are comments.",
  "folders.rule2": "Exclusions start with ! and must come first, they win over inclusions.",
  "folders.rule3":
    "A leading / anchors a rule to the root of the drive. Without it, the rule " +
    "matches anywhere in the tree, which is much slower to evaluate.",
  "folders.rule4": "An empty list syncs everything.",
  "folders.example": "Example:",
  "folders.warn":
    "Saving restarts this account with --resync, which the client requires after " +
    "every change. That re-reads the account state from Microsoft, it does not " +
    "delete local files.",
  "folders.save": "Save and resync",
  "folders.dryRun": "Dry run",
  "folders.dryRunHint": "Preview what the current rules would sync, without changing anything.",
  "folders.savedResync": "Selection saved. The account is restarting with a resync.",
  "folders.savedIdle": "Selection saved. It takes effect on the next start.",
  "folders.editorLabel": "sync_list rules for {name}",

  "tools.title": "Tools",
  "tools.diagnostics": "Diagnostics",
  "tools.diagnosticsHint": "Read-only queries answered by the sync client.",
  "tools.status": "Sync status",
  "tools.quota": "Quota",
  "tools.config": "Show config",
  "tools.consent": "Admin consent URL",
  "tools.consentHint":
    "For tenants where an administrator must approve the application first. Send " +
    "the URL below to your administrator.",
  "tools.running": "Running…",
  "tools.noOutput": "(no output)",
  "tools.maintenance": "Maintenance",
  "tools.autoStart": "Start automatically after sign-in and when the container starts",
  "tools.autoStartSaved": "Auto-start updated.",
  "tools.resync": "Resync now",
  "tools.resyncHint":
    "Restarts the client with --resync: the account state is re-read from " +
    "Microsoft. Local files are not deleted.",
  "tools.danger": "Danger zone",
  "tools.signOut": "Sign out from Microsoft",
  "tools.signOutConfirm":
    'Sign "{name}" out from Microsoft?\n\nSyncing stops and the stored sign-in is ' +
    "removed. Synced files stay on disk. You can sign in again at any time.",
  "tools.signedOut": "{name} was signed out from Microsoft.",
  "tools.delete": "Delete account…",
  "tools.deleteTitle": 'Delete "{name}"?',
  "tools.deleteText":
    "The account is removed from the station: its sign-in, settings and folder " +
    "selection are deleted. This cannot be undone.",
  "tools.deleteData": "Also delete the synced files in {path}",
  "tools.deleteConfirm": "Delete account",
  "tools.deleteConfirmWithData": "Delete account and files",
  "tools.deleted": "{name} was deleted.",

  "add.title": "Add an account",
  "add.hint":
    "Each account gets its own folder below the data volume and its own sign-in. " +
    "A SharePoint document library counts as an account of its own.",
  "add.name": "Display name",
  "add.namePlaceholder": "Work business",
  "add.type": "Type",
  "add.driveId": "Drive ID",
  "add.submit": "Create account",
  "add.created": "Account created. Next: sign in to Microsoft.",

  "lookup.title": "Find the drive ID",
  "lookup.hint":
    "Queries the document libraries of a site with the credentials of an account " +
    "that is already signed in, usually a business account of the same tenant. " +
    "Click a result to fill in its drive ID.",
  "lookup.source": "Signed-in account",
  "lookup.site": "Site name or URL",
  "lookup.sitePlaceholder": "Marketing",
  "lookup.run": "Look up",
  "lookup.none": "No signed-in account yet, sign in with a business account first.",
  "lookup.foundOne": "Found 1 document library:",
  "lookup.foundMany": "Found {n} document libraries:",
  "lookup.raw": "No drive ID recognised, the raw client output is shown below.",
  "lookup.use": "Use",
  "lookup.filled": "Drive ID filled in.",

  "session.title": "Web UI session",
  "session.changePassword": "Change the web UI password",
  "session.currentPassword": "Current password",
  "session.newPassword": "New password",
  "session.repeatPassword": "Repeat new password",
  "session.changeSubmit": "Change password",
  "session.changed": "Password changed. All other sessions were signed out.",
  "session.logout": "Sign out of the web UI",

  // API reason codes, mapped to sentences a person can act on. Unknown codes
  // fall back to errors.generic with the raw code, so nothing is ever silent.
  "errors.generic": "Request failed ({code}).",
  "errors.fieldPrefix": "{field}: {message}",
  "errors.sessionExpired": "Your session expired. Sign in again.",
  "errors.unauthorized": "Your session expired. Sign in again.",
  "errors.invalid-password": "Wrong password.",
  "errors.not-authenticated": "This account is not signed in to Microsoft yet.",
  "errors.already-configured": "A password is already configured.",
  "errors.already-exists": "An account with this name already exists.",
  "errors.required": "This field is required.",
  "errors.required-for-sharepoint": "A SharePoint library needs a drive ID.",
  "errors.invalid-length": "This value is too short or too long.",
  "errors.invalid-characters": "This value contains characters that are not allowed.",
  "errors.invalid-type": "Unknown account type.",
  "errors.unknown-instance": "This account no longer exists.",
  "errors.not-a-url": "That is not a URL. Paste the full address from the address bar.",
  "errors.invalid-scheme": "The pasted URL must start with http:// or https://.",
  "errors.unexpected-host":
    "That URL does not look like the Microsoft redirect. Paste the address of the " +
    "blank page you landed on after signing in, not the sign-in link itself.",
  "errors.missing-code":
    "The pasted URL carries no authorisation code. Make sure to copy the address " +
    "after signing in, not before.",
  "errors.no-pending-sign-in": "This sign-in attempt expired. Start it again.",
  "errors.too-large": "The rule list is too large.",
  "errors.too-many-lines": "The rule list has too many lines.",
  "errors.internal-error": "The station hit an internal error. Check the container log.",

  // Field names for errors.fieldPrefix.
  "fields.name": "Display name",
  "fields.driveId": "Drive ID",
  "fields.password": "Password",
  "fields.responseUrl": "Pasted URL",
  "fields.syncList": "Rule list",
  "fields.site": "Site",
};

/** The active string table. Swap this reference to translate the UI. */
const strings = en;

/**
 * Look up a user-facing string and fill `{placeholder}` slots.
 * @param {string} key Dotted string id.
 * @param {Record<string, string|number>} [params] Placeholder values.
 * @returns {string} The resolved string, or the key itself when missing so a
 *   forgotten entry is visible instead of blank.
 */
function t(key, params = {}) {
  let text = strings[key];
  if (text === undefined) return key;
  for (const [name, value] of Object.entries(params)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

/** Apply the string table to the static markup (data-i18n* attributes). */
function applyStaticStrings() {
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll("[data-i18n-placeholder]")) {
    node.setAttribute("placeholder", t(node.dataset.i18nPlaceholder));
  }
}

// --- DOM helpers ------------------------------------------------------------

const $ = (id) => document.getElementById(id);

/**
 * Build an element. Text always goes through textContent, so callers cannot
 * accidentally inject markup.
 * @param {string} tag Tag name.
 * @param {{text?: string, className?: string, attrs?: Record<string, string>}} [opts] Options.
 * @param {...(Node|null|undefined)} children Child nodes; null/undefined are skipped.
 * @returns {HTMLElement} The new element.
 */
function el(tag, opts = {}, ...children) {
  const node = document.createElement(tag);
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.className) node.className = opts.className;
  for (const [key, value] of Object.entries(opts.attrs || {})) node.setAttribute(key, value);
  for (const child of children) if (child) node.append(child);
  return node;
}

/**
 * Build a button with a click handler that disables the button while the
 * (possibly async) handler runs and surfaces failures as a toast. Used for
 * every one-shot action so no action can be double-fired.
 * @param {string} label Button label.
 * @param {string} className Extra class names.
 * @param {() => (void|Promise<void>)} handler Click handler.
 * @returns {HTMLButtonElement} The button.
 */
function actionButton(label, className, handler) {
  const button = el("button", { text: label, className, attrs: { type: "button" } });
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await handler();
    } catch (err) {
      toast("err", describeError(err));
    } finally {
      // The button may have been removed by a re-render meanwhile; that is fine.
      button.disabled = false;
    }
  });
  return button;
}

/**
 * Show or update an inline message paragraph.
 * @param {HTMLElement} node The .msg element.
 * @param {"ok"|"err"|"info"} kind Visual style.
 * @param {string} text Message text.
 */
function setMsg(node, kind, text) {
  node.className = `msg ${kind}`;
  node.textContent = text;
  node.hidden = false;
}

/** Hide an inline message paragraph. */
function clearMsg(node) {
  node.hidden = true;
  node.textContent = "";
}

/** @returns {boolean} Whether the user prefers reduced motion. */
function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// --- Toasts -----------------------------------------------------------------

/**
 * Show a transient status message in the corner. The container is an
 * aria-live region, so screen readers announce it too.
 * @param {"ok"|"err"|"info"} kind Visual style.
 * @param {string} text Message text.
 */
function toast(kind, text) {
  const container = $("toasts");
  // Keep the stack short; the oldest message is the least interesting one.
  while (container.children.length >= 4) container.firstChild.remove();
  const node = el("div", { text, className: `toast ${kind}`, attrs: { role: "status" } });
  node.addEventListener("click", () => node.remove());
  container.append(node);
  setTimeout(() => node.remove(), kind === "err" ? 9000 : 6000);
}

// --- API helper -------------------------------------------------------------

/**
 * Call the JSON API.
 * @param {string} path API path.
 * @param {{method?: string, body?: object}} [opts] Request options.
 * @returns {Promise<object>} Parsed response body.
 * @throws {Error} With the API reason code as message on a non-2xx response;
 *   `field` and `status` are attached for the callers that need them.
 */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `http-${res.status}`);
    err.field = data.field;
    err.status = res.status;
    // A 401 outside the login form means the session cookie died. Send the
    // user back to the login view instead of failing every action silently.
    if (res.status === 401 && path !== "/api/login") {
      showView("login");
      toast("err", t("errors.sessionExpired"));
    }
    throw err;
  }
  return data;
}

/**
 * Turn an API error into a sentence, using the reason-code table and the
 * offending field when the server names one.
 * @param {Error & {field?: string}} err Error thrown by api().
 * @returns {string} Human readable message.
 */
function describeError(err) {
  const mapped = strings[`errors.${err.message}`];
  const message = mapped !== undefined ? mapped : t("errors.generic", { code: err.message });
  const fieldName = err.field ? strings[`fields.${err.field}`] : undefined;
  // Only prefix the field when it adds information the sentence lacks.
  if (fieldName && !["responseUrl", "password"].includes(err.field)) {
    return t("errors.fieldPrefix", { field: fieldName, message });
  }
  return message;
}

// --- Views ------------------------------------------------------------------

/**
 * Show exactly one of the three top level views and keep the event stream in
 * step: it only makes sense (and only authenticates) in the main view.
 * @param {"setup"|"login"|"main"} name View to show.
 */
function showView(name) {
  for (const view of ["setup", "login", "main"]) {
    $(`view-${view}`).hidden = view !== name;
  }
  if (name === "main") {
    startEventStream();
  } else {
    stopEventStream();
  }
  // Put the cursor where the next keystroke belongs.
  if (name === "login") $("login-password").focus();
  if (name === "setup") $("setup-password").focus();
}

/** The station-wide data directory, from /api/state, for display purposes. */
let dataDir = "";

/** Load the station state and render the matching view. */
async function refreshState() {
  const state = await api("/api/state");
  dataDir = state.dataDir || "";
  const parts = [`v${state.version}`];
  if (state.clientVersion) parts.push(t("app.metaClient", { version: state.clientVersion }));
  $("meta").textContent = parts.join(" · ");

  if (state.setupNeeded) return showView("setup");
  if (!state.authed) return showView("login");
  showView("main");
  await refreshInstances();
}

// --- Account model and card registry ---------------------------------------

/** Latest instance records from the API, keyed by id. Panel handlers read from
 * here so they always act on current data even though panels are not re-built. */
const model = new Map();

/**
 * Rendered cards, keyed by instance id.
 * @type {Map<string, {root: HTMLElement, summary: HTMLElement, panels: HTMLElement, open: string|null}>}
 */
const cards = new Map();

/** Guard against overlapping refreshes: the last one wins. */
let refreshSeq = 0;

/** Reload the instance list and reconcile the cards with it. */
async function refreshInstances() {
  const seq = ++refreshSeq;
  const list = await api("/api/instances");
  if (seq !== refreshSeq) return; // a newer refresh already landed

  for (const instance of list) model.set(instance.id, instance);

  const container = $("instances");
  $("empty-state").hidden = list.length > 0;
  $("accounts-count").textContent = list.length
    ? t(list.length === 1 ? "accounts.countOne" : "accounts.countMany", {
        n: list.length,
        dir: dataDir,
      })
    : "";

  // Reconcile: create/update cards in list order, drop the ones that vanished.
  const seen = new Set();
  list.forEach((instance, index) => {
    seen.add(instance.id);
    let card = cards.get(instance.id);
    if (!card) {
      card = createCard(instance.id);
      cards.set(instance.id, card);
    }
    updateSummary(card, instance);
    // Only move nodes when the order actually changed: re-inserting an element
    // that contains the focused input would blur it.
    if (container.children[index] !== card.root) {
      container.insertBefore(card.root, container.children[index] || null);
    }
  });
  for (const [id, card] of cards) {
    if (!seen.has(id)) {
      card.root.remove();
      cards.delete(id);
      model.delete(id);
    }
  }

  fillLookupSources(list);
}

/** Debounced refresh for SSE state events, which arrive in bursts. */
let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshInstances().catch(() => {}), 150);
}

/**
 * Create the persistent shell of an account card. The summary region is filled
 * by updateSummary(); the panels region belongs to the panel functions.
 * @param {string} id Instance id.
 * @returns {{root: HTMLElement, summary: HTMLElement, panels: HTMLElement, open: string|null}} Card handle.
 */
function createCard(id) {
  const summary = el("div", { className: "acc-summary" });
  const panels = el("div", { className: "acc-panels", attrs: { id: `panels-${id}` } });
  const root = el("article", { className: "account", attrs: { "data-id": id } }, summary, panels);
  return { root, summary, panels, open: null };
}

// --- Status derivation ------------------------------------------------------

/**
 * Format a duration for the status pill.
 * @param {number} ms Milliseconds.
 * @returns {string} A short duration like "5 min" or "3 h".
 */
function formatDuration(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return "<1 min";
  if (min < 120) return `${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/**
 * Describe how the last client run ended.
 * @param {{code: number|null, signal: string|null}|null} lastExit Exit info.
 * @returns {string} e.g. "exit code 1" or "signal SIGKILL".
 */
function formatExit(lastExit) {
  if (!lastExit) return t("status.exitCode", { code: "?" });
  if (lastExit.code !== null && lastExit.code !== undefined) {
    return t("status.exitCode", { code: lastExit.code });
  }
  return t("status.exitSignal", { signal: lastExit.signal || "?" });
}

/**
 * Derive the at-a-glance state of an instance: the pill and, when something is
 * wrong, an alert line that is visible without opening anything.
 * @param {object} instance Instance as returned by the API.
 * @returns {{cls: string, label: string, alert: string|null}} Display state.
 */
function statusFor(instance) {
  const rt = instance.runtime;
  if (!instance.authenticated) {
    return { cls: "warn", label: t("status.notSignedIn"), alert: null };
  }
  if (rt.running) {
    const up = formatDuration(Date.now() - rt.startedAt);
    return {
      cls: "ok",
      label: `${t("status.running")} · ${t("status.up", { duration: up })}`,
      alert: null,
    };
  }
  if (rt.wantRunning && rt.failures > 0) {
    return {
      cls: "err",
      label: t("status.retrying"),
      alert: t("account.failingAlert", { n: rt.failures, exit: formatExit(rt.lastExit) }),
    };
  }
  if (rt.wantRunning) {
    return { cls: "info", label: t("status.starting"), alert: null };
  }
  // Stopped. A non-zero exit code deserves a visible note: the user may not
  // know why syncing ended. Signal exits are excluded because a manual stop
  // terminates the client with a signal, which is not an error.
  const crashed = rt.lastExit && typeof rt.lastExit.code === "number" && rt.lastExit.code !== 0;
  return {
    cls: "neutral",
    label: t("status.stopped"),
    alert: crashed ? t("account.stoppedAfterExit", { exit: formatExit(rt.lastExit) }) : null,
  };
}

// --- Card summary -----------------------------------------------------------

/**
 * Rebuild the summary region of a card from the latest instance record.
 * Never touches the panels region (see the rendering model note on top).
 * @param {{root: HTMLElement, summary: HTMLElement, open: string|null}} card Card handle.
 * @param {object} instance Instance record.
 */
function updateSummary(card, instance) {
  const status = statusFor(instance);
  const summary = card.summary;
  summary.replaceChildren();

  // Title row: name, type chip, status pill.
  const title = el(
    "div",
    { className: "acc-title" },
    el("h3", { text: instance.name }),
    el("span", { text: t(`type.${instance.type}`), className: `chip type-${instance.type}` })
  );
  const pill = el(
    "span",
    { className: `pill ${status.cls}` },
    el("span", { className: "pill-dot", attrs: { "aria-hidden": "true" } }),
    el("span", { text: status.label })
  );
  summary.append(el("div", { className: "acc-head" }, title, pill));

  // Meta row: data path plus small state chips.
  const meta = el("div", { className: "acc-meta" }, el("code", { text: instance.dataPath }));
  if (instance.runtime.resyncPending) {
    meta.append(el("span", { text: t("status.resyncQueued"), className: "chip resync" }));
  }
  summary.append(meta);

  // Failure states must be visible without opening anything.
  if (status.alert) {
    summary.append(el("p", { text: status.alert, className: "acc-alert", attrs: { role: "alert" } }));
  }

  // Action row. The primary slot depends on the account state; the disclosure
  // toggles are always there so logs and folders stay reachable in any state.
  const actions = el("div", { className: "acc-actions" });
  if (!instance.authenticated) {
    actions.append(
      toggleButton(card, "signin", t("action.signIn"), "primary", () => openSignInPanel(card, instance.id))
    );
  } else if (instance.runtime.running || instance.runtime.wantRunning) {
    actions.append(
      actionButton(t("action.stop"), "", async () => {
        await api(`/api/instances/${instance.id}/stop`, { method: "POST" });
        scheduleRefresh();
      })
    );
  } else {
    actions.append(
      actionButton(t("action.start"), "primary", async () => {
        await api(`/api/instances/${instance.id}/start`, { method: "POST" });
        scheduleRefresh();
      })
    );
  }
  actions.append(
    toggleButton(card, "logs", t("action.logs"), "", () => openLogPanel(card, instance.id)),
    toggleButton(card, "folders", t("action.folders"), "", () => openFoldersPanel(card, instance.id)),
    toggleButton(card, "tools", t("action.tools"), "", () => openToolsPanel(card, instance.id))
  );
  summary.append(actions);
}

/**
 * Build a disclosure toggle for one of the card panels: clicking opens the
 * panel (closing whichever was open) or closes it when already open.
 * @param {object} card Card handle.
 * @param {string} name Panel name.
 * @param {string} label Button label.
 * @param {string} className Extra classes.
 * @param {() => void} open Builder invoked when the panel should open.
 * @returns {HTMLButtonElement} The toggle button.
 */
function toggleButton(card, name, label, className, open) {
  const active = card.open === name;
  const button = el("button", {
    text: label,
    className: `${className} ${active ? "active" : ""}`.trim(),
    attrs: {
      type: "button",
      "aria-expanded": String(active),
      "aria-controls": card.panels.id,
    },
  });
  button.addEventListener("click", () => {
    if (card.open === name) closePanel(card);
    else open();
  });
  return button;
}

/**
 * Close whatever panel is open on a card. Closing a pending sign-in also
 * cancels the attempt server-side, so no orphaned auth flow keeps the client
 * config locked (cancel on a non-pending attempt is a harmless no-op).
 * @param {object} card Card handle.
 */
function closePanel(card) {
  if (card.open === "signin") {
    const id = card.root.dataset.id;
    api(`/api/instances/${id}/signin/cancel`, { method: "POST" }).catch(() => {});
  }
  card.open = null;
  card.panels.replaceChildren();
  syncToggles(card);
}

/**
 * Open a named panel on a card, replacing the currently open one.
 * @param {object} card Card handle.
 * @param {string} name Panel name.
 * @param {HTMLElement} content Panel content.
 */
function openPanel(card, name, content) {
  if (card.open === "signin" && name !== "signin") closePanel(card);
  card.open = name;
  card.panels.replaceChildren(content);
  syncToggles(card);
}

/** Re-render the summary so the toggle buttons reflect the open panel. */
function syncToggles(card) {
  const instance = model.get(card.root.dataset.id);
  if (instance) updateSummary(card, instance);
}

// --- Sign-in panel ----------------------------------------------------------

/**
 * Start the Microsoft sign-in for an instance and render the guided
 * copy-paste flow. This is the hardest moment of the whole product, hence the
 * numbered steps and the explicit "blank page is expected" explanation.
 * @param {object} card Card handle.
 * @param {string} id Instance id.
 */
async function openSignInPanel(card, id) {
  const panel = el("div", { className: "panel" });
  panel.append(el("h4", { text: t("signin.title") }));
  const placeholder = el("p", { text: t("signin.preparing"), className: "hint" });
  panel.append(placeholder);
  openPanel(card, "signin", panel);

  let authUrl;
  try {
    // begin() stops a running client first (server-side), because two clients
    // must not touch the same token files at once.
    ({ authUrl } = await api(`/api/instances/${id}/signin/begin`, { method: "POST" }));
  } catch (err) {
    if (card.open === "signin") closePanel(card);
    toast("err", describeError(err));
    return;
  }
  if (card.open !== "signin") return; // user toggled away while we waited
  placeholder.remove();

  const steps = el("ol", { className: "signin-steps" });

  // Step 1: open the link. The URL is a runtime API value, so it is set as a
  // property on an anchor we author, never interpolated into markup.
  const openLink = el("a", {
    text: t("signin.open"),
    className: "button primary",
    attrs: { href: authUrl, target: "_blank", rel: "noopener noreferrer" },
  });
  const copyBtn = actionButton(t("signin.copy"), "", async () => {
    await navigator.clipboard.writeText(authUrl);
    toast("ok", t("signin.copied"));
  });
  steps.append(
    el(
      "li",
      {},
      el("strong", { text: t("signin.step1Title") }),
      el("div", { className: "signin-actions" }, openLink, copyBtn),
      el("p", { text: t("signin.step1Text"), className: "hint" })
    )
  );

  // Step 2: pre-empt the "did it break?" moment.
  steps.append(
    el(
      "li",
      {},
      el("strong", { text: t("signin.step2Title") }),
      el("p", { text: t("signin.step2Text"), className: "hint" })
    )
  );

  // Step 3: the paste target.
  const input = el("input", {
    attrs: {
      type: "url",
      spellcheck: "false",
      placeholder: t("signin.pastePlaceholder"),
      "aria-label": t("signin.step3Title"),
    },
  });
  const errMsg = el("p", { className: "msg", attrs: { hidden: "" } });
  const errOut = el("pre", { className: "output", attrs: { hidden: "", tabindex: "0" } });

  const connect = el("button", { text: t("signin.connect"), className: "primary", attrs: { type: "button" } });
  const cancel = el("button", { text: t("common.cancel"), attrs: { type: "button" } });
  connect.addEventListener("click", async () => {
    clearMsg(errMsg);
    errOut.hidden = true;
    connect.disabled = true;
    try {
      const res = await api(`/api/instances/${id}/signin/complete`, {
        method: "POST",
        body: { responseUrl: input.value.trim() },
      });
      if (!res.authenticated) {
        // Microsoft's URL was fine but the client refused it; show the
        // client's own words, as text, so the user can see why.
        setMsg(errMsg, "err", t("signin.clientRejected"));
        errOut.textContent = res.text || t("tools.noOutput");
        errOut.hidden = false;
        connect.disabled = false;
        return;
      }
      const name = model.get(id)?.name || id;
      // The attempt is consumed: closing must not fire a cancel now.
      card.open = null;
      card.panels.replaceChildren();
      toast("ok", t("signin.success", { name }));
      await refreshInstances();
    } catch (err) {
      setMsg(errMsg, "err", t("signin.failed", { error: describeError(err) }));
      connect.disabled = false;
    }
  });
  cancel.addEventListener("click", () => closePanel(card));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") connect.click();
  });

  steps.append(
    el(
      "li",
      {},
      el("strong", { text: t("signin.step3Title") }),
      el("p", { text: t("signin.step3Text"), className: "hint" }),
      input,
      el("div", { className: "form-actions" }, connect, cancel),
      errMsg,
      errOut
    )
  );

  panel.append(steps);
  input.focus();
}

// --- Log panel --------------------------------------------------------------

/** How many lines a log view keeps before trimming the oldest. */
const LOG_KEEP = 2000;

/**
 * Open the live log tail of an instance. The view follows new lines while the
 * user is at the bottom and stops following when they scroll up, with a
 * "jump to latest" affordance, so reading old lines never fights the stream.
 * @param {object} card Card handle.
 * @param {string} id Instance id.
 */
async function openLogPanel(card, id) {
  const name = model.get(id)?.name || id;
  const pre = el("pre", {
    className: "output log-view",
    attrs: { tabindex: "0", "aria-label": t("logs.label", { name }), "data-instance": id },
  });
  pre.dataset.pinned = "1";
  pre.dataset.count = "0";

  const jump = el("button", {
    text: t("logs.jump"),
    className: "jump",
    attrs: { type: "button", "data-role": "jump", hidden: "" },
  });
  jump.addEventListener("click", () => {
    pre.scrollTop = pre.scrollHeight;
  });
  pre.addEventListener("scroll", () => {
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    pre.dataset.pinned = atBottom ? "1" : "0";
    jump.hidden = atBottom;
  });

  const panel = el(
    "div",
    { className: "panel" },
    el("h4", { text: t("logs.title") }),
    el("p", { text: t("logs.hint"), className: "hint" }),
    el("div", { className: "log-wrap" }, pre, jump)
  );
  openPanel(card, "logs", panel);

  const { lines } = await api(`/api/instances/${id}/logs`);
  if (card.open !== "logs") return;
  pre.textContent = lines.length
    ? lines.map((entry) => `${entry.ts}  ${entry.line}`).join("\n")
    : t("logs.empty");
  pre.dataset.count = String(lines.length);
  pre.scrollTop = pre.scrollHeight;
}

/**
 * Format "now" the way the server timestamps buffered log lines
 * ("YYYY-MM-DD HH:MM:SS"), so live lines line up with fetched ones.
 * @returns {string} Local timestamp.
 */
function logTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/**
 * Append a live log line to an open log view; called from the event stream.
 * Keeps the view bounded and only auto-scrolls while the user is pinned to
 * the bottom. The SSE payload carries no timestamp, so the arrival time is
 * used; that keeps the column aligned with the buffered lines.
 * @param {{id: string, line: string}} payload SSE payload.
 */
function appendLogLine(payload) {
  const pre = document.querySelector(`pre.log-view[data-instance="${CSS.escape(payload.id)}"]`);
  if (!pre) return;
  const count = Number(pre.dataset.count || "0");
  // The station stamps each line in the container's timezone, the same stamp
  // the buffered log carries, so live and fetched lines line up. The local
  // fallback only matters if an older station omits it.
  const line = `${payload.ts || logTimestamp()}  ${payload.line.trimEnd()}`;
  if (count === 0) {
    pre.textContent = line; // replaces the "no lines yet" placeholder
  } else {
    pre.append(document.createTextNode(`\n${line}`));
  }
  let next = count + 1;
  if (next > LOG_KEEP + 500) {
    // Trim in chunks instead of on every line: splitting a large string per
    // event would be the expensive way to keep a cap.
    pre.textContent = pre.textContent.split("\n").slice(-LOG_KEEP).join("\n");
    next = LOG_KEEP;
  }
  pre.dataset.count = String(next);
  if (pre.dataset.pinned === "1") pre.scrollTop = pre.scrollHeight;
}

// --- Folders (sync_list) panel ----------------------------------------------

/**
 * Open the folder selection editor of an instance, with the rule syntax
 * explained right next to the editor and an explicit resync warning.
 * @param {object} card Card handle.
 * @param {string} id Instance id.
 */
async function openFoldersPanel(card, id) {
  const name = model.get(id)?.name || id;
  const panel = el("div", { className: "panel" });
  panel.append(el("h4", { text: t("folders.title") }));

  const rules = el("ul", { className: "rule-list" });
  for (const key of ["folders.rule1", "folders.rule2", "folders.rule3", "folders.rule4"]) {
    rules.append(el("li", { text: t(key) }));
  }
  panel.append(rules);
  panel.append(
    el(
      "div",
      { className: "example" },
      el("span", { text: t("folders.example"), className: "hint" }),
      // The example is static text authored here, shown verbatim.
      el("pre", { text: "!/Documents/temp*\n/Documents/\n/Pictures/Camera Roll/*" })
    )
  );

  const textarea = el("textarea", {
    attrs: { rows: "8", spellcheck: "false", "aria-label": t("folders.editorLabel", { name }) },
  });
  panel.append(textarea);
  panel.append(el("p", { text: t("folders.warn"), className: "warn" }));

  const msg = el("p", { className: "msg", attrs: { hidden: "" } });
  const out = el("pre", { className: "output", attrs: { hidden: "", tabindex: "0" } });

  const save = actionButton(t("folders.save"), "primary", async () => {
    clearMsg(msg);
    const res = await api(`/api/instances/${id}/synclist`, {
      method: "PUT",
      body: { text: textarea.value },
    });
    setMsg(msg, "ok", res.resyncTriggered ? t("folders.savedResync") : t("folders.savedIdle"));
    scheduleRefresh();
  });
  const dryRun = actionButton(t("folders.dryRun"), "", async () => {
    clearMsg(msg);
    out.textContent = t("tools.running");
    out.hidden = false;
    const res = await api(`/api/instances/${id}/dry-run`, { method: "POST" });
    out.textContent = res.text || t("tools.noOutput");
  });
  dryRun.title = t("folders.dryRunHint");

  panel.append(el("div", { className: "form-actions" }, save, dryRun), msg, out);
  openPanel(card, "folders", panel);

  const current = await api(`/api/instances/${id}/synclist`);
  if (card.open !== "folders") return;
  textarea.value = current.text;
  textarea.focus();
}

// --- Tools panel ------------------------------------------------------------

/**
 * Open the tools panel: read-only diagnostics, maintenance switches and the
 * destructive actions, in that order, so the dangerous things sit visibly
 * apart at the bottom.
 * @param {object} card Card handle.
 * @param {string} id Instance id.
 */
function openToolsPanel(card, id) {
  const instance = model.get(id);
  const panel = el("div", { className: "panel" });

  // Diagnostics: each button runs one read-only client query into a shared
  // output area, labelled with what produced it.
  panel.append(
    el("h4", { text: t("tools.diagnostics") }),
    el("p", { text: t("tools.diagnosticsHint"), className: "hint" })
  );
  const caption = el("p", { className: "output-caption", attrs: { hidden: "" } });
  const out = el("pre", { className: "output", attrs: { hidden: "", tabindex: "0" } });
  const linkSlot = el("p", { className: "output-caption", attrs: { hidden: "" } });

  /**
   * Build one diagnostics button.
   * @param {string} labelKey String key for the label.
   * @param {string} path API path suffix.
   * @param {{method?: string, link?: boolean}} [opts] `link` renders a detected
   *   URL in the output as a clickable anchor (used for the consent URL).
   */
  const diag = (labelKey, path, opts = {}) =>
    actionButton(t(labelKey), "", async () => {
      caption.textContent = t(labelKey);
      caption.hidden = false;
      linkSlot.hidden = true;
      linkSlot.replaceChildren();
      out.textContent = t("tools.running");
      out.hidden = false;
      const res = await api(`/api/instances/${id}/${path}`, { method: opts.method || "GET" });
      out.textContent = res.text || t("tools.noOutput");
      if (opts.link) {
        // The consent URL comes back embedded in client output; offering it as
        // a link (an anchor property set at runtime, never markup) saves the
        // user a manual copy step.
        const match = (res.text || "").match(/https:\/\/\S+/);
        if (match) {
          linkSlot.append(
            el("span", { text: t("tools.consentHint"), className: "hint" }),
            el("a", { text: match[0], attrs: { href: match[0], target: "_blank", rel: "noopener noreferrer" } })
          );
          linkSlot.hidden = false;
        }
      }
    });

  const diagRow = el(
    "div",
    { className: "form-actions" },
    diag("tools.status", "status"),
    diag("tools.quota", "quota"),
    diag("tools.config", "config"),
    diag("tools.consent", "admin-consent-url", { link: true })
  );
  panel.append(diagRow, caption, out, linkSlot);

  // Maintenance.
  panel.append(el("h4", { text: t("tools.maintenance") }));
  const autoStart = el("input", { attrs: { type: "checkbox", id: `autostart-${id}` } });
  autoStart.checked = Boolean(instance?.autoStart);
  autoStart.addEventListener("change", async () => {
    autoStart.disabled = true;
    try {
      await api(`/api/instances/${id}`, { method: "PATCH", body: { autoStart: autoStart.checked } });
      toast("ok", t("tools.autoStartSaved"));
      scheduleRefresh();
    } catch (err) {
      autoStart.checked = !autoStart.checked; // revert the optimistic flip
      toast("err", describeError(err));
    } finally {
      autoStart.disabled = false;
    }
  });
  panel.append(
    el(
      "label",
      { className: "check", attrs: { for: `autostart-${id}` } },
      autoStart,
      el("span", { text: t("tools.autoStart") })
    )
  );
  const resync = actionButton(t("tools.resync"), "", async () => {
    await api(`/api/instances/${id}/restart`, { method: "POST", body: { resync: true } });
    scheduleRefresh();
  });
  resync.title = t("tools.resyncHint");
  if (!instance?.authenticated) resync.disabled = true;
  panel.append(
    el("div", { className: "form-actions" }, resync),
    el("p", { text: t("tools.resyncHint"), className: "hint" })
  );

  // Danger zone.
  panel.append(el("h4", { text: t("tools.danger"), className: "danger-title" }));
  const dangerRow = el("div", { className: "form-actions" });
  const confirmSlot = el("div");

  const signOut = actionButton(t("tools.signOut"), "danger", async () => {
    const name = model.get(id)?.name || id;
    // window.confirm with precise wording: signing out is recoverable, so the
    // in-page confirmation is reserved for deletion below.
    if (!window.confirm(t("tools.signOutConfirm", { name }))) return;
    await api(`/api/instances/${id}/signout`, { method: "POST" });
    toast("ok", t("tools.signedOut", { name }));
    await refreshInstances();
    // The panel outlives the refresh; close it so the summary's "Sign in"
    // becomes the obvious next step.
    closePanel(card);
  });
  if (!instance?.authenticated) signOut.disabled = true;

  const del = el("button", { text: t("tools.delete"), className: "danger", attrs: { type: "button" } });
  del.addEventListener("click", () => buildDeleteConfirm(confirmSlot, card, id));

  dangerRow.append(signOut, del);
  panel.append(dangerRow, confirmSlot);
  openPanel(card, "tools", panel);
}

/**
 * In-page delete confirmation with an explicit, separate opt-in for deleting
 * the synced files. The confirm button renames itself when files are included
 * so the user reads what they are about to do.
 * @param {HTMLElement} slot Where to render the confirmation.
 * @param {object} card Card handle.
 * @param {string} id Instance id.
 */
function buildDeleteConfirm(slot, card, id) {
  const instance = model.get(id);
  const name = instance?.name || id;
  slot.replaceChildren();

  const check = el("input", { attrs: { type: "checkbox", id: `delete-data-${id}` } });
  const confirm = el("button", {
    text: t("tools.deleteConfirm"),
    className: "danger solid",
    attrs: { type: "button" },
  });
  check.addEventListener("change", () => {
    confirm.textContent = check.checked ? t("tools.deleteConfirmWithData") : t("tools.deleteConfirm");
  });
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    try {
      await api(`/api/instances/${id}?deleteData=${check.checked ? "true" : "false"}`, {
        method: "DELETE",
      });
      toast("ok", t("tools.deleted", { name }));
      await refreshInstances(); // removes the card entirely
    } catch (err) {
      toast("err", describeError(err));
      confirm.disabled = false;
    }
  });
  const cancel = el("button", { text: t("common.cancel"), attrs: { type: "button" } });
  cancel.addEventListener("click", () => slot.replaceChildren());

  slot.append(
    el(
      "div",
      { className: "confirm" },
      el("p", { text: t("tools.deleteTitle", { name }), className: "confirm-title" }),
      el("p", { text: t("tools.deleteText"), className: "hint" }),
      el(
        "label",
        { className: "check", attrs: { for: `delete-data-${id}` } },
        check,
        el("span", { text: t("tools.deleteData", { path: instance?.dataPath || "" }) })
      ),
      el("div", { className: "form-actions" }, confirm, cancel)
    )
  );
  // Focus lands on Cancel, not on the destructive button: a stray Enter right
  // after opening the confirmation must not delete anything.
  cancel.focus();
}

// --- Add-account form and SharePoint lookup ---------------------------------

/**
 * Open or close the add-account card.
 * @param {boolean} open Whether to show the form.
 */
function setAddFormOpen(open) {
  $("add-card").hidden = !open;
  $("add-toggle").setAttribute("aria-expanded", String(open));
  if (open) $("add-name").focus();
}

/** Wire up the add-account form, including the embedded SharePoint lookup. */
function initAddForm() {
  $("add-toggle").addEventListener("click", () => setAddFormOpen($("add-card").hidden));
  $("empty-add").addEventListener("click", () => setAddFormOpen(true));
  $("add-cancel").addEventListener("click", () => setAddFormOpen(false));

  $("add-type").addEventListener("change", (event) => {
    $("add-sharepoint").hidden = event.target.value !== "sharepoint";
  });

  // Enter inside the lookup's site field should look up, not submit the form.
  $("lookup-site").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      $("lookup-run").click();
    }
  });
  $("lookup-run").addEventListener("click", runSharePointLookup);

  $("add-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const msg = $("add-msg");
    clearMsg(msg);
    const body = { name: $("add-name").value.trim(), type: $("add-type").value };
    if (body.type === "sharepoint") body.driveId = $("add-drive-id").value.trim();
    const submit = event.target.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const created = await api("/api/instances", { method: "POST", body });
      $("add-name").value = "";
      $("add-drive-id").value = "";
      setAddFormOpen(false);
      toast("ok", t("add.created"));
      await refreshInstances();
      // Guide straight into the next step: scroll to the new card and open
      // its sign-in flow, because a created-but-unsigned account does nothing.
      const card = cards.get(created.id);
      if (card) {
        card.root.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
        await openSignInPanel(card, created.id);
      }
    } catch (err) {
      setMsg(msg, "err", describeError(err));
    } finally {
      submit.disabled = false;
    }
  });
}

/**
 * Fill the lookup source dropdown with signed-in accounts, preserving the
 * current selection across refreshes.
 * @param {object[]} list Instances from the API.
 */
function fillLookupSources(list) {
  const select = $("lookup-source");
  const previous = select.value;
  select.replaceChildren();
  const usable = list.filter((instance) => instance.authenticated);
  if (!usable.length) {
    select.append(el("option", { text: t("lookup.none"), attrs: { value: "" } }));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const instance of usable) {
    select.append(
      el("option", {
        text: `${instance.name} (${t(`type.${instance.type}`)})`,
        attrs: { value: instance.id },
      })
    );
  }
  if (usable.some((instance) => instance.id === previous)) select.value = previous;
}

/** Run the SharePoint site lookup and render clickable drive-ID results. */
async function runSharePointLookup() {
  const msg = $("lookup-msg");
  const results = $("lookup-results");
  const raw = $("lookup-raw");
  clearMsg(msg);
  results.replaceChildren();
  raw.hidden = true;

  const instanceId = $("lookup-source").value;
  if (!instanceId) {
    setMsg(msg, "err", t("lookup.none"));
    return;
  }
  const button = $("lookup-run");
  button.disabled = true;
  try {
    const res = await api("/api/sharepoint/lookup", {
      method: "POST",
      body: { instanceId, site: $("lookup-site").value.trim() },
    });
    if (res.libraries?.length) {
      const n = res.libraries.length;
      setMsg(msg, "ok", n === 1 ? t("lookup.foundOne") : t("lookup.foundMany", { n }));
      for (const lib of res.libraries) {
        // One button per library: clicking copies its drive ID into the form.
        const use = el("button", { className: "lookup-result", attrs: { type: "button" } });
        use.append(
          el("span", { text: lib.name || "(unnamed)", className: "lookup-name" }),
          el("code", { text: lib.driveId })
        );
        use.addEventListener("click", () => {
          $("add-drive-id").value = lib.driveId;
          toast("ok", t("lookup.filled"));
        });
        results.append(use);
      }
    } else {
      setMsg(msg, "info", t("lookup.raw"));
      raw.textContent = res.text || t("tools.noOutput");
      raw.hidden = false;
    }
  } catch (err) {
    setMsg(msg, "err", describeError(err));
  } finally {
    button.disabled = false;
  }
}

// --- Authentication and session forms ---------------------------------------

/** Wire up the first-run, login and password-change forms. */
function initAuthForms() {
  $("setup-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const msg = $("setup-msg");
    clearMsg(msg);
    const password = $("setup-password").value;
    if (password !== $("setup-password-repeat").value) {
      return setMsg(msg, "err", t("setup.mismatch"));
    }
    try {
      await api("/api/setup-password", { method: "POST", body: { password } });
      await refreshState();
    } catch (err) {
      if (err.message === "already-configured") return refreshState();
      setMsg(msg, "err", err.message === "invalid-length" ? t("setup.tooShort") : describeError(err));
    }
  });

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const msg = $("login-msg");
    clearMsg(msg);
    try {
      await api("/api/login", { method: "POST", body: { password: $("login-password").value } });
      $("login-password").value = "";
      await refreshState();
    } catch {
      setMsg(msg, "err", t("login.wrongPassword"));
    }
  });

  $("pw-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const msg = $("pw-msg");
    clearMsg(msg);
    if ($("pw-new").value !== $("pw-repeat").value) {
      return setMsg(msg, "err", t("setup.mismatch"));
    }
    try {
      await api("/api/change-password", {
        method: "POST",
        body: { currentPassword: $("pw-current").value, newPassword: $("pw-new").value },
      });
      event.target.reset();
      $("pw-details").open = false;
      toast("ok", t("session.changed"));
    } catch (err) {
      if (err.status === 401) return setMsg(msg, "err", t("login.wrongPassword"));
      setMsg(msg, "err", err.message === "invalid-length" ? t("setup.tooShort") : describeError(err));
    }
  });

  $("logout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" }).catch(() => {});
    await refreshState();
  });
}

// --- Live updates -----------------------------------------------------------

/** @type {EventSource|null} */
let eventSource = null;

/**
 * Subscribe to server-sent events: log lines feed open log panels, state
 * changes trigger a (debounced) summary refresh. Started when the main view
 * shows and stopped when it hides, so an unauthenticated page does not sit in
 * a 401 retry loop.
 */
function startEventStream() {
  if (eventSource) return;
  eventSource = new EventSource("/api/events");
  const live = $("live");
  live.hidden = false;
  setLiveState(false);

  eventSource.addEventListener("open", () => setLiveState(true));
  eventSource.addEventListener("error", () => setLiveState(false)); // EventSource reconnects on its own
  eventSource.addEventListener("log", (event) => appendLogLine(JSON.parse(event.data)));
  eventSource.addEventListener("state", () => scheduleRefresh());
}

/** Tear down the event stream and hide the live indicator. */
function stopEventStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  $("live").hidden = true;
}

/**
 * Update the connection indicator in the header.
 * @param {boolean} connected Whether the stream is currently open.
 */
function setLiveState(connected) {
  $("live").classList.toggle("ok", connected);
  $("live-label").textContent = connected ? t("app.live") : t("app.reconnecting");
}

// --- Boot -------------------------------------------------------------------

applyStaticStrings();
initAuthForms();
initAddForm();
refreshState().catch((err) => {
  document.body.append(
    el("p", { text: t("app.unreachable", { error: err.message }), className: "boot-error" })
  );
});
