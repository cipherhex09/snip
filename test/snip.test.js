import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, FormData } from "miniflare";

let mf;
let tokenMf;
const BASE = "http://snip.test";

before(async () => {
  const common = { modules: true, scriptPath: "src/index.js", modulesRules: [{ type: "ESModule", include: ["**/*.js"] }], kvNamespaces: ["SNIPS"], compatibilityDate: "2026-08-01" };
  mf = new Miniflare({ ...common, bindings: { MAX_BYTES: "2048" } });
  tokenMf = new Miniflare({ ...common, bindings: { SNIP_TOKEN: "s3cret" } });
});

after(async () => {
  await mf.dispose();
  await tokenMf.dispose();
});

const post = (body, query = "", headers = {}, m = mf) =>
  m.dispatchFetch(`${BASE}/${query}`, { method: "POST", body, headers });

test("paste round trip over curl-style requests", async () => {
  const res = await post("hello\nworld\n");
  assert.equal(res.status, 201);
  const link = (await res.text()).trim();
  assert.match(link, /^http:\/\/snip\.test\/[2-9a-zA-Z]{6}$/);
  assert.ok(res.headers.get("x-delete-token"));

  const raw = await mf.dispatchFetch(link);
  assert.equal(await raw.text(), "hello\nworld\n");
  assert.equal(await (await mf.dispatchFetch(link + "/raw", { headers: { Accept: "text/html" } })).text(), "hello\nworld\n");
});

test("browsers get an escaped HTML view", async () => {
  const link = (await (await post("<script>alert(1)</script>")).text()).trim();
  const res = await mf.dispatchFetch(link, { headers: { Accept: "text/html" } });
  const body = await res.text();
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.ok(body.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!body.includes("<script>alert(1)"));
  assert.ok(res.headers.get("content-security-policy").includes("default-src 'none'"));
});

test("a bare URL becomes a short link", async () => {
  const link = (await (await post("https://example.com/some/long/path?q=1\n")).text()).trim();
  const res = await mf.dispatchFetch(link, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://example.com/some/long/path?q=1");
});

test("curl -d sends raw text with a form content type", async () => {
  const form = { "Content-Type": "application/x-www-form-urlencoded" };
  const link = (await (await post("https://example.com/a?b=c", "", form)).text()).trim();
  assert.equal((await mf.dispatchFetch(link, { redirect: "manual" })).headers.get("location"), "https://example.com/a?b=c");

  const paste = (await (await post("a=1&b=2 plain text", "", form)).text()).trim();
  assert.equal(await (await mf.dispatchFetch(paste)).text(), "a=1&b=2 plain text");

  // A no-JavaScript form post is redirected to the new paste.
  const real = await mf.dispatchFetch(`${BASE}/`, { method: "POST", body: "content=from+a+form&ttl=1h", headers: form, redirect: "manual" });
  assert.equal(real.status, 303);
  assert.equal(await (await mf.dispatchFetch(real.headers.get("location"))).text(), "from a form");
});

test("type=paste keeps a URL as text", async () => {
  const link = (await (await post("https://example.com", "?type=paste")).text()).trim();
  const res = await mf.dispatchFetch(link, { redirect: "manual" });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "https://example.com");
});

test("javascript: URLs are never links", async () => {
  const res = await post("javascript:alert(1)", "?type=link");
  assert.equal(res.status, 400);
});

test("custom slugs, and taken slugs are refused", async () => {
  const first = await post("https://example.com", "?slug=docs");
  assert.equal((await first.text()).trim(), `${BASE}/docs`);
  assert.equal((await post("https://example.org", "?slug=docs")).status, 409);
  assert.equal((await post("x", "?slug=raw")).status, 400);
  assert.equal((await post("x", "?slug=a/b")).status, 400);
});

test("burn after reading survives link previews and dies on first real read", async () => {
  const link = (await (await post("one time secret", "?burn=1")).text()).trim();

  const bot = await mf.dispatchFetch(link, { headers: { "User-Agent": "Mozilla/5.0 (compatible; Discordbot/2.0)" } });
  assert.ok((await bot.text()).includes("deleted as soon as you open it"));

  const browser = await mf.dispatchFetch(link, { headers: { Accept: "text/html" } });
  assert.ok((await browser.text()).includes("Open it"));

  const opened = await mf.dispatchFetch(link + "/open", { method: "POST", headers: { Accept: "text/html" } });
  assert.ok((await opened.text()).includes("one time secret"));

  assert.equal((await mf.dispatchFetch(link)).status, 404);
});

test("curl reads a burn paste once", async () => {
  const link = (await (await post("gone soon", "?burn=1", { "User-Agent": "curl/8.7.1" })).text()).trim();
  const first = await mf.dispatchFetch(link, { headers: { "User-Agent": "curl/8.7.1" } });
  assert.equal(await first.text(), "gone soon");
  assert.equal((await mf.dispatchFetch(link, { headers: { "User-Agent": "curl/8.7.1" } })).status, 404);
});

test("delete needs the right token", async () => {
  const res = await post("delete me");
  const link = (await res.text()).trim();
  const token = res.headers.get("x-delete-token");

  assert.equal((await mf.dispatchFetch(link, { method: "DELETE" })).status, 401);
  assert.equal((await mf.dispatchFetch(link, { method: "DELETE", headers: { Authorization: "Bearer nope" } })).status, 403);
  assert.equal((await mf.dispatchFetch(link, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await mf.dispatchFetch(link)).status, 404);
});

test("JSON in, JSON out", async () => {
  const res = await post(JSON.stringify({ content: "from json", ttl: "1h" }), "", {
    "Content-Type": "application/json",
    Accept: "application/json",
  });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.kind, "paste");
  assert.ok(data.expires > Date.now());
  assert.equal(await (await mf.dispatchFetch(data.raw)).text(), "from json");
});

test("form uploads with a file field", async () => {
  const form = new FormData();
  form.set("file", new Blob(["file body"]), "notes.txt");
  form.set("ttl", "1d");
  const res = await mf.dispatchFetch(`${BASE}/`, { method: "POST", body: form, headers: { Accept: "application/json" } });
  const data = await res.json();
  assert.equal(await (await mf.dispatchFetch(data.url)).text(), "file body");
});

test("limits and bad input", async () => {
  assert.equal((await post("x".repeat(3000))).status, 413);
  assert.equal((await post("   ")).status, 400);
  assert.equal((await post("x", "?ttl=forever")).status, 400);
  assert.equal((await post("https://example.com", "?burn=1")).status, 400);
  assert.equal((await mf.dispatchFetch(`${BASE}/missing`)).status, 404);
});

test("token mode guards creation but not reading", async () => {
  assert.equal((await post("hi", "", {}, tokenMf)).status, 401);
  const ok = await post("hi", "", { Authorization: "Bearer s3cret" }, tokenMf);
  assert.equal(ok.status, 201);
  const link = (await ok.text()).trim();
  assert.equal(await (await tokenMf.dispatchFetch(link)).text(), "hi");
});

test("home page renders", async () => {
  const res = await mf.dispatchFetch(`${BASE}/`, { headers: { Accept: "text/html" } });
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes("Snip it"));
});
