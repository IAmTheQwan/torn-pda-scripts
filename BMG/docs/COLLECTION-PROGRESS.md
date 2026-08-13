# Historical collection progress

## Evidence-backed team-alias checkpoint — 2026-08-13

The first deterministic alias bridge is complete. It used one already-known
team, home/away role, a six-hour event/match window, and compatible competition
country/gender/youth scope. A one-event alias additionally required name
similarity of at least 0.68; lower-similarity renames required evidence from at
least two independent wagered events.

- Four guarded dependency waves accepted 320 Torn/provider aliases with 548
  durable event/match evidence rows.
- Confirmed Torn/match links and reconciled outcomes rose from 617 to 1,171.
- Linked historical football wagers rose from 731 to 1,370 of 3,371.
- Fully reconciled competition targets rose from 31 to 81; 82 targets have
  progressed.
- The final audit has zero remaining automatic aliases, zero conflicts, and 137
  two-name fuzzy or otherwise weaker cases left for explicit review.

This bridge made no API calls. Every accepted alias can be traced back to its
Torn event and provider match, and rerunning the apply command is idempotent.

## API-Football reviewed-label checkpoint — 2026-08-13

The second conservative tier resolved explicit same-competition renames and
structural labels such as World Cup groups, league playoffs, and championship
groups. The reviewed registry covers 58 Torn targets representing 610 wagers
and $21,052,225,293 of historical stake. Provider identity and season approval
are checked exactly before any collection begins.

- 59 unique league-season jobs were planned; 57 were new and two were already
  present from the exact tier.
- 13,487 additional provider matches and 942 standings rows imported with zero
  failed jobs, using 114 API requests.
- The canonical reference database now contains 44,908 matches and 3,025
  standings rows across 177 provider capture runs.
- Confirmed Torn/match links increased to 617, producing 617 auditable outcome
  records and linking 731 of 3,371 historical football wagers.
- The collection backlog now has 31 fully reconciled competition targets and
  32 progressed targets.

Partial coverage inside an imported competition is expected when Torn and the
provider spell a team differently. Those remaining events stay unconfirmed
until team-alias evidence is reviewed; the importer never promotes a fuzzy team
match just because the competition mapping is approved.

## API-Football exact-tier checkpoint — 2026-08-13

The Ultra integration is active and the first conservative structured backfill
is complete. A one-call provider catalog audit compared all 553 normalized BMG
competition families against 1,239 API-Football competitions. Country mismatch
guards prevent common league names from being auto-approved.

- 145 high-confidence audit candidates, 326 review candidates, 82 unmatched.
- The stricter first tier required exact normalized competition name, exact
  country, and every wagered API season to be available.
- 90 competitions and 116 unique league-seasons passed that gate.
- 30,400 provider fixtures/results, 1,499 provider teams, and 2,038 official
  standings rows are now in the canonical BMG database.
- 25,595 imported provider matches were finished; one unscored technical award
  is retained as `awarded`, never misrepresented as a scored result.
- Exact unique reconciliation increased confirmed Torn/match links from 26 to
  370 and linked historical wagers from 33 to 462.
- Two date-offset reconciliation candidates remain unconfirmed for review.

The ignored audit, provider catalog, captures, and resumable batch reports live
under `BMG/data/` and `BMG/exports/`. The committed client, contracts, tests,
and workflow documentation are the reproducible blueprint.

## Scope snapshot — 2026-08-13

The football archive currently contains 3,371 wagers across 2,843 distinct
wagered events. Normalizing Torn's season-specific league labels produced:

- 553 competition families;
- 615 wager-season labels needed for the outcome-first reconciliation pass;
- 1,659 league-seasons in the complete three-year build;
- $40,987,692,761 in historical football stake represented by the backlog.

Targets are ordered by historical stake, wager count, and event count. This is a
collection priority, not a recommendation that the highest-staked league was a
good league to bet.

## Measured pilots

| Work unit | Visible work | Captured | Active time |
| --- | --- | ---: | ---: |
| USL Championship 2026 league-season | Results, two `Show more matches` expansions, both conference standings, import, conservative reconciliation | 230 results, 25 standing rows | 204.2 s |
| One representative finished match | Summary, full overall statistics, direct H2H covering 2024–2026, import | 33 stat rows, 5 H2H rows | 98.8 s |

The league capture retained 92,115 bytes of raw JSON evidence. Private capture
archives remain under ignored `BMG/exports/`; the SQLite import also retains the
canonicalized raw JSON. Conservative exact-name/time reconciliation confirmed
five USL events covering six wagers. The other Torn labels use source-name
variants such as `Detroit City FC` versus `Detroit`; they remain unlinked until
the alias evidence is reviewed.

## First estimates

These are active-work estimates from one large league and one match. They are
directionally useful, not a promise:

| Scope | Estimate |
| --- | ---: |
| Outcome-first pass over 615 wager-season labels | 34.8 active hours |
| Full three-year pass over 1,659 league-seasons | 94.0 active hours |
| Stats and H2H for all 2,843 wagered football events | 78.0 additional active hours |

Source discovery, season ambiguity, missing coverage, team-name reconciliation,
and retries can increase these totals. Repeating the benchmark on several small,
large, cup, playoff, and international competitions will narrow the range. The
`collection-progress` command recalculates the estimates from completed runs.

At two active collection hours per day, the current outcome-first estimate is
about 18 working days; at four hours per day it is about nine. The browser work
remains a finite, foreground batch initiated by a direct user request—there is no
timer or automatic restart.

## Collection policy

1. Collect results and standings for wager-season labels in backlog priority.
2. Import immediately, create conservative match-link candidates, repair source
   aliases, review the links, and only then sync outcomes to Torn events.
3. Enrich stats and three-year H2H for confirmed wager-linked matches and for
   upcoming model-relevant matches. Do not spend 78 hours enriching every match
   before knowing that its fields will enter a tested model.
4. Extend the highest-value competitions to a full three seasons after the
   outcome bridge is working.
5. Keep all estimates separate: league-season collection is not the same unit as
   per-match detail collection.

## Tracking commands

```powershell
python .\BMG\src\bmg.py collection-plan football-history-v1 --name "Three-year football outcome expansion" --sport football --years 3
python .\BMG\src\bmg.py collection-progress football-history-v1
python .\BMG\src\bmg.py collection-map TARGET_ID SOURCE_URL --source-competition-id SOURCE_ID
python .\BMG\src\bmg.py collection-start football-history-v1 TARGET_ID SEASON --mode foreground
python .\BMG\src\bmg.py collection-checkpoint RUN_ID PHASE --items 0 --elapsed-seconds 0
python .\BMG\src\bmg.py collection-finish RUN_ID --status complete --target-status imported --active-seconds 0
```

The finish command also records pages, matches, standings, stats, H2H rows, raw
bytes, and notes. This makes interrupted work resumable and keeps future timing
claims tied to evidence.
