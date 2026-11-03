import * as store from "./store.js";
import { TEAMS, STATUSES, OWNER_EMAIL, POSITIONS, MATCH_POSITIONS, FORMATIONS, DEFAULT_FORMATION } from "./config.js";
import { slots, targets, countGroups, balanceIssues, autoAssign, autoLineup } from "./lineup.js";
import { parseWorkbook, loadXlsx, FIRST_UNPLANNED } from "./excel-import.js";
import { spondRows, toIcs } from "./spond.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Ukjent status (f.eks. gammel lagret kode i nettleseren) vises som den er, ikke som første status i lista
const statusOf = (id) => STATUSES.find((s) => s.id === id) || { id, label: id || "Uten status", color: "#94a3b8" };
const today = () => new Date().toISOString().slice(0, 10);
const hasResult = (m) => m.goalsFor !== "" && m.goalsFor != null && m.goalsAgainst !== "" && m.goalsAgainst != null;
// «S», «U» eller «T» sett fra Fana
const outcome = (m) => {
  const d = Number(m.goalsFor) - Number(m.goalsAgainst);
  return d > 0 ? "S" : d < 0 ? "T" : "U";
};

const state = { user: null, matches: [], players: [], team: "", status: "", showPast: false, matrixTeams: new Set(), playerTeams: new Set(), playerSort: "name", editing: null, role: null, access: null };
const canSquad = () => state.role === "owner" || state.role === "eval";
const SPILT = STATUSES.findIndex((s) => s.id === "spilt");
const teamRank = (t) => (TEAMS.includes(t) ? TEAMS.indexOf(t) : TEAMS.length);
const byTeamAndName = (a, b) => (teamRank(a.team) - teamRank(b.team)) || a.name.localeCompare(b.name, "no");
const posOf = (id) => POSITIONS.find((x) => x.id === id);
// Spillerens posisjoner som korte koder, f.eks. «SM / OM / K»
const posShort = (p) => (p.positions || []).filter(posOf).join(" / ");
const posLong = (p) => (p.positions || []).map((id) => posOf(id)?.label).filter(Boolean).join(", ");
// Forslag til kampposisjon: gruppen til spillerens førstevalg
const defaultMatchPos = (p) => posOf((p?.positions || []).find(posOf))?.group || "";
const ROLE_LABEL = { owner: "Eier (full tilgang)", eval: "Evalueringsgruppen – kan sette opp tropper", reader: "Lesetilgang til tropper" };

// ---------- Oppstart ----------
fillSelect($("#statusFilter"), STATUSES.map((s) => [s.id, s.label]), true);
fillSelect($("#playerTeam"), TEAMS.map((t) => [t, t]));
fillSelect($("#matchForm").team, TEAMS.map((t) => [t, t]));
fillSelect($("#matchForm").status, STATUSES.map((s) => [s.id, s.label]));
fillSelect($("#formation"), FORMATIONS.map((f) => [f, f]));
if (store.demoMode) $("#demoBanner").hidden = false;


function fillSelect(sel, pairs, keepFirst = false) {
  if (!keepFirst) sel.innerHTML = "";
  for (const [v, l] of pairs) sel.add(new Option(l, v));
}

async function onUser(user) {
  state.user = user;
  $("#login").hidden = !!user;
  $("#tabs").hidden = !user;
  $("#userBtn").hidden = !user;
  if (!user) return;
  $("#userBtn").textContent = "Logg ut";
  $("#userBtn").title = user.email;
  await resolveRole();
  store.subscribe("matches", (list) => { state.matches = list; renderMatches(); renderStats(); migrateUnplanned(); }, onDbError);
  store.subscribe("players", (list) => {
    state.players = list;
    migrateBegge();
    cleanupPlayers();
    renderPlayers();
    renderStats();
    if (dlg.open && !$$("#squadPicker input").length) {
      const m = state.matches.find((x) => x.id === state.editing);
      renderSquadPicker(form.team.value, m?.squad || [], m?.positions || {});
    }
  }, onDbError);
  showView("matches");
}

// Kamper fra 2027 som ble importert som «Avtalt» og ikke er rørt siden, settes til «Ikke planlagt».
// Kjøres én gang per kamp: etterpå har kampen to logglinjer og blir ikke truffet igjen.
let migrating = false;
async function migrateUnplanned() {
  if (!canSquad() || migrating) return;
  const todo = state.matches.filter((m) => m.date >= FIRST_UNPLANNED && m.status === "avtalt" &&
    (m.log || []).length === 1 && m.log[0].text.startsWith("Importert"));
  if (!todo.length) return;
  migrating = true;
  try {
    for (const m of todo) {
      await store.update("matches", m.id, {
        status: "ikkeplanlagt",
        log: [...m.log, logEntry("Status → Ikke planlagt (2027-kamp)")],
        updatedAt: new Date().toISOString()
      });
    }
  } finally { migrating = false; }
}

// Spillere som sto på «Begge» før Blå fantes, hører nå til Blå.
let movingBegge = false;
async function migrateBegge() {
  if (!canSquad() || movingBegge) return;
  const todo = state.players.filter((p) => p.team === "Begge");
  if (!todo.length) return;
  movingBegge = true;
  try {
    for (const p of todo) await store.update("players", p.id, { team: "Blå" });
  } finally { movingBegge = false; }
}

// Engangsrydding (2. nov. 2026): slett Stas og Emilian, og gi Youssef posisjonen Keeper.
// Eieren får spørsmål før noe endres. Kan fjernes når det er gjort.
let cleaning = false;
async function cleanupPlayers() {
  if (state.role !== "owner" || cleaning || localStorage.getItem("fk_cleanup_2026_11_02")) return;
  const byFirst = (n) => state.players.filter((p) => p.name.trim().split(/\s+/)[0].toLowerCase() === n);
  const del = ["stas", "emilian"].flatMap((n) => { const m = byFirst(n); return m.length === 1 ? m : []; });
  const yo = byFirst("youssef");
  const keeper = yo.length === 1 && !(yo[0].positions || []).includes("K") ? yo[0] : null;
  if (!del.length && !keeper) return;
  cleaning = true;
  const what = [...del.map((p) => `• Slette ${p.name}`), ...(keeper ? [`• Gi ${keeper.name} posisjonen Keeper (K)`] : [])];
  try {
    if (confirm(`Rydding av spillerlisten:\n${what.join("\n")}\n\nGjøre dette nå?`)) {
      for (const p of del) await store.remove("players", p.id);
      if (keeper) {
        const pos = keeper.positions || [];
        await store.update("players", keeper.id, { positions: pos.length < 3 ? [...pos, "K"] : [...pos.slice(0, 2), "K"] });
      }
    }
    localStorage.setItem("fk_cleanup_2026_11_02", "1");
  } finally { cleaning = false; }
}

// Rollen avgjøres av listene i config/access. Reglene i firestore.rules håndhever det samme på serveren.
async function resolveRole() {
  const email = state.user.email.toLowerCase();
  try {
    state.access = await store.get("config", "access");
  } catch (e) {
    state.access = null; // ingen tilgang til lista = ikke medlem (eier har alltid tilgang)
  }
  const a = state.access || {};
  state.role = email === OWNER_EMAIL.toLowerCase() ? "owner"
    : (a.evaluators || []).includes(email) ? "eval"
    : (a.readers || []).includes(email) ? "reader" : null;
  document.body.dataset.role = state.role || "none";
  $("#roleInfo").innerHTML = state.role
    ? `${esc(state.user.email)}: <span class="role">${ROLE_LABEL[state.role]}</span>`
    : `${esc(state.user.email)} har ikke tilgang.`;
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
  const next = idx < SPILT ? STATUSES[idx + 1] : null; // ikke foreslå «Avlyst» som neste steg
  const squad = (m.squad || []).length;
  const warn = squad && balanceIssues(m.formation || DEFAULT_FORMATION, m.squad, m.positions).length;
  return `<article class="match" data-id="${m.id}" style="--c:${s.color}">
    <div class="when">
      <b>${m.date ? dayLabel(m.date) : "Dato?"}</b>
      <span>${esc(m.time || "--:--")}</span>
    </div>
    <div class="what">
      <div class="title"><span class="team team-${esc(m.team)}">${esc(m.team)}</span>
        ${m.homeAway === "Borte" ? "@ " : "vs "}${esc(m.opponent || "?")}
        ${hasResult(m) ? `<span class="score score-${outcome(m)}">${esc(m.goalsFor)}–${esc(m.goalsAgainst)}</span>` : ""}</div>
      <div class="meta">${esc(m.venue || "Bane ikke satt")} · ${esc(m.type || "")} · Tropp: ${squad}${warn ? ` <span class="warn" title="Skjev fordeling av posisjoner">⚠</span>` : ""}</div>
      <span class="status">${esc(s.label)}</span>
    </div>
    ${next ? `<button class="next" data-id="${m.id}" title="Sett til «${esc(next.label)}»">→ ${esc(next.label)}</button>` : ""}
  </article>`;
}

async function advance(id) {
  const m = state.matches.find((x) => x.id === id);
  const idx = STATUSES.findIndex((s) => s.id === m.status);
  const next = STATUSES[Math.min(idx + 1, SPILT)];
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
    team: state.team || TEAMS[0], status: STATUSES[0].id, homeAway: "Hjemme", type: "Treningskamp", squad: []
  };
  state.editing = id;
  $("#matchTitle").textContent = id ? "Rediger kamp" : "Ny kamp";
  for (const el of form.elements) {
    if (el.name && el.name in form.elements) el.value = m[el.name] ?? "";
  }
  form.team.value = m.team || TEAMS[0];
  form.status.value = m.status || STATUSES[0].id;
  $("#deleteMatch").hidden = !id;
  $("#resultOpponent").textContent = m.opponent || "Motstander";
  $("#formation").value = FORMATIONS.includes(m.formation) ? m.formation : DEFAULT_FORMATION;
  board.lineup = [...(m.lineup || [])];
  board.xy = [...(m.slotXY || [])];
  board.picked = null;
  renderSquadPicker(m.team, m.squad || [], m.positions || {});
  const log = m.log || [];
  $("#logBox").hidden = !log.length;
  $("#logList").innerHTML = log.slice().reverse().map((l) =>
    `<li><span class="muted">${new Date(l.at).toLocaleString("no-NO")} · ${esc(l.by)}</span><br>${esc(l.text)}</li>`).join("");
  const venues = [...new Set(state.matches.map((x) => x.venue).filter(Boolean))].sort();
  $("#venueList").innerHTML = venues.map((v) => `<option value="${esc(v)}">`).join("");
  dlg.showModal();
}

form.team.onchange = () => renderSquadPicker(form.team.value, selectedSquad(), selectedPositions());
form.opponent.oninput = () => ($("#resultOpponent").textContent = form.opponent.value || "Motstander");

function selectedSquad() {
  return $$("#squadPicker input:checked").map((i) => i.value);
}

// Kampposisjon for hver uttatt spiller, f.eks. { spillerId: "M" }
function selectedPositions() {
  const out = {};
  for (const s of $$("#squadPicker select.mpos")) {
    if (s.closest(".pick").querySelector("input").checked && s.value) out[s.dataset.id] = s.value;
  }
  return out;
}

function renderSquadPicker(team, chosen, positions = {}) {
  const set = new Set(chosen);
  // Alle spillere kan velges; spillere på kampens lag vises først som anbefalt
  const own = state.players.filter((p) => p.team === team).sort(byTeamAndName);
  const rest = state.players.filter((p) => p.team !== team).sort(byTeamAndName);
  const box = (p) => {
    const on = set.has(p.id);
    const pos = positions[p.id] || "";
    return `<div class="pick${on ? " on" : ""}">
      <label title="${esc((p.team || "Uten lag") + (posLong(p) ? " · " + posLong(p) : ""))}">
        <input type="checkbox" value="${p.id}" ${on ? "checked" : ""} ${canSquad() ? "" : "disabled"}>
        <span class="dot team-${esc(p.team)}"></span><span class="pname">${esc(p.name)}
        ${posShort(p) ? `<small class="muted">${esc(posShort(p))}</small>` : ""}</span></label>
      <select class="mpos" data-id="${p.id}" ${canSquad() ? "" : "disabled"} aria-label="Posisjon i kampen">
        <option value="">–</option>${MATCH_POSITIONS.map((x) =>
          `<option value="${x.id}" ${x.id === pos ? "selected" : ""}>${x.label}</option>`).join("")}
      </select></div>`;
  };
  if (!state.players.length) {
    $("#squadPicker").innerHTML = `<p class="muted">Legg til spillere under «Spillere» først.</p>`;
  } else {
    $("#squadPicker").innerHTML =
      (own.length ? `<div class="squad-group"><span class="team team-${esc(team)}">${esc(team)}</span> anbefalt for denne kampen</div>
        <div class="squad">${own.map(box).join("")}</div>` : "") +
      (rest.length ? `<div class="squad-group rest">Andre spillere</div>
        <div class="squad">${rest.map(box).join("")}</div>` : "");
  }
  $("#squadLocked").hidden = canSquad();
  const count = () => { renderBalance(); renderBoard(); };
  $$("#squadPicker input").forEach((i) => (i.onchange = () => {
    const pick = i.closest(".pick");
    pick.classList.toggle("on", i.checked);
    // Foreslå posisjon ut fra spillerens førstevalg når spilleren tas ut
    const sel = pick.querySelector("select.mpos");
    if (i.checked && !sel.value) sel.value = defaultMatchPos(state.players.find((p) => p.id === i.value));
    count();
  }));
  $$("#squadPicker select.mpos").forEach((s) => (s.onchange = count));
  count();
}

form.onsubmit = async (e) => {
  e.preventDefault();
  const data = {};
  for (const el of form.elements) if (el.name) data[el.name] = el.value.trim();
  const old = state.editing ? state.matches.find((x) => x.id === state.editing) : null;
  // Var spillerlisten ikke lastet da kampen ble åpnet, finnes ingen avkrysningsbokser – behold da troppen
  if (canSquad() && $$("#squadPicker input").length) {
    data.squad = selectedSquad();
    data.positions = selectedPositions();
    data.formation = $("#formation").value;
    data.lineup = currentLineup();
    data.slotXY = slots(data.formation).map((_, i) => board.xy[i] || null);
  } else if (!old) {
    data.squad = [];
  }
  // Ellers sendes ikke tropp/posisjoner/oppstilling med, så de blir stående urørt i databasen
  data.updatedAt = new Date().toISOString();
  const log = [...(old?.log || [])];
  if (hasResult(data)) {
    // Et registrert resultat betyr at kampen er spilt
    if (data.status !== "avlyst") data.status = "spilt";
    if (!old || !hasResult(old) || old.goalsFor !== data.goalsFor || old.goalsAgainst !== data.goalsAgainst) {
      log.push(logEntry(`Resultat ${data.goalsFor}–${data.goalsAgainst}`));
    }
  }
  if (!old) log.push(logEntry(`Opprettet (${statusOf(data.status).label})`));
  else if (old.status !== data.status) log.push(logEntry(`Status → ${statusOf(data.status).label}`));
  else log.push(logEntry("Endret"));
  data.log = log;
  if (old) await store.update("matches", state.editing, data);
  else await store.add("matches", { ...data, createdBy: state.user.email, createdAt: data.updatedAt });
  dlg.close();
};

// ---------- Fordeling og laguppstilling ----------
const board = { lineup: [], picked: null, xy: [], dragged: false };
const playerById = (id) => state.players.find((p) => p.id === id);
const firstName = (id) => (playerById(id)?.name || "?").split(" ")[0];
const posSelect = (id) => $(`#squadPicker select.mpos[data-id="${id}"]`);

function renderBalance() {
  const f = $("#formation").value;
  const squad = selectedSquad();
  const pos = selectedPositions();
  const c = countGroups(squad, pos);
  const t = targets(f, squad.length);
  const issues = balanceIssues(f, squad, pos);
  $("#squadCount").textContent = `(${squad.length} valgt)`;
  $("#balance").innerHTML = squad.length ? `
    <div class="bal-row">${MATCH_POSITIONS.map((x) => {
      const off = x.id === "K" ? c.K !== 1 : Math.abs(c[x.id] - t[x.id]) >= 2;
      return `<span class="bal g-${x.id}${off ? " off" : ""}" title="${x.label}: ${c[x.id]}, anbefalt ${t[x.id]}">
        ${x.label} <b>${c[x.id]}</b><small>/${t[x.id]}</small></span>`;
    }).join("")}
    <button type="button" id="autoAssign" class="eval-only small">⚖️ Fordel posisjoner</button></div>
    ${issues.length ? `<ul class="issues">${issues.map((i) => `<li>⚠ ${esc(i)}</li>`).join("")}</ul>`
      : `<p class="ok">✓ God fordeling for ${esc(f)}</p>`}` : "";
  const btn = $("#autoAssign");
  if (btn) btn.onclick = () => {
    if (Object.keys(pos).length && !confirm("Fordele posisjonene på nytt for hele troppen? Banen tømmes.")) return;
    const res = autoAssign(squad.map(playerById).filter(Boolean), f);
    for (const [id, g] of Object.entries(res)) { const s = posSelect(id); if (s) s.value = g; }
    board.lineup = [];
    board.picked = null;
    renderBalance(); renderBoard();
  };
}

// Oppstillingen begrenset til spillere som faktisk er i troppen
function currentLineup() {
  const squad = new Set(selectedSquad());
  const seen = new Set();
  return slots($("#formation").value).map((_, i) => {
    const id = board.lineup[i];
    if (!id || !squad.has(id) || seen.has(id)) return "";
    seen.add(id);
    return id;
  });
}

// Spiller som settes inn på en plass, får plassens kampposisjon
function syncLineupPositions() {
  const sl = slots($("#formation").value);
  board.lineup.forEach((id, i) => { if (id && sl[i]) { const s = posSelect(id); if (s) s.value = sl[i].g; } });
}

function renderBoard() {
  const sl = slots($("#formation").value);
  board.lineup = currentLineup();
  const onPitch = new Set(board.lineup.filter(Boolean));
  const pos = selectedPositions();
  const bench = selectedSquad().filter((id) => !onPitch.has(id))
    .sort((a, b) => "KFMA".indexOf(pos[a] || "Z") - "KFMA".indexOf(pos[b] || "Z") || firstName(a).localeCompare(firstName(b), "no"));
  const pk = board.picked;
  $("#pitch").innerHTML = `<div class="pitch-lines"><span class="box top"></span><span class="mid"></span><span class="circle"></span><span class="box bottom"></span></div>` +
    sl.map((s, i) => {
      const id = board.lineup[i];
      return `<button type="button" class="slot g-${s.g}${id ? " filled" : ""}${id && id === pk ? " picked" : ""}" data-slot="${i}"
        style="left:${board.xy[i]?.x ?? s.x}%;top:${board.xy[i]?.y ?? s.y}%" title="${esc(s.pos)}">
        <span class="shirt">${id ? esc(firstName(id).slice(0, 2)) : esc(s.pos)}</span>
        <span class="nm">${id ? esc(firstName(id)) : "&nbsp;"}</span></button>`;
    }).join("");
  $("#bench").innerHTML = `<div class="bench-head">Innbyttere (${bench.length})</div>` +
    (bench.length ? bench.map((id) => `<button type="button" class="chip g-${pos[id] || "none"}${id === pk ? " picked" : ""}" data-id="${id}">
      ${esc(playerById(id)?.name || id)} <small>${esc(pos[id] || "–")}</small></button>`).join("")
      : `<span class="muted">${selectedSquad().length ? "Alle i troppen er på banen." : "Velg kamptropp først."}</span>`);
  $("#resetXY").hidden = !board.xy.some(Boolean);
  if (!canSquad()) return;
  $$("#pitch .slot").forEach((b) => {
    b.onclick = () => { if (!board.dragged) clickSlot(+b.dataset.slot); };
    b.onpointerdown = (e) => startDrag(e, b, { slot: +b.dataset.slot, id: board.lineup[+b.dataset.slot] });
  });
  $$("#bench .chip").forEach((b) => (b.onpointerdown = (e) => startDrag(e, b, { id: b.dataset.id })));
  $$("#bench .chip").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    if (board.dragged) return;
    board.picked = board.picked === b.dataset.id ? null : b.dataset.id;
    renderBoard();
  }));
  $("#bench").onclick = () => {
    if (board.dragged) return;
    // Spiller valgt på banen + trykk på benken = ta spilleren av
    if (!board.picked || !onPitch.has(board.picked)) return;
    board.lineup = board.lineup.map((x) => (x === board.picked ? "" : x));
    board.picked = null;
    renderBalance(); renderBoard();
  };
}

function clickSlot(i) {
  const occupant = board.lineup[i] || "";
  const pk = board.picked;
  if (!pk) {
    if (occupant) { board.picked = occupant; renderBoard(); }
    return;
  }
  if (pk === occupant) { board.picked = null; renderBoard(); return; }
  placePlayer(pk, i);
}

// Setter spilleren på plass i; står spilleren alt på banen, bytter de to plass
function placePlayer(pk, i) {
  const occupant = board.lineup[i] || "";
  const from = board.lineup.indexOf(pk);
  board.lineup[i] = pk;
  if (from >= 0) board.lineup[from] = occupant; // bytt plass på banen
  board.picked = null;
  syncLineupPositions();
  renderBalance(); renderBoard();
}

// Dra og slipp (mus og berøring): slipp på en plass = sett inn/bytt, på gresset = flytt plassen dit,
// på «Innbyttere» = ta av banen. Et vanlig trykk uten å dra fungerer som før.
function startDrag(e, el, src) {
  if (e.button > 0) return;
  const x0 = e.clientX, y0 = e.clientY;
  let ghost = null;
  board.dragged = false;
  const move = (ev) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 8) return;
      board.dragged = true;
      ghost = el.cloneNode(true);
      ghost.classList.add("ghost-drag");
      dlg.append(ghost); // dialogen ligger øverst, så skyggen må ligge i den
      el.classList.add("dragging");
    }
    ev.preventDefault();
    ghost.style.left = ev.clientX + "px";
    ghost.style.top = ev.clientY + "px";
  };
  const up = (ev) => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
    if (!ghost) return;
    ghost.remove();
    el.classList.remove("dragging");
    drop(src, ev.clientX, ev.clientY);
    // Klikket som følger etter slipp skal ikke tolkes som et trykk
    setTimeout(() => (board.dragged = false), 0);
  };
  el.setPointerCapture?.(e.pointerId);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}

function drop(src, x, y) {
  const target = document.elementFromPoint(x, y);
  const slotEl = target?.closest("#pitch .slot");
  const pitch = $("#pitch");
  board.picked = null;
  if (slotEl && +slotEl.dataset.slot !== src.slot) {
    if (src.id) placePlayer(src.id, +slotEl.dataset.slot);
    else { renderBoard(); }
    return;
  }
  if (target?.closest("#bench")) {
    if (src.slot !== undefined && src.id) board.lineup[src.slot] = "";
    renderBalance(); renderBoard();
    return;
  }
  if (src.slot !== undefined && target && pitch.contains(target)) {
    // Flytt plassen fritt på banen
    const r = pitch.getBoundingClientRect();
    const clamp = (v) => Math.min(95, Math.max(5, Math.round(v)));
    board.xy[src.slot] = { x: clamp(((x - r.left) / r.width) * 100), y: clamp(((y - r.top) / r.height) * 100) };
  }
  renderBoard();
}

$("#formation").onchange = () => { board.xy = []; syncLineupPositions(); renderBalance(); renderBoard(); };
$("#clearLineup").onclick = () => { board.lineup = []; board.picked = null; renderBoard(); };
$("#resetXY").onclick = () => { board.xy = []; renderBoard(); };
$("#autoLineup").onclick = () => {
  const f = $("#formation").value;
  const players = selectedSquad().map(playerById).filter(Boolean);
  if (!players.length) return alert("Velg kamptropp først.");
  // Spillere uten kampposisjon får en først, så fordelingen holder seg jevn
  const pos = autoAssign(players, f, selectedPositions());
  for (const [id, g] of Object.entries(pos)) { const s = posSelect(id); if (s && !s.value) s.value = g; }
  // Telling av starter i andre kamper, for å fordele spilletid
  const starts = {};
  for (const m of state.matches) if (m.id !== state.editing && m.status !== "avlyst")
    for (const id of m.lineup || []) if (id) starts[id] = (starts[id] || 0) + 1;
  board.lineup = autoLineup(f, players, selectedPositions(), currentLineup(), starts);
  board.picked = null;
  syncLineupPositions();
  renderBalance(); renderBoard();
};

// ---------- Forespørsel til motstander ----------
// Åpner brukerens egen e-post-/SMS-app med ferdig tekst; appen sender ingenting selv.
function requestText() {
  const f = form;
  const own = `Fana G2014 ${f.team.value}`;
  const when = f.date.value
    ? new Date(f.date.value + "T12:00").toLocaleDateString("no-NO", { weekday: "long", day: "numeric", month: "long" }) +
      (f.time.value ? ` kl. ${f.time.value}` : "")
    : "et tidspunkt som passer dere";
  const where = f.venue.value ? `${f.venue.value} (${f.homeAway.value === "Borte" ? "hos dere" : "hjemme hos oss"})`
    : f.homeAway.value === "Borte" ? "hos dere" : "hjemme hos oss";
  const subject = `${f.type.value || "Kamp"}: ${own} – ${f.opponent.value || "?"}`;
  const body = [
    "Hei!",
    "",
    `${own} ønsker å spille ${(f.type.value || "kamp").toLowerCase()} mot ${f.opponent.value || "dere"}.`,
    "",
    `Forslag: ${when}`,
    `Sted: ${where}`,
    "",
    "Passer dette? Gi gjerne beskjed om et annet tidspunkt passer bedre.",
    "",
    "Hilsen",
    state.user?.name || "",
    own
  ].join("\n");
  return { subject, body };
}

const contactEmail = () => (form.contact.value.match(/[^\s,;<>]+@[^\s,;<>]+\.[a-z]{2,}/i) || [""])[0];
const contactPhone = () => ((form.contact.value.match(/\+?\d[\d ]{6,}\d/) || [""])[0]).replace(/ /g, "");

// Sett status til «Forespørsel sendt» når kampen ikke er forespurt ennå
async function markRequested(how) {
  if (!["ikkeplanlagt", "planlagt"].includes(form.status.value)) return;
  form.status.value = "forespurt";
  const m = state.editing && state.matches.find((x) => x.id === state.editing);
  if (!m) return; // ny kamp: statusen lagres når skjemaet lagres
  await store.update("matches", m.id, {
    status: "forespurt",
    log: [...(m.log || []), logEntry(`Forespørsel sendt (${how})`)],
    updatedAt: new Date().toISOString()
  });
}

$("#requestMail").onclick = () => {
  const { subject, body } = requestText();
  location.href = `mailto:${encodeURIComponent(contactEmail())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  markRequested("e-post");
};
$("#requestSms").onclick = () => {
  // «?&body=» fungerer både på iPhone og Android
  location.href = `sms:${contactPhone()}?&body=${encodeURIComponent(requestText().body)}`;
  markRequested("SMS");
};
$("#requestCopy").onclick = async () => {
  await navigator.clipboard.writeText(requestText().body);
  $("#requestCopy").textContent = "✅ Kopiert";
  setTimeout(() => ($("#requestCopy").textContent = "📋 Kopier tekst"), 2000);
  markRequested("kopiert tekst");
};

$("#deleteMatch").onclick = async () => {
  if (!confirm("Slette denne kampen?")) return;
  await store.remove("matches", state.editing);
  dlg.close();
};

// ---------- Laguttak (statistikk) ----------
// Valgene huskes i denne nettleseren
try {
  const saved = JSON.parse(localStorage.getItem("fk_laguttak") || "{}");
  state.matrixTeams = new Set(saved.matches || []);
  state.playerTeams = new Set(saved.players || []);
  state.playerSort = saved.sort === "team" ? "team" : "name";
} catch (e) { /* ignorer */ }
const saveStatsPrefs = () => {
  try {
    localStorage.setItem("fk_laguttak", JSON.stringify({
      matches: [...state.matrixTeams], players: [...state.playerTeams], sort: state.playerSort }));
  } catch (e) { /* ignorer */ }
};

// Flervalg: «Alle» tømmer utvalget, en farge slås av/på. Ingen farge valgt = alle.
function multiFilter(sel, set) {
  const paint = () => $$(`${sel} button`).forEach((x) =>
    x.classList.toggle("active", x.dataset.team ? set.has(x.dataset.team) : !set.size));
  $$(`${sel} button`).forEach((b) => (b.onclick = () => {
    const t = b.dataset.team;
    if (!t) set.clear();
    else if (set.has(t)) set.delete(t);
    else set.add(t);
    if (set.size === TEAMS.length) set.clear(); // alle valgt = «Alle»
    paint(); saveStatsPrefs(); renderStats();
  }));
  paint();
}
multiFilter("#matrixTeam", state.matrixTeams);
multiFilter("#playerFilter", state.playerTeams);
$$("#playerSort button").forEach((b) => {
  b.classList.toggle("active", b.dataset.sort === state.playerSort);
  b.onclick = () => {
    state.playerSort = b.dataset.sort;
    $$("#playerSort button").forEach((x) => x.classList.toggle("active", x === b));
    saveStatsPrefs(); renderStats();
  };
});
const byName = (a, b) => a.name.localeCompare(b.name, "no");
const pdot = (p) => `<span class="pdot team-${esc(p.team)}" title="${esc(p.team || "Uten lag")}"></span>`;

function renderStats() {
  const active = state.matches.filter((m) => m.status !== "avlyst")
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  // Resultater per lag
  const rows = [...TEAMS, "Totalt"].map((t) => {
    const ms = active.filter((m) => hasResult(m) && (t === "Totalt" || m.team === t));
    const c = { S: 0, U: 0, T: 0 };
    let gf = 0, ga = 0;
    for (const m of ms) { c[outcome(m)]++; gf += Number(m.goalsFor); ga += Number(m.goalsAgainst); }
    const form = ms.slice(-5).map((m) => `<span class="score score-${outcome(m)}">${outcome(m)}</span>`).join("");
    return `<tr><th>${t === "Totalt" ? t : `<span class="team team-${t}">${t}</span>`}</th>
      <td>${ms.length}</td><td>${c.S}</td><td>${c.U}</td><td>${c.T}</td>
      <td>${gf}–${ga}</td><td>${gf - ga > 0 ? "+" : ""}${gf - ga}</td><td class="form">${form}</td></tr>`;
  }).join("");
  const played = active.filter(hasResult).reverse();
  $("#resultStats").innerHTML = `<div class="table-wrap"><table class="stats">
      <tr><th></th><th>K</th><th>S</th><th>U</th><th>T</th><th>Mål</th><th>+/-</th><th>Siste 5</th></tr>${rows}</table></div>
    ${played.length ? `<ul class="results">${played.map((m) => `<li>
      <span class="muted">${dayLabel(m.date)}</span>
      <span class="team team-${esc(m.team)}">${esc(m.team)}</span>
      ${m.homeAway === "Borte" ? "@" : "vs"} ${esc(m.opponent)}
      <span class="score score-${outcome(m)}">${esc(m.goalsFor)}–${esc(m.goalsAgainst)}</span></li>`).join("")}</ul>`
      : `<p class="muted">Ingen resultater registrert ennå. Åpne en kamp og fyll inn resultatet.</p>`}`;

  // Spillere: antall kamper per nivå
  const players = state.players
    .filter((p) => !state.playerTeams.size || state.playerTeams.has(p.team))
    .sort(state.playerSort === "team" ? byTeamAndName : byName);
  const count = (p, pred) => active.filter((m) => (m.squad || []).includes(p.id) && pred(m)).length;
  $("#playerStats").innerHTML = `<tr><th>Spiller</th><th>Nivå</th><th>Posisjoner</th>
      ${TEAMS.map((t) => `<th><span class="team team-${t}">${t}</span></th>`).join("")}
      <th>Totalt</th><th>Spilt</th></tr>` +
    players.map((p) => {
      const per = TEAMS.map((t) => count(p, (m) => m.team === t));
      const total = per.reduce((a, b) => a + b, 0);
      return `<tr class="${total ? "" : "zero"}"><th>${pdot(p)}${esc(p.name)}</th><td>${esc(p.team)}</td><td title="${esc(posLong(p))}">${esc(posShort(p))}</td>
        ${per.map((n) => `<td>${n || ""}</td>`).join("")}
        <td><b>${total}</b></td><td>${count(p, (m) => m.status === "spilt") || ""}</td></tr>`;
    }).join("");

  // Matrise: spillere × kamper (innbyttere vises svakere når kampen har oppstilling)
  const isSub = (m, id) => (m.lineup || []).some(Boolean) && !m.lineup.includes(id);
  const cols = active.filter((m) => !state.matrixTeams.size || state.matrixTeams.has(m.team));
  // Antall kamper står i den faste navnekolonnen, så det alltid er synlig når tabellen rulles sidelengs.
  // Hver kampkolonne viser dato, lag, bane og antall i troppen.
  $("#matrix").innerHTML = `<tr><th><div class="pcell">Spiller <span class="nbadge head" title="Antall kamper">Kamper</span></div></th>${cols.map((m) =>
      `<th class="col team-col-${esc(m.team)}" title="${esc(m.team)} ${m.homeAway === "Borte" ? "@" : "vs"} ${esc(m.opponent)}${m.venue ? " · " + esc(m.venue) : ""} · ${(m.squad || []).length} i troppen">
        ${m.date ? m.date.slice(8, 10) + "." + m.date.slice(5, 7) : "?"}<br><small>${esc(m.team[0])}</small>
        <span class="venue">${esc(m.venue || "–")}</span>
        <span class="cnt${(m.squad || []).length ? "" : " empty"}">${(m.squad || []).length}</span></th>`).join("")}</tr>` +
    players.map((p) => {
      const cells = cols.map((m) => (m.squad || []).includes(p.id));
      const n = cells.filter(Boolean).length;
      // Uten spillerfilter: skjul spillere uten kamper som ikke hører til noen av de valgte kampfargene
      if (!n && !state.playerTeams.size && state.matrixTeams.size && !state.matrixTeams.has(p.team)) return "";
      return `<tr class="${n ? "" : "zero"}"><th><div class="pcell"><span class="pn">${pdot(p)}${esc(p.name)}</span><span class="nbadge${n ? "" : " empty"}">${n}</span></div></th>${cells.map((on, i) =>
        `<td data-m="${cols[i].id}" data-p="${p.id}" class="${on ? "on team-col-" + esc(cols[i].team) : ""}${on && isSub(cols[i], p.id) ? " sub" : ""}">${on ? esc(cols[i].positions?.[p.id] || "●") : ""}</td>`).join("")}</tr>`;
    }).join("");
  $("#matrix").classList.toggle("editable", canSquad());
  if (canSquad()) $$("#matrix td[data-m]").forEach((td) => (td.onclick = () => toggleInSquad(td.dataset.m, td.dataset.p)));
}

// Evalueringsgruppen kan ta ut / fjerne spillere direkte i kampmatrisen
async function toggleInSquad(matchId, playerId) {
  const m = state.matches.find((x) => x.id === matchId);
  const p = playerById(playerId);
  if (!m || !p) return;
  const squad = m.squad || [];
  const inSquad = squad.includes(playerId);
  const data = { updatedAt: new Date().toISOString() };
  if (inSquad) {
    data.squad = squad.filter((id) => id !== playerId);
    data.lineup = (m.lineup || []).map((id) => (id === playerId ? "" : id));
    data.log = [...(m.log || []), logEntry(`Tropp: − ${p.name}`)];
  } else {
    data.squad = [...squad, playerId];
    const g = defaultMatchPos(p);
    if (g) data.positions = { ...(m.positions || {}), [playerId]: g };
    data.log = [...(m.log || []), logEntry(`Tropp: + ${p.name}`)];
  }
  await store.update("matches", matchId, data);
}

// ---------- Spillere ----------
$("#playerForm").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("#playerName").value.trim();
  if (!name) return;
  await store.add("players", { name, team: $("#playerTeam").value });
  $("#playerName").value = "";
};

function renderPlayers() {
  // Spillere uten gyldig farge får en egen gruppe, så de ikke forsvinner fra lista
  const groups = [...TEAMS, ""].map((t) => {
    const ps = state.players.filter((p) => (t ? p.team === t : !TEAMS.includes(p.team)))
      .sort((a, b) => a.name.localeCompare(b.name, "no"));
    if (!ps.length) return "";
    return `<div class="card"><h3>${t ? `<span class="pdot team-${esc(t)}"></span>${esc(t)}` : "Uten farge"} <span class="muted">(${ps.length})</span></h3>
      <ul class="players">${ps.map((p) => `<li>
        <span class="pname">${pdot(p)}${esc(p.name)}</span>
        <div class="seg colorpick" role="group" aria-label="Farge for ${esc(p.name)}">${TEAMS.map((x) =>
          `<button type="button" data-id="${p.id}" data-team="${x}" class="${x === p.team ? "active" : ""}"
            ${canSquad() ? "" : "disabled"} title="Flytt til ${x}" aria-pressed="${x === p.team}"><span class="pdot team-${x}"></span>${x}</button>`).join("")}</div>
        <button class="ghost del eval-only" data-id="${p.id}" title="Fjern">✕</button>
        <div class="ppos">${[0, 1, 2].map((i) => `<select data-id="${p.id}" data-i="${i}" ${canSquad() ? "" : "disabled"}
            aria-label="Posisjon ${i + 1}"><option value="">${i + 1}. posisjon</option>${POSITIONS.map((x) =>
            `<option value="${x.id}" ${p.positions?.[i] === x.id ? "selected" : ""}>${x.id} · ${x.label}</option>`).join("")}</select>`).join("")}
        </div></li>`).join("")}</ul></div>`;
  }).join("");
  $("#playerList").innerHTML = groups || `<p class="muted center">Ingen spillere ennå.</p>`;
  $$("#playerList .colorpick button").forEach((b) => (b.onclick = () => {
    const p = playerById(b.dataset.id);
    if (!p || p.team === b.dataset.team) return;
    store.update("players", p.id, { team: b.dataset.team });
  }));
  $$("#playerList .ppos select").forEach((s) => (s.onchange = () => {
    // Lagre de tre valgene samlet, uten tomme felt og uten dubletter
    const vals = $$(`#playerList .ppos select[data-id="${s.dataset.id}"]`).map((x) => x.value);
    store.update("players", s.dataset.id, { positions: [...new Set(vals.filter(Boolean))] });
  }));
  $$("#playerList .del").forEach((b) => (b.onclick = () => {
    if (confirm("Fjerne spilleren?")) store.remove("players", b.dataset.id);
  }));
}

// ---------- Innstillinger ----------
async function loadAccess() {
  if (state.role !== "owner") return;
  const doc = await store.get("config", "access").catch(() => null);
  $("#accessEval").value = (doc?.evaluators || []).join("\n");
  $("#accessRead").value = (doc?.readers || []).join("\n");
}

const parseEmails = (text) =>
  [...new Set(text.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.includes("@")))];

$("#saveAccess").onclick = async () => {
  const evaluators = parseEmails($("#accessEval").value);
  // Står noen i begge lister, gjelder evalueringsgruppen
  const readers = parseEmails($("#accessRead").value).filter((e) => !evaluators.includes(e));
  try {
    await store.add("config", { evaluators, readers }, "access");
    $("#accessEval").value = evaluators.join("\n");
    $("#accessRead").value = readers.join("\n");
    $("#accessMsg").textContent = `Lagret ✓ (${evaluators.length} i evalueringsgruppen, ${readers.length} øvrige)`;
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

// ---------- Eksport til Spond ----------
function spondMatches() {
  const team = $("#spondTeam").value;
  return state.matches
    .filter((m) => m.status !== "avlyst" && m.date && (!team || m.team === team))
    .filter((m) => $("#spondPast").checked || m.date >= today())
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}

function download(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

const spondName = (ext) => `spond-${$("#spondTeam").value || "alle"}-${today()}.${ext}`.toLowerCase().replace("ø", "o");

$("#exportSpondXlsx").onclick = async () => {
  const XLSX = await loadXlsx();
  const ws = XLSX.utils.aoa_to_sheet(spondRows(spondMatches()), { cellDates: true, dateNF: "dd\\.mm\\.yyyy" });
  ws["!cols"] = [12, 14, 10, 12, 14, 12, 24, 24, 30, 20].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Kamper");
  XLSX.writeFile(wb, spondName("xlsx"));
};

$("#exportSpondIcs").onclick = () =>
  download(new Blob([toIcs(spondMatches())], { type: "text/calendar" }), spondName("ics"));

$("#exportCsv").onclick = () => {
  const cols = ["team", "status", "date", "time", "meetTime", "type", "opponent", "homeAway", "venue", "contact", "notes"];
  const name = (id) => state.players.find((p) => p.id === id)?.name || id;
  const rows = [[...cols, "squad"], ...state.matches
    .slice().sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    .map((m) => [...cols.map((c) => c === "status" ? statusOf(m.status).label : m[c] ?? ""),
      (m.squad || []).map((id) => name(id) + (m.positions?.[id] ? ` (${m.positions[id]})` : "")).join(", ")])];
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
  a.download = `kamper-${today()}.csv`;
  a.click();
};

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// Start til slutt, så alle funksjoner og variabler over er klare
store.init(onUser).catch((e) => showLoginError(e));
