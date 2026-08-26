// Central input validation.
//
// Every value that reaches the filesystem, a child process argument or the
// onedrive client config file passes through here. Keeping it in one module
// means there is exactly one place to audit, and no route can quietly invent a
// weaker rule of its own.
//
// Three distinct injection surfaces are guarded:
//   1. Process arguments  - we always spawn with an argv array and never a
//      shell, so shell metacharacters are inert. Values are still restricted so
//      a leading "-" cannot turn user input into an extra client flag.
//   2. Filesystem paths   - instance ids and data folder names become directory
//      names, so path separators and traversal sequences are rejected outright.
//   3. Client config file - the onedrive config uses `key = "value"` lines. A
//      value containing a quote or a newline could append arbitrary settings, so
//      both are rejected rather than escaped.

/** Error carrying the offending field name, mapped to HTTP 400 by the API. */
export class ValidationError extends Error {
  /**
   * @param {string} field Name of the rejected input field.
   * @param {string} reason Machine readable reason code.
   */
  constructor(field, reason) {
    super(`${field}: ${reason}`);
    this.name = "ValidationError";
    this.field = field;
    this.reason = reason;
  }
}

// Slug used for instance ids and data folder names. Lowercase, no dots, so
// "..", hidden files and path separators are impossible by construction.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

// Control characters are rejected in every free-text field: they serve no
// purpose here and are the building block of config and log injection.
const CONTROL_RE = /[\x00-\x1f\x7f]/;

/**
 * Assert that a value is a non-empty string.
 * @param {unknown} value Raw input.
 * @param {string} field Field name for the error.
 * @returns {string} The value as a string.
 */
function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(field, "required");
  }
  return value;
}

/**
 * Validate a slug used as instance id or data folder name.
 * @param {unknown} value Raw input.
 * @param {string} [field] Field name for the error.
 * @returns {string} The validated slug.
 */
export function slug(value, field = "id") {
  const str = requireString(value, field);
  if (!SLUG_RE.test(str)) throw new ValidationError(field, "invalid-slug");
  return str;
}

/**
 * Derive a slug from a human entered name. Used when the UI does not supply an
 * explicit id, so the user never has to think about filesystem-safe names.
 * @param {string} name Display name.
 * @returns {string} A slug, or an empty string if nothing usable remains.
 */
export function slugify(name) {
  return String(name)
    .normalize("NFKD")
    // NFKD splits an accented letter into base plus combining mark; dropping
    // the marks turns "Buero" style input into plain letters instead of
    // separating them with dashes.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

/**
 * Validate a human readable label that is stored and displayed but never
 * reaches a process argument or the client config.
 * @param {unknown} value Raw input.
 * @param {string} [field] Field name for the error.
 * @returns {string} The trimmed label.
 */
export function displayName(value, field = "name") {
  const str = requireString(value, field).trim();
  if (str.length === 0 || str.length > 64) throw new ValidationError(field, "invalid-length");
  if (CONTROL_RE.test(str)) throw new ValidationError(field, "invalid-characters");
  return str;
}

/** Account types the station knows how to configure. */
export const ACCOUNT_TYPES = ["personal", "business", "sharepoint"];

/**
 * Validate the account type of an instance.
 * @param {unknown} value Raw input.
 * @returns {"personal"|"business"|"sharepoint"} The validated type.
 */
export function accountType(value) {
  if (!ACCOUNT_TYPES.includes(value)) throw new ValidationError("type", "invalid-type");
  return value;
}

/**
 * Validate a SharePoint or OneDrive drive id as returned by
 * `--get-sharepoint-drive-id`. Those ids are base64-like with a "b!" prefix.
 * @param {unknown} value Raw input.
 * @returns {string} The validated drive id.
 */
export function driveId(value) {
  const str = requireString(value, "driveId").trim();
  if (str.length > 512) throw new ValidationError("driveId", "invalid-length");
  if (!/^[A-Za-z0-9!_\-.=]+$/.test(str)) throw new ValidationError("driveId", "invalid-characters");
  return str;
}

/**
 * Validate an integer option and clamp it to an allowed range.
 * @param {unknown} value Raw input.
 * @param {{field: string, min: number, max: number}} bounds Field name and range.
 * @returns {number} The validated integer.
 */
export function integer(value, { field, min, max }) {
  const num = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(num)) throw new ValidationError(field, "not-an-integer");
  if (num < min || num > max) throw new ValidationError(field, "out-of-range");
  return num;
}

/**
 * Coerce a checkbox-style input to a strict boolean.
 * @param {unknown} value Raw input.
 * @returns {boolean} The coerced value.
 */
export function boolean(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

/**
 * Validate a value that is written into the onedrive client config file.
 * Quotes and control characters would break out of the `key = "value"` form and
 * let a caller append arbitrary client settings, so both are rejected.
 * @param {unknown} value Raw input.
 * @param {string} field Field name for the error.
 * @param {number} [maxLength] Maximum accepted length.
 * @returns {string} The validated value.
 */
export function configValue(value, field, maxLength = 512) {
  const str = typeof value === "string" ? value : String(value ?? "");
  if (str.length > maxLength) throw new ValidationError(field, "invalid-length");
  if (str.includes('"') || str.includes("\\")) throw new ValidationError(field, "invalid-characters");
  if (CONTROL_RE.test(str)) throw new ValidationError(field, "invalid-characters");
  return str;
}

/**
 * Validate a remote OneDrive path used with `--single-directory` and friends.
 * A leading dash would be parsed as another client flag, so it is rejected.
 * @param {unknown} value Raw input.
 * @param {string} [field] Field name for the error.
 * @returns {string} The validated path.
 */
export function remotePath(value, field = "path") {
  const str = requireString(value, field).trim();
  if (str.length > 1024) throw new ValidationError(field, "invalid-length");
  if (CONTROL_RE.test(str)) throw new ValidationError(field, "invalid-characters");
  if (str.startsWith("-")) throw new ValidationError(field, "invalid-characters");
  if (str.split("/").includes("..")) throw new ValidationError(field, "path-traversal");
  return str;
}

// A sync_list is a plain text file read by the client; it never becomes an
// argument. Only size and control characters need bounding, so operators keep
// the full documented rule syntax (!, -, *, **, /).
const SYNC_LIST_MAX_BYTES = 64 * 1024;
const SYNC_LIST_MAX_LINES = 2000;

/**
 * Validate the raw text of a sync_list file.
 * @param {unknown} value Raw input.
 * @returns {string} The normalised text with LF line endings and no trailing blank lines.
 */
export function syncListText(value) {
  const str = typeof value === "string" ? value : "";
  if (Buffer.byteLength(str, "utf8") > SYNC_LIST_MAX_BYTES) {
    throw new ValidationError("syncList", "too-large");
  }
  const lines = str.split(/\r?\n/);
  if (lines.length > SYNC_LIST_MAX_LINES) throw new ValidationError("syncList", "too-many-lines");
  for (const line of lines) {
    // Tabs are legal inside a rule; other control characters are not.
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(line)) {
      throw new ValidationError("syncList", "invalid-characters");
    }
  }
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

// The client only ever redirects to these two hosts, so anything else pasted
// into the login form is a mistake or an attempt to feed us a foreign URL.
const AUTH_RESPONSE_HOSTS = new Set(["login.microsoftonline.com", "127.0.0.1", "localhost"]);

/**
 * Validate the redirect URL a user pastes back after the Microsoft sign-in.
 * @param {unknown} value Raw input.
 * @returns {string} The validated URL.
 */
export function authResponseUrl(value) {
  const str = requireString(value, "responseUrl").trim();
  if (str.length > 4096) throw new ValidationError("responseUrl", "invalid-length");
  let url;
  try {
    url = new URL(str);
  } catch {
    throw new ValidationError("responseUrl", "not-a-url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ValidationError("responseUrl", "invalid-scheme");
  }
  if (!AUTH_RESPONSE_HOSTS.has(url.hostname)) {
    throw new ValidationError("responseUrl", "unexpected-host");
  }
  // Without a code there is nothing for the client to redeem; catching it here
  // gives a precise message instead of a client timeout minutes later.
  if (!url.searchParams.get("code")) throw new ValidationError("responseUrl", "missing-code");
  return str;
}

/**
 * Validate a GUI password.
 * @param {unknown} value Raw input.
 * @returns {string} The validated password.
 */
export function password(value) {
  const str = requireString(value, "password");
  if (str.length < 8 || str.length > 256) throw new ValidationError("password", "invalid-length");
  return str;
}
