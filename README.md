# pic.sorrycc.com

Single-file Cloudflare Worker that uploads images to a GitHub repo and serves them back through `pic.sorrycc.com`, edge-cached.

- `POST /api/upload` — bearer-auth, accepts `{ file: <base64>, fileName }`, commits to `github.com/sorrycc/pic.sorrycc.com`, returns `{ data: "https://pic.sorrycc.com/<unique>.<ext>" }`.
- `GET /<filename>` — proxies `raw.githubusercontent.com`, cached at the edge for one year. Strict filename whitelist (PNG/JPG/GIF/WEBP/SVG only).

## Configuration

Non-secret config lives in `wrangler.toml`:

- `GITHUB_OWNER` — `sorrycc`
- `GITHUB_REPO` — `pic.sorrycc.com`
- `GITHUB_BRANCH` — `master`

Secrets are stored via `wrangler secret put`:

- `TOKEN` — bearer token clients send to `/api/upload`
- `GITHUB_TOKEN` — GitHub PAT with `contents:write` on the storage repo

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in `TOKEN` and `GITHUB_TOKEN`. `.dev.vars` is gitignored.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in the secrets
npm run dev                      # wrangler dev on http://localhost:8787
```

Smoke test in another shell:

```bash
TOKEN=<your token> node test-upload.js          # uploads upic.png
TOKEN=<your token> node test-upload.js path/to/file.png
```

## Deploy

The `pic.sorrycc.com` zone is not yet in this Cloudflare account. Deploy in two stages:

**Stage 1 — workers.dev only (works today):**

```bash
wrangler login                          # refresh expired oauth
wrangler secret put TOKEN               # paste the bearer token
wrangler secret put GITHUB_TOKEN        # paste the GitHub PAT
wrangler deploy                         # ships to pic-sorrycc-com.<account>.workers.dev
```

**Stage 2 — custom domain (after zone transfer):**

1. Add `sorrycc.com` to the Cloudflare account (registrar nameserver change).
2. Uncomment the `[[routes]]` block in `wrangler.toml`.
3. `wrangler deploy` again — the route binds `pic.sorrycc.com/*` to the Worker.

## Limits

- Upload max size: 25 MB binary (GitHub Contents API limit). On the **free** Workers plan, request bodies are capped at ~6 MB, which translates to ~4.5 MB binary after base64 inflation. Upgrade to Workers Paid if you need more.
- Allowed extensions on read: `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`. Anything else → 404.
- No image compression. Compress client-side before upload if you want it.
