// Minimal structured logger. Writes single-line JSON to stdout so container log
// viewers (Unraid, docker logs) stay greppable.

/**
 * Write one JSON log line to stdout.
 * @param {string} level Log level label.
 * @param {string} msg Human readable message.
 * @param {object} [extra] Additional fields merged into the line.
 */
function emit(level, msg, extra) {
  const line = { ts: new Date().toISOString(), level, msg, ...extra };
  process.stdout.write(JSON.stringify(line) + "\n");
}

export const log = {
  info: (msg, extra) => emit("info", msg, extra),
  warn: (msg, extra) => emit("warn", msg, extra),
  error: (msg, extra) => emit("error", msg, extra),
};
