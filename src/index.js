const SITE_PREFIX = 'https://pic.sorrycc.com/';

const FAST_PATH_BYTE_LIMIT = 34 * 1024 * 1024;
const BINARY_BYTE_LIMIT = 25 * 1024 * 1024;

const FILENAME_RE = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.(png|jpg|jpeg|gif|webp|svg)$/;

const CONTENT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/api/upload') {
      return handleUpload(request, env);
    }
    if (request.method === 'GET') {
      return handleGet(request, env, ctx);
    }
    return new Response('Not Found', { status: 404 });
  },
};

async function handleUpload(request, env) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return jsonError(401, 'Access token required');
  if (token !== env.TOKEN) return jsonError(403, 'Invalid access token');

  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > FAST_PATH_BYTE_LIMIT) {
    return jsonError(413, 'Payload too large');
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'Invalid JSON body');
  }
  const { file, fileName } = body || {};
  if (typeof file !== 'string' || typeof fileName !== 'string') {
    return jsonError(400, 'Missing file or fileName');
  }

  // Tolerate a data-URL prefix and any whitespace/newlines some clients add,
  // matching the old Buffer.from(..., 'base64') leniency.
  const cleaned = file.replace(/^data:[^,]*;base64,/, '').replace(/\s+/g, '');
  let bytes;
  try {
    bytes = atob(cleaned);
  } catch {
    return jsonError(400, 'Invalid base64 data');
  }
  if (bytes.length > BINARY_BYTE_LIMIT) {
    return jsonError(413, 'Payload too large');
  }

  const ext = extractExt(fileName);
  const generated = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;

  const ghUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${generated}`;
  let upstream;
  try {
    upstream = await fetch(ghUrl, {
      method: 'PUT',
      headers: {
        Authorization: `token ${env.GITHUB_TOKEN}`,
        'User-Agent': 'pic-sorrycc-worker',
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
      },
      body: JSON.stringify({
        message: `Upload ${generated}`,
        content: cleaned,
        branch: env.GITHUB_BRANCH,
      }),
    });
  } catch (err) {
    console.error('GitHub fetch threw:', String(err).slice(0, 500));
    return jsonError(502, 'GitHub upload failed');
  }

  if (!upstream.ok) {
    const snippet = (await upstream.text()).slice(0, 500);
    console.error(`GitHub upload ${upstream.status}:`, snippet);
    // Surface the upstream status so a broken/expired GITHUB_TOKEN (401/403)
    // is obvious to the client instead of a generic, undiagnosable 502.
    return jsonError(502, `GitHub upload failed (${upstream.status})`);
  }

  return Response.json({ data: SITE_PREFIX + generated });
}

async function handleGet(request, env, ctx) {
  const url = new URL(request.url);
  let filename = url.pathname.slice(1);
  if (filename.startsWith('proxy/')) filename = filename.slice(6);
  if (!FILENAME_RE.test(filename)) {
    return new Response('Not Found', { status: 404 });
  }

  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;

  const rawUrl = `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/refs/heads/${env.GITHUB_BRANCH}/${filename}`;
  let upstream;
  try {
    upstream = await fetch(rawUrl);
  } catch (err) {
    console.error('raw fetch threw:', String(err).slice(0, 500));
    return new Response('Bad Gateway', { status: 502 });
  }
  if (upstream.status === 404) return new Response('Not Found', { status: 404 });
  if (!upstream.ok) {
    console.error(`raw upstream ${upstream.status} for ${filename}`);
    return new Response('Bad Gateway', { status: 502 });
  }

  const buf = await upstream.arrayBuffer();
  const ext = filename.split('.').pop().toLowerCase();
  const headers = new Headers({
    'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Length': String(buf.byteLength),
  });
  const response = new Response(buf, { status: 200, headers });
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

function extractExt(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '.jpg';
  const ext = name.slice(dot).toLowerCase();
  return /^\.[a-z0-9]+$/.test(ext) ? ext : '.jpg';
}

function jsonError(status, error) {
  return Response.json({ error }, { status });
}
