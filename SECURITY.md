# Security model

Chroma serves three kinds of content from one host: its own pages (dashboard, playground), the API,
and sites deployed by any user. The design goal is that a malicious user can't affect another user's
account, the platform, or the server — even with arbitrary HTML/JS and Pyre code.

## Accounts and sessions

| Control | Implementation (`server/auth.js`) |
| --- | --- |
| Password storage | scrypt, N=2^15, r=8, p=1, 16-byte random salt, 32-byte key |
| Password policy | 10–256 chars, rejects very common passwords and passwords containing the username |
| User enumeration | Unknown usernames run a dummy scrypt so timing and messages match wrong passwords |
| Brute force | 5 failures lock the account for 15 min; auth endpoints limited to 20 requests / 10 min per IP |
| Sessions | 256-bit random token, `HttpOnly; SameSite=Strict; Path=/` (+ `Secure` with `CHROMA_HTTPS=1`), 7 days; only `sha256(token)` is stored |
| CSRF | Every cookie-authenticated non-GET request needs the session's `X-CSRF-Token`; login/signup reject foreign `Origin` |
| API tokens | `chr_` + 256 bits, shown once, stored as SHA-256, revocable, last-use tracked |
| Password change | Re-hashes and revokes every other session |

## Pages and API (`server/security.js`)

`Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-<import map>'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'`, plus `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP and CORP (HSTS with `CHROMA_HTTPS=1`).
Inline script hashes are computed from the served HTML at startup. The playground evaluates Pyre's
generated JavaScript only inside `/assets/js/pyre-worker.js`, a Web Worker served with
`default-src 'none'; script-src 'self' 'unsafe-eval'` — no DOM, no cookies, no network.

## Deployed sites

* Every deployed response carries `Content-Security-Policy: sandbox allow-scripts …` (all file types,
  including SVG/XML). Browsers give the page an **opaque origin**: it can't read platform cookies or
  storage, can't make credentialed requests to the API, and can't script platform pages.
* `X-Content-Type-Options: nosniff` and explicit content types; unknown types are binary downloads.
* Upload paths must be relative, without `..`, `.`-prefixed segments, backslashes, control
  characters or empty segments; 2,000 files, 10 MB per file and 50 MB per deployment.
* Files are stored by SHA-256 in `DATA_DIR/blobs` (mode 600); `db.json` is written atomically (mode 600).
* Projects are owner-scoped; other users get the same 404 whether a project exists or not.

## Pyre Functions (`server/functions.js`)

* The Pyre language has no strings, I/O, pointers or recursion; its JS backend only emits code built
  from checked identifiers and numbers, renames keywords and prototype names, and ticks a loop budget.
* Each call runs in a **new worker thread** with a 3 s wall-clock timeout (then `terminate()`),
  96 MB heap, 20M loop iterations, ≤ 1M buffer elements and validated numeric inputs.
* Public, rate limited (60/min per IP), CORS-enabled without credentials.

## Project databases (`server/database.js`)

* Per-collection rules: `read` public/private, `write` public/create/private. Private collections
  are never readable or writable from deployed pages; an owner's API token (Bearer) is required.
* SQL is always parameterised; field names in filters and ordering must match
  `[A-Za-z_][A-Za-z0-9_]*`; document keys may not start with `_` or be `constructor`/`prototype`.
* 16 KB per document, 10,000 documents per collection, 50 collections, 300 requests/min per IP.

## JS server functions (`server/js-functions.js`, `server/js-runner.mjs`)

Each request gets a **new child process** started with `--permission` (no filesystem beyond the
runner file, no child processes, workers or addons), `--disallow-code-generation-from-strings` and a
64 MB heap. User code runs in a separate V8 context whose only link to the host is a bridge compiled
*inside* that context exchanging JSON strings, so host objects and the host `Function` constructor
are unreachable; `process`, `require`, `fetch` and timers do not exist there. The parent kills the
process after 5 s, caps database calls (200) and response size (1 MB), and strips `Set-Cookie`,
CSP, CORS and HSTS headers from responses. Tests cover `Function`-constructor escapes, `eval`,
infinite loops and memory bombs. Disable entirely with `ALLOW_JS_FUNCTIONS=0`.

## Analytics (`server/analytics.js`)

No cookies and no raw IP addresses are stored. A visitor id is
`HMAC-SHA256(daily salt, ip | user-agent | project)` truncated to 64 bits; salts rotate daily and
are deleted after two days, so visitors cannot be linked across days. Events are kept 31 days.

## Reporting a vulnerability

Please use GitHub's private advisory form (Security → Report a vulnerability) instead of a public issue.
