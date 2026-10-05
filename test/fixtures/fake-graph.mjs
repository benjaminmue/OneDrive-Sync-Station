// A stand-in for the Microsoft identity platform and Graph, on loopback.
//
// Serves the token endpoint and delta pages from a scripted list, and records
// every request so tests can check what the station sent and where.

import { createServer } from "node:http";

/**
 * @typedef {object} FakeGraphOptions
 * @property {object[][]} [pages] Delta pages, each a list of drive items.
 * @property {{status: number, body: object}} [token] Token endpoint answer.
 * @property {number} [throttleFirst] Answer this many of the next delta requests with 429; counts down.
 * @property {(page: number, base: string) => string|null} [nextLink] Override the next link of a page.
 * @property {number} [expireOnPage] Answer this delta page once with 401, as an expired access token would.
 */

/**
 * Start the fake server.
 * @param {FakeGraphOptions} [opts] Scripted behaviour.
 * @returns {Promise<{base: string, requests: object[], script: FakeGraphOptions, reset: () => void, close: () => Promise<void>}>}
 *   Where it listens, what it saw, and the script, which tests may change between requests.
 */
export async function startFakeGraph(opts = {}) {
  const requests = [];
  let base = "";

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url, base);
      requests.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body });
      const send = (status, payload, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(payload));
      };

      if (url.pathname.endsWith("/oauth2/v2.0/token")) {
        const token = opts.token ?? { status: 200, body: { access_token: "fake-access-token", refresh_token: "rotated-refresh-token" } };
        return send(token.status, token.body);
      }
      if (url.pathname.endsWith("/root/delta")) {
        if ((opts.throttleFirst ?? 0) > 0) {
          opts.throttleFirst -= 1;
          return send(429, { error: { code: "activityLimitReached" } }, { "retry-after": "0" });
        }
        const page = Number(url.searchParams.get("page") ?? 0);
        if (opts.expireOnPage === page) {
          delete opts.expireOnPage;
          return send(401, { error: { code: "InvalidAuthenticationToken" } });
        }
        const next = opts.nextLink
          ? opts.nextLink(page, base)
          : page + 1 < (opts.pages ?? [[]]).length
            ? `${base}${url.pathname}?page=${page + 1}`
            : null;
        const payload = { value: (opts.pages ?? [[]])[page] ?? [] };
        if (next) payload["@odata.nextLink"] = next;
        else payload["@odata.deltaLink"] = `${base}${url.pathname}?token=done`;
        return send(200, payload);
      }
      send(404, { error: { code: "itemNotFound" } });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    requests,
    script: opts,
    /** Forget the script and the recorded requests, so no test inherits another's. */
    reset() {
      for (const key of Object.keys(opts)) delete opts[key];
      requests.length = 0;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
