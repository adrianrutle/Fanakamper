import * as store from "./store.js";
import { TEAMS, STATUSES, OWNER_EMAIL } from "./config.js";
import { parseWorkbook } from "./excel-import.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const statusOf = (id) => STATUSES.find((s) => s.id === id) || STATUSES[0];
const today = () => new Date().toISOString().slice(0, 10);

const state = { user: null, matches: [], players: [], team: "", status: "", showPast: false, editing: null };

// ---------- Oppstart ----------
fillSelect($("#statusFilter"), STATUSES.map((s) => [s.id, s.label]), true);
fillSelect($("#playerTeam"), [...TEAMS, "Begge"].map((t) => [t, t]));
fillSelect($("#matchForm").team, TEAMS.map((t) => [t, t]));
fillSelect($("#matchForm").status, STATUSES.map((s) => [s.id, s.label]));
if (store.demoMode) $("#demoBanner").hidden = false;

store.init(onUser).catch((e) => showLoginError(e));

function fillSelect(sel, pairs, keepFirst = false) {
  if (!keepFirst) sel.innerHTML = "";
  for (const [v, l] of pairs) sel.add(new Option(l, v));
}

function onUser(user) {
  state.user = user;
  $("#login").hidden = !!user;
  $("#tabs").hidden = !user;
  $("#userBtn").hidden = !user;
  if (!user) return;
  $("#userBtn").textContent = "Logg ut";
  $("#userBtn").title = user.email;
  store.subscribe("matches", (list) => { state.matches = list; renderMatches(); }, onDbError);
  store.subscribe("players", (list) => { state.players = list; renderPlayers(); }, onDbError);
  showView("matches");
}

function onDbError(e) {
  console.error(e);
  if (e.code === "permission-denied") {
    $("#matchList").innerHTML = `<div class="card error">Kontoen <b>${esc(state.user.email)}</b> har ikke tilgang.
      Be ${esc(OWNER_EMAIL)} legge deg til under Innstillinger → Tilgang.</div>`;
  }
}

function showLoginError(e) {
  console.error(e);
  $("#login").hidden = false;
  $("#loginError").textContent = e.message || String(e);
}

$("#loginBtn").onclick = () => store.signIn().catch(showLoginError);
$("#userBtn").onclick = () => store.signOut();

// ---------- Navigasjon ----------
$$("#tabs button").forEach((b) => (b.onclick = () => showView(b.dataset.view)));
function showView(v) {
  $$(".view").forEach((s) => (s.hidden = s.id !== v));
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  if (v === "settings") loadAccess();
}

// ---------- Kampliste ----------
$$("#teamFilter button").forEach((b) => (b.onclick = () => {
  state.team = b.dataset.team;
  $$("#teamFilter button").forEach((x) => x.classList.toggle("active", x === b));
  renderMatches();
}));
$("#statusFilter").onchange = (e) => { state.status = e.target.value; renderMatches(); };
$("#showPast").onchange = (e) => { state.showPast = e.target.checked; renderMatches(); };

function sortKey(m) { return (m.date || "9999-99-99") + (m.time || ""); }

function renderMatches() {
  const t = today();
  let list = state.matches.filter((m) => !state.team || m.team === state.team);
  // Oppsummering per status for valgt lag (kommende kamper)
  const upcoming = list.filter((m) => !m.date || m.date >= t);
  $("#statusSummary").innerHTML = STATUSES.map((s) => {
    const n = upcoming.filter((m) => m.status === s.id).length;
    return n ? `<span class="pill" style="--c:${s.color}">${esc(s.label)}: ${n}</span>` : "";
  }).join("");

  if (state.status) list = list.filter((m) => m.status === state.status);
  if (!state.showPast) list = list.filter((m) => !m.date || m.date >= t);
  list.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  if (state.showPast) list.reverse();

  if (!list.length) {
    $("#matchList").innerHTML = `<p class="muted center">Ingen kamper her.</p>`;
    return;
  }
  let html = "", month = null;
  for (const m of list) {
    const mk = m.date ? m.date.slice(0, 7) : "uten-dato";
    if (mk !== month) {
      month = mk;
      html += `<h3 class="month">${m.date ? monthName(m.date) : "Uten dato"}</h3>`;
    }
    html += matchCard(m);
  }
  $("#matchList").innerHTML = html;
  $$("#matchList .match").forEach((el) => (el.onclick = (e) => {
    if (e.target.closest(".next")) return;
    openMatch(el.dataset.id);
  }));
  $$("#matchList .next").forEach((b) => (b.onclick = () => advance(b.dataset.id)));
}

function monthName(d) {
  return new Date(d + "T12:00").toLocaleDateString("no-NO", { month: "long", year: "numeric" });
}
function dayLabel(d) {
  return new Date(d + "T12:00").toLocaleDateString("no-NO", { weekday: "short", day: "numeric", month: "short" });
}

function matchCard(m) {
  const s = statusOf(m.status);
  const idx = STATUSES.indexOf(s);
  const next = idx < 4 ? STATUSES[idx + 1] : null; // ikke foreslå «Avlyst» som neste steg
  const squad = (m.squad || []).length;
  return `<article class="match" data-id="${m.id}" style="--c:${s.color}">
    <div class="when">
      <b>${m.date ? dayLabel(m.date) : "Dato?"}</b>
      <span>${esc(m.time || "--:--")}</span>
    </div>
    <div class="what">
      <div class="title"><span class="team team-${esc(m.team)}">${esc(m.team)}</span>
        ${m.homeAway === "Borte" ? "@ " : "vs "}${esc(m.opponent || "?")}</div>
      <div class="meta">${esc(m.venue || "Bane ikke satt")} · ${esc(m.type || "")} · Tropp: ${squad}</div>
      <span class="status">${esc(s.label)}</span>
    </div>
    ${next ? `<button class="next" data-id="${m.id}" title="Sett til «${esc(next.label)}»">→ ${esc(next.label)}</button>` : ""}
  </article>`;
}

async function advance(id) {
  const m = state.matches.find((x) => x.id === id);
  const idx = STATUSES.findIndex((s) => s.id === m.status);
  const next = STATUSES[Math.min(idx + 1, 4)];
  await store.update("matches", id, {
    status: next.id,
    log: [...(m.log || []), logEntry(`Status → ${next.label}`)],
    updatedAt: new Date().toISOString()
  });
}

function logEntry(text) {
  return { at: new Date().toISOString(), by: state.user.email, text };
}

// ---------- Kampskjema ----------
const form = $("#matchForm");
const dlg = $("#matchDialog");

$("#newMatchBtn").onclick = () => openMatch(null);
$("#cancelMatch").onclick = () => dlg.close();

function openMatch(id) {
  const m = id ? state.matches.find((x) => x.id === id) : {
    team: state.team || TEAMS[0], status: "planlagt", homeAway: "Hjemme", type: "Treningskamp", squad: []
  };
  state.editing = id;
  $("#matchTitle").textContent = id ? "Rediger kamp" : "Ny kamp";
  for (const el of form.elements) {
    if (el.name && el.name in form.elements) el.value = m[el.name] ?? "";
  }
  form.team.value = m.team || TEAMS[0];
  form.status.value = m.status || "planlagt";
  $("#deleteMatch").hidden = !id;
  renderSquadPicker(m.team, m.squad || []);
  const log = m.log || [];
  $("#logBox").hidden = !log.length;
  $("#logList").innerHTML = log.slice().reverse().map((l) =>
    `<li><span class="muted">${new Date(l.at).toLocaleString("no-NO")} · ${esc(l.by)}</span><br>${esc(l.text)}</li>`).join("");
  const venues = [...new Set(state.matches.map((x) => x.venue).filter(Boolean))].sort();
  $("#venueList").innerHTML = venues.map((v) => `<option value="${esc(v)}">`).join("");
  dlg.showModal();
}

form.team.onchange = () => renderSquadPicker(form.team.value, selectedSquad());

function selectedSquad() {
  return $$("#squadPicker input:checked").map((i) => i.value);
}

function renderSquadPicker(team, chosen) {
  const set = new Set(chosen);
  const own = (p) => p.team === team || p.team === "Begge";
  const players = state.players.slice().sort((a, b) =>
    (own(b) - own(a)) || a.name.localeCompare(b.name, "no"));
  if (!players.length) {
    $("#squadPicker").innerHTML = `<p class="muted">Legg til spillere under «Spillere» først.</p>`;
  } else {
    $("#squadPicker").innerHTML = players.map((p) => `
      <label class="${own(p) ? "" : "other"}"><input type="checkbox" value="${p.id}" ${set.has(p.id) ? "checked" : ""}>
        ${esc(p.name)}${own(p) ? "" : ` <small>(${esc(p.team)})</small>`}</label>`).join("");
  }
  const count = () => ($("#squadCount").textContent = `(${selectedSquad().length} valgt)`);
  $$("#squadPicker input").forEach((i) => (i.onchange = count));
  count();
}

form.onsubmit = async (e) => {
  e.preventDefault();
  const data = {};
  for (const el of form.elements) if (el.name) data[el.name] = el.value.trim();
  data.squad = selectedSquad();
  data.updatedAt = new Date().toISOString();
  const old = state.editing ? state.matches.find((x) => x.id === state.editing) : null;
  const log = [...(old?.log || [])];
  if (!old) log.push(logEntry(`Opprettet (${statusOf(data.status).label})`));
  else if (old.status !== data.status) log.push(logEntry(`Status → ${statusOf(data.status).label}`));
  else log.push(logEntry("Endret"));
  data.log = log;
  if (old) await store.update("matches", state.editing, data);
  else await store.add("matches", { ...data, createdBy: state.user.email, createdAt: data.updatedAt });
  dlg.close();
};

$("#deleteMatch").onclick = async () => {
  if (!confirm("Slette denne kampen?")) return;
  await store.remove("matches", state.editing);
  dlg.close();
};

// ---------- Spillere ----------
$("#playerForm").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("#playerName").value.trim();
  if (!name) return;
  await store.add("players", { name, team: $("#playerTeam").value });
  $("#playerName").value = "";
};

function renderPlayers() {
  const groups = [...TEAMS, "Begge"].map((t) => {
    const ps = state.players.filter((p) => p.team === t).sort((a, b) => a.name.localeCompare(b.name, "no"));
    if (!ps.length) return "";
    return `<div class="card"><h3>${esc(t)} <span class="muted">(${ps.length})</span></h3>
      <ul class="players">${ps.map((p) => `<li>
        <span>${esc(p.name)}</span>
        <select data-id="${p.id}">${[...TEAMS, "Begge"].map((x) =>
          `<option ${x === p.team ? "selected" : ""}>${x}</option>`).join("")}</select>
        <button class="ghost del" data-id="${p.id}" title="Fjern">✕</button></li>`).join("")}</ul></div>`;
  }).join("");
  $("#playerList").innerHTML = groups || `<p class="muted center">Ingen spillere ennå.</p>`;
  $$("#playerList select").forEach((s) => (s.onchange = () => store.update("players", s.dataset.id, { team: s.value })));
  $$("#playerList .del").forEach((b) => (b.onclick = () => {
    if (confirm("Fjerne spilleren?")) store.remove("players", b.dataset.id);
  }));
}

// ---------- Innstillinger ----------
async function loadAccess() {
  try {
    const doc = await store.get("config", "access");
    $("#accessList").value = (doc?.emails || []).join("\n");
  } catch (e) {
    $("#accessMsg").textContent = "Kun eier kan se/endre tilgang.";
  }
}

$("#saveAccess").onclick = async () => {
  const emails = $("#accessList").value.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  try {
    await store.add("config", { emails }, "access");
    $("#accessMsg").textContent = "Lagret ✓";
  } catch (e) {
    $("#accessMsg").textContent = "Kunne ikke lagre: " + e.message;
  }
};

$("#importFile").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const msg = $("#importMsg");
  msg.textContent = "Leser arket…";
  try {
    const seed = await parseWorkbook(await file.arrayBuffer());
    if (!confirm(`Fant ${seed.matches.length} kamper og ${seed.players.length} spillere. Importere?`)) {
      msg.textContent = "";
      return;
    }
    msg.textContent = "Importerer…";
    const have = new Set(state.matches.map((m) => m.id));
    const havePlayers = new Set(state.players.map((p) => p.id));
    let nm = 0, np = 0;
    for (const p of seed.players || []) {
      if (havePlayers.has(p.id)) continue;
      const { id, ...rest } = p;
      await store.add("players", rest, id);
      np++;
    }
    for (const m of seed.matches || []) {
      if (have.has(m.id)) continue;
      const { id, ...rest } = m;
      await store.add("matches", {
        ...rest,
        log: [logEntry(`Importert fra ${file.name}`)],
        createdBy: state.user.email, createdAt: new Date().toISOString()
      }, id);
      nm++;
    }
    msg.textContent = `Importerte ${nm} kamper og ${np} spillere.`;
  } catch (e) {
    msg.textContent = "Feil: " + e.message;
  }
  e.target.value = "";
};

$("#exportCsv").onclick = () => {
  const cols = ["team", "status", "date", "time", "meetTime", "type", "opponent", "homeAway", "venue", "contact", "notes"];
  const name = (id) => state.players.find((p) => p.id === id)?.name || id;
  const rows = [[...cols, "squad"], ...state.matches
    .slice().sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    .map((m) => [...cols.map((c) => c === "status" ? statusOf(m.status).label : m[c] ?? ""),
      (m.squad || []).map(name).join(", ")])];
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
  a.download = `kamper-${today()}.csv`;
  a.click();
};

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
