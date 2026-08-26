// Local time helpers. The container TZ (set via the TZ env var) decides what
// "local" means, so log lines in the UI match the host clock the user knows.

/**
 * Current local time as `YYYY-MM-DD HH:MM:SS`.
 * @returns {string} Timestamp without timezone suffix.
 */
export function localTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}
