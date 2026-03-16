# Execution Plan — March Madness 2026 Bracket Prediction Engine

## Phase 0: Bracket Resolution
- Confirm full 68-team bracket with regions, seeds, and First Four results
- First Four results (per PRD): CBU beat UVU, Penn beat Yale, VCU beat Dayton, USF beat Wichita State
- Map all 64 remaining teams into their R64 matchups (32 games)
- Store as `data/bracket_2026.json`

## Phase 1: Data Scraping (7 sources, parallel where possible)

### Source 1 — Public Pick Popularity (`data/public_picks.json`)
- **Targets**: ESPN Tournament Challenge, NCAA.com, CBS Brackets, NYT, aggregated articles
- **Extract**: Per team per round: % picking to win that round, reach F4, win championship
- **Fallback**: If direct scrape blocked, search for articles summarizing public pick data
- **Critical**: This is THE core input for value gap calculation

### Source 2 — Prediction Markets (`data/prediction_markets.json`)
- **Targets**: Kalshi, Polymarket, SportsBettingDime
- **Extract**: Champion win %, F4 %, regional winner %
- **Fallback**: Sports betting articles that quote market odds

### Source 3 — Efficiency Analytics (`data/efficiency_metrics.json`)
- **Targets**: BartTorvik, TeamRankings, KenPom references in articles
- **Extract**: AdjO, AdjD, AdjEM, Tempo, Luck, SOS for all 68 teams
- **Fallback**: Any published efficiency rankings article

### Source 4 — Expert Consensus (`data/expert_consensus.json`)
- **Targets**: CBS, Fox Sports, SI, SportsBettingDime, Yahoo, SBR, blogs/podcasts
- **Extract**: Each expert's F4 + champion picks; aggregate to % rates
- **Fallback**: Search for bracket prediction roundup articles

### Source 5 — Vegas Lines (`data/vegas_spreads.json`)
- **Targets**: VegasInsider, ActionNetwork, odds aggregators
- **Extract**: First-round spreads, tournament futures
- **Convert**: Spread → implied win probability via P = 0.5 + (spread * 0.033)

### Source 6 — Injury Reports (`data/injury_flags.json`)
- **Targets**: ESPN injury reports, beat reporter articles
- **Extract**: Per team: player name, status (OUT/QUESTIONABLE/PROBABLE), is_starter
- **Model impact**: Star OUT → -0.06 to -0.10 AdjEM adjustment

### Source 7 — Recency/Momentum (`data/recency_form.json`)
- **Targets**: ESPN team schedules, Sports-Reference game logs
- **Extract**: Last 10 W-L, conference tourney result, MOV trend last 5
- **Model impact**: 7+ wins in L10 → +0.03 AdjEM; conf tourney R1 loss → -0.02 AdjEM

### Bonus: Historical Pattern Priors (`data/pattern_priors.json`)
- **Targets**: NCAA.com records, historical upset rate articles
- **Extract**: 12-over-5 rate, 13-over-4 rate, 1-seeds-in-F4 distribution, avg upsets R64
- Used in pattern sanity check, not in win probability model directly

## Phase 2: Model Build

### `src/analyzeMatchup.js`
- Inputs: two team objects with all scraped data
- Computes win probability from 5 independent sources:
  - Historical seed matchup (weight 0.10)
  - Efficiency-based logistic (weight 0.35)
  - Market-derived (weight 0.30)
  - Vegas-derived (weight 0.15)
  - Expert consensus (weight 0.10)
- Applies recency/injury adjustments to efficiency before computing
- Returns: pick, winProbability, confidence, isUpset, contradiction, valueGap, sources

### `src/poolValueScore.js`
- EV = winProb * scoringPoints * (1 / publicPickRate)
- Scoring: R64=1, R32=2, S16=4, E8=8, F4=16, Championship=32
- Used for champion/F4 selection (not just raw win probability)

### `src/patternCheck.js`
- Post-hoc sanity check on completed bracket
- 5 checks: 12-over-5, 13-over-4, 1-seeds-in-F4, champion popularity, total R64 upsets
- Flags only — never auto-flips picks

## Phase 3: Bracket Generation
- Simulate R64 → R32 → S16 → E8 → F4 → Championship (67 games total)
- Each round's winners feed into next round's matchups
- Final Four and Champion selected using poolValueScore, not just winProb

## Phase 4: Output Generation
- `output/bracket.json` — structured JSON per spec
- `output/bracket_readable.md` — region-by-region human-readable bracket
- `output/edges_report.md` — top 15 picks by pool value score

## Phase 5: Review Gate (STOP HERE)
- Generate `review_needed.md` listing:
  - Every failed scrape
  - Every data gap
  - Sources where <50% of teams had data
  - Picks where ≤2 sources contributed to composite score
- **DO NOT write final outputs until user reviews and approves**

## Execution Strategy
- Run scraping agents in parallel (all 7+ sources simultaneously)
- Log all failures — never block pipeline on a single failed scrape
- Build model after all scrapes complete (use whatever data we got)
- Generate review file and STOP
