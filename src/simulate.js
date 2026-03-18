#!/usr/bin/env node
/**
 * Monte Carlo Tournament Simulator
 * Runs 10,000 tournament simulations using composite win probabilities
 * to find the bracket that maximizes expected pool value.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_DIR = path.join(__dirname, '..', 'output');

// Load all data sources
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
const ROUND_NAMES = ['R64', 'R32', 'S16', 'E8', 'F4', 'Championship'];
const NUM_SIMS = 10000;

// ─── Build Team Database (same as model.js but with four factors) ─────────
function buildTeamDB() {
  const teams = {};

  for (const [region, data] of Object.entries(bracket.regions)) {
    for (const matchup of data.matchups) {
      if (matchup.team1 && !matchup.team1.startsWith('TBD'))
        teams[matchup.team1] = { name: matchup.team1, seed: matchup.seed1, region };
      if (matchup.team2 && !matchup.team2.startsWith('TBD'))
        teams[matchup.team2] = { name: matchup.team2, seed: matchup.seed2, region };
    }
  }

  // First Four teams
  const ff = { 'UMBC': {s:16,r:'Midwest'}, 'Howard': {s:16,r:'Midwest'}, 'Lehigh': {s:16,r:'South'},
    'Prairie View A&M': {s:16,r:'South'}, 'Texas': {s:11,r:'West'}, 'NC State': {s:11,r:'West'},
    'Miami OH': {s:11,r:'Midwest'}, 'SMU': {s:11,r:'Midwest'} };
  for (const [n, d] of Object.entries(ff)) {
    if (!teams[n]) teams[n] = { name: n, seed: d.s, region: d.r };
  }

  // Efficiency
  const effTeams = efficiencyMetrics.teams || {};
  for (const [name, data] of Object.entries(effTeams)) {
    if (teams[name]) {
      teams[name].adjEM = data.adjEM;
      teams[name].adjO = data.adjO;
      teams[name].adjD = data.adjD;
      teams[name].sos = data.sos;
    }
  }

  // Recency
  for (const [name, data] of Object.entries(recencyForm.teams || {})) {
    if (teams[name]) {
      teams[name].momentum = data.momentum;
      teams[name].recencyBoost = data.adjEMBoost || 0;
      teams[name].coachTourneyRecord = data.coachTourneyRecord || null;
    }
  }

  // Injuries (1.0x multiplier — bestGuess baseline)
  const penalties = injuryFlags.adjEMPenalties || {};
  for (const [name, penalty] of Object.entries(penalties)) {
    if (teams[name]) teams[name].injuryPenalty = penalty;
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

  // Public picks
  const champPick = publicPicks.championPickRate || {};
  const f4Pick = publicPicks.finalFourPickRate || {};
  const r64PerTeam = publicPicks.r64WinPickRate || {};
  for (const [name, rate] of Object.entries(champPick)) { if (teams[name]) teams[name].publicChampRate = rate; }
  for (const [name, rate] of Object.entries(f4Pick)) { if (teams[name]) teams[name].publicF4Rate = rate; }

  // Four Factors
  const ffTeams = fourFactors.teams || {};
  for (const [name, data] of Object.entries(ffTeams)) {
    if (teams[name]) {
      teams[name].fourFactors = data;
    }
  }

  // Defaults
  for (const t of Object.values(teams)) {
    t.adjEM = t.adjEM || 0;
    t.injuryPenalty = t.injuryPenalty || 0;
    t.recencyBoost = t.recencyBoost || 0;
    t.champProb = t.champProb || 0.001;
    t.f4Prob = t.f4Prob || 0.001;
    t.expertF4Rate = t.expertF4Rate || 0;
    t.publicChampRate = t.publicChampRate || 0.005;
    t.publicF4Rate = t.publicF4Rate || 0.01;
    t.publicR64Rate = r64PerTeam[t.name] || 0.50;
    t.fourFactors = t.fourFactors || {};
  }

  return teams;
}

// ─── Source Functions (same as model.js) ──────────────────────────────────
function getHistoricalWinRate(s1, s2) {
  if (s1 === s2) return 0.5;
  const key = `${Math.min(s1,s2)}v${Math.max(s1,s2)}`;
  const r = patternPriors.seed_matchup_win_rates;
  if (r[key] !== undefined) return s1 < s2 ? r[key] : (1 - r[key]);
  return Math.max(0.1, Math.min(0.9, 0.5 + (s2 - s1) * 0.015));
}

function getVegasProb(t1Name, t2Name, region) {
  const games = vegasSpreads.firstRound[region];
  if (!games) return null;
  for (const g of games) {
    const m1 = g.team1 === t1Name && g.team2 === t2Name;
    const m2 = g.team1 === t2Name && g.team2 === t1Name;
    if (!m1 && !m2) continue;
    if (g.spread === null) return null;
    const p = Math.min(0.99, 0.5 + Math.abs(g.spread) * 0.033);
    const t1p = g.spread < 0 ? p : (1 - p);
    return m1 ? t1p : (1 - t1p);
  }
  return null;
}

function getMarketProb(t1, t2) {
  const a = t1.f4Prob || t1.champProb * 4 || 0.01;
  const b = t2.f4Prob || t2.champProb * 4 || 0.01;
  const raw = a / (a + b);
  return 0.5 + (raw - 0.5) * 0.4; // bestGuess dampen
}

function getExpertProb(t1, t2) {
  const a = t1.expertF4Rate || 0.01, b = t2.expertF4Rate || 0.01;
  return a / (a + b);
}

// ─── Style Mismatch Modifier (Four Factors — real Sports-Reference data) ──
function getStyleMismatchModifier(t1, t2, round) {
  const ff1 = t1.fourFactors || {}, ff2 = t2.fourFactors || {};
  if (!ff1.tempo || !ff2.tempo) return 0;

  let modifier = 0;

  const paceDiff = Math.abs(ff1.tempo - ff2.tempo);
  if (paceDiff > 5) modifier += (ff1.tempo < ff2.tempo ? 1 : -1) * 0.01;

  const toDiff = (ff1.tovPct || 14) - (ff2.tovPct || 14);
  modifier -= toDiff * 0.003;

  const orbDiff = (ff1.orbPct || 32) - (ff2.orbPct || 32);
  modifier += orbDiff * 0.001;

  const defDiff = (ff2.defEFGPct || 0.49) - (ff1.defEFGPct || 0.49);
  modifier += defDiff * 0.5;

  return Math.max(-0.03, Math.min(0.03, modifier));
}

// ─── Win Probability (composite of all signals + style mismatch) ─────────
function getWinProbability(t1, t2, round, region) {
  const adj1 = t1.adjEM + (t1.recencyBoost || 0) + (t1.injuryPenalty || 0);
  const adj2 = t2.adjEM + (t2.recencyBoost || 0) + (t2.injuryPenalty || 0);

  const historical = getHistoricalWinRate(t1.seed, t2.seed);
  const efficiency = 1 / (1 + Math.exp(-0.12 * (adj1 - adj2)));
  const market = getMarketProb(t1, t2);
  let vegas = round === 'R64' ? getVegasProb(t1.name, t2.name, region) : null;
  if (vegas === null) vegas = market;
  const consensus = getExpertProb(t1, t2);

  const isR64 = round === 'R64';
  const hasRealVegas = vegas !== market;
  const weights = isR64
    ? (hasRealVegas
      ? { historical: 0.15, efficiency: 0.25, market: 0.08, vegas: 0.42, consensus: 0.10 }
      : { historical: 0.20, efficiency: 0.35, market: 0.20, vegas: 0.15, consensus: 0.10 })
    : { historical: 0.08, efficiency: 0.35, market: 0.30, vegas: 0.17, consensus: 0.10 };

  const sources = { historical, efficiency, market, vegas, consensus };
  let comp = 0, tw = 0;
  for (const [k, w] of Object.entries(weights)) {
    if (sources[k] != null) { comp += sources[k] * w; tw += w; }
  }
  comp = tw > 0 ? comp / tw : 0.5;

  // Apply style mismatch modifier
  const styleMod = getStyleMismatchModifier(t1, t2, round);
  comp += styleMod;

  comp = Math.max(0.02, Math.min(0.98, comp));
  return comp;
}

// ─── Tournament Structure ────────────────────────────────────────────────
function getFirstRoundMatchups(teams) {
  const ffWinners = { 'TBD_Midwest16': 'Howard', 'TBD_South16': 'Lehigh', 'TBD_West11': 'Texas', 'TBD_Midwest11': 'SMU' };
  const matchups = [];

  for (const region of ['East', 'West', 'South', 'Midwest']) {
    for (const m of bracket.regions[region].matchups) {
      const t1n = m.team1.startsWith('TBD') ? ffWinners[m.team1] : m.team1;
      const t2n = m.team2.startsWith('TBD') ? ffWinners[m.team2] : m.team2;
      const t1 = teams[t1n], t2 = teams[t2n];
      if (!t1 || !t2) continue;
      matchups.push({ t1, t2, region });
    }
  }
  return matchups;
}

// ─── Single Tournament Simulation ────────────────────────────────────────
function simulateOneTournament(teams, r64Matchups) {
  const results = {}; // team -> furthest round reached

  // Initialize all teams
  for (const t of Object.values(teams)) {
    results[t.name] = 'OUT';
  }

  // R64
  const r64Winners = [];
  for (const { t1, t2, region } of r64Matchups) {
    const prob = getWinProbability(t1, t2, 'R64', region);
    const winner = Math.random() < prob ? t1 : t2;
    results[winner.name] = 'R64';
    r64Winners.push({ winner, region });
  }

  // Group by region for subsequent rounds
  const regionTeams = { East: [], West: [], South: [], Midwest: [] };
  for (const { winner, region } of r64Winners) {
    regionTeams[region].push(winner);
  }

  const regionWinners = {};

  for (const region of ['East', 'West', 'South', 'Midwest']) {
    let currentRound = regionTeams[region];

    // R32
    const r32Winners = [];
    for (let i = 0; i < currentRound.length; i += 2) {
      if (i + 1 >= currentRound.length) { r32Winners.push(currentRound[i]); continue; }
      const prob = getWinProbability(currentRound[i], currentRound[i+1], 'R32', region);
      const winner = Math.random() < prob ? currentRound[i] : currentRound[i+1];
      results[winner.name] = 'R32';
      r32Winners.push(winner);
    }

    // S16
    const s16Winners = [];
    for (let i = 0; i < r32Winners.length; i += 2) {
      if (i + 1 >= r32Winners.length) { s16Winners.push(r32Winners[i]); continue; }
      const prob = getWinProbability(r32Winners[i], r32Winners[i+1], 'S16', region);
      const winner = Math.random() < prob ? r32Winners[i] : r32Winners[i+1];
      results[winner.name] = 'S16';
      s16Winners.push(winner);
    }

    // E8
    if (s16Winners.length >= 2) {
      const prob = getWinProbability(s16Winners[0], s16Winners[1], 'E8', region);
      const winner = Math.random() < prob ? s16Winners[0] : s16Winners[1];
      results[winner.name] = 'E8';
      regionWinners[region] = winner;
    }
  }

  // F4: East vs South, West vs Midwest
  const f4Matchups = [
    { t1: regionWinners['West'], t2: regionWinners['Midwest'] },
    { t1: regionWinners['East'], t2: regionWinners['South'] }
  ];
  const f4Winners = [];
  for (const m of f4Matchups) {
    if (!m.t1 || !m.t2) continue;
    const prob = getWinProbability(m.t1, m.t2, 'F4', 'Final Four');
    const winner = Math.random() < prob ? m.t1 : m.t2;
    results[winner.name] = 'F4';
    f4Winners.push(winner);
  }

  // Championship
  let champion = null;
  if (f4Winners.length >= 2) {
    const prob = getWinProbability(f4Winners[0], f4Winners[1], 'Championship', 'Championship');
    champion = Math.random() < prob ? f4Winners[0] : f4Winners[1];
    results[champion.name] = 'Championship';
  }

  return { results, champion: champion ? champion.name : null };
}

// ─── Monte Carlo Engine ──────────────────────────────────────────────────
function runMonteCarlo(numSims) {
  const teams = buildTeamDB();
  const r64Matchups = getFirstRoundMatchups(teams);

  // Track advancement counts
  const advancement = {}; // team -> { R64: count, R32: count, ..., Championship: count }
  const championCounts = {};

  for (const t of Object.values(teams)) {
    advancement[t.name] = { R64: 0, R32: 0, S16: 0, E8: 0, F4: 0, Championship: 0 };
    championCounts[t.name] = 0;
  }

  console.log(`Running ${numSims} tournament simulations...`);
  const startTime = Date.now();

  for (let i = 0; i < numSims; i++) {
    const { results, champion } = simulateOneTournament(teams, r64Matchups);

    for (const [teamName, roundReached] of Object.entries(results)) {
      if (roundReached === 'OUT') continue;
      const roundIdx = ROUND_NAMES.indexOf(roundReached);
      // If team reached round X, they also reached all prior rounds
      for (let r = 0; r <= roundIdx; r++) {
        advancement[teamName][ROUND_NAMES[r]]++;
      }
    }

    if (champion) championCounts[champion]++;

    if ((i + 1) % 2500 === 0) {
      console.log(`  ${i + 1}/${numSims} simulations complete...`);
    }
  }

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\nCompleted ${numSims} simulations in ${elapsed.toFixed(1)}s`);

  // Convert to probabilities
  const advancementProbs = {};
  for (const [name, counts] of Object.entries(advancement)) {
    advancementProbs[name] = {};
    for (const [round, count] of Object.entries(counts)) {
      advancementProbs[name][round] = count / numSims;
    }
  }

  return { teams, advancementProbs, championCounts, numSims };
}

// ─── Optimal Bracket Selection ───────────────────────────────────────────
function buildOptimalBracket(teams, advancementProbs) {
  const r64Matchups = getFirstRoundMatchups(teams);
  const ffWinners = { 'TBD_Midwest16': 'Howard', 'TBD_South16': 'Lehigh', 'TBD_West11': 'Texas', 'TBD_Midwest11': 'SMU' };

  // For each game slot, pick the team with highest expected points
  // Early rounds (R64, R32): use raw win probability (accuracy matters — you need
  // correct picks to stay competitive). Pool value weighting kicks in from S16+
  // where the points are worth 4-32x and differentiation matters most.
  function expectedPoints(teamName, round) {
    const prob = advancementProbs[teamName]?.[round] || 0;
    const points = SCORING[round] || 1;
    const t = teams[teamName];
    const roundIdx = ROUND_NAMES.indexOf(round);

    // Early rounds (R64, R32): pick the team most likely to win — accuracy matters
    // Pool value (1/pubRate) only applies from S16+ where differentiation pays off
    if (roundIdx <= 1) {
      return prob * points;
    }

    // Late rounds (S16+): pool value scoring
    let pubRate;
    if (round === 'Championship') pubRate = t.publicChampRate || 0.005;
    else if (round === 'F4') pubRate = t.publicF4Rate || 0.01;
    else {
      const r64r = t.publicR64Rate || 0.5;
      const f4r = t.publicF4Rate || 0.01;
      pubRate = r64r * (1 - roundIdx / 4) + f4r * (roundIdx / 4);
    }

    return prob * points * (1 / Math.max(pubRate, 0.02));
  }

  // Build bracket greedily by expected pool value at each slot
  const optimalPicks = [];

  for (const region of ['East', 'West', 'South', 'Midwest']) {
    const regionMatchups = r64Matchups.filter(m => m.region === region);

    // R64
    const r64Picks = [];
    for (const { t1, t2 } of regionMatchups) {
      const ev1 = expectedPoints(t1.name, 'R64');
      const ev2 = expectedPoints(t2.name, 'R64');
      const pick = ev1 >= ev2 ? t1 : t2;
      r64Picks.push(pick);
      optimalPicks.push({ round: 'R64', region, team1: t1.name, team2: t2.name, pick: pick.name,
        advProb: advancementProbs[pick.name]?.R64 || 0, ev: Math.max(ev1, ev2) });
    }

    // R32
    const r32Picks = [];
    for (let i = 0; i < r64Picks.length; i += 2) {
      const t1 = r64Picks[i], t2 = r64Picks[i+1];
      const ev1 = expectedPoints(t1.name, 'R32');
      const ev2 = expectedPoints(t2.name, 'R32');
      const pick = ev1 >= ev2 ? t1 : t2;
      r32Picks.push(pick);
      optimalPicks.push({ round: 'R32', region, team1: t1.name, team2: t2.name, pick: pick.name,
        advProb: advancementProbs[pick.name]?.R32 || 0, ev: Math.max(ev1, ev2) });
    }

    // S16
    const s16Picks = [];
    for (let i = 0; i < r32Picks.length; i += 2) {
      const t1 = r32Picks[i], t2 = r32Picks[i+1];
      const ev1 = expectedPoints(t1.name, 'S16');
      const ev2 = expectedPoints(t2.name, 'S16');
      const pick = ev1 >= ev2 ? t1 : t2;
      s16Picks.push(pick);
      optimalPicks.push({ round: 'S16', region, team1: t1.name, team2: t2.name, pick: pick.name,
        advProb: advancementProbs[pick.name]?.S16 || 0, ev: Math.max(ev1, ev2) });
    }

    // E8
    if (s16Picks.length >= 2) {
      const t1 = s16Picks[0], t2 = s16Picks[1];
      const ev1 = expectedPoints(t1.name, 'E8');
      const ev2 = expectedPoints(t2.name, 'E8');
      const pick = ev1 >= ev2 ? t1 : t2;
      optimalPicks.push({ round: 'E8', region, team1: t1.name, team2: t2.name, pick: pick.name,
        advProb: advancementProbs[pick.name]?.E8 || 0, ev: Math.max(ev1, ev2) });
    }
  }

  // F4 picks: highest EV teams from each side
  // Get E8 winners
  const e8Picks = optimalPicks.filter(p => p.round === 'E8');
  const e8ByRegion = {};
  for (const p of e8Picks) e8ByRegion[p.region] = teams[p.pick];

  // West vs Midwest
  if (e8ByRegion['West'] && e8ByRegion['Midwest']) {
    const t1 = e8ByRegion['West'], t2 = e8ByRegion['Midwest'];
    const ev1 = expectedPoints(t1.name, 'F4');
    const ev2 = expectedPoints(t2.name, 'F4');
    const pick = ev1 >= ev2 ? t1 : t2;
    optimalPicks.push({ round: 'F4', region: 'West vs Midwest', team1: t1.name, team2: t2.name,
      pick: pick.name, advProb: advancementProbs[pick.name]?.F4 || 0, ev: Math.max(ev1, ev2) });
  }

  // East vs South
  if (e8ByRegion['East'] && e8ByRegion['South']) {
    const t1 = e8ByRegion['East'], t2 = e8ByRegion['South'];
    const ev1 = expectedPoints(t1.name, 'F4');
    const ev2 = expectedPoints(t2.name, 'F4');
    const pick = ev1 >= ev2 ? t1 : t2;
    optimalPicks.push({ round: 'F4', region: 'East vs South', team1: t1.name, team2: t2.name,
      pick: pick.name, advProb: advancementProbs[pick.name]?.F4 || 0, ev: Math.max(ev1, ev2) });
  }

  // Championship
  const f4Picks = optimalPicks.filter(p => p.round === 'F4');
  if (f4Picks.length >= 2) {
    const t1 = teams[f4Picks[0].pick], t2 = teams[f4Picks[1].pick];
    const ev1 = expectedPoints(t1.name, 'Championship');
    const ev2 = expectedPoints(t2.name, 'Championship');
    const pick = ev1 >= ev2 ? t1 : t2;
    optimalPicks.push({ round: 'Championship', region: 'Championship', team1: t1.name, team2: t2.name,
      pick: pick.name, advProb: advancementProbs[pick.name]?.Championship || 0, ev: Math.max(ev1, ev2) });
  }

  return optimalPicks;
}

// ─── Report Generation ───────────────────────────────────────────────────
function generateReport(teams, advancementProbs, championCounts, numSims, optimalPicks) {
  let md = '# Monte Carlo Simulation Report\n\n';
  md += `**Simulations:** ${numSims.toLocaleString()}\n`;
  md += `**Generated:** ${new Date().toISOString().split('T')[0]}\n`;
  md += `**Signals:** 5 weighted sources + Four Factors style mismatch + coach experience\n\n`;

  // Championship probabilities
  md += '## Championship Probabilities (Model vs. Public)\n\n';
  md += '| # | Team (Seed) | MC Champ % | Public Champ % | Value Gap | F4 % | E8 % |\n';
  md += '|---|-------------|-----------|---------------|-----------|------|------|\n';

  const champEntries = Object.entries(championCounts)
    .map(([name, count]) => ({ name, prob: count / numSims, seed: teams[name]?.seed || 0 }))
    .filter(e => e.prob > 0.001)
    .sort((a, b) => b.prob - a.prob);

  for (const [i, entry] of champEntries.entries()) {
    const pubRate = (teams[entry.name]?.publicChampRate || 0) * 100;
    const modelRate = entry.prob * 100;
    const gap = modelRate - pubRate;
    const f4Pct = ((advancementProbs[entry.name]?.F4 || 0) * 100).toFixed(1);
    const e8Pct = ((advancementProbs[entry.name]?.E8 || 0) * 100).toFixed(1);
    md += `| ${i + 1} | ${entry.name} (${entry.seed}) | ${modelRate.toFixed(1)}% | ${pubRate.toFixed(1)}% | ${gap >= 0 ? '+' : ''}${gap.toFixed(1)}% | ${f4Pct}% | ${e8Pct}% |\n`;
  }

  // Top advancement probabilities by round
  md += '\n## Advancement Probabilities — Top Teams by Round\n\n';
  for (const round of ['E8', 'F4', 'Championship']) {
    md += `### ${round}\n\n`;
    md += '| Team (Seed) | Probability | Public Rate | Difference |\n';
    md += '|-------------|------------|-------------|------------|\n';

    const sorted = Object.entries(advancementProbs)
      .map(([name, probs]) => ({ name, prob: probs[round] || 0, seed: teams[name]?.seed || 0 }))
      .filter(e => e.prob > 0.01)
      .sort((a, b) => b.prob - a.prob)
      .slice(0, 16);

    for (const entry of sorted) {
      const t = teams[entry.name];
      let pubRate;
      if (round === 'Championship') pubRate = (t?.publicChampRate || 0);
      else if (round === 'F4') pubRate = (t?.publicF4Rate || 0);
      else pubRate = ((t?.publicR64Rate || 0.5) * 0.5 + (t?.publicF4Rate || 0.01) * 0.5);
      const diff = entry.prob - pubRate;
      md += `| ${entry.name} (${entry.seed}) | ${(entry.prob * 100).toFixed(1)}% | ${(pubRate * 100).toFixed(1)}% | ${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}% |\n`;
    }
    md += '\n';
  }

  // Optimal bracket
  md += '## MC-Optimal Bracket (Max Expected Pool Value)\n\n';

  const champPick = optimalPicks.find(p => p.round === 'Championship');
  const f4Picks = optimalPicks.filter(p => p.round === 'F4');
  const e8Picks = optimalPicks.filter(p => p.round === 'E8');

  md += `**Champion:** ${champPick ? champPick.pick : 'TBD'}\n`;
  md += `**Final Four:** ${f4Picks.map(p => p.pick).join(', ') || 'TBD'}\n`;
  md += `**Elite Eight:** ${e8Picks.map(p => p.pick).join(', ') || 'TBD'}\n\n`;

  // Per-region breakdown
  for (const region of ['East', 'West', 'South', 'Midwest']) {
    md += `### ${region}\n\n`;
    md += '| Round | Pick | Adv. Prob | Expected PV |\n';
    md += '|-------|------|-----------|-------------|\n';
    const regionPicks = optimalPicks.filter(p => p.region === region);
    for (const p of regionPicks) {
      md += `| ${p.round} | ${p.pick} (${teams[p.pick]?.seed}) | ${(p.advProb * 100).toFixed(1)}% | ${p.ev.toFixed(2)} |\n`;
    }
    md += '\n';
  }

  // R64 upsets in MC optimal
  md += '### R64 Upsets in MC-Optimal Bracket\n\n';
  const r64Picks = optimalPicks.filter(p => p.round === 'R64');
  const upsets = r64Picks.filter(p => {
    const pickSeed = teams[p.pick]?.seed || 0;
    const oppName = p.pick === p.team1 ? p.team2 : p.team1;
    const oppSeed = teams[oppName]?.seed || 0;
    return pickSeed > oppSeed;
  });

  if (upsets.length) {
    for (const u of upsets) {
      const oppName = u.pick === u.team1 ? u.team2 : u.team1;
      md += `- **${u.pick} (${teams[u.pick]?.seed})** over ${oppName} (${teams[oppName]?.seed}) — ${(u.advProb * 100).toFixed(0)}% model prob\n`;
    }
  } else {
    md += 'No upsets in MC-optimal bracket (all higher seeds favored by EV)\n';
  }

  // Comparison vs deterministic
  md += '\n## Key Insights\n\n';
  md += '### Correlated Paths\n';
  md += 'Monte Carlo simulation captures path correlations that deterministic brackets miss:\n';
  md += '- If a lower seed upsets early, it opens the path for other teams in later rounds\n';
  md += '- The simulation naturally accounts for bracket fragility\n\n';

  // Bracket fragility analysis
  md += '### Bracket Fragility\n\n';
  md += 'Teams whose championship probability depends on narrow paths:\n\n';
  for (const entry of champEntries.slice(0, 8)) {
    const f4Prob = advancementProbs[entry.name]?.F4 || 0;
    const champProb = entry.prob;
    const conditionalChamp = f4Prob > 0 ? champProb / f4Prob : 0;
    md += `- **${entry.name}**: ${(f4Prob * 100).toFixed(1)}% F4 × ${(conditionalChamp * 100).toFixed(0)}% conditional champ = ${(champProb * 100).toFixed(1)}% overall\n`;
  }

  return md;
}

// ─── Main ────────────────────────────────────────────────────────────────
function main() {
  console.log('Monte Carlo Tournament Simulator — March Madness 2026\n');

  const { teams, advancementProbs, championCounts, numSims } = runMonteCarlo(NUM_SIMS);
  const optimalPicks = buildOptimalBracket(teams, advancementProbs);

  const report = generateReport(teams, advancementProbs, championCounts, numSims, optimalPicks);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'simulation_report.md'), report);

  // Also write raw simulation data as JSON for model.js to consume
  const simData = {
    numSims,
    advancementProbs,
    championProbs: {},
    optimalPicks: optimalPicks.map(p => ({
      round: p.round, region: p.region, pick: p.pick,
      advProb: p.advProb, ev: p.ev
    }))
  };
  for (const [name, count] of Object.entries(championCounts)) {
    if (count > 0) simData.championProbs[name] = count / numSims;
  }
  fs.writeFileSync(path.join(OUT_DIR, 'simulation_data.json'), JSON.stringify(simData, null, 2));

  // Print summary
  console.log('\n' + '═'.repeat(60));
  console.log('  MONTE CARLO RESULTS');
  console.log('═'.repeat(60));

  const champSorted = Object.entries(championCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  console.log('\nTop 10 Championship Probabilities:');
  for (const [name, count] of champSorted) {
    const pct = ((count / numSims) * 100).toFixed(1);
    const pub = ((teams[name]?.publicChampRate || 0) * 100).toFixed(1);
    console.log(`  ${name} (${teams[name]?.seed}): ${pct}% model | ${pub}% public`);
  }

  const champPick = optimalPicks.find(p => p.round === 'Championship');
  const f4Picks = optimalPicks.filter(p => p.round === 'F4');
  console.log(`\nMC-Optimal Champion: ${champPick ? champPick.pick : 'TBD'}`);
  console.log(`MC-Optimal F4: ${f4Picks.map(p => p.pick).join(', ')}`);

  console.log('\nFiles written:');
  console.log('  output/simulation_report.md');
  console.log('  output/simulation_data.json');
}

main();
