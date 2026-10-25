// HTML for the browser side. Kept to one inline stylesheet and a few lines of
// script so the whole thing stays a single Worker with no build step.

const STYLE = `
:root{--bg:#fafafa;--fg:#111;--mute:#6b6b6b;--line:#e3e3e3;--card:#fff;--accent:#111}
@media (prefers-color-scheme:dark){:root{--bg:#0c0c0d;--fg:#ececec;--mute:#8a8a8a;--line:#262628;--card:#141416;--accent:#ececec}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 16px 64px}
header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:24px}
h1{font-size:20px;margin:0;letter-spacing:-.01em}
h1 a{color:inherit;text-decoration:none}
.mute{color:var(--mute);font-size:13px}
textarea,input,select{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:8px}
textarea{width:100%;min-height:340px;padding:14px;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}
textarea:focus,input:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:12px}
.row input[type=text],.row input[type=password],select{padding:8px 10px}
label.check{display:flex;gap:6px;align-items:center;font-size:14px}
button,.btn{font:inherit;font-weight:600;padding:9px 16px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:var(--bg);cursor:pointer;text-decoration:none;display:inline-block}
button.ghost,.btn.ghost{background:transparent;color:var(--fg);border-color:var(--line)}
.grow{flex:1}
.result{margin-top:16px;padding:14px;border:1px solid var(--line);border-radius:8px;background:var(--card);display:none}
.result code{font:14px ui-monospace,Menlo,monospace;word-break:break-all}
.err{color:#c62828}
pre{margin:0;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:auto;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
table{border-collapse:collapse;width:100%}
td{padding:0 14px;vertical-align:top;white-space:pre}
td.n{color:var(--mute);text-align:right;user-select:none;width:1%;border-right:1px solid var(--line);padding-left:14px}
tr:first-child td{padding-top:12px}tr:last-child td{padding-bottom:12px}
.center{text-align:center;padding:80px 0}
footer{margin-top:32px}
footer code{font-size:12px}
`;

function shell(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

export function page({ needsToken, maxBytes }) {
  const kb = Math.round(maxBytes / 1024);
  return shell(
    "snip",
    `<header><h1><a href="/">snip</a></h1><span class="mute">paste text or a URL. up to ${kb} KB</span></header>
<form id="f" method="post" action="/">
  <textarea name="content" id="content" placeholder="Paste text, code, or a link to shorten" autofocus required></textarea>
  <div class="row">
    <select name="ttl" aria-label="Expires">
      <option value="10m">10 minutes</option><option value="1h">1 hour</option>
      <option value="1d">1 day</option><option value="7d" selected>7 days</option>
      <option value="30d">30 days</option><option value="never">never</option>
    </select>
    <label class="check"><input type="checkbox" name="burn" value="1"> burn after reading</label>
    <input type="text" name="slug" placeholder="custom name (optional)" aria-label="Custom name" pattern="[A-Za-z0-9_\\-]{2,64}">
    ${needsToken ? `<input type="password" id="token" placeholder="token" aria-label="Token" autocomplete="current-password">` : ""}
    <span class="grow"></span>
    <button type="submit">Snip it</button>
  </div>
</form>
<div class="result" id="result" aria-live="polite"></div>
<footer class="mute">From a terminal: <code>curl --data-binary @file.txt ${"${location}"}</code> or <code>echo https://example.com | curl -d @- ${"${location}"}</code></footer>
<script>
const f = document.getElementById("f"), out = document.getElementById("result"), tok = document.getElementById("token");
for (const c of document.querySelectorAll("footer code")) c.textContent = c.textContent.replace("\${location}", location.origin);
if (tok) { try { tok.value = localStorage.getItem("snip-token") || ""; } catch {} }
f.addEventListener("submit", async (e) => {
  e.preventDefault();
  const headers = { Accept: "application/json" };
  if (tok && tok.value) { headers.Authorization = "Bearer " + tok.value; try { localStorage.setItem("snip-token", tok.value); } catch {} }
  out.style.display = "block"; out.textContent = "Saving...";
  try {
    const res = await fetch("/", { method: "POST", body: new FormData(f), headers });
    const ct = res.headers.get("content-type") || "";
    if (!res.ok) throw new Error(ct.includes("json") ? (await res.json()).error : (await res.text()).trim());
    const d = await res.json();
    out.innerHTML = "";
    const code = document.createElement("code"); code.textContent = d.url;
    const copy = document.createElement("button"); copy.className = "ghost"; copy.type = "button"; copy.textContent = "Copy";
    copy.onclick = () => navigator.clipboard.writeText(d.url).then(() => copy.textContent = "Copied");
    const row = document.createElement("div"); row.className = "row"; row.style.marginTop = "0";
    const a = document.createElement("a"); a.href = d.url; a.className = "btn ghost"; a.textContent = "Open";
    const grow = document.createElement("span"); grow.className = "grow"; grow.append(code);
    row.append(grow, copy, a);
    const meta = document.createElement("div"); meta.className = "mute"; meta.style.marginTop = "8px";
    meta.textContent = (d.kind === "link" ? "Short link" : "Paste") + (d.burn ? ", deleted after the first view" : "") +
      (d.expires ? ", expires " + new Date(d.expires).toLocaleString() : ", never expires") +
      ". Delete token: " + d.deleteToken;
    out.append(row, meta);
    navigator.clipboard?.writeText(d.url).catch(() => {});
  } catch (err) {
    out.innerHTML = ""; const p = document.createElement("span"); p.className = "err"; p.textContent = err.message; out.append(p);
  }
});
</script>`,
  );
}

export function viewPage({ id, content, metadata, burned = false }) {
  const lines = content.replace(/\n$/, "").split("\n");
  const rows = lines.map((l, i) => `<tr><td class="n">${i + 1}</td><td>${esc(l) || " "}</td></tr>`).join("");
  const expiry = metadata.expires ? `expires <time data-t="${metadata.expires}">${new Date(metadata.expires).toISOString()}</time>` : "never expires";
  const note = burned ? "This paste was deleted when you opened it. Copy it now." : expiry;
  return shell(
    `snip ${id}`,
    `<header><h1><a href="/">snip</a> <span class="mute">/ ${esc(id)}</span></h1>
<span class="row" style="margin:0"><span class="mute">${lines.length} line${lines.length === 1 ? "" : "s"}, ${note}</span>
<button class="ghost" type="button" id="copy">Copy</button>${burned ? "" : `<a class="btn ghost" href="/${esc(id)}/raw">Raw</a>`}</span></header>
<pre><table>${rows}</table></pre>
<textarea id="src" hidden>${esc(content)}</textarea>
<script>
for (const t of document.querySelectorAll("time[data-t]")) t.textContent = new Date(+t.dataset.t).toLocaleString();
const b = document.getElementById("copy");
b.onclick = () => navigator.clipboard.writeText(document.getElementById("src").value).then(() => b.textContent = "Copied");
</script>`,
  );
}

export function burnPage(id) {
  return shell(
    "snip",
    `<div class="center"><h1>Someone sent you a paste</h1>
<p class="mute">It will be deleted as soon as you open it.</p>
<form method="post" action="/${esc(id)}/open"><button type="submit">Open it</button></form></div>`,
  );
}

export function notFoundPage() {
  return shell("snip: not found", `<div class="center"><h1>Nothing here</h1><p class="mute">This snip expired, was deleted, or never existed.</p><a class="btn ghost" href="/">New snip</a></div>`);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
