import { DurableObject } from "cloudflare:workers";
import ASSETS from "./assets.gen.js";

// Event types the tracker understands.
//   chest – a normal chest opened
//   rare  – a rare chest opened (counts as a chest too)
//   match – a match played (for chests-per-match stats)
//   token – the pirate token was found 🎉
const TYPES = ["chest", "rare", "match", "token"];
const MAX_BATCH = 50;

// One Durable Object holds all the data, so every button press is applied in order
// and no clicks are lost, even when several friends press at the same moment.
export class Tracker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      INTEGER NOT NULL,
        type    TEXT    NOT NULL,
        player  TEXT,
        session INTEGER
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        name    TEXT,
        started INTEGER NOT NULL,
        ended   INTEGER
      );
      CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
    `);
    // Cached results, rebuilt only after a change, so viewers never cause database reads.
    this.cache = null;
    this.dumpCache = null;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // Live connections: each open dashboard / overlay holds one WebSocket and gets pushed
  // the new summary whenever something changes, instead of asking every few seconds.
  async fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify(this.summary()));
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage() {}
  webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch {}
  }
  webSocketError() {}

  #broadcast() {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const msg = JSON.stringify(this.summary());
    for (const ws of sockets) {
      try { ws.send(msg); } catch {}
    }
  }

  #get(k, fallback = null) {
    const row = this.sql.exec("SELECT v FROM settings WHERE k = ?", k).toArray()[0];
    return row ? JSON.parse(row.v) : fallback;
  }
  #set(k, v) {
    this.sql.exec("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v));
  }
  #bump() {
    this.#set("version", this.#get("version", 0) + 1);
    this.cache = null;
    this.dumpCache = null;
    this.#broadcast();
  }
  #currentSession(create = true) {
    const row = this.sql.exec("SELECT * FROM sessions WHERE ended IS NULL ORDER BY id DESC LIMIT 1").toArray()[0];
    if (row || !create) return row || null;
    const count = this.sql.exec("SELECT COUNT(*) AS c FROM sessions").one().c;
    return this.#startSession(`Session ${count + 1}`);
  }
  #startSession(name) {
    const now = Date.now();
    this.sql.exec("UPDATE sessions SET ended = ? WHERE ended IS NULL", now);
    this.sql.exec("INSERT INTO sessions (name, started) VALUES (?, ?)", name, now);
    return this.sql.exec("SELECT * FROM sessions ORDER BY id DESC LIMIT 1").one();
  }

  add(type, player, n = 1) {
    if (!TYPES.includes(type)) throw new Error(`unknown type "${type}"`);
    n = Math.max(1, Math.min(MAX_BATCH, Math.floor(n) || 1));
    const session = this.#currentSession();
    const now = Date.now();
    for (let i = 0; i < n; i++) {
      this.sql.exec("INSERT INTO events (ts, type, player, session) VALUES (?, ?, ?, ?)", now, type, player || null, session.id);
    }
    this.#bump();
    return this.summary();
  }

  undo(type, player) {
    let q = "SELECT id FROM events WHERE 1=1";
    const args = [];
    if (type === "chests") q += " AND type IN ('chest','rare')";
    else if (type) { q += " AND type = ?"; args.push(type); }
    if (player) { q += " AND player = ?"; args.push(player); }
    const row = this.sql.exec(q + " ORDER BY id DESC LIMIT 1", ...args).toArray()[0];
    if (row) {
      this.sql.exec("DELETE FROM events WHERE id = ?", row.id);
      this.#bump();
    }
    return { removed: row ? 1 : 0, ...this.summary() };
  }

  deleteEvent(id) {
    this.sql.exec("DELETE FROM events WHERE id = ?", id);
    this.#bump();
    return this.summary();
  }

  newSession(name) {
    const count = this.sql.exec("SELECT COUNT(*) AS c FROM sessions").one().c;
    this.#startSession(name || `Session ${count + 1}`);
    this.#bump();
    return this.summary();
  }

  endSession() {
    this.sql.exec("UPDATE sessions SET ended = ? WHERE ended IS NULL", Date.now());
    this.#bump();
    return this.summary();
  }

  updateSettings(patch) {
    const s = this.#get("settings", {});
    if (typeof patch.title === "string") s.title = patch.title.slice(0, 80);
    if (patch.dropRate === null || patch.dropRate === "") delete s.dropRate;
    else if (patch.dropRate !== undefined) {
      const n = Number(patch.dropRate);
      if (n >= 1 && n <= 1e7) s.dropRate = Math.round(n);
    }
    if (patch.goal === null || patch.goal === "") delete s.goal;
    else if (patch.goal !== undefined) {
      const g = Number(patch.goal);
      if (g >= 1 && g <= 1e7) s.goal = Math.round(g);
    }
    if (patch.offset === null || patch.offset === "") delete s.offset;
    else if (patch.offset !== undefined) {
      const o = Number(patch.offset);
      if (o >= 0 && o <= 1e8) s.offset = Math.round(o);
    }
    this.#set("settings", s);
    this.#bump();
    return this.summary();
  }

  reset() {
    this.sql.exec("DELETE FROM events; DELETE FROM sessions; DELETE FROM sqlite_sequence WHERE name IN ('events','sessions');");
    this.#bump();
    return this.summary();
  }

  summary() {
    if (!this.cache) this.cache = this.#computeSummary();
    return { ...this.cache, serverTime: Date.now() };
  }

  #computeSummary() {
    const session = this.#currentSession(false);
    const settings = this.#get("settings", {});
    const offset = settings.offset || 0;
    const sid = session ? session.id : -1;
    // One pass over the events table for every count.
    const c = this.sql.exec(`
      SELECT
        COALESCE(SUM(type IN ('chest','rare')), 0)                 AS tracked,
        COALESCE(SUM(type = 'rare'), 0)                            AS rare,
        COALESCE(SUM(type = 'match'), 0)                           AS matches,
        COALESCE(SUM(type = 'token'), 0)                           AS tokens,
        COALESCE(SUM(type IN ('chest','rare') AND session = ?), 0) AS sChests,
        COALESCE(SUM(type = 'match' AND session = ?), 0)           AS sMatches
      FROM events`, sid, sid).one();
    const last = this.sql.exec("SELECT ts, player, type FROM events WHERE type IN ('chest','rare') ORDER BY id DESC LIMIT 1").toArray()[0] || null;
    return {
      version: this.#get("version", 0),
      settings,
      total: c.tracked + offset,
      tracked: c.tracked,
      offset,
      rare: c.rare,
      matches: c.matches,
      tokens: c.tokens,
      session: session
        ? { id: session.id, name: session.name, started: session.started, chests: c.sChests, matches: c.sMatches }
        : null,
      lastChest: last,
    };
  }

  dump() {
    if (this.dumpCache) return { ...this.dumpCache, summary: this.summary() };
    this.dumpCache = {
      events: this.sql.exec("SELECT id, ts, type, player, session FROM events ORDER BY id").toArray()
        .map((e) => [e.id, e.ts, e.type, e.player, e.session]),
      sessions: this.sql.exec("SELECT * FROM sessions ORDER BY id").toArray(),
    };
    return { ...this.dumpCache, summary: this.summary() };
  }
}

// ---------------------------------------------------------------------------

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-key",
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
const text = (body, status = 200) =>
  new Response(String(body), { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...CORS } });

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

async function readParams(request, url) {
  const p = Object.fromEntries(url.searchParams);
  if (request.method === "POST") {
    const ct = request.headers.get("content-type") || "";
    try {
      if (ct.includes("application/json")) Object.assign(p, await request.json());
      else if (ct.includes("form")) Object.assign(p, Object.fromEntries(await request.formData()));
    } catch { /* ignore empty / bad bodies – Companion sometimes sends none */ }
  }
  return p;
}

const cleanPlayer = (p) => (p ? String(p).trim().slice(0, 32) : "") || null;

// Short plain-text reply for Companion so a button can show the new count.
function reply(p, summary) {
  if (p.format === "text" || p.format === "txt") {
    return text(p.show === "total" ? summary.total : summary.session?.chests ?? summary.total);
  }
  return json({ ok: true, ...summary });
}

function serveAsset(path) {
  if (path.endsWith("/")) path += "index.html";
  const file = ASSETS[path] || ASSETS[path + ".html"];
  if (!file) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
  return new Response(file.body, { headers: { "content-type": file.type, "cache-control": "public, max-age=60" } });
}

async function handleSummary(route, p, tracker) {
  const s = await tracker.summary();
  if (route === "summary") return json(s);
  const field = p.show || "session";
  return text(field === "total" ? s.total : field === "rare" ? s.rare : field === "matches" ? s.matches : s.session?.chests ?? 0);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return serveAsset(url.pathname);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const tracker = env.TRACKER.get(env.TRACKER.idFromName("main"));
    const route = url.pathname.slice(5).replace(/\/+$/, "");
    const p = await readParams(request, url);

    // ---- public, read-only ----
    if (route === "live") return tracker.fetch(request);

    // Polled read endpoints (old open tabs, Companion feedback) get a 2-second edge cache,
    // so frequent polling can't run through the free plan's daily limits.
    if ((route === "summary" || route === "summary.txt") && request.method === "GET") {
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), { method: "GET" });
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
      const res = await handleSummary(route, p, tracker);
      const toCache = new Response(res.body, res);
      toCache.headers.set("cache-control", "public, max-age=2");
      ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
      toCache.headers.set("cache-control", "no-store");
      return toCache;
    }
    if (route === "data") return json(await tracker.dump());
    if (route === "export.csv") {
      const { events, sessions } = await tracker.dump();
      const names = Object.fromEntries(sessions.map((s) => [s.id, s.name]));
      const rows = ["id,time_utc,type,player,session"].concat(
        events.map(([id, ts, type, player, session]) =>
          [id, new Date(ts).toISOString(), type, JSON.stringify(player || ""), JSON.stringify(names[session] || "")].join(","))
      );
      return new Response(rows.join("\n"), {
        headers: { "content-type": "text/csv", "content-disposition": "attachment; filename=chests.csv", ...CORS },
      });
    }
    if (route === "ping") return json({ ok: true });

    // ---- everything below changes data and needs the key ----
    const key = p.key || request.headers.get("x-key") || "";
    if (!env.ADMIN_KEY) return json({ ok: false, error: "ADMIN_KEY is not set. Run: npx wrangler secret put ADMIN_KEY" }, 500);
    if (!safeEqual(key, env.ADMIN_KEY)) return json({ ok: false, error: "bad or missing key" }, 401);

    const player = cleanPlayer(p.player);
    try {
      switch (route) {
        case "check": return json({ ok: true });
        case "chest":
        case "rare":
        case "match":
        case "token":
          return reply(p, await tracker.add(route, player, Number(p.n || 1)));
        case "add":
          return reply(p, await tracker.add(p.type || "chest", player, Number(p.n || 1)));
        case "undo":
          return reply(p, await tracker.undo(p.type || null, player));
        case "delete":
          return json({ ok: true, ...(await tracker.deleteEvent(Number(p.id))) });
        case "session/new":
          return json({ ok: true, ...(await tracker.newSession(p.name ? String(p.name).slice(0, 60) : "")) });
        case "session/end":
          return json({ ok: true, ...(await tracker.endSession()) });
        case "offset": {
          const cur = (await tracker.summary()).offset;
          const next = p.set !== undefined ? Number(p.set) : cur + Number(p.add || 0);
          return reply(p, await tracker.updateSettings({ offset: Math.max(0, next) }));
        }
        case "settings":
          return json({ ok: true, ...(await tracker.updateSettings(p)) });
        case "reset":
          if (p.confirm !== "RESET") return json({ ok: false, error: 'add confirm=RESET to wipe everything' }, 400);
          return json({ ok: true, ...(await tracker.reset()) });
      }
    } catch (e) {
      return json({ ok: false, error: e.message }, 400);
    }
    return json({ ok: false, error: `unknown endpoint /api/${route}` }, 404);
  },
};
