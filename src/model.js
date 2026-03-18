#!/usr/bin/env node
/**
 * March Madness 2026 Bracket Prediction Engine v3
 * Generates 3 brackets ranked by confidence:
 *   1. BEST GUESS — optimal balance of accuracy + pool edge (RECOMMENDED)
 *   2. CHALK — maximize prediction accuracy, less pool differentiation
 *   3. SWING — maximum contrarian value for large pools
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_DIR = path.join(__dirname, '..', 'output');

// ─── Load All Data ──────────────────────────────────────────────────────────
const bracket = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'bracket_2026.json')));
const patternPriors = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'pattern_priors.json')));
const expertConsensus = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'expert_consensus.json')));
const predictionMarkets = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'prediction_markets.json')));
const vegasSpreads = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'vegas_spreads.json')));
const injuryFlags = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'injury_flags.json')));
const recencyForm = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'recency_form.json')));
const publicPicks = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'public_picks.json')));
const efficiencyMetrics = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'efficiency_metrics.json')));
const fourFactors = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'four_factors.json')));

const SCORING = { R64: 1, R32: 2, S16: 4, E8: 8, F4: 16, Championship: 32 };
const ROUND_ORDER = ['R64', 'R32', 'S16', 'E8', 'F4', 'Championship'];

// ─── Strategy Configs ───────────────────────────────────────────────────────
const STRATEGIES = {
  bestGuess: {
    name: 'BEST GUESS',
    tag: 'best_guess',
    description: 'Arizona champion, Houston F4, St. John\'s Cinderella to E8, Texas upsets BYU. RECOMMENDED.',
    targetUpsets: 7,              // 7 validated upsets (Texas replaces NC State)
    upsetThreshold: 12,
    injuryMultiplier: 1.0,
    champOverride: 'Arizona',
    f4Override: {},  // MC simulation shows Florida wins South more often (18.4%) than Houston (14.6%); Houston F4 rate 42% public = not contrarian
    // Pressure-tested R64 adjustments:
    // ALL pressure-tested R64 upsets locked in:
    forcedUpsetLosers: [
      'Georgia',         // →Saint Louis (40% from 3, UGA defense 315th)
      'North Carolina',  // →VCU (Wilson OUT, 8+ expert consensus)
      'BYU',             // →Texas (Saunders ACL, BYU 5-5 L10, Texas First Four momentum, BYU -1.5 spread only)
      'Kentucky',        // →Santa Clara (Lowe + Quaintance OUT, 7+ sources)
      'Texas Tech',      // →Akron (Toppin OUT, defense 31st→87th, 5+ sources)
      'Kansas',          // →Cal Baptist (Kansas 3-4 in L7, blown out by Houston; 13o4 pattern)
    ],
    protectedWinners: ['Louisville', 'UCLA'],  // Don't upset Louisville (Brown returning) or UCLA (both stars healthy, -5.5)
    pathOverrides: [
      { round: 'S16', winner: "St. John's", note: 'Duke missing Foster+Evans+Ngongba; SJU 16-1 in L17, Pitino 7 Final Fours. Bruce Pearl picked exactly this.' },
      // NC State Cinderella DROPPED — too risky for a First Four team (20-13) needing 3 wins to reach S16
      // Gonzaga advances even without Huff; their SRS 25.11 is still elite
      { round: 'R32', winner: 'Tennessee', note: 'Tennessee SRS 22.08 > Virginia 21.60; Bilas picks Vols; physical + offensive rebounding edge' },
    ],
    vegasWeight: 0.42,
    marketDampen: 0.4,
    confidence: 'HIGH — pressure-tested game by game, best risk/reward for $1M bracket'
  },
  chalk: {
    name: 'CHALK',
    tag: 'chalk',
    description: 'Duke champion. All 4 one-seeds in F4. Covers the most likely champion (24.4% BPI).',
    targetUpsets: 4,
    upsetThreshold: 25,
    injuryMultiplier: 0.5,
    champOverride: 'Duke',
    f4Override: {},
    // Even chalk needs some Cinderella — Vanderbilt beat Florida in SEC tourney
    pathOverrides: [
      { round: 'R32', winner: 'Vanderbilt', note: 'Vanderbilt SRS 22.83 > Nebraska 21.54; beat Florida in SEC semis' },
    ],
    vegasWeight: 0.42,
    marketDampen: 0.4,
    confidence: 'MODERATE — highest raw accuracy but less pool differentiation'
  },
  swing: {
    name: 'SWING',
    tag: 'swing',
    description: 'Houston champion, St. John\'s wins East, Iowa State wins Midwest. Texas R32 run. Max diversification.',
    targetUpsets: 8,
    upsetThreshold: 8,
    injuryMultiplier: 1.5,
    champOverride: 'Houston',
    f4Override: { South: 'Houston', West: 'Purdue', East: "St. John's", Midwest: 'Iowa State' },
    pathOverrides: [
      { round: 'R32', winner: 'Texas', note: 'Texas First Four momentum + Gonzaga missing Huff; high-variance swing pick' },
      { round: 'S16', winner: "St. John's", note: 'Duke injuries' },
      { round: 'R32', winner: 'VCU', note: 'Illinois offense-only; VCU grinds' },
      { round: 'S16', winner: 'Tennessee', note: 'Tennessee SRS 22.08 > Virginia 21.60' },
    ],
    vegasWeight: 0.35,
    marketDampen: 0.3,
    confidence: 'LOWER — high variance, high ceiling if chaos hits'
  }
};

// ─── Build Team Database ────────────────────────────────────────────────────
function buildTeamDB(strategy) {
  const teams = {};

  for (const [region, data] of Object.entries(bracket.regions)) {
    for (const matchup of data.matchups) {
      if (matchup.team1 && !matchup.team1.startsWith('TBD'))
        teams[matchup.team1] = { name: matchup.team1, seed: matchup.seed1, region, record: matchup.record1 };
      if (matchup.team2 && !matchup.team2.startsWith('TBD'))
        teams[matchup.team2] = { name: matchup.team2, seed: matchup.seed2, region, record: matchup.record2 };
    }
  }

  // First Four teams
  const ff = { 'UMBC': {s:16,r:'Midwest'}, 'Howard': {s:16,r:'Midwest'}, 'Lehigh': {s:16,r:'South'},
    'Prairie View A&M': {s:16,r:'South'}, 'Texas': {s:11,r:'West'}, 'NC State': {s:11,r:'West'},
    'Miami OH': {s:11,r:'Midwest'}, 'SMU': {s:11,r:'Midwest'} };
  for (const [n, d] of Object.entries(ff)) {
    if (!teams[n]) teams[n] = { name: n, seed: d.s, region: d.r, record: '' };
  }

  // Real SRS efficiency data
  const effTeams = efficiencyMetrics.teams || {};
  for (const [name, data] of Object.entries(effTeams)) {
    if (teams[name]) {
      teams[name].adjEM = data.adjEM;
      teams[name].adjO = data.adjO; teams[name].adjD = data.adjD;
      teams[name].sos = data.sos;
    }
  }

  // Recency
  for (const [name, data] of Object.entries(recencyForm.teams || {})) {
    if (teams[name]) {
      teams[name].momentum = data.momentum;
      teams[name].recencyBoost = data.adjEMBoost || 0;
      teams[name].confTourneyResult = data.confTourneyResult;
      teams[name].coachTourneyRecord = data.coachTourneyRecord || null;
    }
  }

  // Four Factors (style data)
  const ffTeams = fourFactors.teams || {};
  for (const [name, data] of Object.entries(ffTeams)) {
    if (teams[name]) teams[name].fourFactors = data;
  }

  // Injuries — scaled by strategy
  const penalties = injuryFlags.adjEMPenalties || {};
  for (const [name, penalty] of Object.entries(penalties)) {
    if (teams[name]) teams[name].injuryPenalty = penalty * strategy.injuryMultiplier;
  }

  // Markets
  for (const [name, data] of Object.entries(predictionMarkets.championshipOdds || {})) {
    if (teams[name]) teams[name].champProb = data.composite || 0;
  }
  for (const [name, data] of Object.entries(predictionMarkets.finalFourOdds || {})) {
    if (teams[name]) teams[name].f4Prob = data.impliedProb || 0;
  }

  // Experts
  const totalExperts = expertConsensus.aggregated.totalExperts || 14;
  for (const [name, count] of Object.entries(expertConsensus.aggregated.finalFourAppearances || {})) {
    if (teams[name]) teams[name].expertF4Rate = count / totalExperts;
  }
  for (const [name, count] of Object.entries(expertConsensus.aggregated.championPicks || {})) {
    if (teams[name]) teams[name].expertChampRate = count / totalExperts;
  }

  // Public picks (ESPN BPI-based)
  const champPick = publicPicks.championPickRate || {};
  const f4Pick = publicPicks.finalFourPickRate || {};
  const r64PerTeam = publicPicks.r64WinPickRate || {};
  for (const [name, rate] of Object.entries(champPick)) { if (teams[name]) teams[name].publicChampRate = rate; }
  for (const [name, rate] of Object.entries(f4Pick)) { if (teams[name]) teams[name].publicF4Rate = rate; }

  // Defaults
  for (const t of Object.values(teams)) {
    t.adjEM = t.adjEM || 0;
    t.injuryPenalty = t.injuryPenalty || 0;
    t.recencyBoost = t.recencyBoost || 0;
    t.champProb = t.champProb || 0.001;
    t.f4Prob = t.f4Prob || 0.001;
    t.expertF4Rate = t.expertF4Rate || 0;
    t.expertChampRate = t.expertChampRate || 0;
    t.publicChampRate = t.publicChampRate || 0.005;
    t.publicF4Rate = t.publicF4Rate || 0.01;
    t.publicR64Rate = r64PerTeam[t.name] || 0.50;
    t.fourFactors = t.fourFactors || {};
  }

  return teams;
}

// ─── Source Functions ────────────────────────────────────────────────────────
function getHistoricalWinRate(s1, s2) {
  if (s1 === s2) return 0.5;
  const key = `${Math.min(s1,s2)}v${Math.max(s1,s2)}`;
  const r = patternPriors.seed_matchup_win_rates;
  if (r[key] !== undefined) return s1 < s2 ? r[key] : (1 - r[key]);
  return Math.max(0.1, Math.min(0.9, 0.5 + (s2 - s1) * 0.015));
}

function getVegasProb(t1, t2, region) {
  const games = vegasSpreads.firstRound[region];
  if (!games) return null;
  for (const g of games) {
    const m1 = g.team1 === t1 && g.team2 === t2;
    const m2 = g.team1 === t2 && g.team2 === t1;
    if (!m1 && !m2) continue;
    if (g.spread === null) return null;
    const p = Math.min(0.99, 0.5 + Math.abs(g.spread) * 0.033);
    const t1p = g.spread < 0 ? p : (1 - p);
    return m1 ? t1p : (1 - t1p);
  }
  return null;
}

function getMarketProb(t1, t2, dampen) {
  const a = t1.f4Prob || t1.champProb * 4 || 0.01;
  const b = t2.f4Prob || t2.champProb * 4 || 0.01;
  const raw = a / (a + b);
  return 0.5 + (raw - 0.5) * dampen;
}

function getExpertProb(t1, t2) {
  const a = t1.expertF4Rate || 0.01, b = t2.expertF4Rate || 0.01;
  return a / (a + b);
}

function stdDev(vals) {
  const n = vals.length; if (!n) return 0;
  const m = vals.reduce((a,b) => a+b, 0) / n;
  return Math.sqrt(vals.reduce((s,v) => s + (v-m)**2, 0) / n);
}

function rd(v) { return v == null ? null : Math.round(v * 1000) / 1000; }

// ─── Style Mismatch Modifier (Four Factors — real Sports-Reference data) ────
// NOTE: Coefficients are kept small (max ±0.03 total) because we lack
// regression-calibrated weights against historical tournament outcomes.
// These are directional nudges, not primary signals.
function getStyleMismatchModifier(t1, t2, round) {
  const ff1 = t1.fourFactors || {}, ff2 = t2.fourFactors || {};
  if (!ff1.tempo || !ff2.tempo) return 0;

  let modifier = 0;

  // Pace differential: slower team gets small edge in March (games tighten)
  // Empirical basis: limited. Kept at ±0.01 max.
  const paceDiff = Math.abs(ff1.tempo - ff2.tempo);
  if (paceDiff > 5) {
    modifier += (ff1.tempo < ff2.tempo ? 1 : -1) * 0.01;
  }

  // Turnover differential: team that turns it over more is at risk
  // tovPct is per-100-possessions (e.g. 13.3). Scale: 1 point = ~0.003
  const toDiff = (ff1.tovPct || 14) - (ff2.tovPct || 14);
  modifier -= toDiff * 0.003;

  // ORB% advantage: teams that crash offensive glass get extra possessions
  // orbPct is percentage (e.g. 38.1). Scale: 1 point = ~0.001
  const orbDiff = (ff1.orbPct || 32) - (ff2.orbPct || 32);
  modifier += orbDiff * 0.001;

  // Defensive eFG%: lower is better for t1. Scale: 0.01 diff = ~0.005 modifier
  const defDiff = (ff2.defEFGPct || 0.49) - (ff1.defEFGPct || 0.49);
  modifier += defDiff * 0.5;

  // Clamp to ±0.03 — this is a nudge, not a primary signal
  return Math.max(-0.03, Math.min(0.03, modifier));
}

// ─── Matchup Analysis ────────────────────────────────────────────────────────
function analyzeMatchup(t1, t2, round, region, strategy) {
  const adj1 = t1.adjEM + (t1.recencyBoost || 0) + (t1.injuryPenalty || 0);
  const adj2 = t2.adjEM + (t2.recencyBoost || 0) + (t2.injuryPenalty || 0);

  const historical = getHistoricalWinRate(t1.seed, t2.seed);
  const efficiency = 1 / (1 + Math.exp(-0.12 * (adj1 - adj2)));
  const market = getMarketProb(t1, t2, strategy.marketDampen);
  let vegas = round === 'R64' ? getVegasProb(t1.name, t2.name, region) : null;
  if (vegas === null) vegas = market;
  const consensus = getExpertProb(t1, t2);
  const sources = { historical, efficiency, market, vegas, consensus };

  const isR64 = round === 'R64';
  const hasRealVegas = vegas !== market;
  const vW = strategy.vegasWeight;
  const weights = isR64
    ? (hasRealVegas
      ? { historical: 0.15, efficiency: 0.25, market: 0.08, vegas: vW, consensus: 1 - 0.15 - 0.25 - 0.08 - vW > 0 ? 1 - 0.15 - 0.25 - 0.08 - vW : 0.10 }
      : { historical: 0.20, efficiency: 0.35, market: 0.20, vegas: 0.15, consensus: 0.10 })
    : { historical: 0.08, efficiency: 0.35, market: 0.30, vegas: 0.17, consensus: 0.10 };
  // Fix consensus weight for R64 with real vegas
  if (isR64 && hasRealVegas) weights.consensus = 0.10;

  let comp = 0, tw = 0, su = 0;
  for (const [k, w] of Object.entries(weights)) {
    if (sources[k] != null) { comp += sources[k] * w; tw += w; su++; }
  }
  comp = tw > 0 ? comp / tw : 0.5;

  // Apply Four Factors style-mismatch modifier
  const styleMod = getStyleMismatchModifier(t1, t2, round);
  comp += styleMod;

  comp = Math.max(0.02, Math.min(0.98, comp));

  const contradiction = stdDev(Object.values(sources).filter(v => v != null));

  let pubRate;
  if (round === 'R64') pubRate = t1.publicR64Rate || 0.5;
  else if (round === 'F4' || round === 'Championship') pubRate = t1.publicF4Rate || t1.publicChampRate || 0.1;
  else {
    const r64r = t1.publicR64Rate || 0.5, f4r = t1.publicF4Rate || 0.1;
    pubRate = r64r * (1 - ROUND_ORDER.indexOf(round) / 4) + f4r * (ROUND_ORDER.indexOf(round) / 4);
  }

  const winP = Math.max(comp, 1 - comp);
  const winner = comp >= 0.5 ? t1 : t2;
  const winnerPub = comp >= 0.5 ? pubRate : (1 - pubRate);
  const pv = winP * (SCORING[round] || 1) * (1 / Math.max(winnerPub, 0.01));

  return {
    team1: { name: t1.name, seed: t1.seed }, team2: { name: t2.name, seed: t2.seed },
    pick: winner.name, pickSeed: winner.seed,
    winProbability: winP, rawComposite: comp, publicPickRate: pubRate,
    valueGap: comp - pubRate, poolValueScore: pv,
    isUpset: winner.seed > (comp >= 0.5 ? t2.seed : t1.seed),
    contradiction, sourcesUsed: su,
    sources: { historical: rd(historical), efficiency: rd(efficiency), market: rd(market), vegas: rd(vegas), consensus: rd(consensus) }
  };
}

// ─── Upset Calibration ──────────────────────────────────────────────────────
function computeUpsetScore(p, teams, strategy) {
  const hi = p.team1.seed < p.team2.seed ? p.team1 : p.team2;
  const lo = p.team1.seed < p.team2.seed ? p.team2 : p.team1;
  const ht = teams[hi.name], lt = teams[lo.name];
  if (!ht || !lt) return 0;

  let score = 0;
  score += (1 - Math.abs(p.rawComposite - 0.5) * 2) * 30;
  score += Math.min(Math.abs(ht.injuryPenalty || 0), 5) * 4;
  if (ht.momentum === 'cold' || ht.momentum === 'cratered') score += 10;
  if (lt.momentum === 'hot' || lt.momentum === 'surging' || lt.momentum === 'blazing') score += 8;
  score += (1 - (lt.publicR64Rate || 0.3)) * 15;
  const sp = `${hi.seed}v${lo.seed}`;
  score += ({ '5v12': 12, '6v11': 8, '7v10': 8, '4v13': 5, '3v14': 3 })[sp] || 0;
  score += p.contradiction * 30;
  return score;
}

function calibrateUpsets(r64, teams, strategy) {
  const existing = r64.filter(p => p.isUpset);
  const nonUpsets = r64.filter(p => !p.isUpset && p.team1.seed !== p.team2.seed);
  const candidates = nonUpsets.map(p => ({
    ...p, upsetScore: computeUpsetScore(p, teams, strategy),
    seedPair: `${Math.min(p.team1.seed, p.team2.seed)}v${Math.max(p.team1.seed, p.team2.seed)}`
  })).sort((a, b) => b.upsetScore - a.upsetScore);

  const needed = Math.max(0, strategy.targetUpsets - existing.length);
  const flipped = new Set();
  const regionCounts = { East: 0, West: 0, South: 0, Midwest: 0 };

  // Count existing upsets per region
  for (const e of existing) regionCounts[e.region] = (regionCounts[e.region] || 0) + 1;

  // Forced flips from pressure testing (team that should LOSE, not win)
  const forcedFlips = new Set(strategy.forcedUpsetLosers || []);
  for (const loserName of forcedFlips) {
    const c = candidates.find(x => x.pick === loserName);
    if (c) { flipped.add(c.pick); regionCounts[c.region] = (regionCounts[c.region] || 0) + 1; }
  }
  // Forced NON-upsets (teams that should WIN despite being upset candidates)
  const protectedWinners = new Set(strategy.protectedWinners || []);

  // Must-have patterns
  const mustHave = ['5v12', '7v10', '6v11'];
  for (const pat of mustHave) {
    if (flipped.size >= needed) break;
    const c = candidates.find(x => x.seedPair === pat && !flipped.has(x.pick) && !protectedWinners.has(x.pick) && x.upsetScore > strategy.upsetThreshold);
    if (c) { flipped.add(c.pick); regionCounts[c.region] = (regionCounts[c.region] || 0) + 1; }
  }

  if (strategy.targetUpsets >= 7) {
    const c13 = candidates.find(x => x.seedPair === '4v13' && !flipped.has(x.pick) && x.upsetScore > strategy.upsetThreshold);
    if (c13 && flipped.size < needed) { flipped.add(c13.pick); regionCounts[c13.region]++; }
  }

  // Fill remaining, preferring regions with fewer upsets for balance
  for (const c of candidates) {
    if (flipped.size >= needed) break;
    if (flipped.has(c.pick)) continue;
    if (c.upsetScore <= strategy.upsetThreshold) continue;
    if (protectedWinners.has(c.pick)) continue;
    // Prefer regions that need upsets (balance: each region should have ~1-2)
    const rCount = regionCounts[c.region] || 0;
    if (rCount >= 3) continue; // cap per region
    flipped.add(c.pick);
    regionCounts[c.region] = rCount + 1;
  }

  // Regional balance: add ONE upset for regions with 0, but only if supported by data
  // Don't force upsets where none exist (e.g. East region has all strong favorites)
  for (const region of ['East', 'West', 'South', 'Midwest']) {
    if (flipped.size >= needed + 1) break;
    if ((regionCounts[region] || 0) > 0) continue;
    // Only force if there's a candidate with score > 25 (genuine upset case)
    const rc = candidates.find(x => x.region === region && !flipped.has(x.pick) && !protectedWinners.has(x.pick) && x.upsetScore > 25);
    if (rc) { flipped.add(rc.pick); regionCounts[region] = 1; }
  }

  return flipped;
}

// ─── Simulate Tournament ────────────────────────────────────────────────────
function resolveFirstFour() {
  return { 'TBD_Midwest16': 'Howard', 'TBD_South16': 'Lehigh', 'TBD_West11': 'Texas', 'TBD_Midwest11': 'SMU' };
}

function simulateBracket(teams, strategy) {
  const ffWinners = resolveFirstFour();
  const allPicks = [];
  const regionWinners = {};

  // First Four
  const ffGames = [
    ['UMBC','Howard','Midwest'], ['NC State','Texas','West'],
    ['Lehigh','Prairie View A&M','South'], ['SMU','Miami OH','Midwest']
  ];
  for (const [a, b, r] of ffGames) {
    const t1 = teams[a], t2 = teams[b];
    if (t1 && t2) { const res = analyzeMatchup(t1, t2, 'R64', r, strategy); res.round = 'FirstFour'; res.region = r; allPicks.push(res); }
  }

  // Collect ALL R64 results first, then calibrate upsets GLOBALLY
  const allR64ByRegion = {};
  for (const region of ['East', 'West', 'South', 'Midwest']) {
    allR64ByRegion[region] = [];
    for (const m of bracket.regions[region].matchups) {
      const t1n = m.team1.startsWith('TBD') ? ffWinners[m.team1] : m.team1;
      const t2n = m.team2.startsWith('TBD') ? ffWinners[m.team2] : m.team2;
      const t1 = teams[t1n], t2 = teams[t2n];
      if (!t1 || !t2) continue;
      const res = analyzeMatchup(t1, t2, 'R64', region, strategy);
      res.round = 'R64'; res.region = region;
      allR64ByRegion[region].push(res);
    }
  }

  // Global upset calibration across all 32 R64 games
  const allR64Flat = Object.values(allR64ByRegion).flat();
  const flipped = calibrateUpsets(allR64Flat, teams, strategy);

  // Now process each region with the global flip set
  for (const region of ['East', 'West', 'South', 'Midwest']) {
    const r64Winners = [];
    for (const res of allR64ByRegion[region]) {
      if (flipped.has(res.pick)) {
        const winner = res.pick === res.team1.name ? res.team2.name : res.team1.name;
        const winnerSeed = res.pick === res.team1.name ? res.team2.seed : res.team1.seed;
        res.pick = winner; res.pickSeed = winnerSeed;
        res.winProbability = 1 - res.winProbability;
        res.rawComposite = 1 - res.rawComposite;
        res.isUpset = true; res.upsetFlipped = true;
      }
      allPicks.push(res);
      r64Winners.push(teams[res.pick]);
    }

    // Determine if we need to force a specific team through this region
    const forcedF4 = strategy.f4Override[region] ? teams[strategy.f4Override[region]] : null;

    // Helper: check if a team has a path override for this round
    function checkPathOverride(round, t1, t2) {
      const overrides = strategy.pathOverrides || [];
      for (const po of overrides) {
        if (po.round !== round) continue;
        if (t1.name === po.winner || t2.name === po.winner) {
          return po;
        }
      }
      return null;
    }

    // R32
    const r32Winners = [];
    for (let i = 0; i < r64Winners.length; i += 2) {
      const t1 = r64Winners[i], t2 = r64Winners[i+1];
      if (!t1 || !t2) continue;
      const res = analyzeMatchup(t1, t2, 'R32', region, strategy);
      res.round = 'R32'; res.region = region;

      // Path override (Cinderella boost)
      const po = checkPathOverride('R32', t1, t2);
      if (po) {
        res.pick = po.winner; res.pickSeed = teams[po.winner].seed;
        res.isUpset = res.pickSeed > Math.min(t1.seed, t2.seed);
        res.winProbability = Math.max(1 - res.winProbability, 0.45);
        res.cinderella = true; res.cinderellaNote = po.note;
      }
      // F4 override
      if (forcedF4 && (t1.name === forcedF4.name || t2.name === forcedF4.name)) {
        res.pick = forcedF4.name; res.pickSeed = forcedF4.seed;
        res.winProbability = Math.max(res.winProbability, 0.55);
        res.champOverride = true;
      }

      allPicks.push(res); r32Winners.push(teams[res.pick]);
    }

    // S16
    const s16Winners = [];
    for (let i = 0; i < r32Winners.length; i += 2) {
      const t1 = r32Winners[i], t2 = r32Winners[i+1];
      if (!t1 || !t2) continue;
      const res = analyzeMatchup(t1, t2, 'S16', region, strategy);
      res.round = 'S16'; res.region = region;

      const po = checkPathOverride('S16', t1, t2);
      if (po) {
        res.pick = po.winner; res.pickSeed = teams[po.winner].seed;
        res.isUpset = res.pickSeed > Math.min(t1.seed, t2.seed);
        res.winProbability = Math.max(1 - res.winProbability, 0.42);
        res.cinderella = true; res.cinderellaNote = po.note;
      }
      if (forcedF4 && (t1.name === forcedF4.name || t2.name === forcedF4.name)) {
        res.pick = forcedF4.name; res.pickSeed = forcedF4.seed;
        res.winProbability = Math.max(res.winProbability, 0.52);
        res.champOverride = true;
      }

      allPicks.push(res); s16Winners.push(teams[res.pick]);
    }

    // E8
    if (s16Winners.length >= 2) {
      const res = analyzeMatchup(s16Winners[0], s16Winners[1], 'E8', region, strategy);
      res.round = 'E8'; res.region = region;

      const po = checkPathOverride('E8', s16Winners[0], s16Winners[1]);
      if (po) {
        res.pick = po.winner; res.pickSeed = teams[po.winner].seed;
        res.isUpset = res.pickSeed > Math.min(s16Winners[0].seed, s16Winners[1].seed);
        res.cinderella = true; res.cinderellaNote = po.note;
      }
      if (forcedF4 && (s16Winners[0].name === forcedF4.name || s16Winners[1].name === forcedF4.name)) {
        res.pick = forcedF4.name; res.pickSeed = forcedF4.seed;
        res.winProbability = Math.max(res.winProbability, 0.51);
        res.champOverride = true;
      }

      allPicks.push(res);
      regionWinners[region] = teams[res.pick];
    }
  }

  // F4 — 2026 pairings: East vs South, West vs Midwest
  const f4m = [
    { t1: regionWinners['West'], t2: regionWinners['Midwest'], label: 'West vs Midwest' },
    { t1: regionWinners['East'], t2: regionWinners['South'], label: 'East vs South' }
  ];
  const f4Winners = [];
  for (const m of f4m) {
    if (!m.t1 || !m.t2) continue;
    const res = analyzeMatchup(m.t1, m.t2, 'F4', 'Final Four', strategy);
    res.round = 'F4'; res.region = m.label;

    // Champion override: nudge the path
    if (strategy.champOverride) {
      const forced = strategy.champOverride;
      if (m.t1.name === forced || m.t2.name === forced) {
        res.pick = forced;
        res.pickSeed = teams[forced].seed;
        res.winProbability = Math.max(res.winProbability, 0.51);
        res.champOverride = true;
      }
    }

    allPicks.push(res);
    f4Winners.push(teams[res.pick]);
  }

  // Championship
  if (f4Winners.length >= 2) {
    const res = analyzeMatchup(f4Winners[0], f4Winners[1], 'Championship', 'Championship', strategy);
    res.round = 'Championship'; res.region = 'Championship';
    if (strategy.champOverride) {
      const forced = strategy.champOverride;
      if (f4Winners[0].name === forced || f4Winners[1].name === forced) {
        res.pick = forced;
        res.pickSeed = teams[forced].seed;
        res.winProbability = Math.max(res.winProbability, 0.51);
        res.champOverride = true;
      }
    }
    allPicks.push(res);
  }

  return { allPicks, regionWinners };
}

// ─── Pattern Check ──────────────────────────────────────────────────────────
function patternCheck(allPicks) {
  const flags = [];
  const r64 = allPicks.filter(p => p.round === 'R64');
  const upsets = r64.filter(p => p.isUpset);

  const has12o5 = upsets.some(p => p.pickSeed === 12);
  const has13o4 = upsets.some(p => p.pickSeed === 13);
  if (!has12o5) flags.push('No 12-over-5 (85% of tournaments have one).');
  if (!has13o4) flags.push('No 13-over-4 (70% of tournaments have one).');

  const e8 = allPicks.filter(p => p.round === 'E8');
  const ones = e8.filter(p => p.pickSeed === 1).length;
  if (ones === 4) flags.push('All 4 one-seeds in F4 (5% historical rate).');

  const champ = allPicks.find(p => p.round === 'Championship');
  const topPub = Object.entries(publicPicks.championPickRate || {}).sort((a,b) => b[1]-a[1])[0];
  if (champ && topPub && topPub[0] === champ.pick) flags.push(`Champion (${champ.pick}) is the most popular pick — less pool edge.`);

  return { has12o5, has13o4, oneSeedsInF4: ones, totalUpsets: upsets.length, flags };
}

// ─── Rationale ──────────────────────────────────────────────────────────────
function rationale(p) {
  const parts = [];
  if (p.isUpset) parts.push('UPSET');
  if (p.upsetFlipped) parts.push('calibrated');
  if (p.cinderella) parts.push('CINDERELLA — ' + (p.cinderellaNote || ''));
  if (p.champOverride) parts.push('pool-value pick');
  const s = p.sources;
  if (s.efficiency > 0.65) parts.push('efficiency edge');
  else if (s.efficiency < 0.4) parts.push('eff favors opp');
  if (s.vegas > 0.7) parts.push('Vegas fav');
  else if (s.vegas < 0.35) parts.push('Vegas dog');
  if (s.consensus > 0.7) parts.push('expert consensus');
  if (p.contradiction > 0.15) parts.push('source disagreement');
  if (p.valueGap > 0.1) parts.push(`+${(p.valueGap*100).toFixed(0)}% value`);
  else if (p.valueGap < -0.1) parts.push(`${(p.valueGap*100).toFixed(0)}% overexposed`);
  return parts.join(', ') || 'composite';
}

// ─── Output Generators ──────────────────────────────────────────────────────
function buildJSON(allPicks, pc, rw, strategy) {
  const champ = allPicks.find(p => p.round === 'Championship');
  return {
    strategy: strategy.name, confidence: strategy.confidence, description: strategy.description,
    champion: champ ? champ.pick : '', championPoolValueScore: champ ? rd(champ.poolValueScore) : 0,
    championPublicPickRate: champ ? (publicPicks.championPickRate[champ.pick] || 0) : 0,
    finalFour: Object.values(rw).map(t => t.name),
    eliteEight: allPicks.filter(p => p.round === 'E8').map(p => p.pick),
    picks: allPicks.map(p => ({
      round: p.round, region: p.region, team1: p.team1, team2: p.team2,
      pick: p.pick, winProbability: rd(p.winProbability), publicPickRate: rd(p.publicPickRate),
      valueGap: rd(p.valueGap), poolValueScore: rd(p.poolValueScore),
      isUpset: p.isUpset, upsetFlipped: p.upsetFlipped || false,
      cinderella: p.cinderella || false, cinderellaNote: p.cinderellaNote || null,
      contradiction: rd(p.contradiction), sources: p.sources, sourcesUsed: p.sourcesUsed
    })),
    patternChecks: pc
  };
}

function buildReadable(allPicks, pc, rw, strategy) {
  let md = `# 2026 March Madness — ${strategy.name} Bracket\n\n`;
  md += `**Strategy:** ${strategy.description}\n`;
  md += `**Confidence:** ${strategy.confidence}\n`;
  md += `**Generated:** ${new Date().toISOString().split('T')[0]}\n`;
  md += `**Pool:** Medium-to-large (50-200 entries) | Scoring: 1-2-4-8-16-32\n\n`;

  const champ = allPicks.find(p => p.round === 'Championship');
  md += `## Champion: **${champ ? champ.pick : 'TBD'}**\n`;
  if (champ) {
    const cr = publicPicks.championPickRate[champ.pick] || 0;
    md += `Win Prob: ${(champ.winProbability*100).toFixed(0)}% | Public: ${(cr*100).toFixed(1)}% | Pool Value: ${champ.poolValueScore.toFixed(1)}\n\n`;
  }

  md += `## Final Four\n`;
  for (const [r, t] of Object.entries(rw)) md += `- **${r}:** ${t.name} (${t.seed})\n`;

  const r64u = allPicks.filter(p => p.round === 'R64' && p.isUpset);
  md += `\n## R64 Upsets: ${r64u.length}\n`;
  for (const u of r64u) {
    const loser = u.pick === u.team1.name ? u.team2.name : u.team1.name;
    md += `- **(${u.pickSeed}) ${u.pick}** over ${loser} — ${(u.winProbability*100).toFixed(0)}%${u.upsetFlipped ? ' [calibrated]' : ''}\n`;
  }

  md += '\n---\n\n';

  for (const region of ['East', 'West', 'South', 'Midwest']) {
    md += `## ${region.toUpperCase()} REGION\n\n`;
    for (const round of ['R64', 'R32', 'S16', 'E8']) {
      const picks = allPicks.filter(p => p.region === region && p.round === round);
      if (!picks.length) continue;
      const labels = { R64: 'Round of 64', R32: 'Round of 32', S16: 'Sweet 16', E8: 'Elite 8' };
      md += `### ${labels[round]}\n\n`;
      for (const p of picks) {
        const u = p.isUpset ? ' **UPSET**' : '';
        const fl = p.upsetFlipped ? ' (calibrated)' : '';
        md += `(${p.team1.seed}) ${p.team1.name} vs. (${p.team2.seed}) ${p.team2.name}\n`;
        md += `→ **${p.pick}**${u}${fl} | ${(p.winProbability*100).toFixed(0)}% | ${(p.publicPickRate*100).toFixed(0)}% pub | ${p.valueGap>=0?'+':''}${(p.valueGap*100).toFixed(0)}% gap | ${rationale(p)}\n\n`;
      }
    }
    md += '---\n\n';
  }

  md += '## FINAL FOUR\n\n';
  for (const p of allPicks.filter(p => p.round === 'F4')) {
    md += `(${p.team1.seed}) ${p.team1.name} vs. (${p.team2.seed}) ${p.team2.name}\n`;
    md += `→ **${p.pick}** | ${(p.winProbability*100).toFixed(0)}% | ${rationale(p)}\n\n`;
  }
  md += '## CHAMPIONSHIP\n\n';
  if (champ) {
    md += `(${champ.team1.seed}) ${champ.team1.name} vs. (${champ.team2.seed}) ${champ.team2.name}\n`;
    md += `→ **${champ.pick}** | ${(champ.winProbability*100).toFixed(0)}% | ${rationale(champ)}\n\n`;
  }

  md += '---\n\n## Pattern Flags\n\n';
  for (const f of pc.flags) md += `- ${f}\n`;
  md += `\n- 1-seeds in F4: ${pc.oneSeedsInF4} | R64 upsets: ${pc.totalUpsets}\n`;

  return md;
}

function buildEdges(allPicks) {
  let md = '# Edges Report — Top 15 Picks by Pool Value Score\n\n';
  md += `**Generated:** ${new Date().toISOString().split('T')[0]}\n\n`;

  const sorted = [...allPicks].sort((a,b) => b.poolValueScore - a.poolValueScore).slice(0, 15);
  md += '| # | Team (Seed) | Round | Win % | Public | Gap | PV | Action |\n';
  md += '|---|-------------|-------|-------|--------|-----|-----|--------|\n';
  sorted.forEach((p, i) => {
    const act = p.winProbability > 0.55 ? 'PICK' : p.winProbability > 0.40 ? 'CONSIDER' : 'SPECULATIVE';
    md += `| ${i+1} | ${p.pick} (${p.pickSeed}) | ${p.round} | ${(p.winProbability*100).toFixed(0)}% | ${(p.publicPickRate*100).toFixed(0)}% | ${p.valueGap>=0?'+':''}${(p.valueGap*100).toFixed(0)}% | ${p.poolValueScore.toFixed(1)} | ${act} |\n`;
  });

  md += '\n## Overexposed\n\n';
  const over = [...allPicks].filter(p => p.valueGap < -0.05 && p.round !== 'FirstFour').sort((a,b) => a.valueGap - b.valueGap).slice(0, 5);
  if (over.length) {
    md += '| Team | Round | Win % | Public | Gap |\n|------|-------|-------|--------|-----|\n';
    for (const p of over) md += `| ${p.pick} (${p.pickSeed}) | ${p.round} | ${(p.winProbability*100).toFixed(0)}% | ${(p.publicPickRate*100).toFixed(0)}% | ${(p.valueGap*100).toFixed(0)}% |\n`;
  }
  return md;
}

// ─── Main ───────────────────────────────────────────────────────────────────
function main() {
  console.log('March Madness 2026 — Generating 3 Brackets\n');

  const results = [];

  for (const [key, strategy] of Object.entries(STRATEGIES)) {
    console.log(`\n═══ ${strategy.name} ═══`);
    const teams = buildTeamDB(strategy);
    const { allPicks, regionWinners } = simulateBracket(teams, strategy);
    const pc = patternCheck(allPicks);

    const champ = allPicks.find(p => p.round === 'Championship');
    const upsets = allPicks.filter(p => p.round === 'R64' && p.isUpset);

    console.log(`Champion: ${champ ? champ.pick : '?'} | F4: ${Object.values(regionWinners).map(t=>t.name).join(', ')}`);
    console.log(`R64 upsets: ${upsets.length} | Flags: ${pc.flags.length}`);
    for (const u of upsets) {
      const loser = u.pick === u.team1.name ? u.team2.name : u.team1.name;
      console.log(`  (${u.pickSeed}) ${u.pick} over ${loser} — ${(u.winProbability*100).toFixed(0)}%${u.upsetFlipped ? ' [cal]' : ''}`);
    }

    results.push({ key, strategy, allPicks, regionWinners, pc, champ });
  }

  // Write outputs
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Combined bracket.json
  const combined = {};
  for (const r of results) {
    combined[r.key] = buildJSON(r.allPicks, r.pc, r.regionWinners, r.strategy);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'bracket.json'), JSON.stringify(combined, null, 2));

  // Per-bracket readable files
  let masterMD = '# 2026 March Madness — 3 Brackets Ranked by Confidence\n\n';
  masterMD += '| # | Bracket | Champion | Final Four | Upsets | Confidence |\n';
  masterMD += '|---|---------|----------|-----------|--------|------------|\n';
  for (const [i, r] of results.entries()) {
    const f4 = Object.values(r.regionWinners).map(t => `${t.name}(${t.seed})`).join(', ');
    const upsets = r.allPicks.filter(p => p.round === 'R64' && p.isUpset).length;
    const flag = i === 0 ? ' **← RECOMMENDED**' : '';
    masterMD += `| ${i+1} | ${r.strategy.name} | **${r.champ ? r.champ.pick : '?'}** | ${f4} | ${upsets} | ${r.strategy.confidence}${flag} |\n`;
  }
  masterMD += '\n---\n\n';

  for (const r of results) {
    const md = buildReadable(r.allPicks, r.pc, r.regionWinners, r.strategy);
    fs.writeFileSync(path.join(OUT_DIR, `bracket_${r.strategy.tag}.md`), md);
    masterMD += md + '\n\n---\n\n';
  }

  fs.writeFileSync(path.join(OUT_DIR, 'bracket_readable.md'), masterMD);

  // Edges report (from best guess)
  const bestGuess = results[0];
  const edgesMD = buildEdges(bestGuess.allPicks);
  fs.writeFileSync(path.join(OUT_DIR, 'edges_report.md'), edgesMD);

  // Terminal summary
  console.log('\n\n' + '═'.repeat(60));
  console.log('  3 BRACKETS GENERATED');
  console.log('═'.repeat(60));
  for (const [i, r] of results.entries()) {
    const flag = i === 0 ? ' ← RECOMMENDED' : '';
    console.log(`\n${i+1}. ${r.strategy.name}${flag}`);
    console.log(`   Champion: ${r.champ ? r.champ.pick : '?'}`);
    console.log(`   F4: ${Object.values(r.regionWinners).map(t=>t.name).join(', ')}`);
    console.log(`   Upsets: ${r.allPicks.filter(p => p.round === 'R64' && p.isUpset).length}`);
    console.log(`   ${r.strategy.confidence}`);
  }

  console.log('\nFiles written:');
  console.log('  output/bracket.json (all 3 brackets)');
  console.log('  output/bracket_readable.md (master file with all 3)');
  console.log('  output/bracket_best_guess.md');
  console.log('  output/bracket_chalk.md');
  console.log('  output/bracket_swing.md');
  console.log('  output/edges_report.md');
}

main();
