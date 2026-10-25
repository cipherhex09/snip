// snip: a paste bin and link shortener in one Cloudflare Worker.
//
// Every snip is one KV entry. The value is the paste text or the target URL,
// and the metadata says which it is, whether it burns after reading, and the
// hash of its delete token. KV expiry handles TTLs, so there is no cleanup job.

import { page, viewPage, burnPage, notFoundPage } from "./html.js";

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const TTLS = { "10m": 600, "1h": 3600, "1d": 86400, "7d": 604800, "30d": 2592000, never: 0 };
const DEFAULT_TTL = "7d";
const SLUG_RE = /^[A-Za-z0-9_-]{2,64}$/;
const RESERVED = new Set(["raw", "api", "new", "favicon.ico", "robots.txt"]);

// Link preview bots fetch every URL posted in chat. If they could read a
// burn-after-reading paste, it would be gone before the person opened it.
const UNFURLERS = /bot|crawl|spider|preview|slack|discord|telegram|whatsapp|facebookexternalhit|embedly|skype|teams/i;

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      if (err instanceof HttpError) return text(err.message + "\n", err.status);
      console.error(err);
      return text("internal error\n", 500);
    }
  },
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function handle(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const method = request.method;

  if (parts.length === 0) {
    if (method === "GET" || method === "HEAD") {
      return html(page({ needsToken: Boolean(env.SNIP_TOKEN), maxBytes: maxBytes(env) }));
    }
    if (method === "POST" || method === "PUT") return create(request, env, url);
    return text("method not allowed\n", 405);
  }

  if (parts[0] === "robots.txt") return text("User-agent: *\nDisallow: /\n");
  if (parts.length > 2) return notFound(request);

  const id = parts[0];
  const action = parts[1];

  if (method === "DELETE" && !action) return remove(request, env, id);
  if (method === "POST" && action === "open") return open(env, id, true);
  if ((method === "GET" || method === "HEAD") && (!action || action === "raw")) {
    return read(request, env, id, action === "raw");
  }
  return notFound(request);
}

async function create(request, env, url) {
  if (env.SNIP_TOKEN && bearer(request) !== env.SNIP_TOKEN) {
    throw new HttpError(401, "this snip server needs a token: send Authorization: Bearer <token>");
  }

  const input = await readInput(request, url, maxBytes(env));
  const ttlName = input.ttl || DEFAULT_TTL;
  if (!(ttlName in TTLS)) {
    throw new HttpError(400, `ttl must be one of ${Object.keys(TTLS).join(", ")}`);
  }
  const ttl = TTLS[ttlName];

  const body = input.body;
  if (!body.trim()) throw new HttpError(400, "nothing to snip: send some text or a URL");

  const asLink = input.type === "link" || (input.type !== "paste" && looksLikeUrl(body));
  if (asLink && !looksLikeUrl(body)) throw new HttpError(400, "a link must be one http(s) URL");
  if (asLink && input.burn) throw new HttpError(400, "burn after reading is for pastes, not links");

  let id;
  if (input.slug) {
    if (!SLUG_RE.test(input.slug) || RESERVED.has(input.slug)) {
      throw new HttpError(400, "slug must be 2 to 64 letters, numbers, _ or -");
    }
    if (await env.SNIPS.get(input.slug, "stream")) throw new HttpError(409, "that slug is taken");
    id = input.slug;
  } else {
    id = await freshId(env);
  }

  const deleteToken = randomString(24);
  const metadata = {
    kind: asLink ? "link" : "paste",
    burn: Boolean(input.burn),
    created: Date.now(),
    expires: ttl ? Date.now() + ttl * 1000 : null,
    del: await sha256(deleteToken),
  };
  const options = { metadata };
  if (ttl) options.expirationTtl = ttl;
  await env.SNIPS.put(id, asLink ? body.trim() : body, options);

  const link = `${url.origin}/${id}`;
  const result = { id, url: link, raw: `${link}/raw`, kind: metadata.kind, expires: metadata.expires, burn: metadata.burn, deleteToken };
  const headers = { "X-Delete-Token": deleteToken, Location: link };

  if (wantsJson(request)) return json(result, 201, headers);
  if (input.fromForm) {
    // The browser form expects JSON back, but a plain HTML form post without
    // JavaScript should still land somewhere useful.
    return Response.redirect(link, 303);
  }
  return text(link + "\n", 201, headers);
}

async function readInput(request, url, limit) {
  const q = url.searchParams;
  const out = {
    ttl: q.get("ttl"),
    burn: truthy(q.get("burn")),
    slug: q.get("slug"),
    type: q.get("type"),
    body: "",
    fromForm: false,
  };

  const len = Number(request.headers.get("content-length") || 0);
  if (len > limit) throw new HttpError(413, `too big: the limit is ${limit} bytes`);

  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const data = await request.json().catch(() => {
      throw new HttpError(400, "invalid JSON");
    });
    out.body = String(data.content ?? data.text ?? data.url ?? "");
    out.ttl = data.ttl ?? out.ttl;
    out.burn = data.burn ?? out.burn;
    out.slug = data.slug ?? out.slug;
    out.type = data.type ?? out.type;
  } else if (type.includes("application/x-www-form-urlencoded") && !(await isFormPost(request))) {
    // `curl -d @file` sends this content type for raw data, so treat it as
    // plain text unless it actually carries the form's fields.
    out.body = await request.text();
  } else if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    const file = form.get("file");
    out.body = file && typeof file === "object" ? await file.text() : String(form.get("content") ?? "");
    out.ttl = form.get("ttl") || out.ttl;
    out.burn = truthy(form.get("burn")) || out.burn;
    out.slug = form.get("slug") || out.slug;
    out.type = form.get("type") || out.type;
    out.fromForm = !wantsJson(request);
  } else {
    out.body = await request.text();
  }

  if (new TextEncoder().encode(out.body).length > limit) {
    throw new HttpError(413, `too big: the limit is ${limit} bytes`);
  }
  out.slug = out.slug ? String(out.slug).trim() : null;
  out.ttl = out.ttl ? String(out.ttl) : null;
  return out;
}

async function isFormPost(request) {
  const params = new URLSearchParams(await request.clone().text());
  return params.has("content");
}

async function read(request, env, id, raw) {
  const { value, metadata } = await env.SNIPS.getWithMetadata(id);
  if (value === null || !metadata) return notFound(request);

  if (metadata.kind === "link") {
    return new Response(null, { status: 302, headers: { Location: value, "Cache-Control": "no-store" } });
  }

  const browser = acceptsHtml(request);
  const bot = UNFURLERS.test(request.headers.get("user-agent") || "");

  if (metadata.burn) {
    // Browsers get a button so prefetching or a preview cannot spend the paste.
    if (browser || bot) return html(burnPage(id), 200, { "X-Robots-Tag": "noindex" });
    return open(env, id, false);
  }

  if (raw || !browser) return text(value, 200, { "Cache-Control": "private, max-age=60" });
  return html(viewPage({ id, content: value, metadata }), 200, { "X-Robots-Tag": "noindex" });
}

async function open(env, id, fromButton) {
  const { value, metadata } = await env.SNIPS.getWithMetadata(id);
  if (value === null || !metadata || metadata.kind !== "paste") {
    return fromButton ? html(notFoundPage(), 404) : text("not found\n", 404);
  }
  if (metadata.burn) await env.SNIPS.delete(id);
  if (fromButton) return html(viewPage({ id, content: value, metadata, burned: metadata.burn }), 200, { "X-Robots-Tag": "noindex" });
  return text(value, 200, { "Cache-Control": "no-store" });
}

async function remove(request, env, id) {
  const token = bearer(request) || new URL(request.url).searchParams.get("token");
  if (!token) throw new HttpError(401, "send the delete token as Authorization: Bearer <token>");
  const { value, metadata } = await env.SNIPS.getWithMetadata(id);
  if (value === null || !metadata) return text("not found\n", 404);
  if (!timingSafeEqual(await sha256(token), metadata.del)) throw new HttpError(403, "wrong delete token");
  await env.SNIPS.delete(id);
  return text("deleted\n");
}

async function freshId(env) {
  const length = Number(env.ID_LENGTH) || 6;
  for (let i = 0; i < 5; i++) {
    const id = randomString(length);
    if (!(await env.SNIPS.get(id, "stream"))) return id;
  }
  // Five collisions in a row means the keyspace is crowded. A longer id fixes it.
  return randomString(length + 4);
}

function randomString(n) {
  // Rejection sampling keeps every character equally likely.
  const out = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) {
      if (b < limit && out.length < n) out.push(ALPHABET[b % ALPHABET.length]);
    }
  }
  return out.join("");
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function looksLikeUrl(s) {
  const t = s.trim();
  if (/\s/.test(t) || t.length > 4096) return false;
  try {
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function maxBytes(env) {
  return Number(env.MAX_BYTES) || 1024 * 1024;
}

function bearer(request) {
  const h = request.headers.get("authorization") || "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
}

function truthy(v) {
  return v === true || v === "1" || v === "true" || v === "on" || v === "yes";
}

function acceptsHtml(request) {
  return (request.headers.get("accept") || "").includes("text/html");
}

function wantsJson(request) {
  return (request.headers.get("accept") || "").includes("application/json");
}

function notFound(request) {
  return acceptsHtml(request) ? html(notFoundPage(), 404) : text("not found\n", 404);
}

function text(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}
