/* Client-side season simulator — a faithful JS port of nhl_standings_projection.py so a
   HYPOTHETICAL TRADE re-rates both teams and re-runs the Monte-Carlo instantly in the browser
   (no server round-trip). Same team-rating formula, win model, season-variance inflation, playoff
   format (top-3 per division + 2 wildcards) and Cup bracket, so live numbers match the baked ones. */
"use strict";
const SIM = (() => {
  const DIV = {
    BOS:["E","Atlantic"],BUF:["E","Atlantic"],DET:["E","Atlantic"],FLA:["E","Atlantic"],
    MTL:["E","Atlantic"],OTT:["E","Atlantic"],TBL:["E","Atlantic"],TOR:["E","Atlantic"],
    CAR:["E","Metropolitan"],CBJ:["E","Metropolitan"],NJD:["E","Metropolitan"],NYI:["E","Metropolitan"],
    NYR:["E","Metropolitan"],PHI:["E","Metropolitan"],PIT:["E","Metropolitan"],WSH:["E","Metropolitan"],
    CHI:["W","Central"],COL:["W","Central"],DAL:["W","Central"],MIN:["W","Central"],
    NSH:["W","Central"],STL:["W","Central"],UTA:["W","Central"],WPG:["W","Central"],
    ANA:["W","Pacific"],CGY:["W","Pacific"],EDM:["W","Pacific"],LAK:["W","Pacific"],
    SEA:["W","Pacific"],SJS:["W","Pacific"],VAN:["W","Pacific"],VGK:["W","Pacific"],
  };
  // dress = the lineup cut (top-N per group); rides the payload like sigma/pOt. The
  // sum-everything fallback keeps client math faithful to payloads baked BEFORE the
  // contract-reality universe shipped org depth below the cut.
  let CFG = { homeIce: 0.164, beta: 0.0855, goalieW: [1.0, 0.35], sigma: 4.0, games: 82, pOt: 0.222,
              dress: { F: Infinity, D: Infinity } };
  function setModel(m) {
    if (!m) return;
    CFG.homeIce = m.homeIce; CFG.beta = m.beta;
    CFG.goalieW = m.goalieWeights || CFG.goalieW; CFG.games = m.games || 82;
    // season-variance sigma + the OT-loser-point rate ride the payload so a Python-side
    // retune propagates (fallbacks for payloads baked before the model shipped them)
    CFG.sigma = (m.sigma != null) ? m.sigma : 4.0;
    CFG.pOt = (m.pOt != null) ? m.pOt : 0.222;
    CFG.dress = m.dress || { F: Infinity, D: Infinity };
  }

  function dressed(roster) {
    // best dressable lineup per group. Contract structure adjusts SELECTION
    // (mirrors Python _dressed exactly): a fresh multi-year commitment
    // (p.committed) holds a skater seat first; two-way deals (p.twoWay, the
    // club's own AHL-shuttle designation) fill in last; wars desc otherwise.
    // Goalie corps weighting follows quality only (never signing date).
    const f = [], d = [], g = [];
    for (const p of roster) {
      const e = [p.war || 0, p.twoWay ? 1 : 0, p.committed ? 0 : 1];
      if (p.group === "G") g.push(e);
      else if (p.group === "D") d.push(e);
      else f.push(e);
    }
    const cmp = (a, b) => (a[2] - b[2]) || (a[1] - b[1]) || (b[0] - a[0]);
    f.sort(cmp); d.sort(cmp);
    g.sort((a, b) => (a[1] - b[1]) || (b[0] - a[0]));
    const wars = arr => arr.map(e => e[0]);
    return { f: wars(f.slice(0, CFG.dress.F || Infinity)),
             d: wars(d.slice(0, CFG.dress.D || Infinity)), g: wars(g) };
  }
  function rating(roster) {
    const { f, d, g } = dressed(roster);
    let sk = 0;
    for (const w of f) sk += w;
    for (const w of d) sk += w;
    let gg = 0;
    for (let i = 0; i < CFG.goalieW.length; i++) gg += (g[i] || 0) * CFG.goalieW[i];
    return sk + gg;
  }
  function splits(roster) {
    const { f, d, g } = dressed(roster);
    let off = 0, def = 0;
    for (const w of f) off += w;
    for (const w of d) def += w;
    let gg = 0; for (let i = 0; i < CFG.goalieW.length; i++) gg += (g[i] || 0) * CFG.goalieW[i];
    return { offense: +off.toFixed(2), defense: +def.toFixed(2), goaltending: +gg.toFixed(2) };
  }
  function pHome(rh, ra) {
    const z = CFG.homeIce + CFG.beta * (rh - ra);
    return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
  }
  /* Seeded PRNG (mulberry32, 32-bit): the what-if DELTA must carry no sampling
     noise, so a baseline and a scenario replay the SAME random seasons (common
     random numbers). The browser's unseeded RNG gave two 2k-trial runs of identical
     ratings phantom swings up to ~4pp playoff odds on a 0.05pp display threshold. */
  function mulberry32(a) {
    a >>>= 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rand) {  // Box-Muller over the injected seeded stream
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function playoffTeams(pts) {
    const made = new Set(), byDiv = {};
    for (const t in pts) { const d = DIV[t][1]; (byDiv[d] = byDiv[d] || []).push([pts[t], t]); }
    for (const d in byDiv) { byDiv[d].sort((a, b) => b[0] - a[0]); for (const x of byDiv[d].slice(0, 3)) made.add(x[1]); }
    for (const conf of ["E", "W"]) {
      const rem = Object.keys(pts).filter(t => DIV[t][0] === conf && !made.has(t))
        .map(t => [pts[t], t]).sort((a, b) => b[0] - a[0]);
      for (const x of rem.slice(0, 2)) made.add(x[1]);
    }
    return made;
  }
  function seriesWinner(hi, lo, r, rand) {
    const home = [hi, hi, lo, lo, hi, lo, hi];
    let whi = 0, wlo = 0;
    for (const h of home) {
      const pHi = h === hi ? pHome(r[hi], r[lo]) : 1 - pHome(r[lo], r[hi]);
      if (rand() < pHi) whi++; else wlo++;
      if (whi === 4) return hi; if (wlo === 4) return lo;
    }
    return whi > wlo ? hi : lo;
  }
  function cupChamp(pts, r, rand) {
    const made = playoffTeams(pts), champ = {};
    for (const conf of ["E", "W"]) {
      let seeds = [...made].filter(t => DIV[t][0] === conf).sort((a, b) => pts[b] - pts[a]);
      const rank = {}; seeds.forEach((t, i) => rank[t] = i);
      let bracket = [seeds[0], seeds[7], seeds[3], seeds[4], seeds[1], seeds[6], seeds[2], seeds[5]];
      while (bracket.length > 1) {
        const nxt = [];
        for (let i = 0; i < bracket.length; i += 2) {
          const a = bracket[i], b = bracket[i + 1];
          const hi = rank[a] < rank[b] ? a : b, lo = rank[a] < rank[b] ? b : a;
          nxt.push(seriesWinner(hi, lo, r, rand));
        }
        bracket = nxt;
      }
      champ[conf] = bracket[0];
    }
    const e = champ.E, w = champ.W;
    const hi = pts[e] >= pts[w] ? e : w, lo = pts[e] >= pts[w] ? w : e;
    return seriesWinner(hi, lo, r, rand);
  }

  /* Deterministic expected points over a true 82-game balanced schedule (matches the Python
     expected_points bake): 2 per win PLUS the expected overtime-loser point (each loss carries
     a pOt loser point), so totals sit on the REAL standings scale (league mean ~91, not 82).
     Used for the projected-points NUMBER; the MC (which rounds games per pair and so runs a
     longer season) is used only for the rank-based ODDS. */
  function expectedPoints(ratings) {
    const teams = Object.keys(ratings), perOpp = CFG.games / (teams.length - 1), out = {};
    for (const t of teams) {
      let ew = 0;
      for (const o of teams) {
        if (o === t) continue;
        ew += perOpp * (pHome(ratings[t], ratings[o]) + (1 - pHome(ratings[o], ratings[t]))) / 2;
      }
      out[t] = +(2 * ew + CFG.pOt * (CFG.games - ew)).toFixed(1);
    }
    return out;
  }

  /* ratings: {team: number}. Returns {team: {expPoints, playoff, presidents, cup, first}}.
     seed (default 7, matching the Python bake) makes a run fully deterministic, and every
     trial derives its own sub-stream from (seed, trial) so paired baseline/scenario runs
     stay in lockstep: teams iterate in SORTED order (insertion order must never steer
     season-noise pairing or home-game assignment), the same team draws the same season
     noise and game coin-flips in both worlds, and a playoff bracket that runs longer in
     one world cannot desync the next trial. Two runs on identical ratings are therefore
     IDENTICAL -- every unchanged delta reads exactly 0. */
  function simulate(ratings, trials, seed) {
    trials = trials || 2000;
    if (seed == null) seed = 7;
    const teams = Object.keys(ratings).sort();
    const perOpp = Math.max(1, Math.round(CFG.games / (teams.length - 1)));
    const playoff = {}, pres = {}, cup = {}, first = {}, ptsSum = {};
    teams.forEach(t => { playoff[t] = pres[t] = cup[t] = first[t] = ptsSum[t] = 0; });
    for (let n = 0; n < trials; n++) {
      const rand = mulberry32(seed + 0x9E3779B9 * (n + 1));   // per-trial sub-stream
      const r = {}, pts = {};
      teams.forEach(t => { r[t] = ratings[t] + gauss(rand) * CFG.sigma; pts[t] = 0; });
      for (let i = 0; i < teams.length; i++)
        for (let j = i + 1; j < teams.length; j++) {
          const A = teams[i], B = teams[j];
          for (let g = 0; g < perOpp; g++) {
            const home = g % 2 === 0 ? A : B, away = g % 2 === 0 ? B : A;
            const homeWon = rand() < pHome(r[home], r[away]);
            pts[homeWon ? home : away] += 2;
            if (rand() < CFG.pOt) pts[homeWon ? away : home] += 1;  // OT/SO loser point
          }
        }
      let best = teams[0], worst = teams[0];
      teams.forEach(t => { ptsSum[t] += pts[t]; if (pts[t] > pts[best]) best = t; if (pts[t] < pts[worst]) worst = t; });
      playoffTeams(pts).forEach(t => playoff[t]++);
      pres[best]++; first[worst]++; cup[cupChamp(pts, r, rand)]++;
    }
    const out = {};
    teams.forEach(t => out[t] = {
      expPoints: +(ptsSum[t] / trials).toFixed(1),
      playoff: +(100 * playoff[t] / trials).toFixed(1),
      presidents: +(100 * pres[t] / trials).toFixed(1),
      cup: +(100 * cup[t] / trials).toFixed(1),
      first: +(100 * first[t] / trials).toFixed(1),
    });
    return out;
  }

  return { DIV, setModel, rating, splits, simulate, expectedPoints };
})();
