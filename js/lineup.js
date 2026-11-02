// Formasjoner, fordeling av posisjoner og automatisk oppstilling (ren logikk, ingen DOM).
import { POSITIONS, MATCH_POSITIONS, DEFAULT_FORMATION } from "./config.js";

const GROUPS = ["F", "M", "A"];
const posOf = (id) => POSITIONS.find((x) => x.id === id);
const groupLabel = (g) => (MATCH_POSITIONS.find((x) => x.id === g)?.label || g).toLowerCase();
const PLURAL = { K: "keepere", F: "forsvarere", M: "midtbanespillere", A: "angripere" };

// Hvilken detaljert posisjon hver plass i en linje tilsvarer (brukes til å matche spillernes ønsker)
const LINE_POS = {
  F: { 1: ["MS"], 2: ["MS", "MS"], 3: ["VB", "MS", "HB"], 4: ["VB", "MS", "MS", "HB"], 5: ["VB", "MS", "MS", "MS", "HB"] },
  M: { 1: ["OM"], 2: ["SM", "SM"], 3: ["SM", "DM", "SM"], 4: ["VK", "SM", "SM", "HK"], 5: ["VK", "SM", "DM", "SM", "HK"] },
  A: { 1: ["S"], 2: ["S", "S"], 3: ["VK", "S", "HK"], 4: ["VK", "S", "S", "HK"] }
};
const LINE_Y = { F: 72, M: 48, A: 22 };

export function parseFormation(f) {
  const n = String(f || DEFAULT_FORMATION).split("-").map(Number);
  return n.length === 3 && n.every((x) => x > 0) ? n : parseFormation(DEFAULT_FORMATION);
}

// Antall som trengs i startoppstillingen per gruppe
export function needs(f) {
  const [F, M, A] = parseFormation(f);
  return { K: 1, F, M, A };
}

// Plassene på banen: gruppe, detaljert posisjon og koordinater i prosent (eget mål nederst)
export function slots(f) {
  const out = [{ g: "K", pos: "K", x: 50, y: 91 }];
  parseFormation(f).forEach((n, li) => {
    const g = GROUPS[li];
    const pos = LINE_POS[g][n] || Array(n).fill(g === "F" ? "MS" : g === "M" ? "SM" : "S");
    for (let i = 0; i < n; i++) out.push({ g, pos: pos[i], x: Math.round(((i + 1) / (n + 1)) * 100), y: LINE_Y[g] });
  });
  return out;
}

// Anbefalt fordeling for en tropp på n spillere: én keeper, resten i forhold til formasjonen
export function targets(f, n) {
  const need = needs(f);
  const t = { K: n > 0 ? 1 : 0, F: 0, M: 0, A: 0 };
  const rest = Math.max(0, n - t.K);
  const outfield = need.F + need.M + need.A;
  const raw = GROUPS.map((g) => (rest * need[g]) / outfield);
  GROUPS.forEach((g, i) => (t[g] = Math.floor(raw[i])));
  let left = rest - GROUPS.reduce((s, g) => s + t[g], 0);
  GROUPS.map((g, i) => [g, raw[i] - Math.floor(raw[i])]).sort((a, b) => b[1] - a[1])
    .forEach(([g]) => { if (left > 0) { t[g]++; left--; } });
  return t;
}

export function countGroups(squad, positions = {}) {
  const c = { K: 0, F: 0, M: 0, A: 0, none: 0 };
  for (const id of squad) c[positions[id]] !== undefined && positions[id] ? c[positions[id]]++ : c.none++;
  return c;
}

// Advarsler om skjev fordeling i troppen. Tom liste = ok.
export function balanceIssues(f, squad, positions = {}) {
  const n = squad.length;
  if (!n) return [];
  const c = countGroups(squad, positions);
  const need = needs(f);
  const t = targets(f, n);
  const out = [];
  if (n < 9) out.push(`Bare ${n} spillere – 9 trengs på banen`);
  if (c.none) out.push(`${c.none} uten posisjon`);
  if (!c.K) out.push("Ingen keeper");
  else if (c.K > 2) out.push(`${c.K} keepere`);
  for (const g of GROUPS) {
    if (c[g] < need[g]) out.push(`For få ${PLURAL[g]} (${c[g]}, formasjonen trenger ${need[g]})`);
    else if (c[g] - t[g] >= 2) out.push(`Mange ${PLURAL[g]} (${c[g]}, anbefalt ca. ${t[g]})`);
  }
  return out;
}

// Gir hver spiller en kampposisjon slik at troppen blir jevnt fordelt, ut fra spillernes ønsker.
// «fixed» er posisjoner som skal beholdes (f.eks. de som allerede er satt).
export function autoAssign(players, f, fixed = {}) {
  const t = targets(f, players.length);
  const result = {};
  for (const p of players) if (fixed[p.id]) { result[p.id] = fixed[p.id]; t[fixed[p.id]]--; }
  let open = players.filter((p) => !result[p.id]);
  const prefGroups = (p) => (p.positions || []).map((id) => posOf(id)?.group).filter(Boolean);
  // Spillere med færrest ønsker velges først i hver runde, så de ikke blir presset ut
  open.sort((a, b) => prefGroups(a).length - prefGroups(b).length);
  for (let rank = 0; rank < 3; rank++) {
    for (const p of open) {
      const g = prefGroups(p)[rank];
      if (!result[p.id] && g && t[g] > 0) { result[p.id] = g; t[g]--; }
    }
  }
  // Resten fyller hullene, størst behov først (ingen keeper-ønsker → noen må stå i mål)
  for (const p of open.filter((p) => !result[p.id])) {
    const g = ["K", ...GROUPS].sort((a, b) => t[b] - t[a])[0];
    result[p.id] = t[g] > 0 ? g : (prefGroups(p)[0] || "M");
    t[result[p.id]]--;
  }
  return result;
}

// Fyller tomme plasser i oppstillingen. Spillere med riktig kampposisjon foretrekkes, deretter de som
// ønsker akkurat den plassen, og så de som har startet færrest kamper (rettferdig spilletid).
export function autoLineup(f, players, positions, lineup = [], starts = {}) {
  const sl = slots(f);
  const out = sl.map((_, i) => lineup[i] || "");
  const used = new Set(out.filter(Boolean));
  const score = (p, s) => {
    const prefs = p.positions || [];
    const exact = prefs.indexOf(s.pos);
    const inGroup = prefs.findIndex((id) => posOf(id)?.group === s.g);
    return (exact >= 0 ? exact : 3 + (inGroup >= 0 ? inGroup : 3)) * 100 + (starts[p.id] || 0);
  };
  for (const strict of [true, false]) {
    sl.forEach((s, i) => {
      if (out[i]) return;
      const cands = players.filter((p) => !used.has(p.id) && (!strict || positions[p.id] === s.g));
      if (!cands.length) return;
      const best = cands.sort((a, b) => score(a, s) - score(b, s))[0];
      out[i] = best.id;
      used.add(best.id);
    });
  }
  return out;
}

export { groupLabel };
