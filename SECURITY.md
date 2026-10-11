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

## Reporting a vulnerability

Please use GitHub's private advisory form (Security → Report a vulnerability) instead of a public issue.
