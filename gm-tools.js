/* Icenomics GM tools — client-side ports of the three Python engines so the
   Trade Evaluator, realistic-target finder, and lineup-impact preview run in the
   browser off the baked gm-bundle.json (no server; works on the static mobile
   site). The heavy precompute is baked (nhl_gm_bundle.py); this only does the
   light per-request math, ported FAITHFULLY from nhl_trade_eval.py /
   nhl_trade_targets.py / nhl_lineup_impact.py. A node parity test asserts the
   outputs match the Python engines exactly. */
(function (global) {
  "use strict";

  // Python's round(): round-half-to-EVEN (banker's), so dollar/score values
  // match the server bit-for-bit. (Math.round rounds half up — would diverge.)
  function pyround(x, nd) {
    nd = nd || 0;
    if (typeof x !== "number" || !isFinite(x)) return x;
    if (x === 0) return 0;
    // Round the DECIMAL expansion of the actual double (half-to-even), matching
    // CPython's round(x, n). Multiply-then-round can't: x*10^n loses the sub-ulp
    // that tells 1.6665's double (1.66650000…09) it's just ABOVE the midpoint.
    var neg = x < 0, s = Math.abs(x).toFixed(Math.min(100, nd + 18));
    var dot = s.indexOf("."), intPart = s.slice(0, dot), frac = s.slice(dot + 1);
    if (frac.length <= nd) return x;
    var keep = frac.slice(0, nd), drop = frac.slice(nd);
    var first = drop.charCodeAt(0) - 48, up;
    if (first < 5) up = false;
    else if (first > 5) up = true;
    else if (/[1-9]/.test(drop.slice(1))) up = true;             // > half
    else {                                                       // exact tie -> to even
      var last = nd > 0 ? (keep.charCodeAt(nd - 1) - 48) : (intPart.charCodeAt(intPart.length - 1) - 48);
      up = (last % 2 === 1);
    }
    var num = parseInt(intPart + keep || "0", 10);
    if (up) num += 1;
    var val = num / Math.pow(10, nd);
    return neg ? -val : val;
  }
  function groupOf(pos) {
    var p = (pos || "").toUpperCase();
    if (p.charAt(0) === "G") return "G";
    if (p.charAt(0) === "D" || p === "LD" || p === "RD") return "D";
    return "F";
  }
  function ordinal(rd) { return ({1: "1st", 2: "2nd", 3: "3rd"})[rd] || (rd + "th"); }
  function andJoin(a) {
    if (a.length === 1) return a[0];
    if (a.length === 2) return a[0] + " and " + a[1];
    return a.slice(0, -1).join(", ") + ", and " + a[a.length - 1];
  }

  function closestPick(curve, dollars) {
    var rounds = Object.keys(curve).map(Number);
    if (!rounds.length || dollars <= 0) return null;
    var vals = rounds.map(function (r) { return curve[r]; });
    if (dollars < Math.min.apply(null, vals) * 0.5) return null;
    var best = rounds[0];
    rounds.forEach(function (r) {
      if (Math.abs(curve[r] - dollars) < Math.abs(curve[best] - dollars)) best = r;
    });
    return ordinal(best);
  }

  // movability: 1.0 up to the common-trade WAR3, ramping to ~0.05 above the
  // empirical ceiling; expiring/RFA/negative get a +0.15 shop boost. (== Python)
  function movability(war3, cls, negative, anchors) {
    var common = anchors[0], rare = anchors[1];
    var w = Math.max(war3 || 0, 0), m;
    if (w <= common) m = 1.0;
    else if (w >= rare) m = 0.05;
    else m = 1.0 - 0.95 * (w - common) / (rare - common);
    // a pending UFA is the most available at ANY caliber (rental / signable); RFA or
    // overpaid only boosts BELOW the rare ceiling -- a cornerstone isn't shopped (== Python)
    if (cls === "expiring") m = Math.min(1.0, m + 0.15);
    else if ((cls === "rfa" || negative) && w < rare) m = Math.min(1.0, m + 0.15);
    return pyround(m, 3);
  }

  // one (team, player) fit: player strengths × team needs, the inner trade_fit score
  function fitScore(prof, pf, group, fitMap, wantWhy, dimLabel) {
    if (!prof || !pf) return wantWhy ? { fit: 0, why: [] } : 0;
    var sizeDim = group === "D" ? "defSize" : "fwdSize";
    var dims = (prof && prof.dims) || {}, fit = 0, why = [];
    Object.keys(pf).forEach(function (pdim) {
      var strength = pf[pdim];
      var targets = pdim === "size" ? [sizeDim] : (fitMap[pdim] || []);
      targets.forEach(function (td) {
        if (td in dims) {
          var need = 1 - dims[td].pct;
          fit += strength * need;
          if (wantWhy && strength >= 0.6 && need >= 0.6) why.push(td);
        }
      });
    });
    fit = pyround(fit, 3);
    if (!wantWhy) return fit;
    var uniq = why.filter(function (d, i) { return why.indexOf(d) === i; });
    // need descending, then dim-name ascending (deterministic tiebreak == Python)
    uniq.sort(function (a, b) {
      var na = 1 - dims[a].pct, nb = 1 - dims[b].pct;
      return nb !== na ? nb - na : (a < b ? -1 : a > b ? 1 : 0);
    });
    return { fit: fit, why: uniq.map(function (d) { return (dimLabel && dimLabel[d]) || d; }) };
  }

  // ---- composition (lineup-impact) helpers ----
  function dimNumden(ids, players, dims) {
    var nd = {}; dims.forEach(function (d) { nd[d] = [0, 0]; });
    ids.forEach(function (pid) {
      var p = players[pid]; if (!p) return;
      var f = p.feats; if (!f) return;
      var w = p.toi || 0; if (w <= 0) return;
      dims.forEach(function (d) { if (d in f) { nd[d][0] += f[d] * w; nd[d][1] += w; } });
    });
    return nd;
  }
  function teamDimension(ids, players, dims) {
    var nd = dimNumden(ids, players, dims), out = {};
    dims.forEach(function (d) { if (nd[d][1] > 0) out[d] = pyround(nd[d][0] / nd[d][1], 4); });
    return out;
  }
  function pctRank(value, all) {
    var vals = all.filter(function (v) { return v !== null && v !== undefined; });
    var n = vals.length;
    if (value === null || value === undefined || n <= 1) return [null, null];
    var below = vals.filter(function (v) { return v < value; }).length;
    var equal = vals.filter(function (v) { return v === value; }).length;
    var pct = (below + (equal - 1) / 2) / (n - 1);
    var rank = 1 + pyround((1 - pct) * (n - 1));
    return [pyround(pct, 3), rank];
  }

  // ===================== ENGINE 1: evaluate a trade =====================
  function evaluateTrade(B, trade) {
    var teams = (trade.teams || []).slice(), assets = trade.assets || [];
    if (teams.length < 2) return { ok: false, note: "A trade needs at least two teams." };
    var C = B.const, led = {}, caveats = [], flags = [];
    teams.forEach(function (t) {
      led[t] = { capRelief: 0, deadCapAdded: 0, valueDelta: 0, modelDelta: 0, fitDelta: 0, incoming: [], outgoing: [] };
    });
    var fitAvailable = !!B.profiles, superstar = false, thinComp = false, missingVal = false;
    var COMPRESS_MIN = 7000000, COMPRESS_MULT = 1.5, compressedStars = [];

    assets.forEach(function (a) {
      var frm = a.from, to = a.to;
      if (!(frm in led) || !(to in led)) return;
      if (a.kind === "pick") {
        var rnd = parseInt(a.round || 0, 10);
        var pv = B.pickCurve[String(rnd)] || 0;
        led[to].valueDelta += pv; led[frm].valueDelta -= pv;
        var lbl = ((a.year || "") + " " + ordinal(rnd) + " pick").trim();
        led[to].incoming.push({ label: lbl, value: pv });
        led[frm].outgoing.push({ label: lbl, value: pv });
        return;
      }
      if (a.kind !== "player") return;
      var pid = a.player_id, row = B.players[pid];
      var retainReq = parseInt(a.retain_pct || 0, 10);
      var retain = Math.max(0, Math.min(C.maxRetentionPct, retainReq));
      if (retainReq > C.maxRetentionPct)
        flags.push({ level: "error", msg: "Retention on player " + pid + " exceeds the 50% maximum." });
      if (!row || !row.hasAsset) {                 // no asset row == Python's _asset_row None
        missingVal = true;
        led[to].incoming.push({ label: "player " + pid, value: 0, note: "no valuation on file" });
        led[frm].outgoing.push({ label: "player " + pid, value: 0, note: "no valuation on file" });
        return;
      }
      var name = row.name || ("player " + pid);
      var control = parseInt(row.control || 0, 10);
      var capHit = row.capHit || 0;
      var surplus = row.surplus || 0;
      // A trade turns on what a player would FETCH (market value), not what our
      // model says he's WORTH (acquisition cost) -- fairness is on the market; the
      // model is carried alongside as our OPINION, and the gap is the edge.
      var modelVal = (row.tradeVal != null ? row.tradeVal : surplus);
      var marketVal = (row.marketVal != null ? row.marketVal : modelVal);
      if (marketVal >= COMPRESS_MIN && (modelVal <= 0 || marketVal >= COMPRESS_MULT * modelVal))
        compressedStars.push(name);   // our model can't price him; flag, don't trust it
      var group = groupOf(row.pos);
      var effCap = control >= 1 ? capHit : 0;
      var retainedAnnual = control >= 1 ? pyround(effCap * retain / 100) : 0;
      var retainedTotal = retainedAnnual * control;
      var relief = effCap - retainedAnnual;
      led[frm].capRelief += relief; led[frm].deadCapAdded += retainedAnnual;
      led[to].capRelief -= relief;
      var value = marketVal + retainedTotal;
      led[to].valueDelta += value; led[frm].valueDelta -= value;
      led[to].modelDelta += modelVal + retainedTotal; led[frm].modelDelta -= modelVal + retainedTotal;
      if (fitAvailable) {
        led[to].fitDelta += fitScore(B.profiles[to], row.feats, group, B.fitMap, false);
        led[frm].fitDelta -= fitScore(B.profiles[frm], row.feats, group, B.fitMap, false);
      }
      var flagstr = (row.flag || "").toLowerCase();
      if (flagstr.indexOf("superstar") >= 0 || flagstr.indexOf("do not read") >= 0) superstar = true;
      if (row.cls === "expiring" || surplus < -1000000) thinComp = true;
      var cl = row.clause;
      if (cl && cl.hasNmc) {
        flags.push({ level: "warn", msg: name + " holds a full no-move clause — requires his waiver to trade." });
      } else if (cl && cl.hasNtc) {
        var sz = cl.noTradeListSize;
        flags.push({ level: "warn", msg: name + " holds a " + (sz ? sz + "-team " : "") + "no-trade clause — the destination may be blocked." });
      } else if (control >= 1) {
        flags.push({ level: "info", msg: "No movement clause on file for " + name + "." });
      }
      var rec = { label: name, value: pyround(value), capHit: effCap, retainPct: retain,
                  retainedAnnual: retainedAnnual, controlYears: control, surplus: surplus };
      led[to].incoming.push(rec);
      var out = Object.assign({}, rec); out.value = pyround(-value);
      led[frm].outgoing.push(out);
    });

    var retainedSlots = B.retainedSlots || {}, newRet = {};
    assets.forEach(function (a) {
      if (a.kind === "player" && parseInt(a.retain_pct || 0, 10) > 0)
        newRet[a.from] = (newRet[a.from] || 0) + 1;
    });
    var legalOk = true;
    teams.forEach(function (t) {
      var L = led[t];
      L.valueDelta = pyround(L.valueDelta);
      L.modelDelta = pyround(L.modelDelta);
      L.fitDelta = pyround(L.fitDelta, 3);
      var room = (t in B.capSpace) ? B.capSpace[t] : null;
      L.roomBefore = room;
      L.roomAfter = room !== null ? room + L.capRelief : null;
      if (L.roomAfter !== null && L.roomAfter < 0) {
        legalOk = false;
        flags.push({ level: "error", msg: t + " is $" + (-L.roomAfter / 1e6).toFixed(1) + "M over the cap after the trade (LTIR not modelled)." });
      }
      var slots = (retainedSlots[t] || 0) + (newRet[t] || 0);
      if (slots > C.maxRetainedSlots) {
        legalOk = false;
        flags.push({ level: "error", msg: t + " would hold " + slots + " retained contracts (max 3)." });
      }
    });

    var deltas = {}; teams.forEach(function (t) { deltas[t] = led[t].valueDelta; });
    var winner = teams[0], loser = teams[0];
    teams.forEach(function (t) { if (deltas[t] > deltas[winner]) winner = t; if (deltas[t] < deltas[loser]) loser = t; });
    var verdict, note, add;
    if (Math.abs(deltas[winner]) <= C.fairnessBand) {
      verdict = "fair"; note = "Within a pick's worth of even -- a fair deal as drawn."; add = null;
    } else {
      verdict = "lopsided";
      var short = Math.abs(deltas[loser]);
      add = closestPick(B.pickCurve, short);
      note = "Favours " + winner + " by $" + (Math.abs(deltas[winner]) / 1e6).toFixed(1) + "M. " +
        loser + " needs about $" + (short / 1e6).toFixed(1) + "M more value" +
        (add ? " -- roughly a " + add + "-round pick." : ".");
    }
    // OUR MODEL'S separate opinion: the same trade priced on what we think players
    // are WORTH (acquisition cost), not what they'd FETCH. Divergence from the
    // market verdict is the analytical edge a GM is hunting for.
    var mDeltas = {}; teams.forEach(function (t) { mDeltas[t] = led[t].modelDelta; });
    var mWinner = teams[0], mLoser = teams[0];
    teams.forEach(function (t) { if (mDeltas[t] > mDeltas[mWinner]) mWinner = t; if (mDeltas[t] < mDeltas[mLoser]) mLoser = t; });
    var mMargin = teams.length === 2 ? Math.abs(mDeltas[mWinner]) : mDeltas[mWinner] - mDeltas[mLoser];
    var mFavors = (Math.abs(mDeltas[mWinner]) <= C.fairnessBand) ? null : mWinner;
    var modelNote;
    if (compressedStars.length) {
      // the model can't price these players -- it would "win" by giving them away.
      // Defer to the market rather than hand a GM a compression artifact as advice.
      mFavors = null;
      modelNote = "Our model under-prices " + andJoin(compressedStars) + " — our WAR compresses elite players, so its read here isn't reliable. The market price is the one to trust.";
    }
    else if (!mFavors && verdict === "fair") modelNote = "Our model agrees — even by our value, too.";
    else if (mFavors && mFavors === winner) modelNote = "Our model agrees the edge is " + winner + "'s" + (verdict === "fair" ? ", though the market reads it even." : ".");
    else if (mFavors && mFavors !== winner) modelNote = "But our model favours " + mFavors + " — they're moving players we value differently than the market does.";
    else if (!mFavors && verdict !== "fair") modelNote = "Our model has it closer to even — the market edge is the gap between our value and the trade market.";
    else modelNote = null;
    var model = { favors: mFavors, marginDollars: mMargin,
      suggestedAddRound: mFavors ? closestPick(B.pickCurve, Math.abs(mDeltas[mLoser])) : null,
      compressed: compressedStars.length ? compressedStars : null, note: modelNote };
    var confidence = "high";
    if (thinComp || !fitAvailable) confidence = "medium";
    if (superstar || missingVal) confidence = "low";
    if (!fitAvailable) caveats.push("Team-fit inputs unavailable -- value/cap only.");
    caveats.push("Movement clauses (NMC/NTC) are surfaced where on file; a player can always waive, so they flag rather than forbid.");
    caveats.push("Cap is headline-level (no LTIR / bonus overages).");
    if (superstar) caveats.push("A superstar-tier player is involved -- acquisition price uncalibrated.");

    var teamsOut = {}; teams.forEach(function (t) { teamsOut[t] = led[t]; });
    return {
      ok: true, teams: teamsOut,
      fairness: { verdict: verdict, favors: winner,
        marginDollars: teams.length === 2 ? Math.abs(deltas[winner]) : deltas[winner] - deltas[loser],
        suggestedAddRound: add, note: note },
      model: model,
      legality: { ok: legalOk, flags: flags, retainedSlotsBefore: retainedSlots },
      confidence: confidence, caveats: caveats
    };
  }

  // ===================== ENGINE 2: realistic targets =====================
  function findTargets(B, acquirer, partner, k) {
    k = k || 8;
    var prof = B.profiles[acquirer];
    if (!prof) return { available: false, note: "No team profile for " + acquirer + "." };
    var anchors = B.movabilityAnchors, ids = B.rosters[partner] || [], targets = [];
    ids.forEach(function (pid) {
      var p = B.players[pid]; if (!p || !p.feats) return;
      var group = p.grp === "D" ? "D" : "F";
      var fw = fitScore(prof, p.feats, group, B.fitMap, true, B.dimLabel);
      if (fw.fit <= 0) return;
      var war3 = (p.vw || 0) * 3;   // per-season caliber, not season-deflated (== Python)
      var neg = (p.surplus || 0) < -1000000;
      var mv = movability(war3, p.cls, neg, anchors);
      targets.push({ id: pid, name: p.name, pos: p.pos, group: group, fit: fw.fit, movability: mv,
        score: pyround(fw.fit * mv, 3), why: fw.why, capHit: p.capHit, controlYears: p.control,
        valueWar: p.vw, tradeValueDollars: p.surplus, assetClass: p.cls });
    });
    targets.sort(function (a, b) { return b.score - a.score; });
    var needsLab = (prof.needs || []).map(function (d) { return B.dimLabel[d] || d; });
    return { available: true, acquirer: acquirer, partner: partner, needs: needsLab,
      anchors: anchors, targets: targets.slice(0, k) };
  }

  // ===================== ENGINE 2b: recommended moves =====================
  // Caliber by value level (model WAR compresses stars, so 1.2 ~ a real top-6F/
  // top-4D and up reads as "big fish"; below 0.5 is depth).
  function caliber(vw) {
    var v = vw || 0;
    if (v >= 1.2) return "big";
    if (v >= 0.5) return "mid";
    return "depth";
  }

  // For the selected team: who fills its holes, as TRADES (other teams' players,
  // with an acquisition price + a model availability score) and FREE-AGENT SIGNINGS
  // (pending UFAs anywhere + the team's own pending RFAs, with a projected contract).
  // Ranked by fit; the caller filters by kind + caliber. Availability is MODELLED
  // (contract/age/value), not reported -- the UI must say so.
  function recommendMoves(B, team, opts) {
    opts = opts || {};
    var prof = B.profiles[team];
    if (!prof) return { available: false, note: "No team profile for " + team + "." };
    var needsLab = (prof.needs || []).map(function (d) { return B.dimLabel[d] || d; });
    var pidTeam = {};
    Object.keys(B.rosters).forEach(function (t) {
      (B.rosters[t] || []).forEach(function (pid) { pidTeam[pid] = t; });
    });

    var BIG = 1.2, anchors = B.movabilityAnchors;
    // market-vs-model: when the market (a cap hit, or a pending FA's projected deal)
    // pays far above the WAR-implied value, our WAR is under-rating him -- RAPM
    // compresses scorers, so a 110-point winger can read as depth. Flag it.
    var DPW = 5250000, FLOOR = 775000;
    function underModel(p) {
      var warVal = FLOOR + Math.max(p.vw || 0, 0) * DPW;
      var market = (p.cls === "rfa" || p.cls === "expiring") ? (p.projAav || p.capHit || 0) : (p.capHit || 0);
      // star-money ($7M+) paid well above the WAR value -> the model is compressing him
      // (true for scorers and top-pair D). $7M floor keeps fairly-paid role players out.
      return { market: market, under: market >= 7000000 && (market - warVal) >= 3000000 };
    }
    var items = [], seen = {};
    // ---- TRADE targets: ONE leaguewide pass. A player qualifies if he fills a
    // need OR he's a big fish (high value, worth hunting even off-need). Pending
    // UFAs are skipped here -- they surface as FA signings. ----
    if (opts.includeTrades !== false) {
      Object.keys(B.players).forEach(function (pid) {
        var p = B.players[pid];
        if (!p || !p.feats || p.cls === "expiring") return;
        var t = pidTeam[pid];
        if (!t || t === team) return;                // other teams' rostered skaters
        var grp = p.grp === "D" ? "D" : "F";
        var fw = fitScore(prof, p.feats, grp, B.fitMap, true, B.dimLabel);
        var big = (p.vw || 0) >= BIG;
        if (fw.fit <= 0 && !big) return;             // fills a need, or a big fish
        if (seen[pid]) return; seen[pid] = 1;
        var war3 = (p.vw || 0) * 3;   // per-season caliber, not season-deflated (== Python)
        var mv = movability(war3, p.cls, (p.surplus || 0) < -1000000, anchors);
        var um = underModel(p);
        items.push({
          kind: "trade", id: +pid, name: p.name, pos: p.pos, team: t,
          why: fw.why, fit: fw.fit, movability: mv,
          valueWar: p.vw, capHit: p.capHit, controlYears: p.control,
          acqPicks: p.acqPicks, acqWar7: p.acqWar7, compCost: p.compCost,
          marketAav: um.market, underModeled: um.under,
          assetClass: p.cls, tier: caliber(p.vw)
        });
      });
    }
    // ---- FREE-AGENT signings: pending UFAs on OTHER teams (signable in July).
    // A team's own pending FAs are re-sign decisions the FA sidebar already lists --
    // not "moves" to add, and surfacing them here just self-recommends your own
    // roster. Include on a need fit OR big-fish caliber (a star UFA is worth listing). ----
    if (opts.includeFAs !== false) {
      Object.keys(B.players).forEach(function (pid) {
        var p = B.players[pid];
        if (!p || !p.feats || !p.projAav) return;
        if (p.cls !== "expiring") return;            // only pending UFAs are signable by another team
        if (pidTeam[pid] === team) return;           // not your own player (the FA sidebar covers re-signs)
        var grp = p.grp === "D" ? "D" : "F";
        var fw = fitScore(prof, p.feats, grp, B.fitMap, true, B.dimLabel);
        if ((fw.fit <= 0 && (p.vw || 0) < BIG) || seen[pid]) return; seen[pid] = 1;
        var um = underModel(p);
        items.push({
          kind: "fa", id: +pid, name: p.name, pos: p.pos,
          team: pidTeam[pid] || null, faKind: "UFA", why: fw.why, fit: fw.fit,
          valueWar: p.vw, projAav: p.projAav, projTerm: p.projTerm,
          marketAav: um.market, underModeled: um.under,
          tier: caliber(p.vw)
        });
      });
    }
    // need-fit first (best fills on top), then by caliber so off-need big fish
    // still sort sensibly among themselves
    items.sort(function (a, b) { return (b.fit - a.fit) || ((b.valueWar || 0) - (a.valueWar || 0)); });
    return { available: true, team: team, needs: needsLab, items: items };
  }

  // ===================== ENGINE 2c: move-assets deal finder =====================
  // The inverse of recommendMoves: you mark the players you'd trade, and this finds
  // realistic deals -- a partner who NEEDS your asset, returning a player who fills
  // YOUR needs. The send side is built greedily: one piece for a like-for-like swap,
  // but when the target is much heavier (a big fish) it bundles a SECOND willing
  // piece -- a real package -- instead of "add a 1st." Every deal carries the full
  // per-side value ledger (the same evaluateTrade math the Trade evaluator uses) so
  // the card can be opened to read the whole trade, not just the headline.
  function findDeals(B, myTeam, willingIds, opts) {
    opts = opts || {};
    var myProf = B.profiles[myTeam];
    if (!myProf) return { available: false, note: "No team profile for " + myTeam + "." };
    var needsLab = (myProf.needs || []).map(function (d) { return B.dimLabel[d] || d; });
    if (!willingIds || !willingIds.length)
      return { available: true, team: myTeam, needs: needsLab, deals: [], note: "Mark the players you'd move." };

    // the same value the engine weighs: acquisition cost in dollars (age/term-aware)
    var tradeVal = function (P) { return P ? (P.tradeVal != null ? P.tradeVal : (P.surplus || 0)) : 0; };
    var evalSend = function (T, sendArr, getId) {                    // run a send-list -> one return
      var assets = sendArr.map(function (w) { return { from: myTeam, to: T, kind: "player", player_id: w.id }; });
      assets.push({ from: T, to: myTeam, kind: "player", player_id: getId });
      var ev = evaluateTrade(B, { teams: [myTeam, T], assets: assets });
      return { ev: ev, fav: ev.fairness.favors, margin: Math.abs(ev.fairness.marginDollars || 0) };
    };
    // gap beyond which you'd be surrendering a real pick to balance -- bundle a
    // second roster player instead. A 2nd-round pick's worth: now that trade value
    // is realistic (no skater is worth a fortune), "more than a 1st" almost never
    // happens, so the package alternative keys off the smaller, common gap.
    var BIGGAP = (B.pickCurve && B.pickCurve["2"]) || 1.5e6;
    var BIGACQ = 1.0;                                               // big fish = high TRADE value (acqWar7 >= ~a late 1st), not raw WAR --
                                                                    // a young controllable stud qualifies; an aging high-WAR vet does not

    var willingSet = {}; willingIds.forEach(function (x) { willingSet[+x] = 1; });
    var willing = willingIds.map(Number)
      .filter(function (id) { return B.players[id] && B.players[id].feats; })
      .map(function (id) { var P = B.players[id]; return { id: id, P: P, val: tradeVal(P), grp: P.grp === "D" ? "D" : "F" }; });
    if (!willing.length) return { available: true, team: myTeam, needs: needsLab, deals: [] };

    var deals = [], seen = {};
    // Asset-centric: each marked player LEADS its own deals (so every asset you'd move
    // shows what it can fetch), and when a target outweighs the lead chip we bundle a
    // second willing piece into a package rather than attaching a high pick.
    willing.forEach(function (A) {
      var aGrp = A.grp;
      Object.keys(B.rosters).forEach(function (T) {
        if (T === myTeam) return;
        var tProf = B.profiles[T]; if (!tProf) return;
        var tWantsA = fitScore(tProf, A.P.feats, aGrp, B.fitMap, true, B.dimLabel);
        if (tWantsA.fit <= 0) return;                   // T must want the lead chip
        // T's players that fill MY need -- returns, heaviest first so big fish lead
        var returns = (B.rosters[T] || []).map(function (rid) {
          var R = B.players[rid]; if (!R || !R.feats || willingSet[rid]) return null;
          var mw = fitScore(myProf, R.feats, R.grp === "D" ? "D" : "F", B.fitMap, true, B.dimLabel);
          if (mw.fit <= 0) return null;
          return { rid: rid, R: R, why: mw.why, fit: mw.fit, val: tradeVal(R) };
        }).filter(Boolean).sort(function (a, b) { return b.val - a.val; });

        returns.slice(0, 4).forEach(function (c) {
          var sendList = [A];
          var r = evalSend(T, sendList, c.rid);
          // a genuine big fish (high-end caliber) that outweighs the lead chip by more than
          // a 1st -> bundle a 2nd willing asset (preferring one T also wants) rather than
          // attaching a high pick, if it lands closer to even than the lone chip would
          if ((c.R.acqWar7 || 0) >= BIGACQ && r.fav === myTeam && r.margin > BIGGAP) {
            var second = willing.filter(function (w) { return w.id !== A.id; })
              .map(function (w) { return { w: w, t: fitScore(tProf, w.P.feats, w.grp, B.fitMap, true, B.dimLabel).fit }; })
              .sort(function (x, y) { return ((y.t > 0) - (x.t > 0)) || (y.w.val - x.w.val); })[0];
            if (second) {
              var r2 = evalSend(T, [A, second.w], c.rid);
              if (Math.abs(r2.margin) < Math.abs(r.margin)) { sendList = [A, second.w]; r = r2; }
            }
          }
          var key = T + ":" + sendList.map(function (w) { return w.id; }).sort().join(",") + ">" + c.rid;
          if (seen[key]) return; seen[key] = 1;
          var f = r.ev.fairness, led = r.ev.teams[myTeam];
          deals.push({
            // each side's own signed trade value ($ surplus) -- outgoing is negated in the ledger
            send: led.outgoing.map(function (l) { return { name: l.label, value: -l.value }; }),
            get: led.incoming.map(function (l) { return { name: l.label, value: l.value }; }),
            getLead: { id: c.rid, name: c.R.name, pos: c.R.pos, valueWar: c.R.vw },
            leadId: A.id,
            partner: T, fillsMine: c.why, fillsTheirs: tWantsA.why,
            verdict: f.verdict, favors: f.favors, marginDollars: f.marginDollars,
            addRound: f.suggestedAddRound, myNet: led.valueDelta,
            // OUR MODEL's separate take (market fairness above is what it'd take; this
            // is whether we think you WIN it on value) -- the edge to hunt
            modelFavors: (r.ev.model || {}).favors, modelMargin: (r.ev.model || {}).marginDollars,
            modelMyNet: (r.ev.teams[myTeam] || {}).modelDelta,
            // a lopsided deal balances with a pick: the side getting MORE value adds it
            addBy: f.verdict === "fair" ? null : (f.favors === myTeam ? myTeam : T),
            isPackage: sendList.length > 1,
            fairScore: f.verdict === "fair" ? 2 : (f.suggestedAddRound ? 1 : 0),
            fitScore: c.fit + tWantsA.fit
          });
        });
      });
    });
    deals.sort(function (a, b) { return (b.fairScore - a.fairScore) || (b.fitScore - a.fitScore); });
    // keep the board varied: at most 4 deals led by any one asset, so a heavy chip
    // can't crowd out the lighter players you also marked
    var perLead = {}, out = [];
    deals.forEach(function (d) {
      var n = perLead[d.leadId] || 0;
      if (n >= 4) return;
      perLead[d.leadId] = n + 1; out.push(d);
    });
    return { available: true, team: myTeam, needs: needsLab, deals: out.slice(0, 20) };
  }

  // ===================== ENGINE 3: composition impact =====================
  function impact(B, team, change) {
    change = change || {};
    var remove = change.remove || [], add = change.add || [];
    var dims = B.impactDims, players = B.players, league = B.league, rosters = B.rosters;
    var repl = B.replacement || {};
    var removeSet = {}; remove.forEach(function (x) { removeSet[x] = 1; });
    var baseIds = (rosters[team] || []).slice();
    var presentRemoved = baseIds.filter(function (p) { return removeSet[p]; });
    var addedNew = add.filter(function (a) { return baseIds.indexOf(a) < 0; });
    var keepIds = baseIds.filter(function (p) { return !removeSet[p]; }).concat(addedNew);
    var netOut = Math.max(presentRemoved.length - addedNew.length, 0);
    var before = teamDimension(baseIds, players, dims);
    var nd = dimNumden(keepIds, players, dims);
    var rdims = repl.dims || {}, rtoi = repl.toi || 0;
    if (netOut && rtoi) dims.forEach(function (d) {
      if (d in rdims) { nd[d][0] += rdims[d] * rtoi * netOut; nd[d][1] += rtoi * netOut; }
    });
    var after = {}; dims.forEach(function (d) { if (nd[d][1] > 0) after[d] = pyround(nd[d][0] / nd[d][1], 4); });
    var dimsOut = {};
    dims.forEach(function (d) {
      var others = [];
      Object.keys(league).forEach(function (t) { if (t !== team) others.push(league[t][d]); });
      var b = pctRank(before[d] !== undefined ? before[d] : null, others.concat([before[d]]));
      var a = pctRank(after[d] !== undefined ? after[d] : null, others.concat([after[d]]));
      dimsOut[d] = { label: B.impactDimLabel[d], beforePct: b[0], afterPct: a[0],
        deltaPct: (b[0] === null || a[0] === null) ? null : pyround(a[0] - b[0], 3),
        beforeRank: b[1], afterRank: a[1], teams: others.length + 1 };
    });
    return { ok: true, team: team, season: B.season, dims: dimsOut };
  }

  global.GM = { evaluateTrade: evaluateTrade, findTargets: findTargets, impact: impact,
    recommendMoves: recommendMoves, findDeals: findDeals, _pyround: pyround, _groupOf: groupOf };
})(typeof window !== "undefined" ? window : globalThis);
