// Turns the raw event log into every statistic shown on the dashboard.
// events: [id, ts, type, player, session]
export function computeStats({ events, sessions, summary }, now = Date.now()) {
  const ev = events.map(([id, ts, type, player, session]) => ({ id, ts, type, player: player || "Unknown", session }));
  const chests = ev.filter((e) => e.type === "chest" || e.type === "rare");
  const matches = ev.filter((e) => e.type === "match");
  const tokens = ev.filter((e) => e.type === "token");
  const total = chests.length;

  // ----- sessions -----
  const sess = sessions.map((s) => {
    const sc = chests.filter((c) => c.session === s.id);
    const sm = matches.filter((m) => m.session === s.id);
    const lastTs = ev.filter((e) => e.session === s.id).reduce((m, e) => Math.max(m, e.ts), s.started);
    const end = s.ended ?? now;
    const durMs = Math.max(0, (s.ended ? s.ended : now) - s.started);
    return {
      ...s,
      active: !s.ended,
      chests: sc.length,
      rare: sc.filter((c) => c.type === "rare").length,
      matches: sm.length,
      tokens: tokens.filter((t) => t.session === s.id).length,
      durMs,
      lastTs,
      end,
      perHour: durMs > 60_000 ? sc.length / (durMs / 3_600_000) : null,
      gaps: gaps(sc),
    };
  });
  const playTimeMs = sess.reduce((a, s) => a + s.durMs, 0);
  const allGaps = sess.flatMap((s) => s.gaps);
  const current = sess.find((s) => s.active) || null;

  // ----- players -----
  const pmap = new Map();
  for (const c of chests) {
    const p = pmap.get(c.player) || { name: c.player, chests: 0, rare: 0, last: 0, first: c.ts, sessionChests: 0 };
    p.chests++;
    if (c.type === "rare") p.rare++;
    if (current && c.session === current.id) p.sessionChests++;
    p.last = Math.max(p.last, c.ts);
    pmap.set(c.player, p);
  }
  const players = [...pmap.values()].sort((a, b) => b.chests - a.chests);

  // ----- by day / hour of day / weekday -----
  const byDay = new Map();
  const byHour = Array(24).fill(0);
  const byWeekday = Array(7).fill(0);
  for (const c of chests) {
    const d = new Date(c.ts);
    const key = dayKey(d);
    byDay.set(key, (byDay.get(key) || 0) + 1);
    byHour[d.getHours()]++;
    byWeekday[d.getDay()]++;
  }
  const days = fillDays(byDay);
  const bestDay = days.reduce((b, d) => (d.count > (b?.count ?? 0) ? d : b), null);
  const today = byDay.get(dayKey(new Date(now))) || 0;
  const activeDays = [...byDay.values()].filter((v) => v > 0).length;

  // ----- recent pace -----
  const inLast = (ms) => chests.filter((c) => now - c.ts <= ms).length;
  const last10 = inLast(10 * 60_000);
  const last60 = inLast(60 * 60_000);

  // ----- token odds -----
  const firstToken = tokens[0] || null;
  const chestsBeforeToken = firstToken ? chests.filter((c) => c.id < firstToken.id).length : null;
  const OFFICIAL = 137500;
  const customRate = summary.settings?.dropRate || null;
  const dropRate = customRate || OFFICIAL;
  const odds = (oneIn) => 1 - Math.pow(1 - 1 / oneIn, total);
  const need = (oneIn, target) => Math.ceil(Math.log(1 - target) / Math.log(1 - 1 / oneIn));
  const rates = [
    { oneIn: OFFICIAL, label: "Normal (Epic official)" },
    { oneIn: 91667, label: "Treasure Hour 1.5×" },
    { oneIn: 68750, label: "Treasure Hour 2×" },
  ];
  if (customRate && !rates.some((r) => r.oneIn === customRate)) rates.push({ oneIn: customRate, label: "Your custom rate" });
  const oddsTable = rates.map((r) => ({ ...r, p: odds(r.oneIn), mine: r.oneIn === dropRate }));
  const milestones = [0.5, 0.9, 0.99].map((t) => ({ target: t, chests: need(dropRate, t) }));

  return {
    total,
    rare: chests.filter((c) => c.type === "rare").length,
    matches: matches.length,
    tokens: tokens.length,
    firstToken,
    chestsBeforeToken,
    dropRate,
    customRate,
    milestones,
    myOdds: dropRate ? odds(dropRate) : null,
    expectedRemaining: dropRate && !firstToken ? dropRate : null,
    oddsTable,
    sessions: sess,
    current,
    playTimeMs,
    perHour: playTimeMs > 60_000 ? total / (playTimeMs / 3_600_000) : null,
    perMatch: matches.length ? total / matches.length : null,
    avgGapMs: avg(allGaps),
    fastestGapMs: allGaps.length ? Math.min(...allGaps) : null,
    longestGapMs: allGaps.length ? Math.max(...allGaps) : null,
    currentGaps: current ? current.gaps : [],
    lastChest: chests[chests.length - 1] || null,
    firstChest: chests[0] || null,
    players,
    days,
    bestDay,
    today,
    activeDays,
    perActiveDay: activeDays ? total / activeDays : null,
    byHour,
    byWeekday,
    last10,
    last60,
    bestSession: sess.reduce((b, s) => (s.chests > (b?.chests ?? 0) ? s : b), null),
    cumulative: chests.map((c, i) => [c.ts, i + 1]),
    recent: ev.slice(-40).reverse(),
  };
}

function gaps(list) {
  const out = [];
  for (let i = 1; i < list.length; i++) out.push(list[i].ts - list[i - 1].ts);
  return out;
}
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fillDays(map) {
  const keys = [...map.keys()].sort();
  if (!keys.length) return [];
  const out = [];
  const [y, m, d] = keys[0].split("-").map(Number);
  const cur = new Date(y, m - 1, d);
  const end = keys[keys.length - 1];
  for (let guard = 0; guard < 400; guard++) {
    const k = dayKey(cur);
    out.push({ key: k, date: new Date(cur), count: map.get(k) || 0 });
    if (k === end) break;
    cur.setDate(cur.getDate() + 1);
  }
  return out.slice(-60);
}

// ----- formatting helpers -----
export function fmtDur(ms, short = false) {
  if (ms == null || !isFinite(ms)) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (short) return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}
export function ago(ts, now = Date.now()) {
  if (!ts) return "—";
  const d = now - ts;
  if (d < 5000) return "just now";
  return fmtDur(d, true) + " ago";
}
export const fmtNum = (n, digits = 1) => (n == null || !isFinite(n) ? "—" : Number(n).toFixed(digits).replace(/\.0+$/, ""));
export const pct = (p) => (p == null ? "—" : p >= 0.9995 ? ">99.9%" : p < 0.001 && p > 0 ? "<0.1%" : (p * 100).toFixed(1) + "%");
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
