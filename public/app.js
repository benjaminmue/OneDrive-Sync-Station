// OneDrive Sync Station web UI (proof of concept).
//
// Deliberately dependency free: the whole UI is a handful of render functions
// over the JSON API. Every value that comes from the API is inserted with
// textContent or as an element property, never as HTML, so a folder name or a
// client log line can never become markup.

const $ = (id) => document.getElementById(id);

/** Instance rows currently rendered, keyed by id, so events can patch in place. */
const rendered = new Map();

// --- API helper -------------------------------------------------------------

/**
 * Call the JSON API.
 * @param {string} path API path.
 * @param {{method?: string, body?: object}} [opts] Request options.
 * @returns {Promise<object>} Parsed response body.
 * @throws {Error} With the API error code as message on a non-2xx response.
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
    throw err;
  }
  return data;
}

/**
 * Show a status message in one of the message slots.
 * @param {string} id Element id of the message container.
 * @param {"ok"|"err"|"info"} kind Visual style.
 * @param {string} text Message text.
 */
function message(id, kind, text) {
  const el = $(id);
  el.className = `msg ${kind}`;
  el.textContent = text;
}

/** Hide a message slot. */
function clearMessage(id) {
  $(id).className = "msg hidden";
}

/**
 * Build an element with text content and optional class and attributes.
 * @param {string} tag Tag name.
 * @param {{text?: string, className?: string, attrs?: object}} [opts] Options.
 * @returns {HTMLElement} The new element.
 */
function el(tag, opts = {}) {
  const node = document.createElement(tag);
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.className) node.className = opts.className;
  for (const [key, value] of Object.entries(opts.attrs || {})) node.setAttribute(key, value);
  return node;
}

// --- Views ------------------------------------------------------------------

/**
 * Show exactly one of the three top level views.
 * @param {"setup"|"login"|"main"} name View to show.
 */
function showView(name) {
  for (const view of ["setup", "login", "main"]) {
    $(`view-${view}`).classList.toggle("hidden", view !== name);
  }
}

/** Load the station state and render the matching view. */
async function refreshState() {
  const state = await api("/api/state");
  const parts = [`v${state.version}`];
  if (state.clientVersion) parts.push(state.clientVersion);
  $("meta").textContent = parts.join(" · ");

  if (state.setupNeeded) return showView("setup");
  if (!state.authed) return showView("login");
  showView("main");
  await refreshInstances();
}

// --- Instances --------------------------------------------------------------

/**
 * Describe the runtime state of an instance as a badge label and style.
 * @param {object} instance Instance as returned by the API.
 * @returns {{label: string, className: string}} Badge description.
 */
function badgeFor(instance) {
  if (!instance.authenticated) return { label: "not signed in", className: "badge error" };
  if (instance.runtime.running) return { label: "running", className: "badge running" };
  if (instance.runtime.wantRunning) return { label: "restarting", className: "badge error" };
  return { label: "stopped", className: "badge stopped" };
}

/** Reload the instance list and rebuild the rows. */
async function refreshInstances() {
  const list = await api("/api/instances");
  const container = $("instances");
  container.replaceChildren();
  rendered.clear();

  $("accounts-hint").textContent = list.length
    ? `${list.length} account${list.length === 1 ? "" : "s"} configured.`
    : "No accounts yet. Add one below.";

  for (const instance of list) container.append(buildInstanceRow(instance));
  fillSharePointSources(list);
}

/**
 * Build the row for a single instance.
 * @param {object} instance Instance as returned by the API.
 * @returns {HTMLElement} The row element.
 */
function buildInstanceRow(instance) {
  const row = el("div", { className: "instance" });
  const badge = badgeFor(instance);

  const title = el("h3", { text: instance.name });
  title.append(el("span", { text: badge.label, className: badge.className }));
  title.append(el("span", { text: instance.type, className: "badge" }));
  row.append(title);

  row.append(
    el("p", {
      className: "hint",
      text: `Folder: ${instance.dataPath}`,
    })
  );

  const controls = el("div", { className: "row" });
  const addButton = (label, className, handler) => {
    const button = el("button", { text: label, className });
    button.addEventListener("click", () => run(button, handler));
    controls.append(button);
    return button;
  };

  if (!instance.authenticated) {
    addButton("Sign in", "primary", () => beginSignIn(instance, row));
  } else {
    if (instance.runtime.running) {
      addButton("Stop", "", () => api(`/api/instances/${instance.id}/stop`, { method: "POST" }));
    } else {
      addButton("Start", "primary", () =>
        api(`/api/instances/${instance.id}/start`, { method: "POST" })
      );
    }
    addButton("Resync", "", () =>
      api(`/api/instances/${instance.id}/restart`, { method: "POST", body: { resync: true } })
    );
    addButton("Sync status", "", async () => {
      const res = await api(`/api/instances/${instance.id}/status`);
      showOutput(row, res.text);
    });
    addButton("Quota", "", async () => {
      const res = await api(`/api/instances/${instance.id}/quota`);
      showOutput(row, res.text);
    });
    addButton("Sign out", "", () =>
      api(`/api/instances/${instance.id}/signout`, { method: "POST" })
    );
  }

  addButton("Folders", "", () => toggleSyncList(instance, row));
  addButton("Log", "", () => toggleLog(instance, row));
  addButton("Delete", "danger", () => deleteInstance(instance));
  row.append(controls);

  const panels = el("div");
  panels.dataset.role = "panels";
  row.append(panels);

  rendered.set(instance.id, { row, instance });
  return row;
}

/**
 * Run an async handler tied to a button, disabling it while it is in flight and
 * reporting failures next to the account.
 * @param {HTMLButtonElement} button The button that triggered the action.
 * @param {() => Promise<unknown>} handler The action.
 */
async function run(button, handler) {
  button.disabled = true;
  try {
    await handler();
    await refreshInstances();
  } catch (err) {
    window.alert(`Failed: ${err.message}`);
    button.disabled = false;
  }
}

/**
 * Show client output below an instance row.
 * @param {HTMLElement} row Instance row.
 * @param {string} text Output to display.
 */
function showOutput(row, text) {
  const panels = row.querySelector('[data-role="panels"]');
  const existing = panels.querySelector('[data-role="output"]');
  if (existing) existing.remove();
  const pre = el("pre", { className: "log", text: text || "(no output)" });
  pre.dataset.role = "output";
  panels.append(pre);
}

// --- Sign-in ----------------------------------------------------------------

/**
 * Start the Microsoft sign-in and render the copy-paste panel.
 * @param {object} instance Instance record.
 * @param {HTMLElement} row Instance row.
 */
async function beginSignIn(instance, row) {
  const { authUrl } = await api(`/api/instances/${instance.id}/signin/begin`, { method: "POST" });
  const panels = row.querySelector('[data-role="panels"]');
  panels.replaceChildren();

  const panel = el("div", { className: "msg info" });
  panel.append(el("div", { text: "1. Open this link and sign in:" }));

  const link = el("a", { text: authUrl, attrs: { href: authUrl, target: "_blank", rel: "noopener noreferrer" } });
  panel.append(link);
  panel.append(
    el("div", {
      text: "2. You land on a blank page. Copy the full URL from the address bar and paste it here:",
    })
  );

  const input = el("input", { attrs: { type: "text", placeholder: "https://login.microsoftonline.com/…" } });
  panel.append(input);

  const actions = el("div", { className: "row" });
  const submit = el("button", { text: "Connect", className: "primary" });
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    try {
      const res = await api(`/api/instances/${instance.id}/signin/complete`, {
        method: "POST",
        body: { responseUrl: input.value },
      });
      if (!res.authenticated) {
        window.alert(`Sign-in failed:\n\n${res.text}`);
        submit.disabled = false;
        return;
      }
      await refreshInstances();
    } catch (err) {
      window.alert(`Sign-in failed: ${err.message}`);
      submit.disabled = false;
    }
  });

  const cancel = el("button", { text: "Cancel" });
  cancel.addEventListener("click", async () => {
    await api(`/api/instances/${instance.id}/signin/cancel`, { method: "POST" });
    await refreshInstances();
  });

  actions.append(submit, cancel);
  panel.append(actions);
  panels.append(panel);
}

// --- sync_list --------------------------------------------------------------

/**
 * Toggle the folder selection editor of an instance.
 * @param {object} instance Instance record.
 * @param {HTMLElement} row Instance row.
 */
async function toggleSyncList(instance, row) {
  const panels = row.querySelector('[data-role="panels"]');
  const existing = panels.querySelector('[data-role="synclist"]');
  if (existing) return existing.remove();

  const current = await api(`/api/instances/${instance.id}/synclist`);
  const panel = el("div");
  panel.dataset.role = "synclist";
  panel.append(
    el("p", {
      className: "hint",
      text:
        "One rule per line. Nothing is synced unless a rule selects it; an empty list syncs " +
        "everything. Prefix an exclusion with ! and put exclusions before inclusions. " +
        "Saving triggers a resync, which the client requires after every change.",
    })
  );

  const textarea = el("textarea", { attrs: { rows: "8", spellcheck: "false" } });
  textarea.value = current.text;
  panel.append(textarea);

  const actions = el("div", { className: "row" });
  const save = el("button", { text: "Save and resync", className: "primary" });
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      await api(`/api/instances/${instance.id}/synclist`, {
        method: "PUT",
        body: { text: textarea.value },
      });
      await refreshInstances();
    } catch (err) {
      window.alert(`Save failed: ${err.message}`);
      save.disabled = false;
    }
  });

  const preview = el("button", { text: "Dry run" });
  preview.addEventListener("click", async () => {
    preview.disabled = true;
    try {
      const res = await api(`/api/instances/${instance.id}/dry-run`, { method: "POST" });
      showOutput(row, res.text);
    } finally {
      preview.disabled = false;
    }
  });

  actions.append(save, preview);
  panel.append(actions);
  panels.append(panel);
}

// --- Logs -------------------------------------------------------------------

/**
 * Toggle the log tail of an instance.
 * @param {object} instance Instance record.
 * @param {HTMLElement} row Instance row.
 */
async function toggleLog(instance, row) {
  const panels = row.querySelector('[data-role="panels"]');
  const existing = panels.querySelector('[data-role="log"]');
  if (existing) return existing.remove();

  const { lines } = await api(`/api/instances/${instance.id}/logs`);
  const pre = el("pre", { className: "log" });
  pre.dataset.role = "log";
  pre.dataset.instance = instance.id;
  pre.textContent = lines.map((entry) => `${entry.ts}  ${entry.line}`).join("\n");
  panels.append(pre);
  pre.scrollTop = pre.scrollHeight;
}

/**
 * Append a live log line to an open log panel.
 * @param {{id: string, line: string}} payload Event payload.
 */
function appendLogLine(payload) {
  const pre = document.querySelector(`pre[data-instance="${CSS.escape(payload.id)}"]`);
  if (!pre) return;
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  pre.append(document.createTextNode(`\n${payload.line.trimEnd()}`));
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

// --- Account creation -------------------------------------------------------

/** Wire up the "add account" form. */
function initCreateForm() {
  $("new-type").addEventListener("change", (event) => {
    $("new-sharepoint").classList.toggle("hidden", event.target.value !== "sharepoint");
  });

  $("new-submit").addEventListener("click", async () => {
    clearMessage("new-msg");
    const body = {
      name: $("new-name").value,
      type: $("new-type").value,
    };
    if (body.type === "sharepoint") body.driveId = $("new-drive-id").value;
    try {
      await api("/api/instances", { method: "POST", body });
      $("new-name").value = "";
      $("new-drive-id").value = "";
      message("new-msg", "ok", "Account created. Sign in to start syncing.");
      await refreshInstances();
    } catch (err) {
      message("new-msg", "err", `Could not create the account: ${err.message}`);
    }
  });
}

/**
 * Delete an instance after confirming, optionally with its files.
 * @param {object} instance Instance record.
 */
async function deleteInstance(instance) {
  if (!window.confirm(`Remove "${instance.name}"? Its sign-in and settings are deleted.`)) {
    throw new Error("cancelled");
  }
  const withData = window.confirm(
    "Also delete the synced files on disk?\n\nOK deletes them, Cancel keeps them."
  );
  await api(`/api/instances/${instance.id}?deleteData=${withData ? "true" : "false"}`, {
    method: "DELETE",
  });
}

// --- SharePoint lookup ------------------------------------------------------

/**
 * Fill the lookup source dropdown with signed-in accounts.
 * @param {object[]} list Instances from the API.
 */
function fillSharePointSources(list) {
  const select = $("sp-instance");
  select.replaceChildren();
  const usable = list.filter((instance) => instance.authenticated);
  if (!usable.length) {
    select.append(el("option", { text: "no signed-in account", attrs: { value: "" } }));
    return;
  }
  for (const instance of usable) {
    select.append(el("option", { text: instance.name, attrs: { value: instance.id } }));
  }
}

/** Wire up the SharePoint lookup form. */
function initSharePointForm() {
  $("sp-submit").addEventListener("click", async () => {
    clearMessage("sp-msg");
    $("sp-out").classList.add("hidden");
    const instanceId = $("sp-instance").value;
    if (!instanceId) {
      message("sp-msg", "err", "Sign in with a business account first.");
      return;
    }
    try {
      const res = await api("/api/sharepoint/lookup", {
        method: "POST",
        body: { instanceId, site: $("sp-site").value },
      });
      if (res.libraries?.length) {
        const lines = res.libraries.map((lib) => `${lib.name || "(unnamed)"}  ${lib.driveId}`);
        message("sp-msg", "ok", `Found ${res.libraries.length} library/libraries.`);
        $("sp-out").textContent = lines.join("\n");
      } else {
        message("sp-msg", "info", "No drive ID recognised, see the raw output below.");
        $("sp-out").textContent = res.text;
      }
      $("sp-out").classList.remove("hidden");
    } catch (err) {
      message("sp-msg", "err", `Lookup failed: ${err.message}`);
    }
  });
}

// --- Authentication forms ---------------------------------------------------

/** Wire up the first-run and login forms. */
function initAuthForms() {
  $("setup-submit").addEventListener("click", async () => {
    clearMessage("setup-msg");
    const password = $("setup-password").value;
    if (password !== $("setup-password-repeat").value) {
      return message("setup-msg", "err", "The two passwords do not match.");
    }
    try {
      await api("/api/setup-password", { method: "POST", body: { password } });
      await refreshState();
    } catch (err) {
      message("setup-msg", "err", err.message === "invalid-length"
        ? "The password must be at least 8 characters long."
        : `Could not save the password: ${err.message}`);
    }
  });

  $("login-submit").addEventListener("click", async () => {
    clearMessage("login-msg");
    try {
      await api("/api/login", { method: "POST", body: { password: $("login-password").value } });
      $("login-password").value = "";
      await refreshState();
    } catch {
      message("login-msg", "err", "Wrong password.");
    }
  });

  $("login-password").addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("login-submit").click();
  });

  $("logout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    await refreshState();
  });
}

// --- Live updates -----------------------------------------------------------

/** Subscribe to server sent events for log lines and state changes. */
function initEventStream() {
  const source = new EventSource("/api/events");
  source.addEventListener("log", (event) => appendLogLine(JSON.parse(event.data)));
  source.addEventListener("state", () => {
    // State changes are rare and the list is small, so a full refresh keeps the
    // rendering logic in one place instead of patching rows in two ways.
    refreshInstances().catch(() => {});
  });
}

// --- Boot -------------------------------------------------------------------

initAuthForms();
initCreateForm();
initSharePointForm();
initEventStream();
refreshState().catch((err) => {
  document.body.append(el("p", { text: `Could not reach the station: ${err.message}` }));
});
