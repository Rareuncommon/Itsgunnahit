import { computeStats, fmtDur, ago, fmtNum, pct, esc } from "/stats.js";

const $ = (id) => document.getElementById(id);
let data = null;
let stats = null;
let version = -1;
let lastShownCount = null;

// The full event log is only downloaded when the server says something changed.
let loading = false, wanted = -1;
async function onSummary(s) {
  wanted = s.version;
  if (s.version === version || loading) return;
  loading = true;
  try {
    const full = await (await fetch("/api/data", { cache: "no-store" })).json();
    data = full;
    version = full.summary.version;
    render();
  } catch {
    setLive(false);
  } finally {
    loading = false;
    if (wanted !== version) setTimeout(() => onSummary({ version: wanted }), 300);
  }
}

function setLive(ok) {
  $("live").classList.toggle("off", !ok);
  $("liveText").textContent = ok ? "Live – updates instantly" : "Offline – retrying…";
}

function render() {
  if (!data) return;
  const now = Date.now();
  stats = computeStats(data, now);
  const s = stats;
  const settings = data.summary.settings || {};
  const title = settings.title || "Pirate Token Hunt";
  $("title").textContent = title;
  document.title = `${title} · Chest Tracker`;

  // hero
  const sessCount = s.current ? s.current.chests : s.total;
  const num = $("bigNum");
  num.textContent = sessCount.toLocaleString();
  if (lastShownCount !== null && sessCount > lastShownCount) {
    num.classList.remove("bump"); void num.offsetWidth; num.classList.add("bump");
  }
  lastShownCount = sessCount;
  $("sessionName").textContent = s.current ? `${s.current.name} · ${fmtDur(s.current.durMs, true)}` : "all-time (no active session)";
  $("sessTotal").textContent = `${s.total.toLocaleString()} all-time`;
  $("lastChest").textContent = s.lastChest ? `Last chest ${ago(s.lastChest.ts, now)}` : "No chests yet";

  const tok = $("tokenStatus");
  if (s.firstToken) {
    tok.classList.add("found");
    tok.innerHTML = `🎉 PIRATE TOKEN FOUND${s.firstToken.player !== "Unknown" ? ` by <b>${esc(s.firstToken.player)}</b>` : ""} after <b>${s.chestsBeforeToken.toLocaleString()}</b> chests · ${new Date(s.firstToken.ts).toLocaleString()}`;
  } else {
    tok.classList.remove("found");
    tok.textContent = "🪙 Pirate token: not found yet. Keep looting!";
  }

  const goal = settings.goal;
  $("goalBar").hidden = !goal;
  if (goal) {
    const p = Math.min(1, s.total / goal);
    $("goalFill").style.width = `${p * 100}%`;
    $("goalLeft").textContent = `Goal: ${goal.toLocaleString()} chests`;
    $("goalRight").textContent = s.total >= goal ? "Goal reached! 🏆" : `${(goal - s.total).toLocaleString()} to go · ${pct(p)}`;
  }

  renderOdds(s);
  renderTiles(s, now);
  $("cumChart").innerHTML = cumulativeChart(s);
  renderLeaderboard(s);
  $("dayChart").innerHTML = s.days.length
    ? barChart(s.days.map((d) => ({ label: d.date.toLocaleDateString(undefined, { month: "short", day: "numeric" }), v: d.count })), { labelEvery: Math.ceil(s.days.length / 8) })
    : empty();
  $("hourChart").innerHTML = s.tracked
    ? barChart(s.byHour.map((v, h) => ({ label: hourLabel(h), v })), { labelEvery: 3, alt: true })
    : empty();
  $("weekChart").innerHTML = s.tracked
    ? barChart(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => ({ label: d, v: s.byWeekday[i] })), { labelEvery: 1 })
    : empty();
  $("gapChart").innerHTML = gapChart(s.currentGaps);
  renderSessions(s);
  renderFeed(s, now);
}

function renderOdds(s) {
  const rows = s.oddsTable.map((o) => `
    <div class="odds-row${o.mine ? " mine" : ""}">
      <span>${esc(o.label)}<br><small style="color:var(--muted)">1 in ${o.oneIn.toLocaleString()}</small></span>
      <div class="track"><div style="width:${Math.max(o.p * 100, o.p > 0 ? 0.5 : 0).toFixed(2)}%"></div></div>
      <span class="pct">${pctFine(o.p)}</span>
    </div>`).join("");
  const m = s.milestones;
  const toHalf = Math.max(0, m[0].chests - s.total);
  $("odds").innerHTML = rows + `
    <div class="goal-bar" style="margin-top:12px">
      <div class="track"><div class="fill" style="width:${Math.min(100, (s.total / m[0].chests) * 100)}%"></div></div>
      <div class="lbl"><span>${s.total.toLocaleString()} / ${m[0].chests.toLocaleString()} chests to a 50/50 shot</span><span>${toHalf ? toHalf.toLocaleString() + " to go" : "Past the 50% mark!"}</span></div>
    </div>
    <div class="note">Chests needed at ${s.customRate ? "your custom" : "the official"} rate: 50% → ${m[0].chests.toLocaleString()}, 90% → ${m[1].chests.toLocaleString()}, 99% → ${m[2].chests.toLocaleString()}.</div>`;
  $("oddsNote").innerHTML = `Bars show the chance your crew has found at least one token with ${s.total.toLocaleString()} chests opened. Every chest is a fresh 1-in-137,500 roll, so being "due" doesn't make the next chest any better. Official rate posted by Epic on Nov 7, 2026. The Treasure Hour boosts are as reported by community sites.`;
}

const pctFine = (p) => (p === 0 ? "0%" : p < 0.0001 ? (p * 100).toFixed(4) + "%" : p < 0.01 ? (p * 100).toFixed(3) + "%" : (p * 100).toFixed(1) + "%");

function tile(k, v, sub = "", cls = "") {
  return `<div class="tile ${cls}"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`;
}

function renderTiles(s, now) {
  const c = s.current;
  $("tiles").innerHTML = [
    tile("All-time chests", s.total.toLocaleString(), s.offset ? `incl. ${s.offset.toLocaleString()} from before tracking` : `${s.rare} rare · ${s.activeDays} day${s.activeDays === 1 ? "" : "s"} hunting`, "gold"),
    tile("This session", c ? c.chests.toLocaleString() : "—", c ? `${fmtNum(c.perHour)} / hour` : "no active session", "gold"),
    tile("Last chest", `<span data-ago="${s.lastChest?.ts || ""}">${ago(s.lastChest?.ts, now)}</span>`, s.lastChest ? `by ${esc(s.lastChest.player)}` : ""),
    tile("Chests / hour", fmtNum(s.perHour), `over ${fmtDur(s.playTimeMs, true)} played`, "teal"),
    tile("Chests / match", fmtNum(s.perMatch, 2), `${s.matches.toLocaleString()} matches logged`, "teal"),
    tile("Avg time between", fmtDur(s.avgGapMs, true), `fastest ${fmtDur(s.fastestGapMs, true)}`),
    tile("Longest drought", fmtDur(s.longestGapMs, true), "between chests in a session"),
    tile("Pace", `${s.last10} <small style="font-size:14px;color:var(--muted)">/10m</small>`, `${s.last60} in the last hour`),
    tile("Today", s.today.toLocaleString(), s.bestDay ? `best day: ${s.bestDay.count} (${s.bestDay.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })})` : ""),
    tile("Per hunting day", fmtNum(s.perActiveDay), `${s.sessions.length} session${s.sessions.length === 1 ? "" : "s"}`),
    tile("Best session", s.bestSession ? s.bestSession.chests.toLocaleString() : "—", s.bestSession ? esc(s.bestSession.name) : ""),
    tile("Rare chest rate", s.tracked ? pct(s.rare / s.tracked) : "—", `${s.rare} of ${s.tracked} tracked`, "purple"),
  ].join("");
}

function renderLeaderboard(s) {
  if (!s.players.length) { $("leaderboard").innerHTML = `<li class="empty" style="display:block">Add &player=Name to your Companion URL to track who found what.</li>`; return; }
  const max = s.players[0].chests;
  $("leaderboard").innerHTML = s.players.map((p, i) => `
    <li>
      <span class="rank">${i + 1}</span>
      <div style="min-width:0">
        <div class="name">${esc(p.name)}</div>
        <div class="barwrap"><div style="width:${(p.chests / max) * 100}%"></div></div>
      </div>
      <span class="count">${p.chests.toLocaleString()}<small>${pct(p.chests / s.tracked)}${p.rare ? ` · ${p.rare} rare` : ""}${s.current ? ` · ${p.sessionChests} today` : ""}</small></span>
    </li>`).join("");
}

function renderSessions(s) {
  const rows = [...s.sessions].reverse().slice(0, 30).map((x) => `
    <tr class="${x.active ? "active" : ""}">
      <td>${esc(x.name)}${x.active ? " 🔴" : ""}</td>
      <td>${new Date(x.started).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
      <td class="num">${fmtDur(x.durMs, true)}</td>
      <td class="num">${x.chests}</td>
      <td class="num">${x.rare}</td>
      <td class="num">${x.matches}</td>
      <td class="num">${fmtNum(x.perHour)}</td>
      <td class="num">${x.matches ? fmtNum(x.chests / x.matches, 2) : "—"}</td>
      <td class="num">${x.tokens ? "🪙" : ""}</td>
    </tr>`).join("");
  $("sessionsTable").innerHTML = `
    <thead><tr><th>Session</th><th>Started</th><th class="num">Length</th><th class="num">Chests</th><th class="num">Rare</th><th class="num">Matches</th><th class="num">/ hour</th><th class="num">/ match</th><th class="num">Token</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="9" class="empty">No sessions yet. The first chest starts one automatically.</td></tr>`}</tbody>`;
}

const LABELS = { chest: "Chest", rare: "Rare chest", match: "Match", token: "PIRATE TOKEN" };
function renderFeed(s, now) {
  $("feed").innerHTML = s.recent.length
    ? s.recent.map((e) => `<li><span><span class="tag ${e.type}">${LABELS[e.type]}</span>${e.player !== "Unknown" ? esc(e.player) : ""}</span><span class="when" data-ago="${e.ts}">${ago(e.ts, now)}</span></li>`).join("")
    : `<li class="empty" style="display:block">Waiting for the first chest…</li>`;
}

// ---------- tiny SVG charts ----------
const empty = () => `<div class="empty">No data yet</div>`;
const hourLabel = (h) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);

function niceMax(v) {
  if (v <= 4) return 4;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return v;
}

function barChart(items, { labelEvery = 1, alt = false } = {}) {
  const W = 560, H = 200, L = 34, B = 22, T = 8;
  const max = niceMax(Math.max(1, ...items.map((i) => i.v)));
  const bw = (W - L) / items.length;
  const y = (v) => T + (H - T - B) * (1 - v / max);
  let g = "";
  const steps = max % 5 === 0 ? 5 : 4;
  for (let i = 0; i <= steps; i++) {
    const v = (max / steps) * i, yy = y(v);
    g += `<line class="grid" x1="${L}" x2="${W}" y1="${yy}" y2="${yy}"/><text x="${L - 6}" y="${yy + 4}" text-anchor="end">${fmtNum(v)}</text>`;
  }
  items.forEach((it, i) => {
    const x = L + i * bw + bw * 0.15, w = Math.max(1, bw * 0.7), yy = y(it.v);
    g += `<rect class="bar${alt ? " alt" : ""}" x="${x}" y="${yy}" width="${w}" height="${Math.max(0, H - B - yy)}" rx="2"><title>${esc(it.label)}: ${it.v}</title></rect>`;
    if (i % labelEvery === 0) g += `<text x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${esc(it.label)}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${g}</svg>`;
}

function cumulativeChart(s) {
  const pts = s.cumulative;
  if (pts.length < 2) return empty();
  const W = 1100, H = 240, L = 44, B = 24, T = 10, R = 10;
  const t0 = pts[0][0], t1 = Math.max(pts[pts.length - 1][0], t0 + 1);
  const max = niceMax(pts[pts.length - 1][1]);
  // Compress idle time: plot by "play index" across sessions instead of wall clock, so overnight gaps don't flatten the line.
  const x = (i) => L + (W - L - R) * (i / (pts.length - 1));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  let d = `M${x(0)},${y(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) d += `L${x(i)},${y(pts[i][1])}`;
  let g = `<defs><linearGradient id="goldfade" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ffc53d" stop-opacity=".35"/><stop offset="1" stop-color="#ffc53d" stop-opacity="0"/></linearGradient></defs>`;
  const steps = max % 5 === 0 ? 5 : 4;
  for (let i = 0; i <= steps; i++) {
    const v = (max / steps) * i, yy = y(v);
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text x="${L - 6}" y="${yy + 4}" text-anchor="end">${fmtNum(v)}</text>`;
  }
  // session boundaries
  let lastSess = null;
  const ev = data.events.filter((e) => e[2] === "chest" || e[2] === "rare");
  ev.forEach((e, i) => {
    if (e[4] !== lastSess) {
      if (lastSess !== null) g += `<line x1="${x(i)}" x2="${x(i)}" y1="${T}" y2="${H - B}" stroke="#3ddbd9" stroke-opacity=".25" stroke-dasharray="3 4"/>`;
      lastSess = e[4];
    }
  });
  g += `<path class="area" d="${d}L${x(pts.length - 1)},${H - B}L${x(0)},${H - B}Z"/><path class="line" d="${d}"/>`;
  // token marker
  if (s.firstToken && s.chestsBeforeToken != null) {
    const i = Math.max(0, s.chestsBeforeToken - 1);
    g += `<circle class="tok" cx="${x(i)}" cy="${y(pts[i][1])}" r="7"><title>Pirate token found</title></circle>`;
  }
  g += `<text x="${L}" y="${H - 4}">${new Date(t0).toLocaleDateString()}</text><text x="${W - R}" y="${H - 4}" text-anchor="end">${new Date(t1).toLocaleDateString()} · dashed lines = new session</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${g}</svg>`;
}

function gapChart(gaps) {
  if (!gaps.length) return empty();
  // bucket gaps into ranges
  const buckets = [
    ["<30s", 30e3], ["30s–1m", 60e3], ["1–2m", 120e3], ["2–3m", 180e3], ["3–5m", 300e3], ["5–10m", 600e3], ["10m+", Infinity],
  ];
  const counts = buckets.map(() => 0);
  for (const g of gaps) counts[buckets.findIndex(([, lim]) => g < lim)]++;
  return barChart(buckets.map(([label], i) => ({ label, v: counts[i] })), { labelEvery: 1, alt: true });
}

// keep "x ago" labels fresh without a full re-render
setInterval(() => {
  const now = Date.now();
  document.querySelectorAll("[data-ago]").forEach((el) => { const t = Number(el.dataset.ago); if (t) el.textContent = ago(t, now); });
  if (stats?.lastChest) $("lastChest").textContent = `Last chest ${ago(stats.lastChest.ts, now)}`;
}, 1000);
setInterval(() => { if (data) render(); }, 30_000); // refresh durations / rates

window.ChestLive.connect(onSummary, setLive);
