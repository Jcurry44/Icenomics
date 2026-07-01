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
  let CFG = { homeIce: 0.164, beta: 0.0855, goalieW: [1.0, 0.35], sigma: 4.0, games: 82 };
  function setModel(m) {
    if (!m) return;
    CFG.homeIce = m.homeIce; CFG.beta = m.beta;
    CFG.goalieW = m.goalieWeights || CFG.goalieW; CFG.games = m.games || 82;
  }

  function rating(roster) {
    let sk = 0; const g = [];
    for (const p of roster) { if (p.group === "G") g.push(p.war || 0); else sk += (p.war || 0); }
    g.sort((a, b) => b - a);
    let gg = 0;
    for (let i = 0; i < CFG.goalieW.length; i++) gg += (g[i] || 0) * CFG.goalieW[i];
    return sk + gg;
  }
  function splits(roster) {
    let off = 0, def = 0; const g = [];
    for (const p of roster) {
      if (p.group === "G") g.push(p.war || 0);
      else if (p.group === "D") def += (p.war || 0);
      else off += (p.war || 0);
    }
    g.sort((a, b) => b - a);
    let gg = 0; for (let i = 0; i < CFG.goalieW.length; i++) gg += (g[i] || 0) * CFG.goalieW[i];
    return { offense: +off.toFixed(2), defense: +def.toFixed(2), goaltending: +gg.toFixed(2) };
  }
  function pHome(rh, ra) {
    const z = CFG.homeIce + CFG.beta * (rh - ra);
    return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
  }
  function gauss() {  // Box-Muller
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
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
  function seriesWinner(hi, lo, r) {
    const home = [hi, hi, lo, lo, hi, lo, hi];
    let whi = 0, wlo = 0;
    for (const h of home) {
      const pHi = h === hi ? pHome(r[hi], r[lo]) : 1 - pHome(r[lo], r[hi]);
      if (Math.random() < pHi) whi++; else wlo++;
      if (whi === 4) return hi; if (wlo === 4) return lo;
    }
    return whi > wlo ? hi : lo;
  }
  function cupChamp(pts, r) {
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
          nxt.push(seriesWinner(hi, lo, r));
        }
        bracket = nxt;
      }
      champ[conf] = bracket[0];
    }
    const e = champ.E, w = champ.W;
    const hi = pts[e] >= pts[w] ? e : w, lo = pts[e] >= pts[w] ? w : e;
    return seriesWinner(hi, lo, r);
  }

  /* Deterministic expected points over a true 82-game balanced schedule (matches the Python
     expected_points bake). Used for the projected-points NUMBER; the MC (which rounds games per
     pair and so runs a longer season) is used only for the rank-based ODDS. */
  function expectedPoints(ratings) {
    const teams = Object.keys(ratings), perOpp = CFG.games / (teams.length - 1), out = {};
    for (const t of teams) {
      let ep = 0;
      for (const o of teams) {
        if (o === t) continue;
        ep += perOpp * (pHome(ratings[t], ratings[o]) + (1 - pHome(ratings[o], ratings[t]))) / 2 * 2;
      }
      out[t] = +ep.toFixed(1);
    }
    return out;
  }

  /* ratings: {team: number}. Returns {team: {expPoints, playoff, presidents, cup, first}} */
  function simulate(ratings, trials) {
    trials = trials || 2000;
    const teams = Object.keys(ratings);
    const perOpp = Math.max(1, Math.round(CFG.games / (teams.length - 1)));
    const playoff = {}, pres = {}, cup = {}, first = {}, ptsSum = {};
    teams.forEach(t => { playoff[t] = pres[t] = cup[t] = first[t] = ptsSum[t] = 0; });
    for (let n = 0; n < trials; n++) {
      const r = {}, pts = {};
      teams.forEach(t => { r[t] = ratings[t] + gauss() * CFG.sigma; pts[t] = 0; });
      for (let i = 0; i < teams.length; i++)
        for (let j = i + 1; j < teams.length; j++) {
          const A = teams[i], B = teams[j];
          for (let g = 0; g < perOpp; g++) {
            const home = g % 2 === 0 ? A : B, away = g % 2 === 0 ? B : A;
            if (Math.random() < pHome(r[home], r[away])) pts[home] += 2; else pts[away] += 2;
          }
        }
      let best = teams[0], worst = teams[0];
      teams.forEach(t => { ptsSum[t] += pts[t]; if (pts[t] > pts[best]) best = t; if (pts[t] < pts[worst]) worst = t; });
      playoffTeams(pts).forEach(t => playoff[t]++);
      pres[best]++; first[worst]++; cup[cupChamp(pts, r)]++;
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
