// Automatisk laguttak: foreslår tropper for flere kamper ut fra parametre (ren logikk, ingen DOM).
import { TEAMS, POSITIONS, MATCH_POSITIONS, DEFAULT_FORMATION } from "./config.js";
import { autoAssign, autoLineup } from "./lineup.js";

const posOf = (id) => POSITIONS.find((x) => x.id === id);
// Nivå: Hvit = 1, Rød = 2, Blå = 3 (rekkefølgen i TEAMS)
export const levelOf = (team) => (TEAMS.includes(team) ? TEAMS.indexOf(team) + 1 : TEAMS.length);
const GROUPS = MATCH_POSITIONS.map((x) => x.id); // K, F, M, A

export function defaultParams(today) {
  const to = new Date(today + "T12:00");
  to.setDate(to.getDate() + 42);
  return {
    from: today,
    to: to.toISOString().slice(0, 10),
    size: 12,
    mode: "fill",            // "fill" = behold eksisterende tropper og fyll opp, "replace" = lag nye
    mixMode: "count",        // "count" = antall, "pct" = prosent av troppen
    mix: {                   // kampens lag → antall/prosent spillere per spillerfarge
      Hvit: { Hvit: 9, "Rød": 3, "Blå": 0 },
      "Rød": { Hvit: 0, "Rød": 9, "Blå": 3 },
      "Blå": { Hvit: 0, "Rød": 3, "Blå": 9 }
    },
    groupMin: { K: 1, F: 4, M: 4, A: 3 },
    posMin: { MS: 2 },       // detaljerte posisjoner, f.eks. minst 2 midtstoppere
    minGames: 0,
    maxGames: 0,             // 0 = ingen grense
    nff: true,
    lineup: false
  };
}

// Antall per spillerfarge for en tropp på n spillere (prosent fordeles med største rest)
export function quotaFor(params, matchTeam, n) {
  const row = params.mix?.[matchTeam] || {};
  const q = {};
  if (params.mixMode === "pct") {
    const raw = TEAMS.map((t) => (n * (Number(row[t]) || 0)) / 100);
    TEAMS.forEach((t, i) => (q[t] = Math.floor(raw[i])));
    const total = TEAMS.reduce((s, t) => s + (Number(row[t]) || 0), 0);
    let left = Math.round((n * Math.min(total, 100)) / 100) - TEAMS.reduce((s, t) => s + q[t], 0);
    TEAMS.map((t, i) => [t, raw[i] - Math.floor(raw[i])]).sort((a, b) => b[1] - a[1])
      .forEach(([t]) => { if (left > 0 && raw[TEAMS.indexOf(t)] > 0) { q[t]++; left--; } });
  } else {
    TEAMS.forEach((t) => (q[t] = Math.max(0, Math.round(Number(row[t]) || 0))));
  }
  return q;
}

const prefRank = (p, test) => {
  const i = (p.positions || []).findIndex(test);
  return i < 0 ? null : i;
};
const canPlayPos = (p, pos) => prefRank(p, (id) => id === pos);
const canPlayGroup = (p, g) => prefRank(p, (id) => posOf(id)?.group === g);

/**
 * matches: kampene som skal få tropp (sortert eller ikke)
 * allMatches: alle kamper (for å telle kamper i perioden og sjekke samme dag / NFF-regelen)
 * players: spillerne som kan tas ut (allerede filtrert på farge)
 */
export function planSquads({ matches, allMatches, players, params }) {
  const P = { ...params };
  const size = Math.max(1, Number(P.size) || 12);
  const minG = Math.max(0, Number(P.minGames) || 0);
  const maxG = Math.max(0, Number(P.maxGames) || 0);
  const pool = new Map(players.map((p) => [p.id, p]));
  const targets = [...matches].sort((a, b) => ((a.date || "") + (a.time || "")).localeCompare((b.date || "") + (b.time || "")));
  const targetIds = new Set(targets.map((m) => m.id));

  // Tropper slik de blir underveis (forslag for målkampene, uendret for resten)
  const squads = new Map(allMatches.map((m) => [m.id, [...(m.squad || [])]]));
  if (P.mode === "replace") for (const m of targets) squads.set(m.id, []);
  const inWindow = (m) => m.status !== "avlyst" && m.date && m.date >= P.from && m.date <= P.to;
  const count = {};
  const recount = () => {
    for (const id of pool.keys()) count[id] = 0;
    for (const m of allMatches) if (inWindow(m) || targetIds.has(m.id))
      for (const id of squads.get(m.id) || []) if (id in count && !m.absent?.[id]) count[id]++;
  };
  recount();

  // NFF: etter en seriekamp på nivå j kan spilleren ikke spille seriekamp på nivå j+2 eller lavere i neste kamp
  const lastSeriesLevel = (pid, before) => {
    let best = null;
    for (const m of allMatches) {
      if (m.status === "avlyst" || m.type !== "Seriekamp" || !m.date || m.date >= before.date) continue;
      if (!(squads.get(m.id) || []).includes(pid)) continue;
      if (!best || m.date > best.date) best = m;
    }
    return best ? levelOf(best.team) : null;
  };
  const sameDay = (pid, match) => allMatches.some((m) => m.id !== match.id && m.date && m.date === match.date &&
    m.status !== "avlyst" && (squads.get(m.id) || []).includes(pid));

  const result = {};
  for (const m of targets) {
    const warnings = [];
    const squad = (squads.get(m.id) || []).filter((id) => pool.has(id) || P.mode === "fill");
    const before = new Set(m.squad || []);
    const fixedPos = {};
    if (P.mode === "fill") for (const id of squad) if (m.positions?.[id]) fixedPos[id] = m.positions[id];
    const level = levelOf(m.team);
    const quota = quotaFor(P, m.team, size);
    for (const id of squad) { const t = pool.get(id)?.team; if (t in quota) quota[t]--; }

    const eligible = (p) => !squad.includes(p.id) && !sameDay(p.id, m) && (!maxG || count[p.id] < maxG) &&
      (!P.nff || m.type !== "Seriekamp" || (() => { const j = lastSeriesLevel(p.id, m); return j == null || level <= j + 1; })());
    // Lavest først: spillere under minimum, så færrest kamper, så spillere fra kampens egen farge
    const prio = (p) => (count[p.id] < minG ? 0 : 1000) + count[p.id] * 10 +
      Math.abs(levelOf(p.team) - level) * 2;
    const take = (p, group) => {
      squad.push(p.id);
      if (p.team in quota) quota[p.team]--;
      if (group) fixedPos[p.id] = group;
      count[p.id]++;
    };
    const pick = (test, group, label) => {
      const cands = [...pool.values()].filter((p) => eligible(p) && (quota[p.team] ?? 0) > 0)
        .map((p) => [p, test(p)]).filter(([, r]) => r != null)
        .sort((a, b) => prio(a[0]) + a[1] * 4 - (prio(b[0]) + b[1] * 4) || a[0].name.localeCompare(b[0].name, "no"));
      if (!cands.length) return false;
      take(cands[0][0], group);
      return true;
    };
    const have = (test) => squad.filter((id) => { const p = pool.get(id); return p && test(p); }).length;

    // 1) Detaljerte posisjonskrav (f.eks. midtstoppere), 2) krav per gruppe (keeper, forsvar …)
    for (const [pos, n] of Object.entries(P.posMin || {})) {
      const label = (posOf(pos)?.label || pos).toLowerCase();
      for (let i = have((p) => fixedPos[p.id] === posOf(pos)?.group && canPlayPos(p, pos) != null); i < n && squad.length < size; i++)
        if (!pick((p) => canPlayPos(p, pos), posOf(pos)?.group, label)) break;
    }
    for (const g of GROUPS) {
      const n = Number(P.groupMin?.[g]) || 0;
      const label = (MATCH_POSITIONS.find((x) => x.id === g)?.label || g).toLowerCase();
      for (let i = have((p) => (fixedPos[p.id] || "") === g || (!fixedPos[p.id] && canPlayGroup(p, g) === 0)); i < n && squad.length < size; i++)
        if (!pick((p) => canPlayGroup(p, g), g, label)) break;
    }
    // 3) Resten etter fargefordelingen
    for (const t of TEAMS) {
      while ((quota[t] ?? 0) > 0 && squad.length < size) {
        if (!pick((p) => (p.team === t ? 0 : null), null, `spiller fra ${t}`)) { warnings.push(`Mangler ${quota[t]} fra ${t}`); break; }
      }
    }
    // 4) Er fargefordelingen mindre enn troppen, fylles det opp med nærmeste nivå
    while (squad.length < size) {
      const cands = [...pool.values()].filter(eligible).sort((a, b) => prio(a) - prio(b) || a.name.localeCompare(b.name, "no"));
      if (!cands.length) { warnings.push(`Troppen har bare ${squad.length} av ${size}`); break; }
      take(cands[0], null);
    }

    const sp = squad.map((id) => pool.get(id)).filter(Boolean);
    const formation = m.formation || DEFAULT_FORMATION;
    const positions = autoAssign(sp, formation, fixedPos);
    // Sjekk kravene mot troppen slik den ble
    for (const g of GROUPS) {
      const need = Number(P.groupMin?.[g]) || 0;
      const have = squad.filter((id) => positions[id] === g).length;
      if (have < need) warnings.push(`For få ${(MATCH_POSITIONS.find((x) => x.id === g)?.label || g).toLowerCase()} (${have} av ${need})`);
    }
    for (const [pos, need] of Object.entries(P.posMin || {})) {
      const have = squad.filter((id) => positions[id] === posOf(pos)?.group && canPlayPos(pool.get(id) || {}, pos) != null).length;
      if (have < need) warnings.push(`For få ${(posOf(pos)?.label || pos).toLowerCase()} (${have} av ${need})`);
    }
    const entry = { squad: [...squad], positions, warnings };
    if (P.lineup) {
      const starts = {};
      for (const x of allMatches) if (x.id !== m.id) for (const id of x.lineup || []) if (id) starts[id] = (starts[id] || 0) + 1;
      entry.lineup = autoLineup(formation, sp, positions, P.mode === "fill" ? m.lineup || [] : [], starts);
      entry.formation = formation;
    }
    entry.added = squad.filter((id) => !before.has(id));
    entry.removed = [...before].filter((id) => !squad.includes(id));
    squads.set(m.id, squad);
    result[m.id] = entry;
  }

  recount();
  const under = minG ? [...pool.values()].filter((p) => count[p.id] < minG) : [];
  return { result, count, under };
}
