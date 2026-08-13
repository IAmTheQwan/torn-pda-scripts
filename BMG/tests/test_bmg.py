from __future__ import annotations

import contextlib
import io
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR / "src"))

import bmg  # noqa: E402


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
        result = bmg.reconcile_event_matches(self.connection, confirm_exact=True)
        self.assertEqual(1, result["confirmed"])
        link = self.connection.execute("SELECT * FROM event_match_links").fetchone()
        self.assertEqual(1, link["confirmed"])

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


if __name__ == "__main__":
    unittest.main()
