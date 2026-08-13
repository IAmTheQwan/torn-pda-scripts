from __future__ import annotations

import base64
import contextlib
import gzip
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR / "src"))

import bmg  # noqa: E402
import api_football  # noqa: E402


FIXTURE = PROJECT_DIR / "tests" / "fixtures" / "capture-history-v1.json"
FLASHSCORE_FIXTURE = PROJECT_DIR / "tests" / "fixtures" / "flashscore-league-v1.json"
MARKET_ODDS_FIXTURE = PROJECT_DIR / "tests" / "fixtures" / "market-odds-v1.json"


class BmgDatabaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temporary.name) / "test.sqlite"
        self.connection = bmg.open_database(self.db_path)
        bmg.initialize_database(self.connection)

    def tearDown(self) -> None:
        self.connection.close()
        self.temporary.cleanup()

    def count(self, table: str) -> int:
        return int(self.connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])

    def test_initial_bankroll_and_risk_limits(self) -> None:
        row = bmg.latest_bankroll(self.connection)
        self.assertIsNotNone(row)
        self.assertEqual(bmg.STARTING_BANKROLL, row["total"])
        self.assertEqual(
            {
                "reserve": 40_156_081,
                "deployable": 17_209_749,
                "single_option": 1_147_316,
                "single_event": 1_720_974,
                "open_exposure": 5_736_583,
                "daily_stop_loss": 1_720_974,
            },
            bmg.risk_limits(bmg.STARTING_BANKROLL),
        )

    def test_capture_import_is_relational_and_idempotent(self) -> None:
        first = bmg.import_file(self.connection, FIXTURE)
        self.assertEqual(2, first["captures"])
        self.assertEqual(4, first["events"])
        self.assertEqual(10, first["odds"])
        self.assertEqual(2, self.count("capture_runs"))
        self.assertEqual(2, self.count("events"))
        self.assertEqual(2, self.count("markets"))
        self.assertEqual(4, self.count("market_captures"))
        self.assertEqual(5, self.count("selections"))
        self.assertEqual(10, self.count("odds_observations"))
        self.assertEqual(1, self.count("bets"))

        bet = self.connection.execute("SELECT * FROM bets").fetchone()
        self.assertEqual("win", bet["status"])
        self.assertEqual(110_000, bet["profit"])
        self.assertEqual("2026-08-12T12:00:00Z", bet["first_observed_at"])
        self.assertEqual("2026-08-12T13:00:00Z", bet["last_observed_at"])

        second = bmg.import_file(self.connection, FIXTURE)
        self.assertEqual(0, second["captures"])
        self.assertEqual(2, self.count("capture_runs"))
        self.assertEqual(10, self.count("odds_observations"))

    def test_two_outcome_math_candidate_is_review_only(self) -> None:
        bmg.import_file(self.connection, FIXTURE)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            bmg.print_opportunities(self.connection)
        text = output.getvalue()
        self.assertIn("Alex Alpha v Ben Beta", text)
        self.assertIn("reciprocal sum", text)
        self.assertIn("Review only", text)
        self.assertNotIn("North City v South United", text)

    def test_opportunity_math_never_mixes_capture_times(self) -> None:
        bmg.import_file(self.connection, FIXTURE)
        self.connection.execute(
            """
            DELETE FROM odds_observations
            WHERE capture_id = '00000000-0000-4000-8000-000000000002'
              AND selection_id = (
                  SELECT s.selection_id
                  FROM selections s
                  JOIN markets m ON m.market_id = s.market_id
                  JOIN events e ON e.event_id = m.event_id
                  WHERE e.source_event_id = '9002' AND s.name = 'Ben Beta'
              )
            """
        )
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            bmg.print_opportunities(self.connection)
        self.assertNotIn("Alex Alpha v Ben Beta", output.getvalue())

    def test_opportunity_math_requires_complementary_exhaustive_selections(self) -> None:
        def rows(market_type: str, names: list[str]) -> list[dict[str, object]]:
            return [
                {
                    "market_type": market_type,
                    "captured_as_complete": 1,
                    "selection_name": name,
                }
                for name in names
            ]

        self.assertFalse(bmg.opportunity_market_is_exhaustive(
            rows("win_to_nil", ["Home", "Away"])
        ))
        self.assertFalse(bmg.opportunity_market_is_exhaustive(
            rows("double_chance", ["Home or Draw", "Away or Draw", "Home or Away"])
        ))
        self.assertTrue(bmg.opportunity_market_is_exhaustive(
            rows("three_way", ["Home", "Draw", "Away"])
        ))
        self.assertTrue(bmg.opportunity_market_is_exhaustive(
            rows("both_teams_to_score", ["Yes", "No"])
        ))
        self.assertTrue(bmg.opportunity_market_is_exhaustive(
            rows("total", ["Over 2.5 Total Goals", "Under 2.5 Total Goals"])
        ))

    def test_database_rejects_a_single_bet_over_one_billion(self) -> None:
        with self.assertRaises(sqlite3.IntegrityError):
            self.connection.execute(
                """
                INSERT INTO bets (
                    external_bet_id, status, stake, first_observed_at, last_observed_at
                ) VALUES ('too-large', 'pending', 1000000001, '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z')
                """
            )

    def test_repeated_handicap_labels_keep_both_market_orientations(self) -> None:
        def handicap_market(home_line: float, away_line: float) -> dict:
            return {
                "market_key": "asian handicap 1 5 full event|full event",
                "name": "Asian Handicap 1.5 Full event",
                "market_type": "asian_handicap",
                "period": "Full event",
                "captured_as_complete": True,
                "selections": [
                    {
                        "selection_key": f"home|h:{home_line}|l:",
                        "name": "Home",
                        "raw_name": f"Home ({home_line:+g})",
                        "handicap": home_line,
                        "line": None,
                        "odds_decimal": 1.9,
                        "suspended": False,
                        "available": True,
                    },
                    {
                        "selection_key": f"away|h:{away_line}|l:",
                        "name": "Away",
                        "raw_name": f"Away ({away_line:+g})",
                        "handicap": away_line,
                        "line": None,
                        "odds_decimal": 1.9,
                        "suspended": False,
                        "available": True,
                    },
                ],
            }

        capture = {
            "schema_version": "bmg.capture.v1",
            "capture_id": "duplicate-handicap-labels",
            "observed_at": "2026-08-13T04:45:00Z",
            "source": "test",
            "events": [
                {
                    "source_event_id": "duplicate-market-test",
                    "sport": "american football",
                    "title": "Home v Away - Test League",
                    "markets": [handicap_market(-1.5, 1.5), handicap_market(1.5, -1.5)],
                }
            ],
            "bets": [],
        }
        result = bmg.import_capture(self.connection, capture)
        self.assertEqual(2, result["markets"])
        self.assertEqual(2, self.count("markets"))
        self.assertEqual(4, self.count("selections"))
        self.assertEqual(4, self.count("odds_observations"))

    def test_expanded_history_detail_is_raw_and_relational(self) -> None:
        detail = {
            "schema_version": "bmg.history-event-detail.v1",
            "source_event_id": "historic-9001",
            "captured_at": "2026-08-13T05:30:00Z",
            "sport": "Football",
            "title": "Old Home v Old Away - Archive League",
            "league": "Archive League",
            "home_team": "Old Home",
            "away_team": "Old Away",
            "settled_at": "2025-01-02T03:04:05Z",
            "finished_text": "Finished at 03:04:05 - 02/01/2025",
            "additional_expansion_passes": 1,
            "additional_controls_remaining": 0,
            "markets": [
                {
                    "name": "Over/Under 2.5 Total Goals Ordinary time",
                    "selections": [
                        {
                            "name": "Over 2.5 Total Goals",
                            "raw_result_text": "Over 2.5 Total Goals+$5m",
                            "odds_decimal": 1.91,
                            "available": True,
                            "suspended": False,
                        },
                        {
                            "name": "Under 2.5 Total Goals",
                            "raw_result_text": "Under 2.5 Total Goals",
                            "odds_decimal": 1.88,
                            "available": True,
                            "suspended": False,
                        },
                    ],
                }
            ],
        }
        first = bmg.import_history_detail(self.connection, detail)
        second = bmg.import_history_detail(self.connection, detail)
        self.assertEqual(1, first["details"])
        self.assertEqual(0, second["details"])
        self.assertEqual(1, self.count("history_event_details"))
        self.assertEqual(1, self.count("events"))
        self.assertEqual(1, self.count("markets"))
        self.assertEqual(2, self.count("selections"))
        self.assertEqual(2, self.count("odds_observations"))
        event = self.connection.execute("SELECT * FROM events").fetchone()
        self.assertEqual("2025-01-02T03:04:05Z", event["settled_at"])
        market = self.connection.execute("SELECT * FROM markets").fetchone()
        self.assertEqual("total", market["market_type"])
        self.assertEqual("Ordinary Time", market["period"])

    def test_flashscore_league_import_is_relational_and_idempotent(self) -> None:
        first = bmg.import_flashscore_file(self.connection, FLASHSCORE_FIXTURE)
        self.assertEqual(1, first["captures"])
        self.assertEqual(1, first["matches"])
        self.assertEqual(2, first["standings"])
        self.assertEqual(2, first["stats"])
        self.assertEqual(2, first["h2h_matches"])
        self.assertEqual(1, self.count("reference_capture_runs"))
        self.assertEqual(2, self.count("sports_competitions"))
        self.assertEqual(1, self.count("competition_seasons"))
        self.assertEqual(2, self.count("sports_teams"))
        self.assertEqual(2, self.count("sports_matches"))
        self.assertEqual(2, self.count("standing_rows"))
        self.assertEqual(2, self.count("match_stats"))
        self.assertEqual(2, self.count("h2h_snapshot_matches"))

        league_match = self.connection.execute(
            """
            SELECT sm.*
            FROM sports_matches sm
            JOIN match_sources ms ON ms.match_id = sm.match_id
            WHERE ms.source_match_id = 'fixture-match-1'
            """
        ).fetchone()
        self.assertEqual("2026-05-24", league_match["scheduled_date"])
        self.assertEqual("2026-05-24T15:00:00Z", league_match["scheduled_at"])
        self.assertEqual("finished", league_match["status"])

        passes = self.connection.execute(
            "SELECT * FROM match_stats WHERE stat_name = 'Passes'"
        ).fetchone()
        self.assertEqual(86.0, passes["home_value"])
        self.assertEqual(430.0, passes["home_numerator"])
        self.assertEqual(500.0, passes["home_denominator"])

        second = bmg.import_flashscore_file(self.connection, FLASHSCORE_FIXTURE)
        self.assertEqual(0, second["captures"])
        self.assertEqual(1, self.count("reference_capture_runs"))
        self.assertEqual(2, self.count("sports_matches"))

    def test_flashscore_import_accepts_compressed_base64_archive(self) -> None:
        archive = Path(self.temporary.name) / "capture.json.gz.b64"
        archive.write_text(
            base64.b64encode(gzip.compress(FLASHSCORE_FIXTURE.read_bytes())).decode("ascii"),
            encoding="ascii",
        )

        result = bmg.import_flashscore_file(self.connection, archive)

        self.assertEqual(1, result["captures"])
        self.assertEqual(1, result["matches"])

    def test_api_football_capture_uses_exact_utc_schedule_and_shared_reference_tables(self) -> None:
        league = {
            "league": {"id": 999, "name": "Test Premier League", "type": "League"},
            "country": {"name": "Testland"},
            "seasons": [{
                "year": 2025,
                "start": "2025-08-01",
                "end": "2026-05-20",
                "current": False,
                "coverage": {"standings": True, "odds": True},
            }],
        }
        fixtures = [{
            "fixture": {
                "id": 12345,
                "date": "2026-05-20T19:45:00+00:00",
                "status": {"short": "FT", "long": "Match Finished"},
            },
            "league": {"id": 999, "round": "Regular Season - 38"},
            "teams": {
                "home": {"id": 11, "name": "North FC"},
                "away": {"id": 12, "name": "South United"},
            },
            "goals": {"home": 2, "away": 1},
        }]
        standings = [{"league": {"standings": [[
            {
                "rank": 1,
                "team": {"id": 11, "name": "North FC"},
                "points": 82,
                "goalsDiff": 40,
                "group": "Test Premier League",
                "form": "WWDWL",
                "description": "Champion",
                "all": {"played": 38, "win": 25, "draw": 7, "lose": 6,
                        "goals": {"for": 70, "against": 30}},
            },
            {
                "rank": 2,
                "team": {"id": 12, "name": "South United"},
                "points": 78,
                "goalsDiff": 35,
                "group": "Test Premier League",
                "form": "WLWWW",
                "description": "",
                "all": {"played": 38, "win": 24, "draw": 6, "lose": 8,
                        "goals": {"for": 65, "against": 30}},
            },
        ]]}}]

        capture = api_football.transform_season_capture(league, 2025, fixtures, standings)
        result = bmg.import_flashscore_capture(self.connection, capture)

        self.assertEqual("bmg.sports-league.v1", capture["schema_version"])
        self.assertEqual(1, result["matches"])
        self.assertEqual(2, result["standings"])
        match = self.connection.execute(
            "SELECT sm.* FROM sports_matches sm JOIN match_sources ms ON ms.match_id = sm.match_id "
            "WHERE ms.source = 'api-football' AND ms.source_match_id = '12345'"
        ).fetchone()
        self.assertEqual("2026-05-20T19:45:00Z", match["scheduled_at"])
        self.assertEqual("2026-05-20", match["scheduled_date"])
        self.assertEqual("finished", match["status"])

    def test_api_football_coverage_score_prefers_country_and_required_season(self) -> None:
        exact = {
            "league": {"id": 1, "name": "Premier League"},
            "country": {"name": "Tanzania"},
            "seasons": [{"year": 2025}],
        }
        wrong_country = {
            "league": {"id": 2, "name": "Premier League"},
            "country": {"name": "England"},
            "seasons": [{"year": 2025}],
        }
        exact_score = api_football.candidate_score(
            "Premier League", "Tanzania 1", {2025}, exact, strict_country=True
        )
        wrong_score = api_football.candidate_score(
            "Premier League", "Tanzania 1", {2025}, wrong_country, strict_country=True
        )
        self.assertGreater(exact_score["score"], wrong_score["score"])
        self.assertLess(wrong_score["score"], 0.64)
        self.assertEqual(1.0, exact_score["season_score"])

    def test_api_football_exact_backfill_only_accepts_exact_complete_mappings(self) -> None:
        audit = {
            "targets": [
                {
                    "target_id": "safe",
                    "classification": "automatic",
                    "required_seasons": [2025, 2026],
                    "wager_count": 3,
                    "staked": 100,
                    "candidates": [{
                        "league_id": 50,
                        "name": "Safe League",
                        "country": "Safe Country",
                        "name_score": 1.0,
                        "country_score": 1.0,
                        "available_seasons": [2024, 2025, 2026],
                    }],
                },
                {
                    "target_id": "renamed-review",
                    "classification": "automatic",
                    "required_seasons": [2026],
                    "wager_count": 5,
                    "staked": 200,
                    "candidates": [{
                        "league_id": 60,
                        "name": "Different League",
                        "country": "Safe Country",
                        "name_score": 0.9,
                        "country_score": 1.0,
                        "available_seasons": [2026],
                    }],
                },
                {
                    "target_id": "missing-season",
                    "classification": "automatic",
                    "required_seasons": [2026],
                    "wager_count": 7,
                    "staked": 300,
                    "candidates": [{
                        "league_id": 70,
                        "name": "Missing League",
                        "country": "Safe Country",
                        "name_score": 1.0,
                        "country_score": 1.0,
                        "available_seasons": [2025],
                    }],
                },
            ]
        }

        jobs = api_football.exact_backfill_jobs(audit)

        self.assertEqual([(50, 2025), (50, 2026)], [
            (job["league_id"], job["season"]) for job in jobs
        ])

    def test_api_football_reviewed_backfill_is_explicit_and_fails_closed_on_drift(self) -> None:
        audit = {
            "targets": [{
                "target_id": "renamed",
                "competition_family": "Old League Name",
                "jurisdiction": "Testland 1",
                "required_seasons": [2025, 2026],
                "wager_count": 4,
                "staked": 500,
            }]
        }
        catalog = {
            "leagues": [{
                "league": {"id": 80, "name": "New League Name"},
                "country": {"name": "Testland"},
                "seasons": [{"year": 2025}, {"year": 2026}],
            }]
        }
        registry = {
            "schema_version": "bmg.api-football-reviewed-mappings.v1",
            "mappings": [{
                "target_id": "renamed",
                "competition_family": "Old League Name",
                "jurisdiction": "Testland 1",
                "league_id": 80,
                "provider_name": "New League Name",
                "provider_country": "Testland",
                "seasons": [2025, 2026],
                "reason": "Documented competition rename.",
            }],
        }

        jobs = api_football.reviewed_backfill_jobs(audit, catalog, registry)

        self.assertEqual([(80, 2025), (80, 2026)], [
            (job["league_id"], job["season"]) for job in jobs
        ])
        self.assertEqual(500, jobs[0]["staked"])
        drifted = json.loads(json.dumps(registry))
        drifted["mappings"][0]["provider_name"] = "Unexpected Name"
        with self.assertRaises(api_football.ApiFootballError):
            api_football.reviewed_backfill_jobs(audit, catalog, drifted)

    def test_api_football_reviewed_backfill_requires_exact_season_approval(self) -> None:
        audit = {
            "targets": [{
                "target_id": "season-drift",
                "competition_family": "League",
                "jurisdiction": "Testland 1",
                "required_seasons": [2026],
            }]
        }
        catalog = {
            "leagues": [{
                "league": {"id": 90, "name": "League"},
                "country": {"name": "Testland"},
                "seasons": [{"year": 2025}, {"year": 2026}],
            }]
        }
        registry = {
            "schema_version": "bmg.api-football-reviewed-mappings.v1",
            "mappings": [{
                "target_id": "season-drift",
                "competition_family": "League",
                "jurisdiction": "Testland 1",
                "league_id": 90,
                "provider_name": "League",
                "provider_country": "Testland",
                "seasons": [2025],
                "reason": "Test mapping.",
            }],
        }

        with self.assertRaises(api_football.ApiFootballError):
            api_football.reviewed_backfill_jobs(audit, catalog, registry)

    def test_committed_api_football_review_registry_is_complete_and_unique(self) -> None:
        registry_path = PROJECT_DIR / "config" / "api-football-reviewed-mappings.json"
        registry = json.loads(registry_path.read_text(encoding="utf-8"))

        self.assertEqual("bmg.api-football-reviewed-mappings.v1", registry["schema_version"])
        mappings = registry["mappings"]
        target_ids = [item["target_id"] for item in mappings]
        self.assertEqual(len(target_ids), len(set(target_ids)))
        self.assertGreaterEqual(len(mappings), 180)
        for item in mappings:
            self.assertTrue(item["competition_family"])
            self.assertTrue(item["jurisdiction"])
            self.assertGreater(item["league_id"], 0)
            self.assertTrue(item["provider_name"])
            self.assertTrue(item["provider_country"])
            self.assertTrue(item["seasons"])
            self.assertTrue(item["reason"])

    def test_committed_event_match_review_registry_is_complete_and_unique(self) -> None:
        registry_path = PROJECT_DIR / "config" / "event-match-reviewed-decisions.json"
        registry = json.loads(registry_path.read_text(encoding="utf-8"))

        self.assertEqual("bmg.event-match-reviewed-decisions.v1", registry["schema_version"])
        decisions = registry["decisions"]
        event_ids = [item["event_id"] for item in decisions]
        self.assertEqual(len(event_ids), len(set(event_ids)))
        self.assertEqual(25, len(decisions))
        self.assertEqual(24, sum(item["decision"] == "confirmed" for item in decisions))
        self.assertEqual(1, sum(item["decision"] == "rejected" for item in decisions))
        for item in decisions:
            self.assertIn(item["decision"], {"confirmed", "rejected"})
            self.assertGreater(item["event_id"], 0)
            self.assertGreater(item["match_id"], 0)
            self.assertTrue(item["event"]["home_team"])
            self.assertTrue(item["event"]["away_team"])
            self.assertTrue(item["provider"]["source_match_id"])
            self.assertTrue(item["reason"])

    def test_api_football_duplicate_standings_group_names_get_unique_scopes(self) -> None:
        league = {
            "league": {"id": 888, "name": "Grouped League"},
            "country": {"name": "Testland"},
            "seasons": [{"year": 2026, "start": "2026-01-01", "end": "2026-12-31"}],
        }
        row = {
            "rank": 1,
            "team": {"id": 1, "name": "Test Team"},
            "group": "Conference",
            "all": {"played": 1, "win": 1, "draw": 0, "lose": 0,
                    "goals": {"for": 1, "against": 0}},
        }
        standings = [{"league": {"standings": [[row], [{**row, "team": {"id": 2, "name": "Other Team"}}]]}}]

        capture = api_football.transform_season_capture(league, 2026, [], standings)

        self.assertEqual(
            ["group:Conference", "group:Conference:2"],
            [snapshot["scope"] for snapshot in capture["standings"]],
        )

    def test_api_football_unscored_technical_results_are_not_finished(self) -> None:
        self.assertEqual("awarded", api_football.match_status("AWD"))
        self.assertEqual("walkover", api_football.match_status("WO"))
        self.assertEqual("finished", api_football.match_status("FT"))

    def test_api_football_odds_transform_keeps_bookmakers_and_shared_selections(self) -> None:
        payload = {
            "response": [{
                "fixture": {"id": 12345},
                "update": "2026-08-13T17:20:00Z",
                "bookmakers": [
                    {"id": 1, "name": "Book A", "bets": [{
                        "id": 1, "name": "Match Winner", "values": [
                            {"value": "Home", "odd": "2.10"},
                            {"value": "Draw", "odd": "3.40"},
                            {"value": "Away", "odd": "3.60"},
                        ],
                    }, {
                        "id": 10, "name": "Exact Score", "values": [
                            {"value": "1:0", "odd": "8.00"},
                            {"value": "1-0", "odd": "8.50"},
                        ],
                    }]},
                    {"id": 2, "name": "Book B", "bets": [{
                        "id": 1, "name": "Match Winner", "values": [
                            {"value": "Home", "odd": "2.20"},
                            {"value": "Draw", "odd": "3.30"},
                            {"value": "Away", "odd": "3.50"},
                        ],
                    }]},
                ],
            }],
        }

        capture = api_football.transform_odds_capture(
            payload, 12345, "2026-08-13T17:21:00Z"
        )

        self.assertEqual("bmg.market-odds.v1", capture["schema_version"])
        self.assertEqual(["Book A", "Book B"], capture["bookmakers"])
        market = capture["matches"][0]["markets"][0]
        self.assertEqual("moneyline", market["market_type"])
        self.assertEqual(6, len(market["selections"]))
        self.assertEqual(
            market["selections"][0]["source_selection_key"],
            market["selections"][3]["source_selection_key"],
        )
        self.assertEqual({"Book A", "Book B"}, {
            selection["bookmaker"] for selection in market["selections"]
        })
        exact_score = capture["matches"][0]["markets"][1]
        self.assertEqual(2, len({
            selection["source_selection_key"] for selection in exact_score["selections"]
        }))

    def test_team_alias_bridge_requires_one_known_side_and_keeps_evidence(self) -> None:
        bmg.import_file(self.connection, FIXTURE)
        reference = {
            "schema_version": "bmg.sports-league.v1",
            "capture_id": "alias-reference",
            "observed_at": "2026-08-13T20:00:00Z",
            "source": "api-football",
            "page_url": "https://example.test/league",
            "display_timezone": "UTC",
            "competition": {
                "sport": "football", "country": "Testland", "name": "Test League",
                "source_slug": "test-league", "source_url": "https://example.test/league",
            },
            "season": {
                "name": "2026", "source_season_id": "test:2026",
                "source_url": "https://example.test/league", "start_date": "2026-01-01",
                "end_date": "2026-12-31", "is_current": True,
            },
            "standings": [],
            "matches": [{
                "source_match_id": "alias-match",
                "source_url": "https://example.test/match",
                "scheduled_at": "2026-08-13T18:00:00Z",
                "status": "finished",
                "home_team": "North City", "home_team_id": "north",
                "away_team": "South United Athletic", "away_team_id": "south",
                "home_score": 2, "away_score": 0,
            }],
        }
        bmg.import_flashscore_capture(self.connection, reference)

        audit = bmg.build_team_alias_audit(self.connection)

        self.assertEqual(1, audit["summary"]["automatic_aliases"])
        alias = audit["automatic_aliases"][0]
        self.assertEqual("South United", alias["alias"])
        self.assertEqual("South United Athletic", alias["provider_team"])
        first = bmg.apply_team_alias_audit(self.connection, audit)
        self.assertEqual({"aliases": 1, "existing": 0, "evidence": 1}, first)
        self.assertEqual(1, self.count("team_alias_evidence"))
        second = bmg.apply_team_alias_audit(self.connection, audit)
        self.assertEqual({"aliases": 0, "existing": 1, "evidence": 0}, second)

        reconciled = bmg.reconcile_event_matches(self.connection, confirm_exact=True)
        self.assertEqual(1, reconciled["confirmed"])

    def test_team_alias_bridge_leaves_two_fuzzy_names_for_review(self) -> None:
        bmg.import_file(self.connection, FIXTURE)
        reference = {
            "schema_version": "bmg.sports-league.v1",
            "capture_id": "fuzzy-alias-reference",
            "observed_at": "2026-08-13T20:00:00Z",
            "source": "api-football",
            "page_url": "https://example.test/league",
            "display_timezone": "UTC",
            "competition": {
                "sport": "football", "country": "Testland", "name": "Test League",
                "source_slug": "test-league", "source_url": "https://example.test/league",
            },
            "season": {
                "name": "2026", "source_season_id": "fuzzy:2026",
                "source_url": "https://example.test/league", "start_date": "2026-01-01",
                "end_date": "2026-12-31", "is_current": True,
            },
            "standings": [],
            "matches": [{
                "source_match_id": "fuzzy-alias-match",
                "source_url": "https://example.test/match",
                "scheduled_at": "2026-08-13T18:00:00Z",
                "status": "finished",
                "home_team": "North City Football", "home_team_id": "north-fuzzy",
                "away_team": "South United Athletic", "away_team_id": "south-fuzzy",
                "home_score": 1, "away_score": 1,
            }],
        }
        bmg.import_flashscore_capture(self.connection, reference)

        audit = bmg.build_team_alias_audit(self.connection)

        self.assertEqual(0, audit["summary"]["automatic_aliases"])
        self.assertEqual(1, audit["summary"]["review_matches"])

        event = self.connection.execute(
            """SELECT event_id, home_team, away_team, league,
                      COALESCE(scheduled_at, settled_at, '') event_time
               FROM events WHERE source_event_id = '9001'"""
        ).fetchone()
        match = self.connection.execute(
            """SELECT sm.match_id, sm.home_team_id, ht.name home_team,
                      sm.away_team_id, at.name away_team, sc.name competition,
                      sc.country, sm.scheduled_at, ms.source, ms.source_match_id
               FROM sports_matches sm
               JOIN sports_teams ht ON ht.team_id=sm.home_team_id
               JOIN sports_teams at ON at.team_id=sm.away_team_id
               JOIN sports_competitions sc ON sc.competition_id=sm.competition_id
               JOIN match_sources ms ON ms.match_id=sm.match_id
               WHERE ms.source_match_id='fuzzy-alias-match'"""
        ).fetchone()
        registry = {
            "schema_version": "bmg.event-match-reviewed-decisions.v1",
            "decisions": [{
                "event_id": event["event_id"], "match_id": match["match_id"],
                "decision": "confirmed",
                "event": {key: event[key] for key in (
                    "home_team", "away_team", "league", "event_time"
                )},
                "provider": {key: match[key] for key in (
                    "source", "source_match_id", "home_team_id", "home_team",
                    "away_team_id", "away_team", "competition", "country", "scheduled_at"
                )},
                "reason": "Same roles, competition, and kickoff; reviewed fuzzy suffixes.",
            }],
        }
        first = bmg.apply_reviewed_event_match_decisions(self.connection, registry)
        self.assertEqual({"confirmed": 1, "existing": 0, "rejected": 0}, first)
        second = bmg.apply_reviewed_event_match_decisions(self.connection, registry)
        self.assertEqual({"confirmed": 0, "existing": 1, "rejected": 0}, second)
        registry["decisions"][0]["provider"]["away_team"] = "Drifted name"
        with self.assertRaises(ValueError):
            bmg.apply_reviewed_event_match_decisions(self.connection, registry)

    def test_team_alias_scope_guard_rejects_country_gender_and_youth_mismatches(self) -> None:
        countries = {"france", "england", "world"}
        self.assertTrue(bmg.competition_alias_compatible(
            "Ligue 1 2025/2026 (France 1)", "Ligue 1", "France", countries
        ))
        self.assertFalse(bmg.competition_alias_compatible(
            "Division 1 2025/2026 (France 1, female)", "Ligue 1", "France", countries
        ))
        self.assertFalse(bmg.competition_alias_compatible(
            "Premier League 2025/2026 (England 1)", "Ligue 1", "France", countries
        ))
        self.assertFalse(bmg.competition_alias_compatible(
            "World Cup U20 2025 (World Championship U20 1)", "World Cup - U17", "World", countries
        ))

    def test_modeling_schema_tracks_complete_slates_and_timestamped_external_odds(self) -> None:
        bmg.import_file(self.connection, FIXTURE)
        self.assertEqual(4, self.count("capture_events"))
        bmg.import_flashscore_file(self.connection, FLASHSCORE_FIXTURE)
        first = bmg.import_market_odds_file(self.connection, MARKET_ODDS_FIXTURE)
        self.assertEqual(2, first["captures"])
        self.assertEqual(4, first["markets"])
        self.assertEqual(10, first["selections"])
        self.assertEqual(10, first["odds"])
        self.assertEqual(2, self.count("match_markets"))
        self.assertEqual(5, self.count("match_market_selections"))
        self.assertEqual(10, self.count("match_odds_observations"))

        prices = self.connection.execute(
            """
            SELECT moo.observed_at, moo.odds_decimal
            FROM match_odds_observations moo
            JOIN match_market_selections mms ON mms.match_selection_id = moo.match_selection_id
            WHERE mms.source_selection_key = 'home'
            ORDER BY moo.observed_at
            """
        ).fetchall()
        self.assertEqual([(row["observed_at"], row["odds_decimal"]) for row in prices], [
            ("2026-05-24T13:00:00Z", 1.8),
            ("2026-05-24T14:55:00Z", 1.72),
        ])
        second = bmg.import_market_odds_file(self.connection, MARKET_ODDS_FIXTURE)
        self.assertEqual(0, second["captures"])
        self.assertEqual(10, self.count("match_odds_observations"))

    def test_exact_reconciliation_outcome_sync_and_research_slate_are_idempotent(self) -> None:
        bmg.import_flashscore_file(self.connection, FLASHSCORE_FIXTURE)
        capture = {
            "schema_version": "bmg.capture.v1",
            "capture_id": "torn-slate-fixture",
            "observed_at": "2026-05-24T12:00:00Z",
            "source": "torn-visible-bookie-dom",
            "events": [{
                "source_event_id": "torn-arsenal-chelsea",
                "sport": "football",
                "title": "Arsenal v Chelsea - Premier League 2025/2026",
                "league": "Premier League 2025/2026 (England 1)",
                "home_team": "Arsenal FC",
                "away_team": "Chelsea",
                "scheduled_at": "2026-05-24T15:00:00Z",
                "captured_as_complete": True,
                "markets": [],
            }],
            "bets": [],
        }
        bmg.import_capture(self.connection, capture)
        self.connection.execute(
            "UPDATE events SET scheduled_at = NULL, settled_at = '2026-05-25T01:30:00Z'"
        )
        self.connection.execute(
            """
            UPDATE sports_matches
            SET scheduled_at = '2026-05-24T23:30:00Z', scheduled_date = '2026-05-24'
            """
        )
        result = bmg.reconcile_event_matches(self.connection, confirm_exact=True)
        self.assertEqual(1, result["confirmed"])
        link = self.connection.execute("SELECT * FROM event_match_links").fetchone()
        self.assertEqual(1, link["confirmed"])
        self.assertEqual("exact-team-alias/time/competition", link["link_method"])

        first_sync = bmg.sync_confirmed_outcomes(self.connection)
        second_sync = bmg.sync_confirmed_outcomes(self.connection)
        self.assertEqual(1, first_sync["outcomes"])
        self.assertEqual(0, second_sync["outcomes"])
        outcome = self.connection.execute("SELECT * FROM event_outcomes").fetchone()
        self.assertEqual((2.0, 1.0, "home"), (outcome["home_score"], outcome["away_score"], outcome["winner"]))

        slate = bmg.create_research_slate(
            self.connection, "torn-slate-fixture", capture_complete=True, note="fixture slate"
        )
        self.assertEqual(1, slate["events"])
        slate_event = self.connection.execute("SELECT * FROM research_slate_events").fetchone()
        self.assertEqual("confirmed", slate_event["mapping_status"])

    def test_backtests_must_be_strictly_out_of_sample(self) -> None:
        self.connection.execute(
            """
            INSERT INTO model_versions (name, version, sport, algorithm, created_at)
            VALUES ('baseline', '0.1', 'football', 'elo-poisson', '2026-08-13T00:00:00Z')
            """
        )
        model_id = int(self.connection.execute("SELECT model_version_id FROM model_versions").fetchone()[0])
        with self.assertRaises(sqlite3.IntegrityError):
            self.connection.execute(
                """
                INSERT INTO backtest_runs (
                    backtest_run_id, model_version_id, created_at, training_end, test_start, test_end
                ) VALUES ('leaky', ?, '2026-08-13T00:00:00Z', '2026-06-01', '2026-05-01', '2026-07-01')
                """,
                (model_id,),
            )

    def test_collection_plan_tracks_priority_timing_and_eta(self) -> None:
        bmg.import_file(self.connection, FIXTURE)
        plan = bmg.build_collection_plan(
            self.connection,
            plan_id="history-v1",
            name="Historical football",
            sport="football",
            history_years=3,
        )
        self.assertGreaterEqual(plan["targets"], 1)
        target = self.connection.execute(
            "SELECT * FROM collection_targets ORDER BY priority_score DESC LIMIT 1"
        ).fetchone()
        bmg.map_collection_target(
            self.connection,
            target["target_id"],
            "https://www.flashscore.com/football/test/league/",
            "test-league",
        )
        run_id = bmg.start_collection_run(
            self.connection,
            plan_id="history-v1",
            target_id=target["target_id"],
            season_name="2025/2026",
            mode="benchmark",
        )
        bmg.add_collection_checkpoint(
            self.connection,
            run_id=run_id,
            phase="results-expanded",
            items_visible=10,
            elapsed_seconds=12.5,
        )
        bmg.finish_collection_run(
            self.connection,
            SimpleNamespace(
                run_id=run_id,
                finished_at="2026-08-13T13:00:00Z",
                active_seconds=30.0,
                status="complete",
                target_status="captured",
                pages=2,
                matches=10,
                standings=2,
                stats=0,
                h2h=0,
                bytes=1000,
                notes="fixture benchmark",
            ),
        )
        self.assertEqual(1, self.count("collection_runs"))
        self.assertEqual(1, self.count("collection_checkpoints"))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            bmg.print_collection_progress(self.connection, "history-v1")
        self.assertIn("projected remaining active time", output.getvalue())


if __name__ == "__main__":
    unittest.main()
