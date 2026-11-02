import * as store from "./store.js";
import { TEAMS, STATUSES, OWNER_EMAIL, POSITIONS, MATCH_POSITIONS } from "./config.js";
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

const state = { user: null, matches: [], players: [], team: "", status: "", showPast: false, matrixTeam: "", editing: null, role: null, access: null };
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
  return `<article class="match" data-id="${m.id}" style="--c:${s.color}">
    <div class="when">
      <b>${m.date ? dayLabel(m.date) : "Dato?"}</b>
      <span>${esc(m.time || "--:--")}</span>
    </div>
    <div class="what">
      <div class="title"><span class="team team-${esc(m.team)}">${esc(m.team)}</span>
        ${m.homeAway === "Borte" ? "@ " : "vs "}${esc(m.opponent || "?")}
        ${hasResult(m) ? `<span class="score score-${outcome(m)}">${esc(m.goalsFor)}–${esc(m.goalsAgainst)}</span>` : ""}</div>
      <div class="meta">${esc(m.venue || "Bane ikke satt")} · ${esc(m.type || "")} · Tropp: ${squad}</div>
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
  const count = () => {
    const pos = Object.values(selectedPositions());
    const per = MATCH_POSITIONS.map((x) => [x.id, pos.filter((v) => v === x.id).length]).filter(([, n]) => n);
    $("#squadCount").textContent = `(${selectedSquad().length} valgt${per.length ? ": " + per.map(([k, n]) => `${k} ${n}`).join(" · ") : ""})`;
  };
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
  const picker = canSquad() && $$("#squadPicker input").length;
  data.squad = picker ? selectedSquad() : (old?.squad || []);
  data.positions = picker ? selectedPositions() : (old?.positions || {});
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

// ---------- Statistikk ----------
$$("#matrixTeam button").forEach((b) => (b.onclick = () => {
  state.matrixTeam = b.dataset.team;
  $$("#matrixTeam button").forEach((x) => x.classList.toggle("active", x === b));
  renderStats();
}));

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
  const players = state.players.slice().sort(byTeamAndName);
  const count = (p, pred) => active.filter((m) => (m.squad || []).includes(p.id) && pred(m)).length;
  $("#playerStats").innerHTML = `<tr><th>Spiller</th><th>Nivå</th><th>Posisjoner</th>
      ${TEAMS.map((t) => `<th><span class="team team-${t}">${t}</span></th>`).join("")}
      <th>Totalt</th><th>Spilt</th></tr>` +
    players.map((p) => {
      const per = TEAMS.map((t) => count(p, (m) => m.team === t));
      const total = per.reduce((a, b) => a + b, 0);
      return `<tr class="${total ? "" : "zero"}"><th>${esc(p.name)}</th><td>${esc(p.team)}</td><td title="${esc(posLong(p))}">${esc(posShort(p))}</td>
        ${per.map((n) => `<td>${n || ""}</td>`).join("")}
        <td><b>${total}</b></td><td>${count(p, (m) => m.status === "spilt") || ""}</td></tr>`;
    }).join("");

  // Matrise: spillere × kamper
  const cols = active.filter((m) => !state.matrixTeam || m.team === state.matrixTeam);
  $("#matrix").innerHTML = `<tr><th>Spiller</th>${cols.map((m) =>
      `<th class="col team-col-${esc(m.team)}" title="${esc(m.team)} – ${esc(m.opponent)}">
        ${m.date ? m.date.slice(8, 10) + "." + m.date.slice(5, 7) : "?"}<br><small>${esc(m.team[0])}</small></th>`).join("")}
      <th>Σ</th></tr>` +
    players.map((p) => {
      const cells = cols.map((m) => (m.squad || []).includes(p.id));
      const n = cells.filter(Boolean).length;
      if (!n && state.matrixTeam && p.team !== state.matrixTeam) return "";
      return `<tr class="${n ? "" : "zero"}"><th>${esc(p.name)}</th>${cells.map((on, i) =>
        `<td class="${on ? "on team-col-" + esc(cols[i].team) : ""}">${on ? esc(cols[i].positions?.[p.id] || "●") : ""}</td>`).join("")}<td><b>${n}</b></td></tr>`;
    }).join("");
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
  const groups = TEAMS.map((t) => {
    const ps = state.players.filter((p) => p.team === t).sort((a, b) => a.name.localeCompare(b.name, "no"));
    if (!ps.length) return "";
    return `<div class="card"><h3>${esc(t)} <span class="muted">(${ps.length})</span></h3>
      <ul class="players">${ps.map((p) => `<li>
        <span class="pname">${esc(p.name)}</span>
        <select class="pteam" data-id="${p.id}" ${canSquad() ? "" : "disabled"}>${TEAMS.map((x) =>
          `<option ${x === p.team ? "selected" : ""}>${x}</option>`).join("")}</select>
        <button class="ghost del eval-only" data-id="${p.id}" title="Fjern">✕</button>
        <div class="ppos">${[0, 1, 2].map((i) => `<select data-id="${p.id}" data-i="${i}" ${canSquad() ? "" : "disabled"}
            aria-label="Posisjon ${i + 1}"><option value="">${i + 1}. posisjon</option>${POSITIONS.map((x) =>
            `<option value="${x.id}" ${p.positions?.[i] === x.id ? "selected" : ""}>${x.id} · ${x.label}</option>`).join("")}</select>`).join("")}
        </div></li>`).join("")}</ul></div>`;
  }).join("");
  $("#playerList").innerHTML = groups || `<p class="muted center">Ingen spillere ennå.</p>`;
  $$("#playerList select.pteam").forEach((s) => (s.onchange = () => store.update("players", s.dataset.id, { team: s.value })));
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
