// Valkey Cache Lab dashboard: plain JS, no build step.
// Polls the API every second (/health, /stats, /valkey/info) and the key list every 2 seconds.

const $ = (selector) => document.querySelector(selector);
const SVG_NS = "http://www.w3.org/2000/svg";

const TIMELINE_WINDOW_MS = 120_000;
const TTL_SCALE_MS = 60_000;     // TTL bars and histogram span 0-60 s
const TTL_BIN_MS = 2_000;
const MAX_HISTORY = 30;

const state = {
  live: true,
  history: [],          // last requests: { id, source, ms }
  timeline: [],         // { t, keys }
  keys: [],             // { key, ttlMs }
  keysFetchedAt: 0,
  keysTruncated: false,
  selectedKey: null,
};

// ---------- API ----------

async function api(path, options = {}) {
  try {
    const response = await fetch(path, options);
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { ok: response.ok, status: response.status, body };
  } catch {
    return { ok: false, status: 0, body: null }; // API not reachable
  }
}

// ---------- Formatting ----------

const fmtInt = (n) => Number(n).toLocaleString("en-US");
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
const fmtSeconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const time = () => new Date().toLocaleTimeString("en-GB");

function fmtBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function fmtDuration(seconds) {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------- Activity log ----------

function log(html, kind = "") {
  const li = el("li");
  li.append(el("time", {}, time()));
  const span = el("span", kind ? { class: kind } : {});
  span.innerHTML = html; // only called with strings built in this file
  li.append(span);
  const list = $("#activity");
  list.prepend(li);
  while (list.children.length > 40) list.lastChild.remove();
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- Polling: status, tiles, server info, timeline ----------

async function pollStatus() {
  const [health, stats, info] = await Promise.all([api("/health"), api("/stats"), api("/valkey/info")]);

  const pill = $("#status-pill");
  if (health.status === 0) {
    pill.className = "pill pill-fail";
    pill.textContent = "API offline";
  } else if (health.body?.status === "healthy") {
    pill.className = "pill pill-ok";
    pill.textContent = `Valkey connected · ping ${health.body.pingMs} ms`;
  } else {
    pill.className = "pill pill-warn";
    pill.textContent = "Valkey down · serving from database";
  }

  if (stats.ok) {
    const c = stats.body.cache;
    $("#t-hit-ratio").textContent = c.hits + c.misses ? `${Math.round(c.hitRatio * 100)}%` : "–";
    $("#t-hit-detail").textContent = `${fmtInt(c.hits)} hits · ${fmtInt(c.misses)} misses`;
    $("#t-db").textContent = fmtInt(stats.body.databaseQueries);
    $("#t-errors").textContent = fmtInt(c.errors);
  }

  if (info.ok) {
    const i = info.body;
    $("#server-meta").textContent = `Valkey ${i.version} · up ${fmtDuration(i.uptimeSeconds)}`;
    $("#t-keys").textContent = fmtInt(i.keys);
    $("#t-memory").textContent = fmtBytes(i.usedMemoryBytes);
    $("#t-ops").textContent = fmtInt(i.opsPerSecond);
    renderServerInfo(i);
  } else {
    $("#server-meta").textContent = "";
    for (const id of ["#t-keys", "#t-memory", "#t-ops"]) $(id).textContent = "–";
  }

  const now = Date.now();
  state.timeline.push({ t: now, keys: info.ok ? info.body.keys : null });
  state.timeline = state.timeline.filter((p) => now - p.t <= TIMELINE_WINDOW_MS);
  renderTimeline();
}

function renderServerInfo(i) {
  const lookups = i.keyspaceHits + i.keyspaceMisses;
  const rows = [
    ["valkey_version", i.version],
    ["uptime", fmtDuration(i.uptimeSeconds)],
    ["connected_clients", fmtInt(i.connectedClients)],
    ["used_memory", fmtBytes(i.usedMemoryBytes)],
    ["maxmemory", i.maxMemoryBytes ? fmtBytes(i.maxMemoryBytes) : "0 (no limit)"],
    ["maxmemory_policy", i.maxMemoryPolicy],
    ["total_commands_processed", fmtInt(i.totalCommands)],
    ["keyspace_hits", fmtInt(i.keyspaceHits)],
    ["keyspace_misses", fmtInt(i.keyspaceMisses)],
    ["server hit ratio", lookups ? `${Math.round((i.keyspaceHits / lookups) * 100)}%` : "–"],
    ["expired_keys", fmtInt(i.expiredKeys)],
    ["evicted_keys", fmtInt(i.evictedKeys)],
  ];
  const dl = $("#server-info");
  dl.replaceChildren(...rows.map(([k, v]) => {
    const div = el("div");
    div.append(el("dt", {}, k), el("dd", {}, v ?? "–"));
    return div;
  }));
}

// ---------- Chart: keys over time ----------

function renderTimeline() {
  const chart = $("#timeline-chart");
  const W = 640, H = 180, L = 44, R = 12, T = 12, B = 26;
  const pw = W - L - R, ph = H - T - B;
  const now = Date.now();
  const points = state.timeline.filter((p) => p.keys !== null);
  const maxKeys = Math.max(100, ...points.map((p) => p.keys));
  const yMax = Math.ceil((maxKeys * 1.2) / 50) * 50; // headroom for the label above the line
  const x = (t) => L + pw * (1 - (now - t) / TIMELINE_WINDOW_MS);
  const y = (v) => T + ph * (1 - v / yMax);

  const nodes = [];
  for (const v of [0, yMax / 2, yMax]) {
    nodes.push(svg("line", { class: v ? "grid-line" : "axis", x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    nodes.push(svg("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }, fmtInt(v)));
  }
  for (const [sec, label] of [[120, "-2 min"], [60, "-1 min"], [0, "now"]]) {
    nodes.push(svg("text", { x: x(now - sec * 1000), y: H - 6, "text-anchor": sec === 120 ? "start" : sec === 0 ? "end" : "middle" }, label));
  }

  // Break the line where Valkey was unreachable
  const segments = [];
  let current = [];
  for (const p of state.timeline) {
    if (p.keys === null) { if (current.length) segments.push(current); current = []; }
    else current.push(p);
  }
  if (current.length) segments.push(current);

  for (const seg of segments) {
    const line = seg.map((p) => `${x(p.t).toFixed(1)},${y(p.keys).toFixed(1)}`).join(" ");
    const area = `${x(seg[0].t).toFixed(1)},${y(0)} ${line} ${x(seg[seg.length - 1].t).toFixed(1)},${y(0)}`;
    nodes.push(svg("polygon", { class: "area", points: area }));
    nodes.push(svg("polyline", { class: "line", points: line }));
  }

  const last = points[points.length - 1];
  if (last) {
    nodes.push(svg("circle", { class: "dot", cx: x(last.t), cy: y(last.keys), r: 3.5 }));
    nodes.push(svg("text", { class: "label-strong", x: x(last.t) - 8, y: y(last.keys) - 8, "text-anchor": "end" }, `${fmtInt(last.keys)} keys`));
  } else {
    nodes.push(svg("text", { class: "empty-text", x: W / 2, y: H / 2, "text-anchor": "middle" }, "Waiting for Valkey…"));
  }
  chart.replaceChildren(...nodes);
}

// ---------- Keys: list, TTL countdown, histogram ----------

const rowByKey = new Map();

async function pollKeys() {
  const pattern = $("#pattern").value.trim() || "*";
  const result = await api(`/valkey/keys?pattern=${encodeURIComponent(pattern)}&limit=500`);
  if (!result.ok) {
    state.keys = [];
  } else {
    state.keys = result.body.keys.sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true }));
    state.keysTruncated = result.body.truncated;
  }
  state.keysFetchedAt = Date.now();
  $("#keys-count").textContent = result.ok
    ? `${fmtInt(state.keys.length)}${state.keysTruncated ? "+" : ""} keys`
    : "Valkey unavailable";
  syncKeyRows();
  tick();
}

const remainingMs = (k) => (k.ttlMs < 0 ? -1 : Math.max(0, k.ttlMs - (Date.now() - state.keysFetchedAt)));

function createRow(key) {
  const tr = el("tr");
  tr.dataset.key = key;
  const keyCell = el("td");
  keyCell.append(el("button", { class: "key-link", type: "button", "data-action": "inspect" }, key));
  const ttlCell = el("td");
  const ttl = el("div", { class: "ttl" });
  const bar = el("span", { class: "ttl-bar" });
  bar.append(el("span"));
  ttl.append(bar, el("span", { class: "ttl-text" }));
  ttlCell.append(ttl);
  const actions = el("td", { class: "actions" });
  actions.append(el("button", { class: "btn btn-small", type: "button", "data-action": "delete" }, "Delete"));
  tr.append(keyCell, ttlCell, actions);
  return tr;
}

// Reuse existing rows so clicks aren't lost when the list refreshes
function syncKeyRows() {
  const tbody = $("#keys-table tbody");
  const wanted = new Set(state.keys.map((k) => k.key));
  for (const [key, row] of rowByKey) {
    if (!wanted.has(key)) { row.remove(); rowByKey.delete(key); }
  }
  state.keys.forEach((k, i) => {
    let row = rowByKey.get(k.key);
    if (!row) { row = createRow(k.key); rowByKey.set(k.key, row); }
    row.classList.toggle("selected", k.key === state.selectedKey);
    if (tbody.children[i] !== row) tbody.insertBefore(row, tbody.children[i] ?? null);
  });
  $("#keys-empty").hidden = state.keys.length > 0;
}

// Runs every 250 ms: TTLs count down locally between refreshes
function tick() {
  for (const k of state.keys) {
    const row = rowByKey.get(k.key);
    if (!row) continue;
    const rem = remainingMs(k);
    const ttl = row.querySelector(".ttl");
    const fill = row.querySelector(".ttl-bar span");
    const text = row.querySelector(".ttl-text");
    if (rem < 0) {
      ttl.className = "ttl none";
      fill.style.width = "100%";
      text.textContent = "no TTL";
    } else {
      ttl.className = rem < 5000 ? "ttl soon" : "ttl";
      fill.style.width = `${Math.min(100, (rem / TTL_SCALE_MS) * 100)}%`;
      text.textContent = fmtSeconds(rem);
    }
    row.classList.toggle("expired", rem === 0);
  }
  renderTtlHistogram();
}

function renderTtlHistogram() {
  const chart = $("#ttl-chart");
  const W = 640, H = 170, L = 44, R = 12, T = 14, B = 26;
  const pw = W - L - R, ph = H - T - B;
  const bins = new Array(TTL_SCALE_MS / TTL_BIN_MS).fill(0);
  let noTtl = 0, beyond = 0, soon = 0;

  for (const k of state.keys) {
    const rem = remainingMs(k);
    if (rem < 0) { noTtl++; continue; }
    if (rem === 0) continue;
    if (rem <= 5000) soon++;
    const i = Math.floor(rem / TTL_BIN_MS);
    if (i >= bins.length) beyond++; else bins[i]++;
  }

  const maxBin = Math.max(...bins);
  const yMax = Math.max(10, Math.ceil(maxBin / 10) * 10);
  const bw = pw / bins.length;
  const y = (v) => T + ph * (1 - v / yMax);
  const nodes = [];

  for (const v of [0, yMax / 2, yMax]) {
    nodes.push(svg("line", { class: v ? "grid-line" : "axis", x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    nodes.push(svg("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }, fmtInt(v)));
  }
  for (let s = 0; s <= 60; s += 10) {
    nodes.push(svg("text", { x: L + (pw * s) / 60, y: H - 6, "text-anchor": s === 0 ? "start" : s === 60 ? "end" : "middle" }, s === 60 ? "60 s" : `${s}`));
  }
  bins.forEach((count, i) => {
    if (!count) return;
    const rect = svg("rect", { class: "bar-ttl", x: L + i * bw + 1, y: y(count), width: Math.max(1, bw - 2), height: Math.max(1, y(0) - y(count)) });
    rect.append(svg("title", {}, `${count} keys expire in ${i * 2}-${i * 2 + 2} s`));
    nodes.push(rect);
  });
  if (maxBin > 0) {
    const peak = bins.indexOf(maxBin);
    nodes.push(svg("text", { class: "label-strong", x: L + peak * bw + bw / 2, y: y(maxBin) - 5, "text-anchor": "middle" }, fmtInt(maxBin)));
  } else {
    nodes.push(svg("text", { class: "empty-text", x: W / 2, y: H / 2, "text-anchor": "middle" }, "No keys with a TTL"));
  }
  chart.replaceChildren(...nodes);

  const notes = [`${fmtInt(soon)} keys expire in the next 5 s.`];
  if (noTtl) notes.push(`${fmtInt(noTtl)} without TTL (never expire).`);
  if (beyond) notes.push(`${fmtInt(beyond)} expire after 60 s.`);
  $("#ttl-note").textContent = notes.join(" ");
}

// ---------- Inspector ----------

async function inspect(key) {
  state.selectedKey = key;
  syncKeyRows();
  const box = $("#inspector");
  const result = await api(`/valkey/key?key=${encodeURIComponent(key)}`);
  if (result.status === 404) {
    box.replaceChildren(el("p", { class: "empty" }, `${key} no longer exists (expired or deleted).`));
    return;
  }
  if (!result.ok) {
    box.replaceChildren(el("p", { class: "empty" }, "Could not read the key: Valkey is unavailable."));
    return;
  }
  const k = result.body;
  let value = k.value;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { /* plain string */ }
  }
  const dl = el("dl");
  dl.append(
    el("dt", {}, "Type"), el("dd", {}, k.type),
    el("dt", {}, "TTL"), el("dd", {}, k.ttlMs < 0 ? "no TTL (-1)" : fmtSeconds(k.ttlMs)),
    el("dt", {}, "Read with"), el("dd", { class: "cmd" }, k.command),
  );
  const pre = el("pre", {}, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  box.replaceChildren(el("h3", {}, k.key), dl, pre);
  log(`<code>${escapeHtml(k.command)}</code>`);
}

// ---------- Actions ----------

async function requestProduct(withCache) {
  const id = Number($("#product-id").value) || 1;
  const path = withCache ? `/products/${id}` : `/products/${id}/no-cache`;
  const started = performance.now();
  const result = await api(path);
  const elapsed = performance.now() - started;
  const box = $("#last-result");
  box.className = "result";

  if (result.status === 404) {
    state.history.push({ id, source: "missing", ms: elapsed });
    box.replaceChildren(resultHead("not found", "missing", elapsed),
      explain(`Product ${id} doesn't exist. The API asked the database, got nothing, and cached nothing, so the next request will hit the database again. This is <strong>cache penetration</strong> (Step 5).`));
    log(`GET ${escapeHtml(path)} → 404 in ${fmtMs(elapsed)}`, "a-db");
  } else if (!result.ok) {
    box.replaceChildren(resultHead("error", "error", elapsed), explain("The API is not reachable."));
    log(`GET ${escapeHtml(path)} → failed`, "a-fail");
    return renderLatency();
  } else {
    const { source, ms, product } = result.body;
    state.history.push({ id, source, ms });
    const text = !withCache
      ? "The baseline: this endpoint never looks at the cache."
      : source === "cache"
        ? `Hit: <code>GET product:${id}</code> found the value in Valkey, so the database wasn't touched.`
        : `Miss: <code>GET product:${id}</code> returned nil, so the API queried the database and stored the result with <code>SET</code> and a TTL. Call it again.`;
    box.replaceChildren(resultHead(source, source, ms), explain(text), el("pre", {}, JSON.stringify(product, null, 2)));
    log(`GET ${escapeHtml(path)} → <strong>${source}</strong> in ${fmtMs(ms)}`, source === "cache" ? "a-hit" : "a-db");
  }
  state.history = state.history.slice(-MAX_HISTORY);
  renderLatency();
  pollKeys();
}

function resultHead(label, kind, ms) {
  const head = el("div", { class: "result-head" });
  head.append(el("span", { class: "result-ms" }, fmtMs(ms)), el("span", { class: `badge badge-${kind}` }, label));
  return head;
}

function explain(html) {
  const p = el("p", { class: "explain" });
  p.innerHTML = html; // only called with strings built in this file
  return p;
}

function renderLatency() {
  const chart = $("#latency-chart");
  const W = 640, H = 200, L = 52, R = 12, T = 16, B = 24;
  const pw = W - L - R, ph = H - T - B;
  const min = 0.5, max = 2000; // log scale: cache (~1 ms) and database (~500 ms) fit on one chart
  const y = (ms) => T + ph * (1 - (Math.log10(Math.min(max, Math.max(min, ms))) - Math.log10(min)) / (Math.log10(max) - Math.log10(min)));
  const nodes = [];
  for (const v of [1, 10, 100, 1000]) {
    nodes.push(svg("line", { class: "grid-line", x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    nodes.push(svg("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }, v >= 1000 ? "1 s" : `${v} ms`));
  }
  nodes.push(svg("line", { class: "axis", x1: L, x2: W - R, y1: y(min), y2: y(min) }));

  const slot = pw / MAX_HISTORY;
  state.history.forEach((r, i) => {
    const top = y(Math.max(r.ms, 0.6));
    const rect = svg("rect", { class: `bar-${r.source}`, x: L + i * slot + 2, y: top, width: slot - 4, height: y(min) - top });
    rect.append(svg("title", {}, `product ${r.id}: ${r.source}, ${fmtMs(r.ms)}`));
    nodes.push(rect);
  });
  if (state.history.length) {
    const i = state.history.length - 1, r = state.history[i];
    nodes.push(svg("text", { class: "label-strong", x: L + i * slot + slot / 2, y: y(Math.max(r.ms, 0.6)) - 5, "text-anchor": i > MAX_HISTORY - 4 ? "end" : "middle" }, fmtMs(r.ms)));
  } else {
    nodes.push(svg("text", { class: "empty-text", x: W / 2, y: H / 2, "text-anchor": "middle" }, "Make a request to see its latency"));
  }
  chart.replaceChildren(...nodes);
}

async function warm(jitter) {
  const buttons = [$("#warm-fixed"), $("#warm-jitter")];
  buttons.forEach((b) => (b.disabled = true));
  const result = await api(`/cache/warm?jitter=${jitter}`, { method: "POST" });
  buttons.forEach((b) => (b.disabled = false));
  if (result.ok) log(`Warmed ${result.body.warmed} keys ${jitter ? "with jitter (TTL 30-45 s)" : "with a fixed TTL (30 s)"}`, "a-hit");
  else log("Warm-up failed: Valkey is unavailable", "a-fail");
  pollKeys();
}

async function burst(event) {
  event.preventDefault();
  const requests = Number($("#burst-requests").value) || 200;
  const ids = Number($("#burst-ids").value) || 5;
  const button = event.submitter ?? $("#burst-form button");
  button.disabled = true;
  const box = $("#burst-result");
  box.className = "result result-empty";
  box.textContent = `Firing ${requests} requests…`;
  const result = await api(`/lab/burst?requests=${requests}&distinctIds=${ids}`, { method: "POST" });
  button.disabled = false;
  if (!result.ok) {
    box.textContent = "The burst failed: the API is not reachable.";
    return;
  }
  const r = result.body;
  box.className = "result";

  const split = el("div", { class: "split", role: "img", "aria-label": `${r.fromCache} from cache, ${r.fromDatabase} from database` });
  split.append(el("span", { class: "s-hit", style: `width:${(r.fromCache / r.requests) * 100}%` }),
               el("span", { class: "s-db", style: `width:${(r.fromDatabase / r.requests) * 100}%` }));

  const numbers = el("div", { class: "numbers" });
  for (const [value, label] of [
    [fmtInt(r.fromCache), "from cache"],
    [fmtInt(r.fromDatabase), "from database"],
    [fmtInt(r.databaseQueries), "database queries"],
    [fmtMs(r.p50Ms), "p50 latency"],
    [fmtMs(r.p95Ms), "p95 latency"],
    [fmtMs(r.elapsedMs), "total time"],
  ]) {
    const d = el("div");
    d.append(el("b", {}, value), el("span", {}, label));
    numbers.append(d);
  }

  let text;
  if (r.databaseQueries > r.distinctIds) {
    text = `<strong>Stampede:</strong> ${fmtInt(r.databaseQueries)} database queries for only ${r.distinctIds} distinct products. All the requests missed at the same instant, before the first one could fill the cache. Step 5 fixes this with a lock (<code>SET NX</code>).`;
  } else if (r.databaseQueries === 0) {
    text = "Every request was served by Valkey. The database was not touched.";
  } else {
    text = `${fmtInt(r.databaseQueries)} database queries for ${r.distinctIds} distinct products.`;
  }
  box.replaceChildren(split, numbers, explain(text));
  log(`Burst of ${fmtInt(r.requests)} requests over ${r.distinctIds} ids → ${fmtInt(r.databaseQueries)} database queries`, r.databaseQueries > r.distinctIds ? "a-fail" : "a-hit");
  pollKeys();
}

async function deleteKey(key) {
  const result = await api(`/valkey/key?key=${encodeURIComponent(key)}`, { method: "DELETE" });
  if (result.ok) log(`<code>DEL ${escapeHtml(key)}</code> → the next request for it is a miss`, "a-db");
  else log(`Could not delete ${escapeHtml(key)}`, "a-fail");
  if (state.selectedKey === key) {
    state.selectedKey = null;
    $("#inspector").replaceChildren(el("p", { class: "empty" }, "Select a key to see its type, TTL and value."));
  }
  pollKeys();
}

// Two clicks to flush: the first one arms the button for 3 seconds
let flushTimer = null;
async function flush() {
  const button = $("#flush");
  if (!button.classList.contains("armed")) {
    button.classList.add("armed");
    button.textContent = "Click again to flush";
    flushTimer = setTimeout(() => { button.classList.remove("armed"); button.textContent = "Flush database"; }, 3000);
    return;
  }
  clearTimeout(flushTimer);
  button.classList.remove("armed");
  button.textContent = "Flush database";
  const result = await api("/valkey/flush", { method: "POST" });
  if (result.ok) log("<code>FLUSHDB</code> → every key is gone, the cache is cold", "a-fail");
  else log("Flush failed", "a-fail");
  pollKeys();
}

async function resetStats() {
  await api("/stats/reset", { method: "POST" });
  log("Counters reset");
  pollStatus();
}

// ---------- Wiring ----------

$("#request-form").addEventListener("submit", (e) => { e.preventDefault(); requestProduct(true); });
$("#btn-nocache").addEventListener("click", () => requestProduct(false));
$("#warm-fixed").addEventListener("click", () => warm(false));
$("#warm-jitter").addEventListener("click", () => warm(true));
$("#burst-form").addEventListener("submit", burst);
$("#flush").addEventListener("click", flush);
$("#reset-stats").addEventListener("click", resetStats);
$("#pattern").addEventListener("change", () => pollKeys());
$("#live").addEventListener("change", (e) => (state.live = e.target.checked));

$("#keys-table tbody").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-action]");
  if (!button) return;
  const key = button.closest("tr").dataset.key;
  if (button.dataset.action === "inspect") inspect(key);
  if (button.dataset.action === "delete") deleteKey(key);
});

setInterval(() => state.live && pollStatus(), 1000);
setInterval(() => state.live && pollKeys(), 2000);
setInterval(() => state.live && tick(), 250);

pollStatus();
pollKeys();
renderLatency();
log("Dashboard opened");
