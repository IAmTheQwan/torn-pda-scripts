from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR / "src"))

import capture_inbox  # noqa: E402


def payload(capture_id: str = "capture-inbox-test-0001") -> dict:
    return {
        "schema_version": "bmg.export.v1",
        "captures": [{
            "schema_version": "bmg.capture.v1",
            "capture_id": capture_id,
            "observed_at": "2026-08-14T13:17:16.494Z",
            "source": "torn-visible-bookie-dom",
            "page_url": "https://www.torn.com/page.php?sid=bookie",
            "page_hash": "#/football/5147621",
            "events": [{
                "source_event_id": "5147621",
                "sport": "football",
                "title": "VPS v TPS - Veikkausliiga 2026 (Finland 1)",
                "league": "Veikkausliiga 2026 (Finland 1)",
                "home_team": "VPS",
                "away_team": "TPS",
                "scheduled_at": "2026-08-14T15:00:00Z",
                "markets": [{
                    "name": "3-Way Ordinary time",
                    "market_type": "three_way",
                    "period": "Ordinary time",
                    "captured_as_complete": True,
                    "selections": [{
                        "name": "VPS",
                        "raw_name": "VPS",
                        "odds_decimal": 1.66,
                        "suspended": False,
                        "available": True,
                    }],
                }],
                "captured_as_complete": True,
            }],
            "bets": [],
        }],
    }


class CaptureInboxTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.repository = self.root / "inbox"
        self.database = self.root / "bmg.sqlite"
        self.incoming = self.repository / "incoming" / "2026" / "08" / "14"
        self.incoming.mkdir(parents=True)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_payload(self, value: dict, name: str = "capture.json") -> Path:
        path = self.incoming / name
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def test_processes_valid_files_and_moves_them_to_processed(self) -> None:
        source = self.write_payload(payload())
        totals = capture_inbox.process_inbox(self.repository, self.database)

        self.assertEqual(1, totals["files"])
        self.assertEqual(1, totals["processed"])
        self.assertEqual(1, totals["captures"])
        self.assertFalse(source.exists())
        destination = self.repository / "processed" / "2026" / "08" / "14" / "capture.json"
        self.assertTrue(destination.exists())
        connection = sqlite3.connect(self.database)
        try:
            self.assertEqual(1, connection.execute("SELECT COUNT(*) FROM capture_runs").fetchone()[0])
        finally:
            connection.close()

    def test_rejects_credentials_without_moving_or_importing(self) -> None:
        value = payload("capture-inbox-test-0002")
        value["token"] = "must-not-pass"
        source = self.write_payload(value)

        with self.assertRaisesRegex(ValueError, "credential-like"):
            capture_inbox.process_inbox(self.repository, self.database)

        self.assertTrue(source.exists())
        self.assertFalse((self.repository / "processed").exists())

    def test_dry_run_validates_without_writes(self) -> None:
        source = self.write_payload(payload("capture-inbox-test-0003"))
        totals = capture_inbox.process_inbox(self.repository, self.database, dry_run=True)

        self.assertEqual(1, totals["files"])
        self.assertEqual(0, totals["processed"])
        self.assertTrue(source.exists())
        self.assertFalse(self.database.exists())


if __name__ == "__main__":
    unittest.main()
