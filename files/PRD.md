# PRD: March Madness 2026 Bracket Prediction Engine

## Context
The 2026 NCAA Tournament bracket was revealed on Selection Sunday, March 15, 2026.
68 teams. 67 games. First Four already underway as of March 16.
First Four results: CBU beat UVU, Penn beat Yale, VCU beat Dayton, USF beat Wichita State.
First Round starts March 19.

---

## Pool Size and Scoring — Read First Before Building the Model

The bracket strategy must be calibrated to pool context. This changes which picks are optimal.

**Pool Size:**
- Small pool (under 15 entries): go chalk. Don't force upsets. Let others take risk.
- Medium pool (15–100 entries): balance chalk with 2–3 strategic upsets.
- Large pool (100+ entries): be contrarian. Avoid 1-seeds as champion. Find underselected
  teams whose advancement odds exceed their public pick rate.

**Default assumption:** Build for a medium-to-large pool (50–200 entries).
This means the champion pick should ideally NOT be the most popular public pick,
unless their odds are dramatically superior to all alternatives.

**Scoring format assumption (standard):** 1-2-4-8-16-32 points per round.
Champion pick is worth 32 points — same as picking all 32 first-round games correctly.
This means the model should weight later-round picks more heavily than early upsets.
A wrong champion pick that goes out in Round 1 costs 32 points.
A correct 12-over-5 upset earns 1 point.
Implication: do not sacrifice a strong champion pick chasing small-value early upsets.

---

## Step 1 — Scrape Public Pick Popularity (THE most important data source)

This is the single biggest edge in bracket pools and the most overlooked input.
A team's advancement odds mean nothing in isolation — you need to know how popular
that pick is relative to their actual odds. When popularity >> odds, avoid them.
When odds >> popularity, that is the value play.

Scrape public pick rates from:
- https://fantasy.espn.com/tournament-challenge-bracket/2026/en/ (ESPN bracket challenge — largest pool, shows % picking each team per round)
- https://www.ncaa.com/brackets (NCAA bracket challenge public pick data)
- https://www.cbssports.com/brackets (CBS bracket challenge pick rates)
- https://www.nytimes.com/spotlight/basketball-bracket (NYT bracket if available)
- Search: "2026 March Madness most popular bracket picks" for any aggregated public data

Per team, per round, extract:
- % of public brackets picking them to win that round
- % of public brackets picking them to reach Final Four
- % of public brackets picking them as champion

Store as: `data/public_picks.json`

The value gap formula (compute for every team):
  VALUE_GAP = advancement_odds% - public_pick_rate%
  Positive = underselected relative to odds (good value)
  Negative = overselected relative to odds (avoid or fade)

Flag any team where VALUE_GAP > +10% as a high-value pick.
Flag any team where VALUE_GAP < -10% as overexposed (avoid for champion).

---

## Step 2 — Scrape Prediction Markets

Prediction markets carry no house margin and are peer-to-peer. Treat them as the
closest thing to true probability available — more reliable than sportsbooks.

Fetch live champion, regional winner, and game-level odds from:
- https://kalshi.com (NCAA Tournament winner market + individual game markets)
- https://polymarket.com (champion + regional markets)
- https://defirate.com/prediction-markets/march-madness-odds/
- https://www.sportsbettingdime.com/news/college-basketball/march-madness-champion-odds-after-selection-sunday/

Per team, extract:
- Champion win probability (%)
- Final Four probability (%) if available
- Regional winner probability (%) if available

Flag any Kalshi vs. Polymarket spread greater than 5% on the same team.
This signals genuine disagreement between informed traders — investigate further.

Store as: `data/prediction_markets.json`

---

## Step 2 — Scrape Efficiency Analytics

Fetch efficiency data for all 68 tournament teams from:
- https://www.barttorvik.com
- https://www.teamrankings.com/ncaa-basketball/
- Any KenPom data referenced in published articles (kenpom.com requires login — pull referenced numbers from articles instead)

Per team, extract:
- AdjO (offensive efficiency per 100 possessions)
- AdjD (defensive efficiency per 100 possessions)
- AdjEM (efficiency margin = AdjO minus AdjD)
- Tempo (possessions per 40 minutes)
- Luck rating
- SOS (strength of schedule)

Store as: `data/efficiency_metrics.json`

---

## Step 3 — Scrape Expert Consensus

Fetch full bracket predictions from at least 6 of the following:
- https://www.cbssports.com/college-basketball/news/2026-ncaa-tournament-bracket-predictions-march-madness-expert-picks-upsets/
- https://www.foxsports.com/stories/college-basketball/ncaa-mens-tournament-bracket-picks-expert-predictions-analysis
- https://www.sportsbettingdime.com/news/college-basketball/expert-march-madness-brackets-picks-2026-ncaa-tournament/
- https://www.sportsbookreview.com/picks/ncaa-basketball/march-madness-bracket-reactions-2026/
- https://sports.yahoo.com (search for their East, West, Midwest, South region breakdown articles)
- https://www.si.com/college-basketball/march-madness-brackets-expert-predictions-2026-mens-ncaa-tournament
- Search for additional sources: query "2026 March Madness bracket predictions blog" and "2026 NCAA tournament picks podcast recap"

Per expert, extract:
- Their Final Four picks (all 4 teams)
- Their champion pick

Then aggregate across all experts:
- % of experts picking each team to reach the Final Four
- % of experts picking each team to win the championship

Store as: `data/expert_consensus.json`

---

## Step 4 — Scrape Vegas Lines

Fetch first-round point spreads and tournament futures from:
- https://www.vegasinsider.com/college-basketball/march-madness-odds-2026/
- https://www.actionnetwork.com
- Any publicly available odds aggregator

Convert spreads to implied win probabilities using:
  P(favorite wins) = 0.5 + (spread * 0.033)

Store as: `data/vegas_spreads.json`

---

## Step 5 — Scrape Injury and News Intel

Search ESPN NCAAB injury report and beat reporter articles for all 68 teams.
Query pattern: "[team name] injury 2026 NCAA tournament"
Also search: "[team name] lineup 2026 tournament"

Flag each player as: OUT / QUESTIONABLE / PROBABLE
Note which flagged players are starters or key contributors.

Store as: `data/injury_flags.json`

Apply in model: if a team's star player is flagged OUT, apply a -0.06 to -0.10 adjustment to their AdjEM before computing win probability.

---

## Step 6 — Historical Tournament Meta-Patterns

Scrape or derive historical NCAA tournament structural trends from:
- https://www.ncaa.com/news/basketball-men/article/march-madness-records-stats
- https://bleacherreport.com or similar for "March Madness upset trends history"
- Search: "how often does a 12 seed beat a 5 seed March Madness history"
- Search: "how many 1 seeds make the Final Four on average March Madness"

Build a `PATTERN_PRIORS` object with the following (look up actual historical rates, do not guess):

```json
{
  "at_least_one_12over5_rate": "X% of tournaments",
  "at_least_one_13over4_rate": "X% of tournaments",
  "at_least_one_11over6_rate": "X% of tournaments",
  "at_least_one_10over7_rate": "X% of tournaments",
  "num_1seeds_in_final_four_distribution": {
    "0": "X%",
    "1": "X%",
    "2": "X%",
    "3": "X%",
    "4": "X% (historically rare)"
  },
  "avg_total_upsets_r64": "X",
  "double_digit_seed_final_four_rate": "X%"
}
```

Store as: `data/pattern_priors.json`

---

## Step 7 — Scrape Recency and Momentum Data

Tournament performance often diverges from season-long efficiency ratings.
Teams that are peaking matter more than their full-season averages suggest.

For each of the top 32 seeds, search and extract:
- Last 10 games record (W-L)
- Conference tournament result (won/lost in semis/finals/first round)
- Any notable injuries or lineup changes in the past 3 weeks
- Margin of victory trend over last 5 games (improving or declining)

Sources:
- https://www.espn.com/mens-college-basketball/team/schedule (per team)
- https://www.sports-reference.com/cbb/ (game logs)
- Search: "[team name] conference tournament 2026 result"

Store as: `data/recency_form.json`

Apply in model: teams on a hot streak (7+ wins in last 10) get +0.03 AdjEM boost.
Teams that lost in conference tournament first round get -0.02 AdjEM penalty.

---

## The Model: Win Probability and Value Gap Calculation

### Part A — Per-Game Win Probability

Build `src/analyzeMatchup.js`:

```javascript
function analyzeMatchup(team1, team2, round) {

  // Step 1: Apply recency adjustments to efficiency ratings
  const t1AdjEM = team1.adjEM + team1.hotStreakBonus + team1.injuryPenalty;
  const t2AdjEM = team2.adjEM + team2.hotStreakBonus + team2.injuryPenalty;

  // Step 2: Compute win probability from each source independently
  const sources = {

    // Historical: what does seed matchup history say?
    historical: getHistoricalWinRate(team1.seed, team2.seed),

    // Efficiency: convert adjusted efficiency margin to win probability
    // Use logistic regression: P = 1 / (1 + e^(-0.15 * effDiff))
    // This is the academically validated formula, not a linear approximation
    efficiency: 1 / (1 + Math.exp(-0.15 * (t1AdjEM - t2AdjEM))),

    // Markets: use Kalshi/Polymarket per-game contract if available
    // If not, derive from relative champion odds:
    //   P(t1 wins this game) = t1.advancementOdds / (t1.advancementOdds + t2.advancementOdds)
    market: deriveGameOddsFromMarkets(team1, team2, predictionMarkets),

    // Vegas: convert moneyline to no-vig implied probability
    // Step 1: Convert American odds to raw probability
    //   If odds > 0: rawP = 100 / (odds + 100)
    //   If odds < 0: rawP = (-odds) / (-odds + 100)
    // Step 2: Remove vig by normalizing both sides to sum to 1
    vegas: moneylineToNoVigProbability(matchup.moneylineFavorite, matchup.moneylineUnderdog),

    // Expert consensus: % of experts picking team1 to advance this round
    consensus: team1.expertAdvanceRateThisRound /
      (team1.expertAdvanceRateThisRound + team2.expertAdvanceRateThisRound)
  };

  // Step 3: Weighted composite (weights reflect predictive accuracy literature)
  // Efficiency and markets are most predictive; historical and consensus are weaker
  const composite = weightedAverage(sources, {
    historical: 0.10,
    efficiency: 0.35,
    market:     0.30,
    vegas:      0.15,
    consensus:  0.10
  });

  // Step 4: Contradiction score = std deviation across sources
  // High std dev on a lower seed = genuine upset candidate, not just noise
  const contradiction = stdDev(Object.values(sources));

  // Step 5: Value gap = model probability vs. public pick rate
  // This is separate from win probability — it measures pool edge
  const publicPickRate = team1.publicPickRateThisRound;
  const valueGap = composite - publicPickRate;

  return {
    pick: composite >= 0.5 ? team1 : team2,
    winProbability: composite,
    confidence: Math.abs(composite - 0.5) * 2,
    isUpset: composite >= 0.5 && team1.seed > team2.seed,
    contradiction,
    valueGap,      // positive = underselected = pool edge
    sources        // full breakdown for transparency
  };
}
```

### Part B — Pool Value Score (runs on top of win probability)

For every team in every round, compute a POOL VALUE SCORE that combines
win probability with how unique the pick is in the pool:

```javascript
function poolValueScore(team, round, winProb, publicPickRate, scoringPoints) {
  // Expected value of picking this team in this round:
  //   EV = winProb * scoringPoints * (1 / publicPickRate)
  // The (1 / publicPickRate) factor rewards picks fewer people are making.
  // A team with 50% win odds picked by only 20% of the pool is 2.5x more valuable
  // than a team with 50% odds picked by 50% of the pool.
  const SCORING = { R64: 1, R32: 2, S16: 4, E8: 8, F4: 16, Championship: 32 };
  return winProb * SCORING[round] * (1 / publicPickRate);
}
```

Use POOL VALUE SCORE to make final champion and Final Four picks, not just win probability alone.

### Part C — Pattern Sanity Check

Build `src/patternCheck.js` — runs after all 67 picks are generated:

```javascript
function applyPatternConstraints(bracket, patternPriors) {

  const flags = [];

  // Check 1: Does bracket include at least one 12-over-5?
  // Historical rate is ~54% of tournaments have at least one.
  // If no 12-over-5 picked, find the one with highest VALUE_GAP and flag it.
  // Do NOT auto-flip — present it for consideration.

  // Check 2: Does bracket include at least one 13-over-4?
  // Historical rate is ~39% of tournaments have at least one.
  // Same logic — flag highest VALUE_GAP candidate.

  // Check 3: How many 1-seeds in Final Four?
  // Compare against patternPriors distribution (scraped in Step 6).
  // If 4 picked: flag as historically rare (happened once in 40 years).
  // If 0 picked: flag as historically unusual.
  // Most likely outcome: 2 or 3.

  // Check 4: Is the champion pick the most popular public pick?
  // If yes, flag it — in large pools this is usually a mistake.
  // Surface the next-best team by POOL VALUE SCORE as an alternative.

  // Check 5: Total R64 upsets vs. historical average.
  // If bracket has fewer than historical average upsets, surface
  // the top 3 highest-VALUE_GAP lower seeds as candidates to reconsider.

  return { bracket, flags };
  // NOTE: pattern check NEVER auto-flips picks. It flags for transparency only.
  // The model's data-driven picks are the output. Pattern check adds context.
}
```

---

## Output Spec

### `output/bracket.json`
```json
{
  "champion": "",
  "championPoolValueScore": 0.0,
  "championPublicPickRate": 0.0,
  "finalFour": ["", "", "", ""],
  "eliteEight": ["", "", "", "", "", "", "", ""],
  "picks": [
    {
      "round": "R64",
      "region": "East",
      "team1": { "name": "", "seed": 0 },
      "team2": { "name": "", "seed": 0 },
      "pick": "",
      "winProbability": 0.0,
      "publicPickRate": 0.0,
      "valueGap": 0.0,
      "poolValueScore": 0.0,
      "isUpset": false,
      "contradiction": 0.0,
      "sources": {
        "historical": 0.0,
        "efficiency": 0.0,
        "market": 0.0,
        "vegas": 0.0,
        "consensus": 0.0
      }
    }
  ],
  "patternChecks": {
    "has12over5": false,
    "has13over4": false,
    "oneSeedsInFinalFour": 0,
    "totalUpsetsR64": 0,
    "historicalAvgUpsetsR64": 0,
    "championIsTopPublicPick": false,
    "patternFlags": []
  }
}
```

### `output/bracket_readable.md`
Full bracket laid out region by region. For each game:
- Both teams with seeds
- **Winner in bold**
- Confidence percentage
- One-line rationale if it's an upset pick or a high-confidence chalk pick

Example format:
```
EAST REGION — Round of 64
(1) Duke vs. (16) Siena → **Duke** | 96% | Dominant efficiency margin, unanimous expert consensus
(8) UConn vs. (9) Missouri → **UConn** | 58% | Slight efficiency edge, mild market favorite
(5) St. John's vs. (12) Northern Iowa → **Northern Iowa** | 53% UPSET | High source contradiction, analytics favor UNI's defensive profile over St. John's pace
```

- Confidence % (win probability)
- Public pick rate %
- Value gap (+ or - and what it means)
- One-line rationale for every pick (not just upsets)

Example:
```
EAST REGION — Round of 64
(1) Duke vs. (16) Siena
→ **Duke** | 96% win prob | 94% public | +2% value gap | Dominant AdjEM, unanimous consensus
(5) St. John's vs. (12) Northern Iowa
→ **Northern Iowa** UPSET | 53% win prob | 22% public | +31% value gap | High source contradiction, strong pool value
```

### `output/edges_report.md`

Top 15 picks ranked by POOL VALUE SCORE (not just win probability).
For each:
- Team, seed, round
- Win probability
- Public pick rate
- Value gap
- Which sources are driving the divergence
- Recommended action: PICK / CONSIDER / AVOID

---

## Execution Order

1. Run Steps 1–7 (all scraping). Confirm all 8 JSON files exist with real data.
   If any scrape fails, log the failure and fall back to the next best source.
2. Run `src/analyzeMatchup.js` for all 67 games starting from Round of 64.
   Simulate forward — picks in early rounds determine who plays in later rounds.
3. Compute POOL VALUE SCORE for every team at every round.
4. Run `src/patternCheck.js` on full bracket output. Log all flags.
5. Generate `output/bracket.json`
6. Generate `output/bracket_readable.md`
7. Generate `output/edges_report.md`
8. Print terminal summary:
   - Champion pick + win probability + public pick rate + value gap
   - Final Four picks
   - Total upsets called in R64
   - Top 3 highest pool-value picks
   - All pattern check flags