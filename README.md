# pic.sorrycc.com

Single-file Cloudflare Worker that uploads images to a GitHub repo and serves them back through `pic.sorrycc.com`, edge-cached.

- `POST /api/upload` — bearer-auth, accepts `{ file: <base64>, fileName }`, commits to `github.com/sorrycc-bot/image-2025-08`, returns `{ data: "https://pic.sorrycc.com/<unique>.<ext>" }`.
- `GET /<filename>` — proxies `raw.githubusercontent.com`, cached at the edge for one year. Strict filename whitelist (PNG/JPG/GIF/WEBP/SVG only).

## Configuration

Non-secret config lives in `wrangler.toml`:

- `GITHUB_OWNER` — `sorrycc-bot`
- `GITHUB_REPO` — `image-2025-08`
- `GITHUB_BRANCH` — `main`

Secrets are stored via `wrangler secret put`:

- `TOKEN` — bearer token clients send to `/api/upload`
- `GITHUB_TOKEN` — GitHub PAT with `contents:write` on the storage repo. **This token expires; when uploads start returning `502 GitHub upload failed (401)`, regenerate the PAT and re-run `wrangler secret put GITHUB_TOKEN`.**

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

The `pic.sorrycc.com` custom domain is already bound (see the `[[routes]]` block in `wrangler.toml`). To ship changes:

```bash
wrangler login                          # refresh expired oauth
wrangler secret put TOKEN               # only if rotating the client bearer token
wrangler secret put GITHUB_TOKEN        # only if rotating the GitHub PAT
wrangler deploy                         # ships to pic.sorrycc.com
```

Secrets persist across deploys, so a plain `wrangler deploy` is enough for code-only changes.

## Limits

- Upload max size: 25 MB binary (GitHub Contents API limit). On the **free** Workers plan, request bodies are capped at ~6 MB, which translates to ~4.5 MB binary after base64 inflation. Upgrade to Workers Paid if you need more.
- Allowed extensions on read: `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`. Anything else → 404.
- No image compression. Compress client-side before upload if you want it.
