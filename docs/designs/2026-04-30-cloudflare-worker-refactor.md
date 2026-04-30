# Refactor pic.sorrycc.com to Cloudflare Worker

## 1. Background

`pic.sorrycc.com` today is an Express/Node service (`index.js`, ~466 LOC) with two responsibilities: receive base64 image uploads, push them to a GitHub repo, and proxy reads back via `raw.githubusercontent.com` with a 3-month local-disk cache. It also runs `pngquant` / `jpegoptim` / `gifsicle` via `execSync` to compress before upload.

The user wants this on Cloudflare Workers, behind the `pic.sorrycc.com` zone (manual zone transfer to CF account `965e9128d01710c7d4c2034d7b539d21` is the user's follow-up). Native CLI compression cannot run in the Workers runtime (no `child_process`, no native binaries), so compression is dropped entirely. Storage stays on GitHub.

The GitHub repo is being renamed `sorrycc/upic-github` → `sorrycc/pic.sorrycc.com`; the Worker config + README must reflect that.

## 2. Requirements Summary

Replace the Express server with a single Cloudflare Worker that:
- Accepts `POST /api/upload` (bearer-auth, base64 JSON in, JSON URL out) and pushes the file to GitHub.
- Serves `GET /<filename>` by proxying `raw.githubusercontent.com`, edge-cached via the Workers Cache API.
- Drops local disk cache, periodic cleanup, `/tmp` static, the localhost fallback, and all binary compression.
- Keeps an identical request/response contract for `POST /api/upload` so existing uPic clients work unchanged.

## 3. Acceptance Criteria

1. `wrangler deploy` ships a single Worker bound to `pic.sorrycc.com` (after the user's manual zone transfer); no Express, no Node runtime, no `node_modules` shipped.
2. `POST https://pic.sorrycc.com/api/upload` with `Authorization: Bearer $TOKEN` and body `{ file: <base64>, fileName: "x.png" }` returns 200 `{ data: "https://pic.sorrycc.com/<timestamp>-<rand>.png" }` and the file appears on the `sorrycc/pic.sorrycc.com` repo.
3. Same request without / with-wrong bearer token returns 401 / 403 respectively.
4. `GET https://pic.sorrycc.com/<filename>` returns the image bytes with the correct `Content-Type` (png/jpeg/gif/webp/svg), `Cache-Control: public, max-age=31536000, immutable`, and is served from CF edge cache on the second request (verifiable via `cf-cache-status: HIT`).
5. `GET https://pic.sorrycc.com/../package.json` (or any non-matching pattern, including paths with slashes) returns 404.
6. `POST /api/upload` with body > 25 MB returns 413.
7. When the GitHub Contents API call fails, `POST /api/upload` returns 502 with a JSON error body — no `localhost` URL ever leaks.
8. `wrangler dev` runs the Worker locally on `:8787` using `.dev.vars`; the existing test script (updated) successfully uploads through it.
9. README reflects: new repo name `sorrycc/pic.sorrycc.com`, new architecture (Worker + GitHub), updated env var list (no `MAX_CACHE_SIZE_MB`, no `CACHE_CLEANUP_INTERVAL_HOURS`, no `PORT`), updated deploy instructions (`wrangler deploy`).
10. The repo no longer contains `cache/`, `tmp/`, the `setInterval` cleanup logic, the Express dependency, or any reference to `pngquant` / `jpegoptim` / `gifsicle`.

## 4. Problem Analysis

- **Approach A — Pages Functions** → rejected. Pages is built around static-site repos with `functions/`; for a single-purpose API Worker it adds repo structure noise and slower cold-iteration. No upside here.
- **Approach B — Worker + Hono router** → rejected as YAGNI. Two routes (`POST /api/upload`, `GET /<filename>`) don't justify the dependency. Plain `fetch` handler with a 5-line URL switch is clearer.
- **Chosen approach — Single Worker, plain `fetch` handler, JS (not TS)** → minimal surface. Existing repo is JS; staying on JS avoids a TypeScript toolchain the project doesn't otherwise need. Worker uses Web standards (`fetch`, `Request`, `Response`, `caches.default`, `atob` / `Uint8Array`).

## 5. Decision Log

**1. Returned upload URL shape**
- Options: A) `https://pic.sorrycc.com/<filename>` · B) `https://pic.sorrycc.com/proxy/<filename>` · C) `raw.githubusercontent.com/...` direct · D) configurable
- Decision: **A)** — host-as-CDN-prefix is the cleanest shape for new uploads. **Revised in Phase 4 review:** `SITE_PREFIX` is hard-coded as `'https://pic.sorrycc.com/'` in `src/index.js`. **Revised post-deploy:** the original "nothing in the codebase pins `/proxy/`" reasoning was incomplete — the *existing URLs in the wild* (issued under the old Express server's `SITE_PREFIX = https://pic.sorrycc.com/proxy/`) all carry the `/proxy/` segment, and they were 404'ing after deploy. Mitigation: keep `/<file>` as the canonical path returned by `/api/upload`, **and** serve the same content at `/proxy/<file>` so legacy URLs keep working forever. Both routes share validation, cache, and upstream fetch.

**2. GitHub upload failure handling**
- Options: A) 502 JSON, no fallback · B) retry-then-502 · C) R2 emergency bucket
- Decision: **A)** — KISS. The current localhost fallback (`index.js:371-374`) is unreachable to remote clients anyway. No retry in v1; uploads are interactive. Filename collisions are a non-issue: `${Date.now()}-${Math.round(Math.random()*1e9)}` collides at ~0 probability per ms, so the 409-on-collision case doesn't need a dedicated error code.

**3. Read-path caching**
- Options: A) CF Cache API only · B) keep some disk-equivalent · C) custom KV cache layer
- Decision: **A)** — `caches.default` keyed by request URL, `Cache-Control: public, max-age=31536000, immutable`. Filenames are unique-suffixed so entries are effectively immutable; CF does LRU eviction per colo. No manual cleanup needed.

**4. Secrets vs config**
- Options: A) secrets for sensitive + `[vars]` for non-sensitive · B) all secrets · C) all `[vars]` + `.dev.vars`
- Decision: **A)** — `TOKEN` + `GITHUB_TOKEN` via `wrangler secret put`; `GITHUB_OWNER` + `GITHUB_REPO` + `GITHUB_BRANCH` as `[vars]` in `wrangler.toml`. `.dev.vars` (gitignored) carries secrets locally. **Revised in Phase 4 review:** the original `GITHUB_REPO=owner/repo/branch` triple required string-splitting at runtime — replaced with three discrete vars to remove the parsing step and make the config self-documenting.

**5. Local dev workflow**
- Options: A) `wrangler dev` local mode · B) `wrangler dev --remote` · C) staging-only on `*.workers.dev`
- Decision: **A)** — fastest iteration, Cache API works locally, no CF-specific bindings (no R2/KV/D1) needed.

**6. Upload request/response contract**
- Options: A) identical to current · B) breaking change
- Decision: **A)** — `POST /api/upload`, `Authorization: Bearer <TOKEN>`, body `{ file, fileName }`, response `{ data: <url> }`. Server-side filename `${Date.now()}-${rand}${ext}`. Drop the dead `sanitizedBasename` variable.

**7. Read-path filename whitelist**
- Options: A) strict regex · B) any non-slash · C) other
- Decision: **A)** `^[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.(png|jpg|jpeg|gif|webp|svg)$`; 404 on non-match. Closes a latent open-proxy issue in `index.js:389-439`. **Revised in Phase 4 review:** leading dot disallowed (first character class excludes `.`) so dotfiles like `.hidden.png` are also rejected — uploads never produce them.

**8. Upload size cap**
- Options: A) 25 MB binary · B) 50 MB · C) no limit
- Decision: **A)** — 25 MB on the **decoded** binary, since GitHub's Contents API limit applies to the file, not the base64 envelope. Enforced in two places: (1) fast-path 413 if `Content-Length > 34 MB` (≈ 25 MB × 4/3 base64 inflation, plus JSON overhead) when the header is present, (2) post-`atob` 413 on `bytes.length > 25 * 1024 * 1024`. **Practical ceiling on free Workers tier: ~4.5 MB binary** (the 6 MB request-body cap divided by base64 inflation). User accepts that.

**9. Language**
- Options: A) JS (ESM) · B) TypeScript
- Decision: **A)** — the existing repo is JS; YAGNI on adding a TS toolchain for ~150 LOC. Workers types via JSDoc if needed.

## 6. Design

### 6.1 File layout

```
.
├── src/
│   └── index.js          ← Worker entry (default export { fetch })
├── wrangler.toml         ← name, main, compatibility_date, [vars], routes
├── .dev.vars.example     ← TOKEN= / GITHUB_TOKEN= template
├── .gitignore            ← adds .dev.vars, .wrangler/, dist/
├── package.json          ← drops express/body-parser/node-fetch/dotenv; adds wrangler devDep
├── test-upload.js        ← retargeted to localhost:8787
├── README.md             ← rewritten for Worker + GitHub
├── docs/designs/2026-04-30-cloudflare-worker-refactor.md
└── upic.png              ← test fixture (kept)
```

Removed entirely: `index.js` (root), `cache/`, `tmp/`, `images/`. `package-lock.json` regenerated and committed on first install.

### 6.2 Worker shape (`src/index.js`)

Single default export with a `fetch(request, env, ctx)` handler. Internal pseudo-routes:

```js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/api/upload') {
      return handleUpload(request, env);
    }
    if (request.method === 'GET') {
      return handleGet(request, env, ctx);  // single 404 producer for all non-matching GETs
    }
    return new Response('Not Found', { status: 404 });
  }
};
```

`handleGet`'s filename regex (6.4 step 1) acts as the single 404 producer for everything that's not a valid image read — including `GET /`, `GET /api/upload`, `GET /foo/bar`, etc. No second 404 path.

### 6.3 `handleUpload`

1. Bearer-auth: extract `Authorization: Bearer <token>`, compare to `env.TOKEN` (plain equality is fine for a single-user service; constant-time compare is YAGNI). Missing header → 401, mismatch → 403. Auth runs **before** any body inspection so unauthorized requests never reach size/decode logic — keeps log noise low and avoids using decode CPU on attacker traffic.
2. Fast-path size check: if `Content-Length` header is present and > 34 MB (≈ 25 MB binary inflated by base64 + JSON overhead), return 413 immediately.
3. Parse JSON body; require `file` (base64 string) and `fileName` (string).
4. Decode base64 via `atob`. Wrap in `try`/`catch` — invalid input → 400 `{ error: 'Invalid base64 data' }`. (Replaces the regex check; simpler and uses the runtime's actual decoder.)
5. Verify decoded byte length ≤ 25 MB; otherwise 413.
6. Generate `${Date.now()}-${Math.round(Math.random()*1e9)}${ext}` (ext from `fileName`, default `.jpg`).
7. PUT `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${filename}` with body `JSON.stringify({ message: 'Upload ' + filename, content: <original base64 string>, branch: env.GITHUB_BRANCH })`. Headers: `Authorization: token <env.GITHUB_TOKEN>`, `User-Agent: pic-sorrycc-worker`, `Content-Type: application/json`, `Accept: application/vnd.github+json`.
8. On 2xx: return `{ data: SITE_PREFIX + filename }` (where `SITE_PREFIX` is the hard-coded module constant `'https://pic.sorrycc.com/'`). On non-2xx: `console.error` the upstream status + first 500 chars of the body (visible via `wrangler tail`), return 502 with `{ error: 'GitHub upload failed' }`. Catch network/`fetch` rejections the same way (502).

### 6.4 `handleGet`

1. Strip leading `/` from `url.pathname`, then strip an optional single `proxy/` prefix (legacy-URL compat — see Decision #1's post-deploy revision). Test the resulting name against `^[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.(png|jpg|jpeg|gif|webp|svg)$`. On non-match → 404. Rejection rationale per case:
   - `sub/foo.png`, `proxy/sub/foo.png` → after at most one `proxy/` strip, still contains `/`; character class never matches `/`.
   - `../package.json` (after `URL` normalization of `..`) → contains `/`, same.
   - `.foo.png`, `.hidden` → first char is `.`, blocked by the leading `[a-zA-Z0-9_-]` (no dot).
   - `anything.js`, `package.json` → extension not in the alternation.
2. Cache lookup. `const cache = caches.default; const hit = await cache.match(request);` → if hit, return it directly. Validation runs first so a future regex tightening can't be bypassed by a previously-cached entry under a now-invalid name.
3. On miss: `fetch(\`https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/refs/heads/${env.GITHUB_BRANCH}/${filename}\`)`.
   - Wrap in `try`/`catch` — network/fetch rejection → 502.
   - Upstream `404` → 404 to client.
   - Other non-2xx → 502.
4. Read upstream body once: `const buf = await upstream.arrayBuffer()`. Build a fresh response:
   ```js
   const headers = new Headers({
     'Content-Type': contentTypeFor(ext),
     'Cache-Control': 'public, max-age=31536000, immutable',
     'Content-Length': String(buf.byteLength),
   });
   const response = new Response(buf, { status: 200, headers });
   ```
   This explicitly **strips** upstream `Cache-Control` (raw.githubusercontent.com sends ~5 min), `ETag`, `Expires`, `Set-Cookie` — only the headers above are forwarded. Reading into an `ArrayBuffer` once also sidesteps the "body already consumed" trap when both serving and caching.
5. `ctx.waitUntil(cache.put(request, response.clone()))` — clone for cache, return original.
6. Content-Type map: `.png → image/png`, `.jpg|.jpeg → image/jpeg`, `.gif → image/gif`, `.webp → image/webp`, `.svg → image/svg+xml`.

### 6.5 `wrangler.toml`

```toml
name = "pic-sorrycc-com"
main = "src/index.js"
compatibility_date = "2026-04-01"

[vars]
GITHUB_OWNER  = "sorrycc"
GITHUB_REPO   = "pic.sorrycc.com"
GITHUB_BRANCH = "master"

# Custom domain. Activated after the user transfers the zone to their CF account.
# Until then, the routes block stays commented and deploy targets *.workers.dev.
# [[routes]]
# pattern = "pic.sorrycc.com/*"
# zone_name = "sorrycc.com"
# custom_domain = true
```

`SITE_PREFIX` is intentionally not a var — it's hard-coded in `src/index.js` since there's exactly one consumer.

### 6.6 `.dev.vars.example`

```
TOKEN=
GITHUB_TOKEN=
```

`.dev.vars` (gitignored) is what `wrangler dev` actually reads.

### 6.7 `package.json`

```json
{
  "name": "pic-sorrycc-com",
  "version": "2.0.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "node test-upload.js"
  },
  "devDependencies": {
    "wrangler": "^3.90.0"
  }
}
```

No runtime dependencies. `node-fetch` / `dotenv` / `express` / `body-parser` / `form-data` all dropped.

### 6.8 `test-upload.js`

Stays in plain Node 18+, uses global `fetch`. Drops `dotenv` and `node-fetch` requires. Reads `TOKEN` directly from `process.env`. Endpoint configurable via `process.env.UPLOAD_URL`, default `http://localhost:8787/api/upload`.

Invocation: `TOKEN=xxx node test-upload.js [path/to/image]`. Documented in the README.

### 6.9 README

Rewritten sections: title (new repo name), what-it-does (1 paragraph), env vars list, local dev (`wrangler dev` + `.dev.vars`), deploy (`wrangler login`, `wrangler secret put TOKEN`, `wrangler secret put GITHUB_TOKEN`, `wrangler deploy`), note about the manual zone transfer, and the `TOKEN=xxx node test-upload.js` smoke-test invocation.

### 6.10 Error handling boundaries

- Upload path: any thrown error inside `handleUpload` → 500 generic JSON. Specific cases (auth, size, base64, GitHub) → their tailored status codes. No stack traces leaked.
- Get path: validation fail → 404; upstream 404 → 404; upstream non-404 non-2xx → 502; network/`fetch` rejection → 502.
- `console.log`/`console.error` for observability (`wrangler tail`).

## 7. Files Changed

- `src/index.js` — **new**. Worker entry: upload + proxy + cache + auth + size cap + filename whitelist.
- `wrangler.toml` — **new**. Worker config, `[vars]`, custom-domain route.
- `.dev.vars.example` — **new**. Local secrets template.
- `.gitignore` — **modified**. Add `.dev.vars`, `.wrangler/`, `dist/`. Remove obsolete entries (`cache/`, `tmp/`, `images/`).
- `package.json` — **rewritten**. Drop runtime deps, add `wrangler` devDep, new scripts.
- `test-upload.js` — **modified**. Retarget to `process.env.UPLOAD_URL || 'http://localhost:8787/api/upload'`. Drop `dotenv`/`node-fetch` requires.
- `README.md` — **rewritten**. New repo name, Worker architecture, new env list, deploy steps.
- `index.js` — **deleted**. Old Express server.
- `cache/`, `tmp/`, `images/` — **deleted** (no Worker equivalent needed).
- `package-lock.json` — **regenerated** (committed) on first `npm install`. The `.wrangler/` runtime cache is gitignored.
- `.env.example`, `.env` — **deleted** (superseded by `.dev.vars.example`).

## 8. Verification

All steps assume implementation is complete (Phase 5 done) and run from the repo root.

1. [AC1] `npx wrangler deploy --dry-run` succeeds; the bundled output contains no Express, no Node `fs`/`path` imports.
2. [AC2] Run `wrangler dev` locally with valid `.dev.vars`; `TOKEN=xxx node test-upload.js` returns `{ data: "https://pic.sorrycc.com/<ts>-<rand>.png" }` and the file appears on `github.com/sorrycc/pic.sorrycc.com`.
3. [AC3] `curl -X POST localhost:8787/api/upload -H 'Content-Type: application/json' --data '{}'` → 401. Same with `Authorization: Bearer wrong` → 403.
4. [AC4] After upload, `curl -i localhost:8787/<filename>` returns 200 with `Content-Type: image/png`, `Cache-Control: public, max-age=31536000, immutable`, and a `Content-Length` matching the file. Once deployed to CF, second request shows `cf-cache-status: HIT`. (In `wrangler dev`, Cache API stores work but the header isn't set; inspect by re-running and confirming the upstream `fetch` is not called — log line absent on the second request.)
5. [AC5] Five whitelist/traversal cases all return 404, each exercising a different rejection rule from 6.4 step 1:
   - (a) `curl -i localhost:8787/sub/foo.png` — slash in pathname.
   - (b) `curl -i 'localhost:8787/..%2Fpackage.json'` — `URL` normalizes to `/../package.json`, slash rejects after stripping the leading `/`.
   - (c) `curl -i localhost:8787/.hidden.png` — leading dot blocked by first-char class.
   - (d) `curl -i localhost:8787/anything.js` — extension not in alternation.
   - (e) `curl -i localhost:8787/proxy/sub/foo.png` — only one `proxy/` segment is stripped; the residual `sub/` keeps the slash.

   Plus a positive case: `curl -i localhost:8787/proxy/<existing-file>.png` returns 200 (legacy URL compat).
6. [AC6] Two independent paths:
   - 6a (fast-path): send a body of ~36 MB so curl sets `Content-Length: ~37748736` (> 34 MB cap). Expect 413; the worker log shows the fast-path message and no `atob` invocation.
   - 6b (post-`atob`): force chunked transfer so `Content-Length` is absent — `curl -X POST ... -H 'Transfer-Encoding: chunked' -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' --data-binary @body.json` where `body.json` is `{"file":"<base64 of 26 MB of zeros>","fileName":"x.png"}`. Expect 413 from the post-`atob` branch. (Note: `wrangler dev`'s upstream proxy may inject `Content-Length` regardless — if so, this path is verifiable only via unit test of the `handleUpload` function.)
7. [AC7] Edit `.dev.vars` to set `GITHUB_TOKEN=bogus`, restart `wrangler dev`, run the test script. Assert HTTP 502 and JSON body `{"error":"GitHub upload failed"}`.
8. [AC8] `wrangler dev` boots on `:8787` purely locally (no `--remote`); the test script passes against it.
9. [AC9] `grep -E 'upic-github|MAX_CACHE_SIZE_MB|CACHE_CLEANUP_INTERVAL_HOURS|PORT=' README.md` → no matches.
10. [AC10] `ls cache tmp images 2>&1 | grep -c 'No such'` → 3. `grep -rE 'pngquant|jpegoptim|gifsicle|setInterval' src/` → no matches. `grep -E 'express|body-parser|node-fetch|dotenv|form-data' package.json` → no matches.
