// Leser vinterserie-arket (samme oppsett som «Vinterserie 2014 kullet …xlsx») direkte i nettleseren.
// Bruker arkene «FANA» (kampoppsett), «Laguttak» (spillere + tropper) og «Lag i serien» (kontaktpersoner).
// Ingenting lastes opp noe sted annet enn til appens egen database.

const XLSX_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";

// Nivå i arket → lag i appen
const LEVEL_TEAM = { 1: "Hvit", 2: "Rød" };
const CLUB = "Fana G2014";

export function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = XLSX_URL;
    s.onload = () => ok(window.XLSX);
    s.onerror = () => fail(new Error("Kunne ikke laste Excel-leser"));
    document.head.appendChild(s);
  });
}

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const slug = (s) => clean(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/ø/g, "o").replace(/æ/g, "ae").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const playerId = (name) => "p-" + slug(name);
export const matchId = (team, date) => `${slug(team)}-${date}`;

function teamOf(name) {
  const n = clean(name);
  if (!n.startsWith(CLUB)) return null;
  return n.slice(CLUB.length).trim(); // «Hvit» / «Rød»
}

// Kamper fra og med denne datoen er ikke avtalt ennå og importeres som «Ikke planlagt»
export const FIRST_UNPLANNED = "2027-01-01";

export async function parseWorkbook(buf) {
  const XLSX = await loadXlsx();
  const wb = XLSX.read(buf, { type: "array" });
  const rows = (name) => {
    const ws = wb.Sheets[name];
    if (!ws) throw new Error(`Fant ikke arket «${name}»`);
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  };
  const toDate = (v) => {
    if (typeof v !== "number") return null;
    const d = XLSX.SSF.parse_date_code(v);
    return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  };
  const toTime = (v) => {
    if (typeof v === "number") { // Excel-klokkeslett som brøkdel av døgn
      const min = Math.round(v * 24 * 60);
      return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
    }
    const m = clean(v).match(/(\d{1,2})[:.](\d{2})/);
    return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
  };

  // Kontaktpersoner
  const contacts = {};
  if (wb.Sheets["Lag i serien"]) {
    for (const r of rows("Lag i serien").slice(1)) {
      if (!r[0]) continue;
      contacts[clean(r[0]).toLowerCase()] = [r[4], r[6], r[5]].map(clean).filter(Boolean).join(", ");
    }
  }

  // Kamper fra «FANA»: tabellen som starter med «Startdato*»
  const fana = rows("FANA");
  const start = fana.findIndex((r) => clean(r[0]) === "Startdato*");
  if (start < 0) throw new Error("Fant ikke kamptabellen (Startdato*) i arket «FANA»");
  const matches = [];
  for (const r of fana.slice(start + 1)) {
    const date = toDate(r[0]);
    if (!date) break;
    const [home, away] = [clean(r[6]), clean(r[7])];
    const team = teamOf(home) || teamOf(away);
    if (!team) continue;
    const isHome = !!teamOf(home);
    const opponent = isHome ? away : home;
    matches.push({
      id: matchId(team, date),
      team, date,
      time: toTime(r[1]),
      meetTime: toTime(r[2]),
      endTime: toTime(r[4]),
      type: clean(r[5]) || "Seriekamp",
      opponent,
      homeAway: isHome ? "Hjemme" : "Borte",
      venue: clean(r[9]),
      contact: contacts[opponent.toLowerCase()] || "",
      notes: clean(r[8]),
      status: date >= FIRST_UNPLANNED ? "ikkeplanlagt" : "avtalt",
      squad: []
    });
  }

  // Spillere og tropper fra «Laguttak»
  const players = new Map();
  if (wb.Sheets["Laguttak"]) {
    const lt = rows("Laguttak");
    const row = (label) => lt.find((r) => clean(r[0]) === label) || [];
    const dates = row("Dato").slice(1).map(toDate);
    const levels = row("Nivå").slice(1).map((v) => LEVEL_TEAM[parseInt(String(v).replace(/\D/g, ""))]);
    const byId = new Map(matches.map((m) => [m.id, m]));

    const listStart = lt.findIndex((r) => clean(r[0]) === "Spiller" && clean(r[1]) === "Nivå");
    if (listStart >= 0) {
      for (const r of lt.slice(listStart + 1)) {
        const name = clean(r[0]);
        if (!name) continue;
        players.set(playerId(name), { id: playerId(name), name, team: LEVEL_TEAM[r[1]] || "Begge" });
      }
    }
    for (const r of lt) {
      if (!/^Spiller \d+$/.test(clean(r[0]))) continue;
      r.slice(1).forEach((v, i) => {
        const name = clean(v);
        if (!name || !dates[i] || !levels[i]) return;
        const id = playerId(name);
        if (!players.has(id)) players.set(id, { id, name, team: levels[i] });
        byId.get(matchId(levels[i], dates[i]))?.squad.push(id);
      });
    }
  }

  return { matches, players: [...players.values()] };
}
