# March Madness 2026 — Bracket Prediction Engine

## What This Project Does
Scrapes 9 independent data sources, triangulates them, and outputs actual bracket picks
for all 67 games of the 2026 NCAA Tournament. The goal is not just to predict games
accurately — it is to WIN A BRACKET POOL by finding picks where our model diverges
from public consensus.

## The Core Insight
Bracket pools are peer-to-peer contests. You are not competing against the tournament.
You are competing against other entries. A team can be genuinely likely to win AND be
a bad pick — because everyone else is also picking them, so you gain no edge.

The real question for every pick: does picking this team give me an advantage over
the rest of my pool, or am I just picking what everyone else is picking?

## Rules
- No hardcoded team opinions. All picks must be derived from scraped data.
- If the data says a great team deserves the Final Four, pick them.
- Upsets are only forced when data supports them — never for novelty.
- Public pick popularity is a required input, not optional. It is the core of the edge calculation.
- Every pick needs a traceable source citation.
- The model must account for pool size and scoring format (see PRD).

## Required Outputs
1. `data/` — all scraped JSON files (one per source)
2. `output/bracket.json` — all 67 picks with confidence, edge score, and source breakdown
3. `output/bracket_readable.md` — full region-by-region picks, human readable,
   one-line rationale on every pick (not just upsets)
4. `output/edges_report.md` — top 15 matchups ranked by value gap between
   advancement odds and public pick rate

## Reference
See PRD.md for the full scraping pipeline, model logic, and output spec.
