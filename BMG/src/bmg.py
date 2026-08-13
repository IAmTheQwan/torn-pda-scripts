#!/usr/bin/env python3
"""BMG local database, import, bankroll, and odds-math CLI."""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import math
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from pathlib import Path
from statistics import median
from typing import Any, Iterable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


PROJECT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DB = PROJECT_DIR / "data" / "bmg.sqlite"
DEFAULT_TEAM_ALIAS_AUDIT = PROJECT_DIR / "data" / "team-alias-audit.json"
DEFAULT_EVENT_MATCH_REVIEW = PROJECT_DIR / "config" / "event-match-reviewed-decisions.json"
SCHEMA_FILES = sorted((PROJECT_DIR / "schema").glob("[0-9][0-9][0-9]_*.sql"))
STARTING_BANKROLL = 57_365_830
TORN_OPTION_CAP = 1_000_000_000
CAPTURE_SCHEMA = "bmg.capture.v1"
MARKET_ODDS_SCHEMA = "bmg.market-odds.v1"
REFERENCE_LEAGUE_SCHEMAS = {"bmg.flashscore-league.v1", "bmg.sports-league.v1"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_torn_finished_at(value: Any) -> tuple[str | None, str]:
    text = clean_text(value)
    match = re.search(
        r"Finished at\s+(\d{1,2}):(\d{2}):(\d{2})\s+-\s+(\d{1,2})/(\d{1,2})/(\d{4})",
        text,
        re.IGNORECASE,
    )
    if not match:
        return None, ""
    hour, minute, second, day, month, year = (int(part) for part in match.groups())
    settled_at = datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)
    finished_text = match.group(0)
    return settled_at.isoformat().replace("+00:00", "Z"), finished_text


def clean_text(value: Any) -> str:
    return " ".join(str(value or "").split())


def canonical(value: Any) -> str:
    return " ".join(
        "".join(character.lower() if character.isalnum() else " " for character in clean_text(value)).split()
    )


def classify_market(value: Any) -> str:
    name = canonical(value)
    if "3 way" in name:
        return "three_way"
    if "asian handicap" in name:
        return "asian_handicap"
    if "handicap" in name or "spread" in name:
        return "spread"
    if any(term in name for term in ("over under", "total goals", "total points", "total games", "total sets", "total rounds")):
        return "total"
    if "both teams" in name and "score" in name:
        return "both_teams_to_score"
    if "correct score" in name:
        return "correct_score"
    if any(term in name for term in ("moneyline", "match winner", "to win", "winner", "2 way")):
        return "moneyline"
    return "other"


def market_period(value: Any) -> str:
    text = clean_text(value)
    lowered = text.lower()
    for period in (
        "ordinary time",
        "full time",
        "full event",
        "full match",
        "first half",
        "second half",
        "first period",
        "second period",
        "third period",
        "first set",
        "second set",
        "third set",
    ):
        if period in lowered:
            return period.title()
    return ""


def stable_hash(*parts: Any) -> str:
    material = "|".join(canonical(part) for part in parts)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:24]


def optional_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def whole_dollars(value: Any, default: int = 0) -> int:
    try:
        result = int(float(value))
    except (TypeError, ValueError):
        return default
    return result


def open_database(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def apply_schema(connection: sqlite3.Connection) -> None:
    for schema_file in SCHEMA_FILES:
        connection.executescript(schema_file.read_text(encoding="utf-8"))
    migrations = {
        "events": {
            "settled_at": "TEXT",
            "raw_finished_text": "TEXT NOT NULL DEFAULT ''",
        },
        "bets": {
            "settled_at": "TEXT",
            "raw_selection_text": "TEXT NOT NULL DEFAULT ''",
        },
        "forecast_evaluations": {
            "evaluation_metadata_json": "TEXT NOT NULL DEFAULT '{}'",
        },
    }
    for table, columns in migrations.items():
        existing = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
        for column, declaration in columns.items():
            if column not in existing:
                connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_bets_settled_at ON bets (settled_at DESC)")
    connection.execute("PRAGMA user_version = 7")
    backfill_capture_events(connection)
    connection.commit()


def latest_bankroll(connection: sqlite3.Connection) -> sqlite3.Row | None:
    return connection.execute(
        "SELECT * FROM bankroll_snapshots ORDER BY observed_at DESC, bankroll_snapshot_id DESC LIMIT 1"
    ).fetchone()


def initialize_database(connection: sqlite3.Connection, starting_bankroll: int = STARTING_BANKROLL) -> bool:
    apply_schema(connection)
    if latest_bankroll(connection):
        return False
    connection.execute(
        """
        INSERT INTO bankroll_snapshots
            (observed_at, wallet, bookie, stocks, other_liquid, total, source, note)
        VALUES (?, ?, 0, 0, 0, ?, 'manual-seed', 'BMG starting bankroll')
        """,
        (utc_now(), starting_bankroll, starting_bankroll),
    )
    connection.commit()
    return True


def capture_objects(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        raise ValueError("Capture export must be a JSON object.")
    if isinstance(payload.get("captures"), list):
        captures = payload["captures"]
    elif isinstance(payload.get("capture"), dict):
        captures = [payload["capture"]]
    elif payload.get("capture_id"):
        captures = [payload]
    else:
        raise ValueError("No capture or captures array found.")
    if not all(isinstance(capture, dict) for capture in captures):
        raise ValueError("Each capture must be a JSON object.")
    return captures


def bet_event_stub(bet: dict[str, Any]) -> dict[str, Any]:
    return {
        "source_event_id": bet.get("source_event_id") or bet.get("game_id"),
        "sport": bet.get("sport"),
        "title": bet.get("event_title") or bet.get("match_title"),
        "league": bet.get("league") or bet.get("competition"),
        "home_team": bet.get("home_team"),
        "away_team": bet.get("away_team"),
        "visible_status": bet.get("status"),
        "settled_at": bet.get("settled_at"),
        "finished_text": bet.get("finished_text"),
    }


def backfill_capture_events(connection: sqlite3.Connection) -> int:
    """Recover capture membership for databases created before schema v4."""
    if not connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'capture_events'"
    ).fetchone():
        return 0
    if connection.execute(
        "SELECT 1 FROM schema_meta WHERE key = 'capture_events_backfilled_v4' AND value = '1'"
    ).fetchone():
        return 0
    inserted = 0
    rows = connection.execute("SELECT capture_id, raw_json FROM capture_runs").fetchall()
    for row in rows:
        try:
            capture = json.loads(row["raw_json"])
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(capture, dict):
            continue
        records: list[tuple[dict[str, Any], bool]] = []
        records.extend(
            (event, bool(event.get("captured_as_complete")))
            for event in (capture.get("events") or [])
            if isinstance(event, dict)
        )
        records.extend(
            (bet_event_stub(bet), False)
            for bet in (capture.get("bets") or [])
            if isinstance(bet, dict)
        )
        for event, complete in records:
            event_row = connection.execute(
                "SELECT event_id FROM events WHERE event_uid = ?", (event_identity(event),)
            ).fetchone()
            if not event_row:
                continue
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO capture_events (capture_id, event_id, captured_as_complete)
                VALUES (?, ?, ?)
                """,
                (row["capture_id"], int(event_row[0]), 1 if complete else 0),
            )
            inserted += max(0, cursor.rowcount)
    connection.execute(
        "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('capture_events_backfilled_v4', '1')"
    )
    return inserted


def event_identity(event: dict[str, Any]) -> str:
    source_id = clean_text(event.get("source_event_id") or event.get("game_id"))
    if source_id:
        return f"torn:{source_id.lower()}"
    return "fingerprint:" + stable_hash(
        event.get("sport"), event.get("title"), event.get("scheduled_at"), event.get("league")
    )


def upsert_event(
    connection: sqlite3.Connection,
    event: dict[str, Any],
    observed_at: str,
) -> int:
    participants = event.get("participants") if isinstance(event.get("participants"), list) else []
    home_team = clean_text(event.get("home_team") or (participants[0] if participants else ""))
    away_team = clean_text(event.get("away_team") or (participants[1] if len(participants) > 1 else ""))
    uid = event_identity(event)
    values = {
        "event_uid": uid,
        "source_event_id": clean_text(event.get("source_event_id") or event.get("game_id")),
        "sport": canonical(event.get("sport")) or "unknown",
        "title": clean_text(event.get("title")) or "Unknown Torn Bookie event",
        "league": clean_text(event.get("league") or event.get("competition")),
        "home_team": home_team,
        "away_team": away_team,
        "scheduled_at": clean_text(event.get("scheduled_at")) or None,
        "settled_at": clean_text(event.get("settled_at")) or None,
        "visible_status": clean_text(event.get("visible_status") or event.get("status")),
        "observed_at": observed_at,
        "raw_state_text": clean_text(event.get("raw_state_text")),
        "raw_finished_text": clean_text(event.get("raw_finished_text") or event.get("finished_text")),
    }
    connection.execute(
        """
        INSERT INTO events (
            event_uid, source_event_id, sport, title, league, home_team, away_team,
            scheduled_at, settled_at, visible_status, first_observed_at, last_observed_at,
            raw_state_text, raw_finished_text
        ) VALUES (
            :event_uid, :source_event_id, :sport, :title, :league, :home_team, :away_team,
            :scheduled_at, :settled_at, :visible_status, :observed_at, :observed_at,
            :raw_state_text, :raw_finished_text
        )
        ON CONFLICT(event_uid) DO UPDATE SET
            source_event_id = CASE WHEN excluded.source_event_id <> '' THEN excluded.source_event_id ELSE events.source_event_id END,
            sport = CASE WHEN excluded.sport <> 'unknown' THEN excluded.sport ELSE events.sport END,
            title = CASE WHEN excluded.title <> 'Unknown Torn Bookie event' THEN excluded.title ELSE events.title END,
            league = CASE WHEN excluded.league <> '' THEN excluded.league ELSE events.league END,
            home_team = CASE WHEN excluded.home_team <> '' THEN excluded.home_team ELSE events.home_team END,
            away_team = CASE WHEN excluded.away_team <> '' THEN excluded.away_team ELSE events.away_team END,
            scheduled_at = COALESCE(excluded.scheduled_at, events.scheduled_at),
            settled_at = COALESCE(excluded.settled_at, events.settled_at),
            visible_status = CASE WHEN excluded.visible_status <> '' THEN excluded.visible_status ELSE events.visible_status END,
            last_observed_at = excluded.last_observed_at,
            raw_state_text = CASE WHEN excluded.raw_state_text <> '' THEN excluded.raw_state_text ELSE events.raw_state_text END,
            raw_finished_text = CASE WHEN excluded.raw_finished_text <> '' THEN excluded.raw_finished_text ELSE events.raw_finished_text END
        """,
        values,
    )
    return int(connection.execute("SELECT event_id FROM events WHERE event_uid = ?", (uid,)).fetchone()[0])


def selection_identity(selection: dict[str, Any]) -> str:
    supplied = clean_text(selection.get("selection_key"))
    if supplied:
        return supplied.lower()
    handicap = selection.get("handicap") if selection.get("handicap") is not None else ""
    line = selection.get("line") if selection.get("line") is not None else ""
    return f"{canonical(selection.get('name'))}|h:{handicap}|l:{line}"


def market_selection_signature(market: dict[str, Any]) -> str:
    selections = market.get("selections") if isinstance(market.get("selections"), list) else []
    keys = sorted(selection_identity(selection) for selection in selections if isinstance(selection, dict))
    return "||".join(keys)


def market_identity(market: dict[str, Any]) -> str:
    supplied = clean_text(market.get("market_key"))
    if supplied:
        return supplied.lower()
    return f"{canonical(market.get('name'))}|{canonical(market.get('period'))}"


def upsert_market(
    connection: sqlite3.Connection,
    event_id: int,
    market: dict[str, Any],
    observed_at: str,
) -> int:
    key = market_identity(market)
    complete = 1 if market.get("captured_as_complete") is True else 0
    connection.execute(
        """
        INSERT INTO markets (
            event_id, market_key, name, market_type, period, captured_as_complete,
            first_observed_at, last_observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id, market_key) DO UPDATE SET
            name = excluded.name,
            market_type = excluded.market_type,
            period = excluded.period,
            captured_as_complete = MAX(markets.captured_as_complete, excluded.captured_as_complete),
            last_observed_at = excluded.last_observed_at
        """,
        (
            event_id,
            key,
            clean_text(market.get("name")) or "Unknown market",
            canonical(market.get("market_type")) or "other",
            clean_text(market.get("period")),
            complete,
            observed_at,
            observed_at,
        ),
    )
    return int(
        connection.execute(
            "SELECT market_id FROM markets WHERE event_id = ? AND market_key = ?", (event_id, key)
        ).fetchone()[0]
    )


def upsert_selection(
    connection: sqlite3.Connection,
    market_id: int,
    selection: dict[str, Any],
    observed_at: str,
) -> int:
    key = selection_identity(selection)
    connection.execute(
        """
        INSERT INTO selections (
            market_id, selection_key, name, raw_name, handicap, line,
            first_observed_at, last_observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(market_id, selection_key) DO UPDATE SET
            name = excluded.name,
            raw_name = excluded.raw_name,
            handicap = COALESCE(excluded.handicap, selections.handicap),
            line = COALESCE(excluded.line, selections.line),
            last_observed_at = excluded.last_observed_at
        """,
        (
            market_id,
            key,
            clean_text(selection.get("name")) or "Unknown selection",
            clean_text(selection.get("raw_name") or selection.get("name")),
            optional_float(selection.get("handicap")),
            optional_float(selection.get("line")),
            observed_at,
            observed_at,
        ),
    )
    return int(
        connection.execute(
            "SELECT selection_id FROM selections WHERE market_id = ? AND selection_key = ?",
            (market_id, key),
        ).fetchone()[0]
    )


def insert_outcome(
    connection: sqlite3.Connection,
    capture_id: str,
    event_id: int,
    outcome: dict[str, Any],
    observed_at: str,
) -> None:
    if not outcome:
        return
    connection.execute(
        """
        INSERT OR IGNORE INTO event_outcomes (
            capture_id, event_id, observed_at, status, home_score, away_score, winner, raw_score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            capture_id,
            event_id,
            observed_at,
            clean_text(outcome.get("status")),
            optional_float(outcome.get("home_score")),
            optional_float(outcome.get("away_score")),
            clean_text(outcome.get("winner")),
            clean_text(outcome.get("raw_score")),
        ),
    )


def import_event(
    connection: sqlite3.Connection,
    capture_id: str,
    event: dict[str, Any],
    observed_at: str,
) -> dict[str, int]:
    event_id = upsert_event(connection, event, observed_at)
    connection.execute(
        """
        INSERT INTO capture_events (capture_id, event_id, captured_as_complete)
        VALUES (?, ?, ?)
        ON CONFLICT(capture_id, event_id) DO UPDATE SET
            captured_as_complete = MAX(capture_events.captured_as_complete, excluded.captured_as_complete)
        """,
        (capture_id, event_id, 1 if event.get("captured_as_complete") is True else 0),
    )
    counts = {"events": 1, "markets": 0, "selections": 0, "odds": 0, "outcomes": 0}
    markets = [market for market in (event.get("markets") or []) if isinstance(market, dict)]
    base_keys = [market_identity(market) for market in markets]
    key_counts = {key: base_keys.count(key) for key in set(base_keys)}
    for market, base_key in zip(markets, base_keys):
        if key_counts[base_key] > 1:
            signature = market_selection_signature(market)
            market = {**market, "market_key": f"{base_key}|s:{signature}"}
        market_id = upsert_market(connection, event_id, market, observed_at)
        connection.execute(
            """
            INSERT OR REPLACE INTO market_captures (capture_id, market_id, captured_as_complete)
            VALUES (?, ?, ?)
            """,
            (capture_id, market_id, 1 if market.get("captured_as_complete") is True else 0),
        )
        counts["markets"] += 1
        for selection in market.get("selections") or []:
            if not isinstance(selection, dict):
                continue
            selection_id = upsert_selection(connection, market_id, selection, observed_at)
            counts["selections"] += 1
            odds = optional_float(selection.get("odds_decimal"))
            if odds is not None and odds > 0:
                connection.execute(
                    """
                    INSERT OR IGNORE INTO odds_observations (
                        capture_id, selection_id, observed_at, odds_decimal, suspended, available
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        capture_id,
                        selection_id,
                        observed_at,
                        odds,
                        1 if selection.get("suspended") else 0,
                        0 if selection.get("available") is False else 1,
                    ),
                )
                counts["odds"] += 1
    outcome = event.get("outcome") if isinstance(event.get("outcome"), dict) else {}
    if outcome:
        insert_outcome(connection, capture_id, event_id, outcome, observed_at)
        counts["outcomes"] += 1
    return counts


def normalize_bet_status(value: Any) -> str:
    status = canonical(value)
    return {
        "open": "pending",
        "pending": "pending",
        "won": "win",
        "win": "win",
        "lost": "loss",
        "loss": "loss",
        "refunded": "refund",
        "refund": "refund",
    }.get(status, "unknown")


def import_bet(
    connection: sqlite3.Connection,
    capture_id: str,
    bet: dict[str, Any],
    observed_at: str,
) -> None:
    event_stub = bet_event_stub(bet)
    event_id = upsert_event(connection, event_stub, observed_at)
    connection.execute(
        """
        INSERT OR IGNORE INTO capture_events (capture_id, event_id, captured_as_complete)
        VALUES (?, ?, 0)
        """,
        (capture_id, event_id),
    )
    market = {
        "name": bet.get("market_name") or "Unknown bet market",
        "market_type": bet.get("market_type") or "other",
        "period": bet.get("period") or "",
        "captured_as_complete": False,
    }
    market_id = upsert_market(connection, event_id, market, observed_at)
    selection = {
        "name": bet.get("selection_name") or "Unknown selection",
        "raw_name": bet.get("selection_name") or "",
        "handicap": bet.get("handicap"),
        "line": bet.get("line"),
    }
    selection_id = upsert_selection(connection, market_id, selection, observed_at)
    status = normalize_bet_status(bet.get("status"))
    stake = max(0, whole_dollars(bet.get("stake")))
    if stake > TORN_OPTION_CAP:
        raise ValueError(f"Bet {bet.get('external_bet_id')} exceeds Torn's per-option $1B limit.")
    profit = None if bet.get("profit") is None else whole_dollars(bet.get("profit"))
    payout = None if bet.get("payout") is None else max(0, whole_dollars(bet.get("payout")))
    external_id = clean_text(bet.get("external_bet_id")) or "capture:" + stable_hash(
        event_identity(event_stub), market.get("name"), selection.get("name"), stake, bet.get("odds_decimal")
    )
    connection.execute(
        """
        INSERT INTO bets (
            external_bet_id, capture_id, event_id, market_id, selection_id, status,
            stake, odds_decimal, payout, profit, first_observed_at, last_observed_at, raw_text
            , settled_at, raw_selection_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(external_bet_id) DO UPDATE SET
            capture_id = excluded.capture_id,
            event_id = excluded.event_id,
            market_id = excluded.market_id,
            selection_id = excluded.selection_id,
            status = excluded.status,
            stake = excluded.stake,
            odds_decimal = COALESCE(excluded.odds_decimal, bets.odds_decimal),
            payout = COALESCE(excluded.payout, bets.payout),
            profit = COALESCE(excluded.profit, bets.profit),
            settled_at = COALESCE(excluded.settled_at, bets.settled_at),
            last_observed_at = excluded.last_observed_at,
            raw_text = CASE WHEN excluded.raw_text <> '' THEN excluded.raw_text ELSE bets.raw_text END,
            raw_selection_text = CASE WHEN excluded.raw_selection_text <> '' THEN excluded.raw_selection_text ELSE bets.raw_selection_text END
        """,
        (
            external_id,
            capture_id,
            event_id,
            market_id,
            selection_id,
            status,
            stake,
            optional_float(bet.get("odds_decimal")),
            payout,
            profit,
            observed_at,
            observed_at,
            clean_text(bet.get("raw_text")),
            clean_text(bet.get("settled_at")) or None,
            clean_text(bet.get("raw_selection_name") or bet.get("selection_name")),
        ),
    )


def import_capture(connection: sqlite3.Connection, capture: dict[str, Any]) -> dict[str, int]:
    capture_id = clean_text(capture.get("capture_id"))
    observed_at = clean_text(capture.get("observed_at"))
    if not capture_id or not observed_at:
        raise ValueError("Every capture needs capture_id and observed_at.")
    if connection.execute("SELECT 1 FROM capture_runs WHERE capture_id = ?", (capture_id,)).fetchone():
        return {"captures": 0, "events": 0, "markets": 0, "selections": 0, "odds": 0, "outcomes": 0, "bets": 0}

    events = capture.get("events") if isinstance(capture.get("events"), list) else []
    bets = capture.get("bets") if isinstance(capture.get("bets"), list) else []
    schema_version = clean_text(capture.get("schema_version")) or CAPTURE_SCHEMA
    if schema_version != CAPTURE_SCHEMA:
        raise ValueError(f"Unsupported capture schema {schema_version!r}; expected {CAPTURE_SCHEMA!r}.")

    connection.execute(
        """
        INSERT INTO capture_runs (
            capture_id, schema_version, observed_at, source, page_url, page_hash,
            event_count, bet_count, imported_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            capture_id,
            schema_version,
            observed_at,
            clean_text(capture.get("source")) or "unknown",
            clean_text(capture.get("page_url")),
            clean_text(capture.get("page_hash")),
            len(events),
            len(bets),
            utc_now(),
            json.dumps(capture, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        ),
    )
    counts = {"captures": 1, "events": 0, "markets": 0, "selections": 0, "odds": 0, "outcomes": 0, "bets": 0}
    for event in events:
        if not isinstance(event, dict):
            continue
        event_counts = import_event(connection, capture_id, event, observed_at)
        for key, value in event_counts.items():
            counts[key] += value
    for bet in bets:
        if not isinstance(bet, dict):
            continue
        import_bet(connection, capture_id, bet, observed_at)
        counts["bets"] += 1
    return counts


def merge_counts(total: dict[str, int], addition: dict[str, int]) -> None:
    for key, value in addition.items():
        total[key] = total.get(key, 0) + value


def import_file(connection: sqlite3.Connection, path: Path) -> dict[str, int]:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    total: dict[str, int] = {}
    with connection:
        for capture in capture_objects(payload):
            merge_counts(total, import_capture(connection, capture))
    return total


def detail_market(market: dict[str, Any], detail_complete: bool) -> dict[str, Any]:
    market_name = clean_text(market.get("name")) or "Unknown market"
    selections = []
    for selection in market.get("selections") or []:
        if not isinstance(selection, dict):
            continue
        selections.append(
            {
                "name": clean_text(selection.get("name")) or "Unknown selection",
                "raw_name": clean_text(selection.get("raw_result_text") or selection.get("name")),
                "odds_decimal": optional_float(selection.get("odds_decimal")),
                "suspended": bool(selection.get("suspended")),
                "available": selection.get("available") is not False,
            }
        )
    return {
        "name": market_name,
        "market_type": canonical(market.get("market_type")) or classify_market(market_name),
        "period": clean_text(market.get("period")) or market_period(market_name),
        "captured_as_complete": detail_complete,
        "selections": selections,
    }


def import_history_detail(connection: sqlite3.Connection, detail: dict[str, Any]) -> dict[str, int]:
    source_event_id = clean_text(detail.get("source_event_id"))
    captured_at = clean_text(detail.get("captured_at"))
    if not source_event_id or not captured_at:
        raise ValueError("Every history detail needs source_event_id and captured_at.")
    raw_json = json.dumps(detail, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    detail_id = "history-detail:" + stable_hash(source_event_id, captured_at, raw_json)
    settled_at = clean_text(detail.get("settled_at")) or None
    finished_text = clean_text(detail.get("finished_text"))
    parsed_settled_at, parsed_finished_text = parse_torn_finished_at(
        " ".join(
            [
                finished_text,
                clean_text(detail.get("raw_text")),
                " ".join(clean_text(value) for value in (detail.get("titles") or [])),
            ]
        )
    )
    settled_at = settled_at or parsed_settled_at
    finished_text = finished_text or parsed_finished_text

    def backfill_settlement() -> None:
        if not settled_at:
            return
        event_row = connection.execute(
            "SELECT event_id FROM events WHERE event_uid = ?", (f"torn:{source_event_id.lower()}",)
        ).fetchone()
        if not event_row:
            return
        event_id = int(event_row[0])
        connection.execute(
            """
            UPDATE events
            SET settled_at = COALESCE(settled_at, ?),
                raw_finished_text = CASE WHEN raw_finished_text = '' THEN ? ELSE raw_finished_text END
            WHERE event_id = ?
            """,
            (settled_at, finished_text, event_id),
        )
        connection.execute(
            "UPDATE bets SET settled_at = COALESCE(settled_at, ?) WHERE event_id = ?",
            (settled_at, event_id),
        )

    if connection.execute(
        "SELECT 1 FROM history_event_details WHERE detail_id = ?", (detail_id,)
    ).fetchone():
        backfill_settlement()
        return {"captures": 0, "events": 0, "markets": 0, "selections": 0, "odds": 0, "outcomes": 0, "bets": 0, "details": 0}

    markets = [market for market in (detail.get("markets") or []) if isinstance(market, dict)]
    selection_count = sum(
        len([selection for selection in (market.get("selections") or []) if isinstance(selection, dict)])
        for market in markets
    )
    expansion_passes = max(0, whole_dollars(detail.get("additional_expansion_passes")))
    controls_remaining = max(0, whole_dollars(detail.get("additional_controls_remaining")))
    detail_complete = controls_remaining == 0
    connection.execute(
        """
        INSERT INTO history_event_details (
            detail_id, source_event_id, captured_at, sport, title, market_count,
            selection_count, additional_expansion_passes, additional_controls_remaining, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            detail_id,
            source_event_id,
            captured_at,
            canonical(detail.get("sport")) or "unknown",
            clean_text(detail.get("title")),
            len(markets),
            selection_count,
            expansion_passes,
            controls_remaining,
            raw_json,
        ),
    )
    capture = {
        "schema_version": CAPTURE_SCHEMA,
        "capture_id": detail_id,
        "observed_at": captured_at,
        "source": "torn-visible-mybets-expanded-dom",
        "page_url": "https://www.torn.com/page.php?sid=bookie",
        "page_hash": f"#/your-bets/{source_event_id}",
        "events": [
            {
                "source_event_id": source_event_id,
                "sport": detail.get("sport"),
                "title": detail.get("title"),
                "league": detail.get("league"),
                "home_team": detail.get("home_team"),
                "away_team": detail.get("away_team"),
                "settled_at": settled_at,
                "finished_text": finished_text,
                "visible_status": "finished",
                "captured_as_complete": detail_complete,
                "markets": [detail_market(market, detail_complete) for market in markets],
            }
        ],
        "bets": [],
    }
    counts = import_capture(connection, capture)
    backfill_settlement()
    counts["details"] = 1
    return counts


def import_history_details_file(connection: sqlite3.Connection, path: Path) -> dict[str, int]:
    latest_by_event: dict[str, dict[str, Any]] = {}

    def detail_rank(value: dict[str, Any]) -> tuple[int, str]:
        markets = value.get("markets") if isinstance(value.get("markets"), list) else []
        complete = bool(markets) and whole_dollars(value.get("additional_controls_remaining")) == 0
        return (1 if complete else 0, clean_text(value.get("captured_at")))

    for line_number, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), start=1):
        if not line.strip():
            continue
        detail = json.loads(line)
        if not isinstance(detail, dict):
            raise ValueError(f"History detail line {line_number} is not a JSON object.")
        source_event_id = clean_text(detail.get("source_event_id"))
        if not source_event_id:
            raise ValueError(f"History detail line {line_number} has no source_event_id.")
        current = latest_by_event.get(source_event_id)
        if current is None or detail_rank(detail) >= detail_rank(current):
            latest_by_event[source_event_id] = detail
    total: dict[str, int] = {}
    with connection:
        for detail in latest_by_event.values():
            merge_counts(total, import_history_detail(connection, detail))
    return total


def flashscore_capture_objects(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        raise ValueError("Flashscore export must be a JSON object.")
    captures = payload.get("captures") if isinstance(payload.get("captures"), list) else [payload]
    if not all(isinstance(capture, dict) for capture in captures):
        raise ValueError("Every Flashscore capture must be a JSON object.")
    return captures


def parse_flashscore_schedule(
    raw_value: Any,
    season: dict[str, Any] | None,
    display_timezone: str,
) -> tuple[str | None, str | None]:
    """Return UTC timestamp when time is visible plus a reliable local date."""
    raw = clean_text(raw_value)
    match = re.fullmatch(r"(\d{1,2})\.(\d{1,2})\.(?:(\d{2,4}))?(?:\s+(\d{1,2}):(\d{2}))?", raw)
    if not match:
        return None, None
    day, month = int(match.group(1)), int(match.group(2))
    supplied_year = match.group(3)
    hour = int(match.group(4)) if match.group(4) is not None else None
    minute = int(match.group(5)) if match.group(5) is not None else None
    if supplied_year:
        year = int(supplied_year)
        if year < 100:
            year += 2000 if year < 70 else 1900
    else:
        start_text = clean_text((season or {}).get("start_date"))
        end_text = clean_text((season or {}).get("end_date"))
        start = datetime.fromisoformat(start_text).date() if start_text else None
        end = datetime.fromisoformat(end_text).date() if end_text else None
        candidates = sorted({value.year for value in (start, end) if value is not None})
        year = candidates[0] if candidates else datetime.now(timezone.utc).year
        for candidate in candidates:
            try:
                candidate_date = datetime(candidate, month, day).date()
            except ValueError:
                continue
            if (start is None or candidate_date >= start) and (end is None or candidate_date <= end):
                year = candidate
                break
    try:
        local_date = datetime(year, month, day)
    except ValueError:
        return None, None
    date_text = local_date.date().isoformat()
    if hour is None or minute is None:
        return None, date_text
    try:
        local_zone = ZoneInfo(display_timezone) if display_timezone else timezone.utc
    except ZoneInfoNotFoundError:
        if display_timezone == "America/New_York":
            # Windows Python may not ship the IANA tz database. US daylight
            # time runs from the second Sunday in March to the first Sunday in
            # November; these boundaries are sufficient for modern match data.
            march_first = datetime(year, 3, 1)
            second_sunday = 1 + ((6 - march_first.weekday()) % 7) + 7
            november_first = datetime(year, 11, 1)
            first_sunday = 1 + ((6 - november_first.weekday()) % 7)
            dst_start = datetime(year, 3, second_sunday, 2)
            dst_end = datetime(year, 11, first_sunday, 2)
            offset_hours = -4 if dst_start <= local_time_candidate(local_date, hour, minute) < dst_end else -5
            local_zone = timezone(timedelta(hours=offset_hours))
        else:
            return None, date_text
    local_time = local_date.replace(hour=hour, minute=minute, tzinfo=local_zone)
    return local_time.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"), date_text


def local_time_candidate(local_date: datetime, hour: int, minute: int) -> datetime:
    return local_date.replace(hour=hour, minute=minute)


def parse_stat_value(raw_value: Any) -> tuple[float | None, float | None, float | None]:
    raw = clean_text(raw_value).replace(",", "")
    value_match = re.match(r"^(-?\d+(?:\.\d+)?)", raw)
    ratio_match = re.search(r"\((-?\d+(?:\.\d+)?)\s*/\s*(-?\d+(?:\.\d+)?)\)", raw)
    value = optional_float(value_match.group(1)) if value_match else None
    numerator = optional_float(ratio_match.group(1)) if ratio_match else None
    denominator = optional_float(ratio_match.group(2)) if ratio_match else None
    return value, numerator, denominator


def upsert_sports_competition(
    connection: sqlite3.Connection,
    *,
    source: str,
    sport: str,
    country: str,
    name: str,
    source_competition_id: str,
    source_slug: str,
    source_url: str,
    observed_at: str,
) -> int:
    sport_key = canonical(sport) or "unknown"
    country_name = clean_text(country)
    display_name = clean_text(name) or "Unknown competition"
    canonical_name = canonical(display_name)
    connection.execute(
        """
        INSERT INTO sports_competitions (
            sport, country, name, canonical_name, first_observed_at, last_observed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(sport, country, canonical_name) DO UPDATE SET
            name = excluded.name,
            last_observed_at = excluded.last_observed_at
        """,
        (sport_key, country_name, display_name, canonical_name, observed_at, observed_at),
    )
    competition_id = int(
        connection.execute(
            "SELECT competition_id FROM sports_competitions WHERE sport = ? AND country = ? AND canonical_name = ?",
            (sport_key, country_name, canonical_name),
        ).fetchone()[0]
    )
    external_id = clean_text(source_competition_id) or f"{sport_key}:{canonical(country_name)}:{canonical_name}"
    connection.execute(
        """
        INSERT INTO competition_sources (
            competition_id, source, source_competition_id, source_slug, source_url,
            first_observed_at, last_observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, source_competition_id) DO UPDATE SET
            competition_id = excluded.competition_id,
            source_slug = CASE WHEN excluded.source_slug <> '' THEN excluded.source_slug ELSE competition_sources.source_slug END,
            source_url = CASE WHEN excluded.source_url <> '' THEN excluded.source_url ELSE competition_sources.source_url END,
            last_observed_at = excluded.last_observed_at
        """,
        (competition_id, source, external_id, source_slug, source_url, observed_at, observed_at),
    )
    return competition_id


def upsert_competition_season(
    connection: sqlite3.Connection,
    competition_id: int,
    source: str,
    season: dict[str, Any],
    observed_at: str,
) -> int:
    name = clean_text(season.get("name")) or "Unknown season"
    connection.execute(
        """
        INSERT INTO competition_seasons (
            competition_id, name, start_date, end_date, is_current,
            first_observed_at, last_observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(competition_id, name) DO UPDATE SET
            start_date = COALESCE(excluded.start_date, competition_seasons.start_date),
            end_date = COALESCE(excluded.end_date, competition_seasons.end_date),
            is_current = excluded.is_current,
            last_observed_at = excluded.last_observed_at
        """,
        (
            competition_id,
            name,
            clean_text(season.get("start_date")) or None,
            clean_text(season.get("end_date")) or None,
            1 if season.get("is_current") else 0,
            observed_at,
            observed_at,
        ),
    )
    season_id = int(
        connection.execute(
            "SELECT season_id FROM competition_seasons WHERE competition_id = ? AND name = ?",
            (competition_id, name),
        ).fetchone()[0]
    )
    source_season_id = clean_text(season.get("source_season_id")) or f"{competition_id}:{name}"
    connection.execute(
        """
        INSERT INTO season_sources (
            season_id, source, source_season_id, source_url, first_observed_at, last_observed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, source_season_id) DO UPDATE SET
            season_id = excluded.season_id,
            source_url = CASE WHEN excluded.source_url <> '' THEN excluded.source_url ELSE season_sources.source_url END,
            last_observed_at = excluded.last_observed_at
        """,
        (season_id, source, source_season_id, clean_text(season.get("source_url")), observed_at, observed_at),
    )
    return season_id


def upsert_sports_team(
    connection: sqlite3.Connection,
    *,
    source: str,
    source_team_id: str,
    sport: str,
    country: str,
    name: str,
    source_url: str,
    observed_at: str,
) -> int:
    external_id = clean_text(source_team_id)
    display_name = clean_text(name) or "Unknown team"
    existing = None
    if external_id:
        existing = connection.execute(
            "SELECT team_id FROM team_sources WHERE source = ? AND source_team_id = ?",
            (source, external_id),
        ).fetchone()
    if existing:
        team_id = int(existing[0])
        connection.execute(
            "UPDATE sports_teams SET name = ?, last_observed_at = ? WHERE team_id = ?",
            (display_name, observed_at, team_id),
        )
    else:
        sport_key = canonical(sport) or "unknown"
        country_name = clean_text(country)
        name_key = canonical(display_name)
        connection.execute(
            """
            INSERT INTO sports_teams (
                sport, country, name, canonical_name, first_observed_at, last_observed_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(sport, country, canonical_name) DO UPDATE SET
                name = excluded.name,
                last_observed_at = excluded.last_observed_at
            """,
            (sport_key, country_name, display_name, name_key, observed_at, observed_at),
        )
        team_id = int(
            connection.execute(
                "SELECT team_id FROM sports_teams WHERE sport = ? AND country = ? AND canonical_name = ?",
                (sport_key, country_name, name_key),
            ).fetchone()[0]
        )
    external_id = external_id or "name:" + stable_hash(sport, country, display_name)
    connection.execute(
        """
        INSERT INTO team_sources (
            team_id, source, source_team_id, source_name, source_url,
            first_observed_at, last_observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, source_team_id) DO UPDATE SET
            team_id = excluded.team_id,
            source_name = excluded.source_name,
            source_url = CASE WHEN excluded.source_url <> '' THEN excluded.source_url ELSE team_sources.source_url END,
            last_observed_at = excluded.last_observed_at
        """,
        (team_id, source, external_id, display_name, source_url, observed_at, observed_at),
    )
    connection.execute(
        """
        INSERT OR IGNORE INTO team_aliases (team_id, source, alias, canonical_alias)
        VALUES (?, ?, ?, ?)
        """,
        (team_id, source, display_name, canonical(display_name)),
    )
    return team_id


def source_team_id(connection: sqlite3.Connection, source: str, external_id: Any) -> int | None:
    row = connection.execute(
        "SELECT team_id FROM team_sources WHERE source = ? AND source_team_id = ?",
        (source, clean_text(external_id)),
    ).fetchone()
    return int(row[0]) if row else None


def upsert_sports_match(
    connection: sqlite3.Connection,
    *,
    source: str,
    record: dict[str, Any],
    sport: str,
    country: str,
    competition_id: int | None,
    season_id: int | None,
    season: dict[str, Any] | None,
    display_timezone: str,
    observed_at: str,
) -> int:
    external_id = clean_text(record.get("source_match_id"))
    if not external_id:
        raise ValueError("Every reference match needs source_match_id.")
    home_team_id = source_team_id(connection, source, record.get("home_team_id"))
    away_team_id = source_team_id(connection, source, record.get("away_team_id"))
    if home_team_id is None:
        home_team_id = upsert_sports_team(
            connection,
            source=source,
            source_team_id=clean_text(record.get("home_team_id")),
            sport=sport,
            country=country,
            name=clean_text(record.get("home_team")),
            source_url="",
            observed_at=observed_at,
        )
    if away_team_id is None:
        away_team_id = upsert_sports_team(
            connection,
            source=source,
            source_team_id=clean_text(record.get("away_team_id")),
            sport=sport,
            country=country,
            name=clean_text(record.get("away_team")),
            source_url="",
            observed_at=observed_at,
        )
    scheduled_at = clean_text(record.get("scheduled_at")) or None
    scheduled_date = clean_text(record.get("scheduled_date")) or None
    if scheduled_at:
        parsed = parse_iso_datetime(scheduled_at)
        scheduled_at = parsed.isoformat().replace("+00:00", "Z") if parsed else None
        if scheduled_at and not scheduled_date:
            scheduled_date = scheduled_at[:10]
    if not scheduled_at and not scheduled_date:
        scheduled_at, scheduled_date = parse_flashscore_schedule(
            record.get("raw_scheduled_local") or record.get("raw_date"), season, display_timezone
        )
    home_score = optional_float(record.get("home_score"))
    away_score = optional_float(record.get("away_score"))
    status = clean_text(record.get("status"))
    if not status:
        status = "finished" if home_score is not None and away_score is not None else "scheduled"
    source_row = connection.execute(
        "SELECT match_id FROM match_sources WHERE source = ? AND source_match_id = ?",
        (source, external_id),
    ).fetchone()
    if source_row:
        match_id = int(source_row[0])
        connection.execute(
            """
            UPDATE sports_matches SET
                competition_id = COALESCE(competition_id, ?),
                season_id = COALESCE(season_id, ?),
                home_team_id = ?, away_team_id = ?,
                round = CASE WHEN ? <> '' THEN ? ELSE round END,
                scheduled_at = COALESCE(?, scheduled_at),
                scheduled_date = COALESCE(?, scheduled_date),
                raw_scheduled_local = CASE WHEN ? <> '' THEN ? ELSE raw_scheduled_local END,
                display_timezone = CASE WHEN ? <> '' THEN ? ELSE display_timezone END,
                status = CASE WHEN ? <> '' THEN ? ELSE status END,
                home_score = COALESCE(?, home_score),
                away_score = COALESCE(?, away_score),
                last_observed_at = ?
            WHERE match_id = ?
            """,
            (
                competition_id,
                season_id,
                home_team_id,
                away_team_id,
                clean_text(record.get("round")),
                clean_text(record.get("round")),
                scheduled_at,
                scheduled_date,
                clean_text(record.get("raw_scheduled_local") or record.get("raw_date")),
                clean_text(record.get("raw_scheduled_local") or record.get("raw_date")),
                display_timezone,
                display_timezone,
                status,
                status,
                home_score,
                away_score,
                observed_at,
                match_id,
            ),
        )
    else:
        cursor = connection.execute(
            """
            INSERT INTO sports_matches (
                sport, competition_id, season_id, home_team_id, away_team_id, round,
                scheduled_at, scheduled_date, raw_scheduled_local, display_timezone,
                status, home_score, away_score, first_observed_at, last_observed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                canonical(sport) or "unknown",
                competition_id,
                season_id,
                home_team_id,
                away_team_id,
                clean_text(record.get("round")),
                scheduled_at,
                scheduled_date,
                clean_text(record.get("raw_scheduled_local") or record.get("raw_date")),
                display_timezone,
                status,
                home_score,
                away_score,
                observed_at,
                observed_at,
            ),
        )
        match_id = int(cursor.lastrowid)
    connection.execute(
        """
        INSERT INTO match_sources (
            match_id, source, source_match_id, source_url, first_observed_at, last_observed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, source_match_id) DO UPDATE SET
            source_url = CASE WHEN excluded.source_url <> '' THEN excluded.source_url ELSE match_sources.source_url END,
            last_observed_at = excluded.last_observed_at
        """,
        (match_id, source, external_id, clean_text(record.get("source_url")), observed_at, observed_at),
    )
    return match_id


def split_flashscore_competition(value: Any, fallback_country: str) -> tuple[str, str]:
    text = clean_text(value)
    match = re.fullmatch(r"(.+?)\s*\(([^()]+)\)", text)
    if match:
        return clean_text(match.group(1)), clean_text(match.group(2))
    return text or "Unknown competition", fallback_country


def import_flashscore_capture(connection: sqlite3.Connection, capture: dict[str, Any]) -> dict[str, int]:
    if capture.get("schema_version") not in REFERENCE_LEAGUE_SCHEMAS:
        raise ValueError("Unsupported reference-league capture schema.")
    capture_id = clean_text(capture.get("capture_id"))
    observed_at = clean_text(capture.get("observed_at"))
    source = clean_text(capture.get("source")) or "flashscore-visible-browser"
    if not capture_id or not observed_at:
        raise ValueError("Every Flashscore capture needs capture_id and observed_at.")
    if connection.execute(
        "SELECT 1 FROM reference_capture_runs WHERE capture_id = ?", (capture_id,)
    ).fetchone():
        return {"captures": 0, "competitions": 0, "seasons": 0, "teams": 0, "matches": 0, "standings": 0, "stats": 0, "h2h_matches": 0}
    competition = capture.get("competition") if isinstance(capture.get("competition"), dict) else {}
    season = capture.get("season") if isinstance(capture.get("season"), dict) else {}
    matches = [row for row in (capture.get("matches") or []) if isinstance(row, dict)]
    raw_json = json.dumps(capture, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    connection.execute(
        """
        INSERT INTO reference_capture_runs (
            capture_id, schema_version, observed_at, source, page_url, display_timezone,
            competition_count, season_count, match_count, imported_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)
        """,
        (
            capture_id,
            capture["schema_version"],
            observed_at,
            source,
            clean_text(capture.get("page_url")),
            clean_text(capture.get("display_timezone")),
            len(matches),
            utc_now(),
            raw_json,
        ),
    )
    sport = clean_text(competition.get("sport")) or "football"
    country = clean_text(competition.get("country"))
    source_slug = clean_text(competition.get("source_slug"))
    competition_id = upsert_sports_competition(
        connection,
        source=source,
        sport=sport,
        country=country,
        name=clean_text(competition.get("name")),
        source_competition_id=source_slug,
        source_slug=source_slug,
        source_url=clean_text(competition.get("source_url")),
        observed_at=observed_at,
    )
    season_id = upsert_competition_season(connection, competition_id, source, season, observed_at)
    display_timezone = clean_text(capture.get("display_timezone"))
    known_team_ids: set[str] = set()

    def ensure_team(record: dict[str, Any], prefix: str, source_url: str = "") -> int:
        external_id = clean_text(record.get(f"{prefix}_team_id") or record.get("team_id"))
        name = clean_text(record.get(f"{prefix}_team") or record.get("team"))
        team_id = upsert_sports_team(
            connection,
            source=source,
            source_team_id=external_id,
            sport=sport,
            country=country,
            name=name,
            source_url=source_url,
            observed_at=observed_at,
        )
        known_team_ids.add(external_id)
        connection.execute(
            """
            INSERT INTO season_teams (season_id, team_id, first_observed_at, last_observed_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(season_id, team_id) DO UPDATE SET last_observed_at = excluded.last_observed_at
            """,
            (season_id, team_id, observed_at, observed_at),
        )
        return team_id

    standings = [item for item in (capture.get("standings") or []) if isinstance(item, dict)]
    for snapshot in standings:
        for row in snapshot.get("rows") or []:
            if isinstance(row, dict):
                ensure_team(row, "", clean_text(row.get("team_url")))
    for row in matches:
        ensure_team(row, "home")
        ensure_team(row, "away")
        upsert_sports_match(
            connection,
            source=source,
            record=row,
            sport=sport,
            country=country,
            competition_id=competition_id,
            season_id=season_id,
            season=season,
            display_timezone=display_timezone,
            observed_at=observed_at,
        )

    standing_row_count = 0
    for snapshot in standings:
        scope = canonical(snapshot.get("scope")) or "overall"
        cursor = connection.execute(
            """
            INSERT INTO standings_snapshots (capture_id, season_id, scope, observed_at)
            VALUES (?, ?, ?, ?)
            """,
            (capture_id, season_id, scope, observed_at),
        )
        snapshot_id = int(cursor.lastrowid)
        for row in snapshot.get("rows") or []:
            if not isinstance(row, dict):
                continue
            team_id = source_team_id(connection, source, row.get("team_id"))
            if team_id is None:
                continue
            connection.execute(
                """
                INSERT INTO standing_rows (
                    standings_snapshot_id, team_id, rank, played, wins, draws, losses,
                    goals_for, goals_against, goal_difference, points, qualification,
                    form_json, raw_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    snapshot_id,
                    team_id,
                    whole_dollars(row.get("rank"), 0) or None,
                    whole_dollars(row.get("played"), 0),
                    whole_dollars(row.get("wins"), 0),
                    whole_dollars(row.get("draws"), 0),
                    whole_dollars(row.get("losses"), 0),
                    whole_dollars(row.get("goals_for"), 0),
                    whole_dollars(row.get("goals_against"), 0),
                    whole_dollars(row.get("goal_difference"), 0),
                    whole_dollars(row.get("points"), 0),
                    clean_text(row.get("qualification")),
                    json.dumps(row.get("form") or [], ensure_ascii=False, separators=(",", ":")),
                    json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
                ),
            )
            standing_row_count += 1

    stat_count = 0
    h2h_match_count = 0
    details = [item for item in (capture.get("match_details") or []) if isinstance(item, dict)]
    for detail in details:
        context_row = connection.execute(
            "SELECT match_id FROM match_sources WHERE source = ? AND source_match_id = ?",
            (source, clean_text(detail.get("source_match_id"))),
        ).fetchone()
        if not context_row:
            continue
        context_match_id = int(context_row[0])
        for stat_set in detail.get("stats") or []:
            if not isinstance(stat_set, dict):
                continue
            period = canonical(stat_set.get("period")) or "overall"
            for stat in stat_set.get("rows") or []:
                if not isinstance(stat, dict):
                    continue
                home_value, home_numerator, home_denominator = parse_stat_value(stat.get("home_raw"))
                away_value, away_numerator, away_denominator = parse_stat_value(stat.get("away_raw"))
                stat_group = clean_text(stat.get("group"))
                stat_name = clean_text(stat.get("name")) or "Unknown stat"
                connection.execute(
                    """
                    INSERT INTO match_stats (
                        capture_id, match_id, period, stat_group, stat_key, stat_name,
                        home_raw, away_raw, home_value, away_value,
                        home_numerator, home_denominator, away_numerator, away_denominator,
                        observed_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        capture_id,
                        context_match_id,
                        period,
                        stat_group,
                        canonical(stat_name),
                        stat_name,
                        clean_text(stat.get("home_raw")),
                        clean_text(stat.get("away_raw")),
                        home_value,
                        away_value,
                        home_numerator,
                        home_denominator,
                        away_numerator,
                        away_denominator,
                        observed_at,
                    ),
                )
                stat_count += 1
        h2h = detail.get("h2h") if isinstance(detail.get("h2h"), dict) else None
        if h2h:
            left_team_id = source_team_id(connection, source, h2h.get("left_team_id"))
            right_team_id = source_team_id(connection, source, h2h.get("right_team_id"))
            if left_team_id is not None and right_team_id is not None:
                cursor = connection.execute(
                    """
                    INSERT INTO h2h_snapshots (
                        capture_id, context_match_id, left_team_id, right_team_id, scope, observed_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        capture_id,
                        context_match_id,
                        left_team_id,
                        right_team_id,
                        canonical(h2h.get("scope")) or "overall",
                        observed_at,
                    ),
                )
                snapshot_id = int(cursor.lastrowid)
                for ordinal, row in enumerate(h2h.get("matches") or []):
                    if not isinstance(row, dict):
                        continue
                    ensure_team(row, "home")
                    ensure_team(row, "away")
                    competition_name, h2h_country = split_flashscore_competition(row.get("competition"), country)
                    h2h_competition_id = upsert_sports_competition(
                        connection,
                        source=source,
                        sport=sport,
                        country=h2h_country,
                        name=competition_name,
                        source_competition_id=f"{canonical(sport)}:{canonical(h2h_country)}:{canonical(competition_name)}",
                        source_slug="",
                        source_url="",
                        observed_at=observed_at,
                    )
                    match_id = upsert_sports_match(
                        connection,
                        source=source,
                        record=row,
                        sport=sport,
                        country=h2h_country,
                        competition_id=h2h_competition_id,
                        season_id=None,
                        season=None,
                        display_timezone=display_timezone,
                        observed_at=observed_at,
                    )
                    connection.execute(
                        "INSERT INTO h2h_snapshot_matches (h2h_snapshot_id, match_id, ordinal) VALUES (?, ?, ?)",
                        (snapshot_id, match_id, ordinal),
                    )
                    h2h_match_count += 1
    return {
        "captures": 1,
        "competitions": 1,
        "seasons": 1,
        "teams": len(known_team_ids),
        "matches": len(matches),
        "standings": standing_row_count,
        "stats": stat_count,
        "h2h_matches": h2h_match_count,
    }


def import_flashscore_file(connection: sqlite3.Connection, path: Path) -> dict[str, int]:
    if path.name.lower().endswith(".json.gz.b64"):
        compressed = base64.b64decode("".join(path.read_text(encoding="ascii").split()), validate=True)
        payload = json.loads(gzip.decompress(compressed).decode("utf-8-sig"))
    else:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    total: dict[str, int] = {}
    with connection:
        for capture in flashscore_capture_objects(payload):
            merge_counts(total, import_flashscore_capture(connection, capture))
    return total


def market_odds_capture_objects(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        raise ValueError("Market-odds export must be a JSON object.")
    captures = payload.get("captures") if isinstance(payload.get("captures"), list) else [payload]
    if not all(isinstance(capture, dict) for capture in captures):
        raise ValueError("Every market-odds capture must be a JSON object.")
    return captures


def import_market_odds_capture(
    connection: sqlite3.Connection, capture: dict[str, Any]
) -> dict[str, int]:
    if clean_text(capture.get("schema_version")) != MARKET_ODDS_SCHEMA:
        raise ValueError(f"Unsupported market-odds schema; expected {MARKET_ODDS_SCHEMA!r}.")
    capture_id = clean_text(capture.get("capture_id"))
    observed_at = clean_text(capture.get("observed_at"))
    source = clean_text(capture.get("source")) or "visible-market-odds"
    if not capture_id or not observed_at:
        raise ValueError("Every market-odds capture needs capture_id and observed_at.")
    if connection.execute(
        "SELECT 1 FROM reference_capture_runs WHERE capture_id = ?", (capture_id,)
    ).fetchone():
        return {"captures": 0, "matches": 0, "markets": 0, "selections": 0, "odds": 0}
    matches = [row for row in (capture.get("matches") or []) if isinstance(row, dict)]
    raw_json = json.dumps(capture, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    connection.execute(
        """
        INSERT INTO reference_capture_runs (
            capture_id, schema_version, observed_at, source, page_url, display_timezone,
            competition_count, season_count, match_count, imported_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
        """,
        (
            capture_id,
            MARKET_ODDS_SCHEMA,
            observed_at,
            source,
            clean_text(capture.get("page_url")),
            clean_text(capture.get("display_timezone")),
            len(matches),
            utc_now(),
            raw_json,
        ),
    )
    counts = {"captures": 1, "matches": 0, "markets": 0, "selections": 0, "odds": 0}
    default_bookmaker = clean_text(capture.get("bookmaker"))
    for match in matches:
        match_source = clean_text(match.get("match_source")) or source
        source_match_id = clean_text(match.get("source_match_id"))
        match_row = connection.execute(
            "SELECT match_id FROM match_sources WHERE source = ? AND source_match_id = ?",
            (match_source, source_match_id),
        ).fetchone()
        if not match_row:
            raise ValueError(
                f"Odds match {source_match_id!r} is not imported for source {match_source!r}; "
                "import its fixture/results capture first."
            )
        match_id = int(match_row[0])
        counts["matches"] += 1
        for market in (match.get("markets") or []):
            if not isinstance(market, dict):
                continue
            name = clean_text(market.get("name")) or "Unknown market"
            period = clean_text(market.get("period")) or market_period(name) or "full_time"
            market_type = canonical(market.get("market_type")) or classify_market(name)
            source_market_key = clean_text(market.get("source_market_key")) or stable_hash(
                market_type, period, name
            )
            connection.execute(
                """
                INSERT INTO match_markets (
                    match_id, source, source_market_key, name, market_type, period,
                    first_observed_at, last_observed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(match_id, source, source_market_key) DO UPDATE SET
                    name = excluded.name,
                    market_type = excluded.market_type,
                    period = excluded.period,
                    last_observed_at = excluded.last_observed_at
                """,
                (match_id, source, source_market_key, name, market_type, period, observed_at, observed_at),
            )
            market_id = int(
                connection.execute(
                    """
                    SELECT match_market_id FROM match_markets
                    WHERE match_id = ? AND source = ? AND source_market_key = ?
                    """,
                    (match_id, source, source_market_key),
                ).fetchone()[0]
            )
            counts["markets"] += 1
            for selection in (market.get("selections") or []):
                if not isinstance(selection, dict):
                    continue
                selection_name = clean_text(selection.get("name")) or "Unknown selection"
                selection_key = clean_text(selection.get("source_selection_key")) or stable_hash(
                    selection_name, selection.get("handicap"), selection.get("line")
                )
                connection.execute(
                    """
                    INSERT INTO match_market_selections (
                        match_market_id, source_selection_key, name, handicap, line
                    ) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(match_market_id, source_selection_key) DO UPDATE SET
                        name = excluded.name,
                        handicap = COALESCE(excluded.handicap, match_market_selections.handicap),
                        line = COALESCE(excluded.line, match_market_selections.line)
                    """,
                    (
                        market_id,
                        selection_key,
                        selection_name,
                        optional_float(selection.get("handicap")),
                        optional_float(selection.get("line")),
                    ),
                )
                selection_id = int(
                    connection.execute(
                        """
                        SELECT match_selection_id FROM match_market_selections
                        WHERE match_market_id = ? AND source_selection_key = ?
                        """,
                        (market_id, selection_key),
                    ).fetchone()[0]
                )
                counts["selections"] += 1
                odds = optional_float(selection.get("odds_decimal"))
                if odds is None or odds <= 0:
                    continue
                bookmaker = clean_text(selection.get("bookmaker")) or default_bookmaker
                odds_cursor = connection.execute(
                    """
                    INSERT OR IGNORE INTO match_odds_observations (
                        capture_id, match_selection_id, bookmaker, observed_at, odds_decimal, available
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        capture_id,
                        selection_id,
                        bookmaker,
                        clean_text(selection.get("observed_at")) or observed_at,
                        odds,
                        0 if selection.get("available") is False else 1,
                    ),
                )
                counts["odds"] += max(0, odds_cursor.rowcount)
    return counts


def import_market_odds_file(connection: sqlite3.Connection, path: Path) -> dict[str, int]:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    total: dict[str, int] = {}
    with connection:
        for capture in market_odds_capture_objects(payload):
            merge_counts(total, import_market_odds_capture(connection, capture))
    return total


def team_lookup_keys(value: Any) -> set[str]:
    base = canonical(value)
    if not base:
        return set()
    tokens = base.split()
    expanded = ["united" if token == "utd" else token for token in tokens]
    keys = {base, " ".join(expanded)}
    for candidate in list(keys):
        candidate_tokens = candidate.split()
        if candidate_tokens and candidate_tokens[0] == "fc":
            keys.add(" ".join(candidate_tokens[1:]))
        if candidate_tokens and candidate_tokens[-1] == "fc":
            keys.add(" ".join(candidate_tokens[:-1]))
    return {key for key in keys if key}


def build_team_lookup(connection: sqlite3.Connection, sport: str) -> dict[str, set[int]]:
    lookup: dict[str, set[int]] = defaultdict(set)
    sport_key = canonical(sport)
    for row in connection.execute(
        "SELECT team_id, name FROM sports_teams WHERE sport = ?", (sport_key,)
    ):
        for key in team_lookup_keys(row["name"]):
            lookup[key].add(int(row["team_id"]))
    for row in connection.execute(
        """
        SELECT ta.team_id, ta.alias
        FROM team_aliases ta JOIN sports_teams st ON st.team_id = ta.team_id
        WHERE st.sport = ?
        """,
        (sport_key,),
    ):
        for key in team_lookup_keys(row["alias"]):
            lookup[key].add(int(row["team_id"]))
    return lookup


def lookup_team_ids(lookup: dict[str, set[int]], name: Any) -> set[int]:
    team_ids: set[int] = set()
    for key in team_lookup_keys(name):
        team_ids.update(lookup.get(key, set()))
    return team_ids


def team_name_similarity(left: Any, right: Any) -> float:
    left_keys = team_lookup_keys(left)
    right_keys = team_lookup_keys(right)
    if not left_keys or not right_keys:
        return 0.0
    best = max(SequenceMatcher(None, a, b).ratio() for a in left_keys for b in right_keys)
    for a in left_keys:
        for b in right_keys:
            a_initials = "".join(token[0] for token in a.split() if token)
            b_initials = "".join(token[0] for token in b.split() if token)
            if a == b_initials or b == a_initials:
                best = 1.0
    return round(best, 6)


def competition_alias_compatible(
    event_league: Any,
    provider_competition: Any,
    provider_country: Any,
    known_countries: set[str],
) -> bool:
    event_key = canonical(event_league)
    _, jurisdiction = split_torn_league_label(event_league)
    jurisdiction_key = canonical(jurisdiction)
    competition_key = canonical(provider_competition)
    country_key = canonical(provider_country)
    country_aliases = {
        "uae": "united arab emirates",
        "us": "usa",
        "united states": "usa",
        "faroe islands": "faroe islands",
    }
    country_key = country_aliases.get(country_key, country_key)
    event_country = ""
    for candidate in sorted(known_countries | set(country_aliases), key=len, reverse=True):
        normalized_candidate = country_aliases.get(candidate, candidate)
        if jurisdiction_key == candidate or jurisdiction_key.startswith(candidate + " "):
            event_country = normalized_candidate
            break
    if event_country and country_key and event_country != country_key:
        return False
    event_is_women = any(token in event_key for token in ("female", "women", "femenil", "feminine"))
    provider_is_women = any(
        token in competition_key for token in ("female", "women", "femenil", "feminine")
    )
    if event_is_women != provider_is_women:
        return False
    event_youth = set(re.findall(r"\bu\s*(\d{2})\b", event_key))
    provider_youth = set(re.findall(r"\bu\s*(\d{2})\b", competition_key))
    if event_youth != provider_youth and (event_youth or provider_youth):
        return False
    return True


def build_team_alias_audit(
    connection: sqlite3.Connection,
    *,
    sport: str = "football",
    max_time_gap_hours: float = 6.0,
) -> dict[str, Any]:
    """Find evidence-backed Torn aliases without accepting two-name fuzzy matches."""
    if max_time_gap_hours <= 0:
        raise ValueError("max_time_gap_hours must be positive.")
    sport_key = canonical(sport)
    lookup = build_team_lookup(connection, sport_key)
    teams = {
        int(row["team_id"]): clean_text(row["name"])
        for row in connection.execute(
            "SELECT team_id, name FROM sports_teams WHERE sport = ?", (sport_key,)
        )
    }
    matches_by_home: dict[int, list[dict[str, Any]]] = defaultdict(list)
    matches_by_away: dict[int, list[dict[str, Any]]] = defaultdict(list)
    matches_by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    known_countries = {
        canonical(row["country"])
        for row in connection.execute("SELECT DISTINCT country FROM sports_competitions")
        if canonical(row["country"])
    }
    match_rows = connection.execute(
        """
        SELECT sm.match_id, sm.home_team_id, sm.away_team_id, sm.scheduled_at,
               sm.scheduled_date, sm.status, ht.name AS home_name, at.name AS away_name,
               COALESCE(sc.name, '') AS competition, COALESCE(sc.country, '') AS competition_country
        FROM sports_matches sm
        JOIN sports_teams ht ON ht.team_id = sm.home_team_id
        JOIN sports_teams at ON at.team_id = sm.away_team_id
        LEFT JOIN sports_competitions sc ON sc.competition_id = sm.competition_id
        WHERE sm.sport = ? AND sm.scheduled_at IS NOT NULL
          AND sm.status NOT IN ('cancelled', 'postponed')
        """,
        (sport_key,),
    ).fetchall()
    for row in match_rows:
        match_time = parse_iso_datetime(row["scheduled_at"])
        if match_time is None:
            continue
        item = {
            "match_id": int(row["match_id"]),
            "home_team_id": int(row["home_team_id"]),
            "away_team_id": int(row["away_team_id"]),
            "home_name": clean_text(row["home_name"]),
            "away_name": clean_text(row["away_name"]),
            "competition": clean_text(row["competition"]),
            "competition_country": clean_text(row["competition_country"]),
            "scheduled_at": match_time.isoformat().replace("+00:00", "Z"),
            "match_time": match_time,
        }
        matches_by_home[item["home_team_id"]].append(item)
        matches_by_away[item["away_team_id"]].append(item)
        matches_by_date[match_time.date().isoformat()].append(item)

    suggestions: dict[str, dict[int, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    review_matches: list[dict[str, Any]] = []
    counts = {
        "events_scanned": 0,
        "one_anchor_events": 0,
        "two_unknown_events": 0,
        "already_resolvable_events": 0,
        "no_timing_evidence": 0,
    }
    events = connection.execute(
        """
        SELECT e.event_id, e.event_uid, e.home_team, e.away_team, e.league,
               e.scheduled_at, e.settled_at
        FROM events e
        WHERE e.sport = ?
          AND e.home_team <> '' AND e.away_team <> ''
          AND EXISTS (SELECT 1 FROM bets b WHERE b.event_id = e.event_id)
          AND NOT EXISTS (
              SELECT 1 FROM event_match_links eml
              WHERE eml.event_id = e.event_id AND eml.confirmed = 1
          )
        ORDER BY COALESCE(e.scheduled_at, e.settled_at), e.event_id
        """,
        (sport_key,),
    ).fetchall()
    max_seconds = max_time_gap_hours * 3600
    for event in events:
        counts["events_scanned"] += 1
        event_time = parse_iso_datetime(event["scheduled_at"] or event["settled_at"])
        if event_time is None:
            counts["no_timing_evidence"] += 1
            continue
        home_ids = lookup_team_ids(lookup, event["home_team"])
        away_ids = lookup_team_ids(lookup, event["away_team"])
        if home_ids and away_ids:
            counts["already_resolvable_events"] += 1
            continue
        anchor_side = ""
        anchor_id: int | None = None
        unknown_alias = ""
        candidate_rows: list[dict[str, Any]] = []
        if len(home_ids) == 1 and not away_ids:
            anchor_side = "home"
            anchor_id = next(iter(home_ids))
            unknown_alias = clean_text(event["away_team"])
            candidate_rows = matches_by_home.get(anchor_id, [])
        elif len(away_ids) == 1 and not home_ids:
            anchor_side = "away"
            anchor_id = next(iter(away_ids))
            unknown_alias = clean_text(event["home_team"])
            candidate_rows = matches_by_away.get(anchor_id, [])
        if anchor_id is not None:
            counts["one_anchor_events"] += 1
            timed = []
            for match in candidate_rows:
                delta = abs((event_time - match["match_time"]).total_seconds())
                if delta <= max_seconds:
                    timed.append((delta, match))
            opponents: dict[int, list[tuple[float, dict[str, Any]]]] = defaultdict(list)
            for delta, match in timed:
                opponent_id = (
                    int(match["away_team_id"]) if anchor_side == "home" else int(match["home_team_id"])
                )
                opponents[opponent_id].append((delta, match))
            if len(opponents) == 1:
                opponent_id, evidence_rows = next(iter(opponents.items()))
                evidence_rows.sort(key=lambda item: (item[0], item[1]["match_id"]))
                best_delta, best_match = evidence_rows[0]
                suggestions[canonical(unknown_alias)][opponent_id].append(
                    {
                        "event_id": int(event["event_id"]),
                        "event_uid": clean_text(event["event_uid"]),
                        "event_league": clean_text(event["league"]),
                        "event_time": event_time.isoformat().replace("+00:00", "Z"),
                        "anchor_side": anchor_side,
                        "anchor_team_id": anchor_id,
                        "anchor_team": teams.get(anchor_id, ""),
                        "match_ids": [int(item[1]["match_id"]) for item in evidence_rows],
                        "provider_team_id": opponent_id,
                        "provider_team": teams.get(opponent_id, ""),
                        "provider_competition": best_match["competition"],
                        "provider_country": best_match["competition_country"],
                        "provider_time": best_match["scheduled_at"],
                        "time_gap_minutes": round(best_delta / 60, 2),
                        "confidence": 0.995 if best_delta <= 4 * 3600 else 0.99,
                    }
                )
            elif timed:
                review_matches.append(
                    {
                        "event_id": int(event["event_id"]),
                        "home_team": clean_text(event["home_team"]),
                        "away_team": clean_text(event["away_team"]),
                        "event_league": clean_text(event["league"]),
                        "review_reason": "one known team but multiple provider opponents in the time window",
                        "candidate_match_ids": sorted(int(match["match_id"]) for _, match in timed),
                    }
                )
            continue

        if not home_ids and not away_ids:
            counts["two_unknown_events"] += 1
            nearby: list[tuple[float, dict[str, Any]]] = []
            for offset in (-1, 0, 1):
                day = (event_time + timedelta(days=offset)).date().isoformat()
                for match in matches_by_date.get(day, []):
                    delta = abs((event_time - match["match_time"]).total_seconds())
                    if delta <= max_seconds:
                        nearby.append((delta, match))
            scored: list[tuple[float, float, float, float, dict[str, Any]]] = []
            for delta, match in nearby:
                home_score = team_name_similarity(event["home_team"], match["home_name"])
                away_score = team_name_similarity(event["away_team"], match["away_name"])
                combined = (home_score + away_score) / 2
                if home_score >= 0.5 and away_score >= 0.5 and combined >= 0.7:
                    scored.append((combined, home_score, away_score, delta, match))
            scored.sort(key=lambda item: (-item[0], item[3], item[4]["match_id"]))
            if scored:
                top = scored[0]
                margin = top[0] - scored[1][0] if len(scored) > 1 else top[0]
                if margin >= 0.08:
                    match = top[4]
                    review_matches.append(
                        {
                            "event_id": int(event["event_id"]),
                            "home_team": clean_text(event["home_team"]),
                            "away_team": clean_text(event["away_team"]),
                            "event_league": clean_text(event["league"]),
                            "review_reason": "both team names require fuzzy review",
                            "candidate_match_id": int(match["match_id"]),
                            "provider_home_team_id": int(match["home_team_id"]),
                            "provider_home_team": match["home_name"],
                            "provider_away_team_id": int(match["away_team_id"]),
                            "provider_away_team": match["away_name"],
                            "provider_competition": match["competition"],
                            "home_similarity": top[1],
                            "away_similarity": top[2],
                            "combined_similarity": round(top[0], 6),
                            "candidate_margin": round(margin, 6),
                            "time_gap_minutes": round(top[3] / 60, 2),
                        }
                    )

    automatic: list[dict[str, Any]] = []
    conflicts: list[dict[str, Any]] = []
    for alias_key, candidates in suggestions.items():
        if not alias_key:
            continue
        if len(candidates) != 1:
            conflicts.append(
                {
                    "canonical_alias": alias_key,
                    "candidate_team_ids": sorted(candidates),
                    "event_ids": sorted(
                        evidence["event_id"]
                        for rows in candidates.values()
                        for evidence in rows
                    ),
                }
            )
            continue
        team_id, evidence = next(iter(candidates.items()))
        evidence.sort(key=lambda item: (item["event_id"], item["match_ids"]))
        aliases = []
        for item in evidence:
            event_row = next((row for row in events if int(row["event_id"]) == item["event_id"]), None)
            if event_row is not None:
                value = clean_text(
                    event_row["away_team"] if item["anchor_side"] == "home" else event_row["home_team"]
                )
                if value and value not in aliases:
                    aliases.append(value)
        alias = aliases[0] if aliases else alias_key
        similarity = team_name_similarity(alias, teams.get(team_id, ""))
        competition_compatible = all(
            competition_alias_compatible(
                item["event_league"],
                item["provider_competition"],
                item["provider_country"],
                known_countries,
            )
            for item in evidence
        )
        if not competition_compatible or (len(evidence) < 2 and similarity < 0.68):
            review_matches.append(
                {
                    "event_id": int(evidence[0]["event_id"]),
                    "event_ids": [int(item["event_id"]) for item in evidence],
                    "alias": alias,
                    "provider_team_id": team_id,
                    "provider_team": teams.get(team_id, ""),
                    "review_reason": (
                        "competition country/gender/youth mismatch"
                        if not competition_compatible
                        else "one-event alias has weak name similarity"
                    ),
                    "name_similarity": similarity,
                    "evidence_count": len(evidence),
                    "evidence": evidence,
                }
            )
            continue
        automatic.append(
            {
                "alias": alias,
                "canonical_alias": alias_key,
                "team_id": team_id,
                "provider_team": teams.get(team_id, ""),
                "rule": "unique-opponent/known-side/six-hour-window",
                "confidence": min(float(item["confidence"]) for item in evidence),
                "name_similarity": similarity,
                "evidence_count": len(evidence),
                "evidence": evidence,
            }
        )
    automatic.sort(key=lambda item: (-int(item["evidence_count"]), item["canonical_alias"]))
    conflicts.sort(key=lambda item: item["canonical_alias"])
    review_matches.sort(key=lambda item: int(item["event_id"]))
    return {
        "schema_version": "bmg.team-alias-audit.v1",
        "observed_at": utc_now(),
        "sport": sport_key,
        "policy": {
            "automatic": "one uniquely mapped side, same role and provider opponent within six hours, compatible competition scope, plus repeated events or name similarity >= 0.68",
            "review_only": "both team names fuzzy or more than one provider opponent",
        },
        "summary": {
            **counts,
            "automatic_aliases": len(automatic),
            "automatic_evidence_events": sum(int(item["evidence_count"]) for item in automatic),
            "review_matches": len(review_matches),
            "conflicts": len(conflicts),
        },
        "automatic_aliases": automatic,
        "review_matches": review_matches,
        "conflicts": conflicts,
    }


def apply_team_alias_audit(connection: sqlite3.Connection, audit: dict[str, Any]) -> dict[str, int]:
    if audit.get("schema_version") != "bmg.team-alias-audit.v1":
        raise ValueError("Unsupported team-alias audit schema.")
    sport = canonical(audit.get("sport"))
    if not sport:
        raise ValueError("Team-alias audit has no sport.")
    current = build_team_alias_audit(connection, sport=sport)
    current_candidates = {
        (str(item["canonical_alias"]), int(item["team_id"])): item
        for item in (current.get("automatic_aliases") or [])
        if isinstance(item, dict)
    }
    counts = {"aliases": 0, "existing": 0, "evidence": 0}
    with connection:
        for item in audit.get("automatic_aliases") or []:
            if not isinstance(item, dict):
                raise ValueError("Automatic team-alias entries must be objects.")
            alias = clean_text(item.get("alias"))
            alias_key = canonical(alias)
            team_id = int(item.get("team_id"))
            if alias_key != clean_text(item.get("canonical_alias")):
                raise ValueError(f"Team alias canonical form drifted: {alias}")
            team_row = connection.execute(
                "SELECT name FROM sports_teams WHERE team_id = ? AND sport = ?", (team_id, sport)
            ).fetchone()
            if team_row is None or clean_text(team_row["name"]) != clean_text(item.get("provider_team")):
                raise ValueError(f"Provider team drifted for alias: {alias}")
            existing_ids = lookup_team_ids(build_team_lookup(connection, sport), alias)
            already_applied = team_id in existing_ids
            if existing_ids and existing_ids != {team_id}:
                raise ValueError(f"Alias already resolves to a different or ambiguous team: {alias}")
            if not already_applied and (alias_key, team_id) not in current_candidates:
                raise ValueError(f"Alias evidence no longer reproduces against the current database: {alias}")
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO team_aliases (team_id, source, alias, canonical_alias)
                VALUES (?, 'torn-evidence-bridge', ?, ?)
                """,
                (team_id, alias, alias_key),
            )
            counts["aliases"] += max(0, cursor.rowcount)
            counts["existing"] += 1 if cursor.rowcount == 0 else 0
            alias_row = connection.execute(
                """
                SELECT team_alias_id FROM team_aliases
                WHERE team_id = ? AND source = 'torn-evidence-bridge' AND canonical_alias = ?
                """,
                (team_id, alias_key),
            ).fetchone()
            if alias_row is None:
                raise ValueError(f"Could not persist alias: {alias}")
            for evidence in item.get("evidence") or []:
                event_id = int(evidence["event_id"])
                confidence = float(evidence["confidence"])
                for match_id in evidence.get("match_ids") or []:
                    raw_json = json.dumps(
                        evidence, ensure_ascii=False, sort_keys=True, separators=(",", ":")
                    )
                    evidence_cursor = connection.execute(
                        """
                        INSERT OR IGNORE INTO team_alias_evidence (
                            team_alias_id, event_id, match_id, rule, confidence, observed_at, raw_json
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            int(alias_row["team_alias_id"]),
                            event_id,
                            int(match_id),
                            clean_text(item.get("rule")),
                            confidence,
                            utc_now(),
                            raw_json,
                        ),
                    )
                    counts["evidence"] += max(0, evidence_cursor.rowcount)
    return counts


def apply_reviewed_event_match_decisions(
    connection: sqlite3.Connection, registry: dict[str, Any]
) -> dict[str, int]:
    """Apply explicit event/match decisions after verifying every stored identity field."""
    if registry.get("schema_version") != "bmg.event-match-reviewed-decisions.v1":
        raise ValueError("Unsupported event-match review registry schema.")
    decisions = registry.get("decisions")
    if not isinstance(decisions, list):
        raise ValueError("Event-match review registry decisions must be a list.")

    counts = {"confirmed": 0, "existing": 0, "rejected": 0}
    seen_events: set[int] = set()
    with connection:
        for item in decisions:
            if not isinstance(item, dict):
                raise ValueError("Event-match review decisions must be objects.")
            event_id = int(item.get("event_id"))
            match_id = int(item.get("match_id"))
            decision = canonical(item.get("decision"))
            reason = clean_text(item.get("reason"))
            if event_id in seen_events:
                raise ValueError(f"Duplicate reviewed event_id: {event_id}")
            seen_events.add(event_id)
            if decision not in {"confirmed", "rejected"}:
                raise ValueError(f"Unsupported review decision for event {event_id}: {decision}")
            if not reason:
                raise ValueError(f"Review decision has no rationale for event {event_id}.")

            event = connection.execute(
                """
                SELECT event_id, home_team, away_team, league,
                       COALESCE(scheduled_at, settled_at, '') AS event_time
                FROM events WHERE event_id = ?
                """,
                (event_id,),
            ).fetchone()
            provider = connection.execute(
                """
                SELECT sm.match_id, sm.home_team_id, ht.name AS home_team,
                       sm.away_team_id, at.name AS away_team,
                       COALESCE(sc.name, '') AS competition,
                       COALESCE(sc.country, '') AS country,
                       COALESCE(sm.scheduled_at, '') AS scheduled_at,
                       ms.source, ms.source_match_id
                FROM sports_matches sm
                JOIN sports_teams ht ON ht.team_id = sm.home_team_id
                JOIN sports_teams at ON at.team_id = sm.away_team_id
                LEFT JOIN sports_competitions sc ON sc.competition_id = sm.competition_id
                JOIN match_sources ms ON ms.match_id = sm.match_id
                WHERE sm.match_id = ? AND ms.source = ?
                """,
                (match_id, clean_text((item.get("provider") or {}).get("source"))),
            ).fetchone()
            if event is None:
                raise ValueError(f"Reviewed Torn event no longer exists: {event_id}")
            if provider is None:
                raise ValueError(f"Reviewed provider match no longer exists: {match_id}")

            expected_event = item.get("event")
            expected_provider = item.get("provider")
            if not isinstance(expected_event, dict) or not isinstance(expected_provider, dict):
                raise ValueError(f"Review decision snapshots are missing for event {event_id}.")
            event_fields = ("home_team", "away_team", "league", "event_time")
            provider_text_fields = (
                "source", "source_match_id", "home_team", "away_team",
                "competition", "country", "scheduled_at",
            )
            for field in event_fields:
                if clean_text(event[field]) != clean_text(expected_event.get(field)):
                    raise ValueError(f"Reviewed event {event_id} drifted at {field}.")
            for field in provider_text_fields:
                if clean_text(provider[field]) != clean_text(expected_provider.get(field)):
                    raise ValueError(f"Reviewed match {match_id} drifted at {field}.")
            for field in ("home_team_id", "away_team_id"):
                if int(provider[field]) != int(expected_provider.get(field)):
                    raise ValueError(f"Reviewed match {match_id} drifted at {field}.")

            if decision == "rejected":
                counts["rejected"] += 1
                continue

            known_countries = {
                canonical(row["country"])
                for row in connection.execute("SELECT DISTINCT country FROM sports_competitions")
                if canonical(row["country"])
            }
            if not competition_alias_compatible(
                event["league"], provider["competition"], provider["country"], known_countries
            ):
                raise ValueError(
                    f"Confirmed review fails the country/gender/youth scope guard: event {event_id}."
                )
            event_time = parse_iso_datetime(event["event_time"])
            provider_time = parse_iso_datetime(provider["scheduled_at"])
            if event_time is None or provider_time is None:
                raise ValueError(f"Confirmed review has no comparable kickoff time: event {event_id}.")
            if abs((event_time - provider_time).total_seconds()) > 6 * 3600:
                raise ValueError(f"Confirmed review exceeds the six-hour guard: event {event_id}.")

            conflicting_event_link = connection.execute(
                """
                SELECT match_id FROM event_match_links
                WHERE event_id = ? AND confirmed = 1 AND match_id <> ?
                """,
                (event_id, match_id),
            ).fetchone()
            if conflicting_event_link is not None:
                raise ValueError(f"Event {event_id} is already confirmed to another match.")
            conflicting_match_link = connection.execute(
                """
                SELECT event_id FROM event_match_links
                WHERE match_id = ? AND confirmed = 1 AND event_id <> ?
                """,
                (match_id, event_id),
            ).fetchone()
            if conflicting_match_link is not None:
                raise ValueError(f"Match {match_id} is already confirmed to another Torn event.")
            existing = connection.execute(
                """
                SELECT confirmed FROM event_match_links
                WHERE event_id = ? AND match_id = ?
                """,
                (event_id, match_id),
            ).fetchone()
            if existing is not None and int(existing["confirmed"]) == 1:
                counts["existing"] += 1
                continue
            connection.execute(
                """
                INSERT INTO event_match_links (
                    event_id, match_id, link_method, confidence, confirmed, linked_at
                ) VALUES (?, ?, 'reviewed-registry/name-role-time', 0.995, 1, ?)
                ON CONFLICT(event_id, match_id) DO UPDATE SET
                    link_method = excluded.link_method,
                    confidence = excluded.confidence,
                    confirmed = excluded.confirmed,
                    linked_at = excluded.linked_at
                """,
                (event_id, match_id, utc_now()),
            )
            counts["confirmed"] += 1
    return counts


def parse_iso_date(value: Any) -> datetime | None:
    text = clean_text(value)
    if not text:
        return None
    try:
        return datetime.fromisoformat(text[:10])
    except ValueError:
        return None


def parse_iso_datetime(value: Any) -> datetime | None:
    text = clean_text(value)
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def reconcile_event_matches(
    connection: sqlite3.Connection,
    *,
    sport: str = "football",
    max_day_gap: int = 1,
    confirm_exact: bool = False,
) -> dict[str, int]:
    if max_day_gap < 0:
        raise ValueError("max_day_gap cannot be negative.")
    team_map = build_team_lookup(connection, sport)

    counts = {"events_scanned": 0, "unmapped": 0, "candidates": 0, "confirmed": 0}
    events = connection.execute(
        """
        SELECT * FROM events
        WHERE sport = ? AND home_team <> '' AND away_team <> ''
        ORDER BY COALESCE(scheduled_at, settled_at), event_id
        """,
        (canonical(sport),),
    ).fetchall()
    for event in events:
        counts["events_scanned"] += 1
        home_ids = lookup_team_ids(team_map, event["home_team"])
        away_ids = lookup_team_ids(team_map, event["away_team"])
        event_time = parse_iso_datetime(event["scheduled_at"] or event["settled_at"])
        event_date = parse_iso_date(event["scheduled_at"] or event["settled_at"])
        if not home_ids or not away_ids or event_date is None:
            counts["unmapped"] += 1
            continue
        placeholders_home = ",".join("?" for _ in home_ids)
        placeholders_away = ",".join("?" for _ in away_ids)
        rows = connection.execute(
            f"""
            SELECT sm.match_id, sm.scheduled_at, sm.scheduled_date, sc.name AS competition
            FROM sports_matches sm
            LEFT JOIN sports_competitions sc ON sc.competition_id = sm.competition_id
            WHERE sm.home_team_id IN ({placeholders_home})
              AND sm.away_team_id IN ({placeholders_away})
              AND COALESCE(sm.scheduled_date, substr(sm.scheduled_at, 1, 10)) IS NOT NULL
            """,
            (*sorted(home_ids), *sorted(away_ids)),
        ).fetchall()
        candidates: list[tuple[int, sqlite3.Row, bool, bool]] = []
        for row in rows:
            # Torn's finished timestamp is UTC. Prefer an exact provider UTC kickoff
            # when available so a late local match is not treated as a one-day miss.
            match_date = parse_iso_date(row["scheduled_at"] or row["scheduled_date"])
            if match_date is None:
                continue
            gap = abs((match_date.date() - event_date.date()).days)
            if gap > max_day_gap:
                continue
            league_key = canonical(event["league"])
            competition_key = canonical(row["competition"])
            league_matches = bool(competition_key and competition_key in league_key)
            match_time = parse_iso_datetime(row["scheduled_at"])
            time_aligned = bool(
                event_time is not None
                and match_time is not None
                and abs((event_time - match_time).total_seconds()) <= 6 * 3600
            )
            candidates.append((gap, row, league_matches, time_aligned))
        if not candidates:
            counts["unmapped"] += 1
            continue
        candidates.sort(key=lambda item: (item[0], 0 if item[2] else 1, int(item[1]["match_id"])))
        best_gap, _, best_league, _ = candidates[0]
        best = [item for item in candidates if item[0] == best_gap and item[2] == best_league]
        for gap, row, league_matches, time_aligned in candidates:
            exact = gap == 0 or time_aligned
            confidence = 0.99 if exact and league_matches else 0.96 if exact else 0.88
            should_confirm = confirm_exact and exact and len(best) == 1 and int(best[0][1]["match_id"]) == int(row["match_id"])
            connection.execute(
                """
                INSERT INTO event_match_links (
                    event_id, match_id, link_method, confidence, confirmed, linked_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(event_id, match_id) DO UPDATE SET
                    link_method = excluded.link_method,
                    confidence = MAX(event_match_links.confidence, excluded.confidence),
                    confirmed = MAX(event_match_links.confirmed, excluded.confirmed),
                    linked_at = excluded.linked_at
                """,
                (
                    int(event["event_id"]),
                    int(row["match_id"]),
                    "exact-team-alias/" + ("time" if time_aligned else "date")
                    + ("/competition" if league_matches else ""),
                    confidence,
                    1 if should_confirm else 0,
                    utc_now(),
                ),
            )
            counts["candidates"] += 1
            if should_confirm:
                counts["confirmed"] += 1
    connection.commit()
    return counts


def sync_confirmed_outcomes(connection: sqlite3.Connection) -> dict[str, int]:
    rows = connection.execute(
        """
        SELECT e.event_id, e.event_uid, sm.match_id, sm.status, sm.home_score, sm.away_score,
               sm.last_observed_at, ms.source, ms.source_match_id, ms.source_url
        FROM event_match_links eml
        JOIN events e ON e.event_id = eml.event_id
        JOIN sports_matches sm ON sm.match_id = eml.match_id
        LEFT JOIN match_sources ms ON ms.match_id = sm.match_id
        WHERE eml.confirmed = 1
          AND sm.status = 'finished'
          AND sm.home_score IS NOT NULL
          AND sm.away_score IS NOT NULL
        ORDER BY e.event_id, ms.source
        """
    ).fetchall()
    counts = {"eligible": 0, "captures": 0, "outcomes": 0}
    seen_pairs: set[tuple[int, int]] = set()
    for row in rows:
        pair = (int(row["event_id"]), int(row["match_id"]))
        if pair in seen_pairs:
            continue
        seen_pairs.add(pair)
        counts["eligible"] += 1
        capture_id = "outcome-reconciliation:" + stable_hash(
            row["event_uid"], row["match_id"], row["home_score"], row["away_score"], row["status"]
        )
        observed_at = clean_text(row["last_observed_at"]) or utc_now()
        evidence = {
            "schema_version": "bmg.outcome-reconciliation.v1",
            "event_uid": row["event_uid"],
            "match_id": row["match_id"],
            "source": row["source"],
            "source_match_id": row["source_match_id"],
            "source_url": row["source_url"],
            "home_score": row["home_score"],
            "away_score": row["away_score"],
        }
        cursor = connection.execute(
            """
            INSERT OR IGNORE INTO capture_runs (
                capture_id, schema_version, observed_at, source, page_url, page_hash,
                event_count, bet_count, imported_at, raw_json
            ) VALUES (?, 'bmg.outcome-reconciliation.v1', ?, 'confirmed-reference-link', ?, '', 1, 0, ?, ?)
            """,
            (
                capture_id,
                observed_at,
                clean_text(row["source_url"]),
                utc_now(),
                json.dumps(evidence, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
            ),
        )
        counts["captures"] += max(0, cursor.rowcount)
        winner = "draw"
        if float(row["home_score"]) > float(row["away_score"]):
            winner = "home"
        elif float(row["away_score"]) > float(row["home_score"]):
            winner = "away"
        outcome_cursor = connection.execute(
            """
            INSERT OR IGNORE INTO event_outcomes (
                capture_id, event_id, observed_at, status, home_score, away_score, winner, raw_score
            ) VALUES (?, ?, ?, 'finished', ?, ?, ?, ?)
            """,
            (
                capture_id,
                int(row["event_id"]),
                observed_at,
                float(row["home_score"]),
                float(row["away_score"]),
                winner,
                f"{row['home_score']}-{row['away_score']}",
            ),
        )
        counts["outcomes"] += max(0, outcome_cursor.rowcount)
        connection.execute(
            "INSERT OR IGNORE INTO capture_events (capture_id, event_id, captured_as_complete) VALUES (?, ?, 1)",
            (capture_id, int(row["event_id"])),
        )
    connection.commit()
    return counts


def create_research_slate(
    connection: sqlite3.Connection,
    capture_id: str,
    *,
    slate_id: str | None = None,
    sport: str = "football",
    capture_complete: bool = False,
    note: str = "",
) -> dict[str, int | str]:
    capture = connection.execute(
        "SELECT capture_id, source, observed_at FROM capture_runs WHERE capture_id = ?", (capture_id,)
    ).fetchone()
    if not capture:
        raise ValueError(f"Unknown Torn capture_id {capture_id!r}.")
    rows = connection.execute(
        """
        SELECT ce.event_id,
               (SELECT eml.match_id FROM event_match_links eml
                WHERE eml.event_id = ce.event_id
                ORDER BY eml.confirmed DESC, eml.confidence DESC, eml.match_id LIMIT 1) AS match_id,
               (SELECT eml.confirmed FROM event_match_links eml
                WHERE eml.event_id = ce.event_id
                ORDER BY eml.confirmed DESC, eml.confidence DESC, eml.match_id LIMIT 1) AS confirmed
        FROM capture_events ce JOIN events e ON e.event_id = ce.event_id
        WHERE ce.capture_id = ? AND e.sport = ?
        ORDER BY ce.event_id
        """,
        (capture_id, canonical(sport)),
    ).fetchall()
    if not rows:
        raise ValueError("That capture has no matching slate events.")
    final_slate_id = clean_text(slate_id) or f"slate:{capture_id}:{canonical(sport)}"
    with connection:
        connection.execute(
            """
            INSERT INTO research_slates (
                slate_id, source, sport, observed_at, capture_complete, event_count, created_at, note
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(slate_id) DO UPDATE SET
                capture_complete = MAX(research_slates.capture_complete, excluded.capture_complete),
                event_count = excluded.event_count,
                note = CASE WHEN excluded.note <> '' THEN excluded.note ELSE research_slates.note END
            """,
            (
                final_slate_id,
                capture["source"],
                canonical(sport),
                capture["observed_at"],
                1 if capture_complete else 0,
                len(rows),
                utc_now(),
                clean_text(note),
            ),
        )
        for row in rows:
            status = "unmapped" if row["match_id"] is None else "confirmed" if row["confirmed"] else "candidate"
            connection.execute(
                """
                INSERT INTO research_slate_events (
                    slate_id, event_id, capture_id, match_id, mapping_status
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(slate_id, event_id) DO UPDATE SET
                    capture_id = excluded.capture_id,
                    match_id = excluded.match_id,
                    mapping_status = excluded.mapping_status
                """,
                (final_slate_id, int(row["event_id"]), capture_id, row["match_id"], status),
            )
    return {"slate_id": final_slate_id, "events": len(rows)}


def register_model_version(connection: sqlite3.Connection, args: argparse.Namespace) -> None:
    feature_spec = json.loads(args.feature_spec)
    if not isinstance(feature_spec, dict):
        raise ValueError("--feature-spec must be a JSON object.")
    with connection:
        if args.active:
            connection.execute("UPDATE model_versions SET active = 0 WHERE sport = ?", (canonical(args.sport),))
        connection.execute(
            """
            INSERT INTO model_versions (
                name, version, sport, algorithm, feature_spec_json, training_cutoff,
                created_at, active, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(name, version) DO UPDATE SET
                algorithm = excluded.algorithm,
                feature_spec_json = excluded.feature_spec_json,
                training_cutoff = excluded.training_cutoff,
                active = excluded.active,
                notes = excluded.notes
            """,
            (
                clean_text(args.name),
                clean_text(args.version),
                canonical(args.sport),
                clean_text(args.algorithm),
                json.dumps(feature_spec, sort_keys=True, separators=(",", ":")),
                clean_text(args.training_cutoff) or None,
                utc_now(),
                1 if args.active else 0,
                clean_text(args.notes),
            ),
        )
    print(f"Registered model {args.name} {args.version}{' (active)' if args.active else ''}.")


def resolve_review_date(connection: sqlite3.Connection, value: str | None, sport: str) -> str:
    if value:
        try:
            return datetime.strptime(value, "%Y-%m-%d").date().isoformat()
        except ValueError as exc:
            raise ValueError("--date must use YYYY-MM-DD.") from exc
    row = connection.execute(
        """
        SELECT MAX(substr(observed_at, 1, 10))
        FROM research_slates
        WHERE sport = ? AND source <> 'bmg-daily-aggregate'
        """,
        (canonical(sport),),
    ).fetchone()
    if not row or not row[0]:
        raise ValueError("No research slate exists for that sport; capture and register one first.")
    return str(row[0])


def create_daily_research_slate(
    connection: sqlite3.Connection,
    *,
    review_date: str,
    sport: str = "football",
) -> dict[str, Any]:
    """Freeze the latest capture of every event registered on one UTC date."""
    resolved_date = resolve_review_date(connection, review_date, sport)
    rows = connection.execute(
        """
        WITH candidates AS (
            SELECT rse.event_id, rse.capture_id, rse.match_id, rse.mapping_status,
                   rs.observed_at, rs.capture_complete,
                   ROW_NUMBER() OVER (
                       PARTITION BY rse.event_id
                       ORDER BY rs.observed_at DESC, rs.slate_id DESC
                   ) AS rank_number
            FROM research_slates rs
            JOIN research_slate_events rse ON rse.slate_id = rs.slate_id
            WHERE rs.sport = ?
              AND substr(rs.observed_at, 1, 10) = ?
              AND rs.source <> 'bmg-daily-aggregate'
        )
        SELECT * FROM candidates WHERE rank_number = 1 ORDER BY event_id
        """,
        (canonical(sport), resolved_date),
    ).fetchall()
    if not rows:
        raise ValueError(f"No {sport} research slates were recorded on {resolved_date}.")
    membership = [
        [int(row["event_id"]), row["capture_id"], row["match_id"], row["mapping_status"]]
        for row in rows
    ]
    membership_hash = hashlib.sha256(
        json.dumps(membership, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:12]
    slate_id = f"slate:daily:{resolved_date}:{canonical(sport)}:{membership_hash}"
    observed_at = max(str(row["observed_at"]) for row in rows)
    capture_complete = int(all(bool(row["capture_complete"]) for row in rows))
    now = utc_now()
    with connection:
        connection.execute(
            """
            INSERT OR IGNORE INTO research_slates (
                slate_id, source, sport, observed_at, capture_complete,
                event_count, created_at, note
            ) VALUES (?, 'bmg-daily-aggregate', ?, ?, ?, ?, ?, ?)
            """,
            (
                slate_id,
                canonical(sport),
                observed_at,
                capture_complete,
                len(rows),
                now,
                f"Frozen daily aggregate for {resolved_date}; each event retains its own source capture.",
            ),
        )
        for row in rows:
            connection.execute(
                """
                INSERT OR IGNORE INTO research_slate_events (
                    slate_id, event_id, capture_id, match_id, mapping_status
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    slate_id,
                    int(row["event_id"]),
                    row["capture_id"],
                    row["match_id"],
                    row["mapping_status"],
                ),
            )
    return {
        "slate_id": slate_id,
        "review_date": resolved_date,
        "observed_at": observed_at,
        "capture_complete": capture_complete,
        "events": len(rows),
    }


def ensure_consensus_benchmark_model(connection: sqlite3.Connection, sport: str) -> int:
    feature_spec = {
        "source": "external bookmaker odds",
        "aggregation": "median of per-bookmaker de-vigged probabilities",
        "lower_bound": "25th percentile of per-bookmaker de-vigged probabilities",
        "supported_markets": ["three_way", "both_teams_to_score", "half_goal_match_total"],
    }
    with connection:
        connection.execute(
            """
            INSERT OR IGNORE INTO model_versions (
                name, version, sport, algorithm, feature_spec_json,
                created_at, active, notes
            ) VALUES (
                'external-market-consensus', '0.1.0', ?,
                'normalized median bookmaker price benchmark', ?, ?, 0,
                'Paper price benchmark only; not a validated match-outcome model.'
            )
            """,
            (
                canonical(sport),
                json.dumps(feature_spec, sort_keys=True, separators=(",", ":")),
                utc_now(),
            ),
        )
    row = connection.execute(
        """
        SELECT model_version_id FROM model_versions
        WHERE name = 'external-market-consensus' AND version = '0.1.0'
        """
    ).fetchone()
    if not row:
        raise RuntimeError("Could not register the external-market consensus benchmark.")
    return int(row[0])


def interpolated_quantile(values: list[float], fraction: float) -> float:
    if not values:
        raise ValueError("Cannot take a quantile of an empty collection.")
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def review_selection_role(
    name: Any,
    *,
    market_kind: str,
    home_team: str,
    away_team: str,
) -> str | None:
    value = canonical(name)
    if market_kind == "three_way":
        if value in {"home", canonical(home_team)}:
            return "home"
        if value == "draw":
            return "draw"
        if value in {"away", canonical(away_team)}:
            return "away"
    elif market_kind == "both_teams_to_score" and value in {"yes", "no"}:
        return value
    elif market_kind == "total":
        if value.startswith("over "):
            return "over"
        if value.startswith("under "):
            return "under"
    return None


def supported_review_market(
    market_name: str,
    market_type: str,
    period: str,
    selection_rows: list[Any],
) -> tuple[dict[str, Any] | None, str]:
    """Map only settlement-compatible Torn markets to exact provider surfaces."""
    market_kind = canonical(market_type).replace(" ", "_")
    name = clean_text(market_name)
    period_text = canonical(period)
    if "ordinary time" not in canonical(name) and period_text not in {"ordinary time", "full time"}:
        return None, "unsupported_market"
    if market_kind == "three_way" and canonical(name).startswith("3 way"):
        return {
            "kind": "three_way",
            "external_market": "Match Winner",
            "external_market_aliases": ("1X2",),
            "roles": ("home", "draw", "away"),
            "line": None,
        }, "eligible"
    if market_kind == "both_teams_to_score" and canonical(name).startswith("both teams to score"):
        return {
            "kind": "both_teams_to_score",
            "external_market": "Both Teams Score",
            "external_market_aliases": ("Both Teams to Score",),
            "roles": ("yes", "no"),
            "line": None,
        }, "eligible"
    if market_kind == "total" and name.lower().startswith("over/under") and "total goals" in name.lower():
        lines = {optional_float(row["line"]) for row in selection_rows if row["selection_id"] is not None}
        lines.discard(None)
        if len(lines) != 1:
            return None, "selection_mismatch"
        line = float(next(iter(lines)))
        doubled = round(line * 2)
        if not math.isclose(line * 2, doubled, abs_tol=1e-9) or doubled % 2 == 0:
            return None, "settlement_mismatch"
        return {
            "kind": "total",
            "external_market": "Goals Over/Under",
            "external_market_aliases": (f"Over/Under {line:g}",),
            "roles": ("over", "under"),
            "line": line,
        }, "eligible"
    return None, "unsupported_market"


def external_market_consensus(
    connection: sqlite3.Connection,
    *,
    match_id: int,
    descriptor: dict[str, Any],
    home_team: str,
    away_team: str,
    information_cutoff: str,
) -> dict[str, Any]:
    cutoff = parse_iso_datetime(information_cutoff)
    rows = connection.execute(
        """
        SELECT rcr.capture_id, rcr.observed_at AS capture_observed_at,
               mm.name AS market_name, mms.name AS selection_name,
               mms.line, moo.bookmaker, moo.odds_decimal,
               moo.observed_at, moo.available
        FROM match_markets mm
        JOIN match_market_selections mms ON mms.match_market_id = mm.match_market_id
        JOIN match_odds_observations moo ON moo.match_selection_id = mms.match_selection_id
        JOIN reference_capture_runs rcr ON rcr.capture_id = moo.capture_id
        WHERE mm.match_id = ?
        """,
        (match_id,),
    ).fetchall()
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    accepted_market_names = {
        canonical(descriptor["external_market"]),
        *(canonical(value) for value in descriptor.get("external_market_aliases", ())),
    }
    for row in rows:
        if canonical(row["market_name"]) not in accepted_market_names:
            continue
        observed = parse_iso_datetime(row["observed_at"] or row["capture_observed_at"])
        if not observed or (cutoff and observed > cutoff) or not row["available"]:
            continue
        if descriptor["line"] is not None:
            external_line = optional_float(row["line"])
            if external_line is None or not math.isclose(
                external_line, float(descriptor["line"]), abs_tol=1e-9
            ):
                continue
        role = review_selection_role(
            row["selection_name"],
            market_kind=descriptor["kind"],
            home_team=home_team,
            away_team=away_team,
        )
        odds = optional_float(row["odds_decimal"])
        bookmaker = clean_text(row["bookmaker"])
        if role not in descriptor["roles"] or odds is None or odds <= 1 or not bookmaker:
            continue
        key = (bookmaker, str(row["capture_id"]))
        group = grouped.setdefault(
            key,
            {"bookmaker": bookmaker, "capture_id": row["capture_id"], "observed": observed, "prices": {}},
        )
        group["observed"] = max(group["observed"], observed)
        group["prices"][role] = odds

    latest_by_book: dict[str, dict[str, Any]] = {}
    required = set(descriptor["roles"])
    for group in grouped.values():
        if set(group["prices"]) != required:
            continue
        previous = latest_by_book.get(group["bookmaker"])
        if previous is None or group["observed"] > previous["observed"]:
            latest_by_book[group["bookmaker"]] = group

    role_probabilities: dict[str, list[float]] = {role: [] for role in descriptor["roles"]}
    for group in latest_by_book.values():
        implied = {role: 1 / float(group["prices"][role]) for role in descriptor["roles"]}
        overround = sum(implied.values())
        if overround <= 0:
            continue
        for role in descriptor["roles"]:
            role_probabilities[role].append(implied[role] / overround)
    if not role_probabilities or any(not values for values in role_probabilities.values()):
        return {"book_count": 0, "probabilities": {}, "lows": {}, "highs": {}, "captures": []}

    medians = {role: median(values) for role, values in role_probabilities.items()}
    median_total = sum(medians.values())
    probabilities = {role: value / median_total for role, value in medians.items()}
    lows = {role: interpolated_quantile(values, 0.25) for role, values in role_probabilities.items()}
    highs = {role: interpolated_quantile(values, 0.75) for role, values in role_probabilities.items()}
    captures = sorted({str(group["capture_id"]) for group in latest_by_book.values()})
    return {
        "book_count": len(latest_by_book),
        "probabilities": probabilities,
        "lows": lows,
        "highs": highs,
        "captures": captures,
    }


def paper_stake(
    bankroll: int,
    odds: float,
    probability: float,
    *,
    kelly_fraction: float,
    max_bankroll_fraction: float,
) -> int:
    if bankroll <= 0 or odds <= 1 or probability <= 0 or probability >= 1:
        return 0
    net_odds = odds - 1
    full_kelly = (net_odds * probability - (1 - probability)) / net_odds
    if full_kelly <= 0:
        return 0
    fractional = bankroll * full_kelly * kelly_fraction
    bankroll_cap = bankroll * max_bankroll_fraction
    return max(0, int(min(fractional, bankroll_cap, TORN_OPTION_CAP)))


def run_daily_paper_review(
    connection: sqlite3.Connection,
    *,
    review_date: str | None = None,
    sport: str = "football",
    min_books: int = 5,
    min_ev: float = 0.03,
    kelly_fraction: float = 0.25,
    max_bankroll_fraction: float = 0.01,
    snapshot_label: str = "",
    run_id: str | None = None,
    notes: str = "",
) -> dict[str, Any]:
    if min_books < 1:
        raise ValueError("min_books must be at least one.")
    if min_ev < 0:
        raise ValueError("min_ev cannot be negative.")
    if not 0 < kelly_fraction <= 1:
        raise ValueError("kelly_fraction must be greater than zero and at most one.")
    if not 0 < max_bankroll_fraction <= 1:
        raise ValueError("max_bankroll_fraction must be greater than zero and at most one.")
    resolved_date = resolve_review_date(connection, review_date, sport)
    slate = create_daily_research_slate(
        connection, review_date=resolved_date, sport=sport
    )
    model_version_id = ensure_consensus_benchmark_model(connection, sport)
    created_at = datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
    final_run_id = clean_text(run_id) or (
        f"paper-review:{resolved_date}:{stable_hash(slate['slate_id'], created_at)}"
    )
    if connection.execute(
        "SELECT 1 FROM forecast_runs WHERE forecast_run_id = ?", (final_run_id,)
    ).fetchone():
        raise ValueError(f"forecast run {final_run_id!r} already exists; choose another --run-id.")
    bankroll_row = latest_bankroll(connection)
    bankroll = int(bankroll_row["total"]) if bankroll_row else 0
    bankroll_snapshot_id = int(bankroll_row["bankroll_snapshot_id"]) if bankroll_row else None
    config = {
        "review_date": resolved_date,
        "snapshot_label": clean_text(snapshot_label),
        "min_books": min_books,
        "min_ev": min_ev,
        "kelly_fraction": kelly_fraction,
        "max_bankroll_fraction": max_bankroll_fraction,
        "market_depth_policy": "evaluate only displayed, complete, settlement-compatible markets",
        "mode": "paper_only",
    }
    market_rows = connection.execute(
        """
        SELECT rse.event_id, rse.capture_id, rse.match_id, rse.mapping_status,
               e.title AS event_title, e.home_team, e.away_team,
               cr.observed_at AS capture_observed_at,
               m.market_id, m.name AS market_name, m.market_type, m.period,
               mc.captured_as_complete,
               s.selection_id, s.name AS selection_name, s.line, s.handicap,
               oo.odds_decimal, oo.suspended, oo.available, oo.observed_at
        FROM research_slate_events rse
        JOIN events e ON e.event_id = rse.event_id
        JOIN capture_runs cr ON cr.capture_id = rse.capture_id
        JOIN market_captures mc ON mc.capture_id = rse.capture_id
        JOIN markets m ON m.market_id = mc.market_id AND m.event_id = rse.event_id
        LEFT JOIN selections s ON s.market_id = m.market_id
        LEFT JOIN odds_observations oo
          ON oo.capture_id = rse.capture_id AND oo.selection_id = s.selection_id
        WHERE rse.slate_id = ?
        ORDER BY rse.event_id, m.market_id, s.selection_id
        """,
        (slate["slate_id"],),
    ).fetchall()
    grouped: dict[tuple[int, int], list[sqlite3.Row]] = defaultdict(list)
    for row in market_rows:
        grouped[(int(row["event_id"]), int(row["market_id"]))].append(row)

    counts: dict[str, int] = defaultdict(int)
    pick_rows: list[dict[str, Any]] = []
    with connection:
        connection.execute(
            """
            INSERT INTO forecast_runs (
                forecast_run_id, model_version_id, slate_id, mode, created_at,
                information_cutoff, config_json, notes
            ) VALUES (?, ?, ?, 'paper', ?, ?, ?, ?)
            """,
            (
                final_run_id,
                model_version_id,
                slate["slate_id"],
                created_at,
                slate["observed_at"],
                json.dumps(config, sort_keys=True, separators=(",", ":")),
                clean_text(notes),
            ),
        )
        for (event_id, market_id), rows in grouped.items():
            first = rows[0]
            active_rows = [row for row in rows if row["selection_id"] is not None]
            exhaustive = opportunity_market_is_exhaustive(active_rows)
            descriptor, descriptor_status = supported_review_market(
                first["market_name"], first["market_type"], first["period"], active_rows
            )
            status = descriptor_status
            reason = {
                "unsupported_market": "This market is retained but not yet mapped to an exact settlement-compatible provider surface.",
                "settlement_mismatch": "Whole-goal lines can push and require a push-probability model before expected value is comparable.",
                "selection_mismatch": "The displayed Torn selections did not share one unambiguous supported line.",
            }.get(descriptor_status, "")
            consensus: dict[str, Any] = {
                "book_count": 0, "probabilities": {}, "lows": {}, "highs": {}, "captures": []
            }
            if first["mapping_status"] != "confirmed" or first["match_id"] is None:
                status = "unmapped_event"
                reason = "No confirmed canonical fixture link was available at review time."
            elif (
                not active_rows
                or not all(bool(row["captured_as_complete"]) for row in active_rows)
                or not all(
                    row["odds_decimal"] is not None
                    and bool(row["available"])
                    and not bool(row["suspended"])
                    and float(row["odds_decimal"]) > 1
                    for row in active_rows
                )
            ):
                status = "partial_torn"
                reason = "The captured Torn market did not contain a complete set of active prices."
            elif descriptor is not None and not exhaustive:
                status = "partial_torn"
                reason = "The displayed selections were not a provably exhaustive market shape."
            elif descriptor is not None:
                roles: dict[str, sqlite3.Row] = {}
                for row in active_rows:
                    role = review_selection_role(
                        row["selection_name"],
                        market_kind=descriptor["kind"],
                        home_team=first["home_team"],
                        away_team=first["away_team"],
                    )
                    if role is None or role in roles:
                        status = "selection_mismatch"
                        reason = "Torn selection labels did not map one-to-one to the supported market roles."
                        break
                    roles[role] = row
                if status == "eligible" and set(roles) != set(descriptor["roles"]):
                    status = "selection_mismatch"
                    reason = "Torn selection labels did not cover every supported market role."
                if status == "eligible":
                    consensus = external_market_consensus(
                        connection,
                        match_id=int(first["match_id"]),
                        descriptor=descriptor,
                        home_team=first["home_team"],
                        away_team=first["away_team"],
                        information_cutoff=first["capture_observed_at"],
                    )
                    if consensus["book_count"] == 0:
                        status = "no_external_market"
                        reason = "No timestamp-safe complete external bookmaker surface matched this market."
                    elif consensus["book_count"] < min_books:
                        status = "insufficient_books"
                        reason = f"Only {consensus['book_count']} complete bookmakers were available; {min_books} required."

            details = {
                "reason": reason,
                "event_title": first["event_title"],
                "capture_observed_at": first["capture_observed_at"],
                "external_capture_ids": consensus["captures"],
                "supported_descriptor": descriptor or {},
            }
            connection.execute(
                """
                INSERT INTO market_review_coverage (
                    forecast_run_id, event_id, market_id, capture_id, match_id,
                    market_name, market_type, period, torn_selection_count,
                    torn_capture_complete, exhaustive, external_market_name,
                    external_bookmaker_count, status, details_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    final_run_id,
                    event_id,
                    market_id,
                    first["capture_id"],
                    first["match_id"],
                    first["market_name"],
                    first["market_type"],
                    first["period"],
                    len(active_rows),
                    1 if active_rows and all(bool(row["captured_as_complete"]) for row in active_rows) else 0,
                    1 if exhaustive else 0,
                    descriptor["external_market"] if descriptor else "",
                    int(consensus["book_count"]),
                    status,
                    json.dumps(details, sort_keys=True, separators=(",", ":")),
                ),
            )
            counts[status] += 1
            counts["markets"] += 1
            if status != "eligible" or descriptor is None:
                continue
            for role in descriptor["roles"]:
                row = roles[role]
                probability = float(consensus["probabilities"][role])
                probability_low = float(consensus["lows"][role])
                probability_high = float(consensus["highs"][role])
                odds = float(row["odds_decimal"])
                implied_probability = 1 / odds
                consensus_ev = probability * odds - 1
                conservative_ev = probability_low * odds - 1
                action = "paper_pick" if conservative_ev >= min_ev else "pass"
                stake = paper_stake(
                    bankroll,
                    odds,
                    probability_low,
                    kelly_fraction=kelly_fraction,
                    max_bankroll_fraction=max_bankroll_fraction,
                ) if action == "paper_pick" else 0
                forecast_key = f"torn-market:{market_id}:{role}"
                features = {
                    "book_count": consensus["book_count"],
                    "consensus_expected_value": consensus_ev,
                    "conservative_expected_value": conservative_ev,
                    "external_capture_ids": consensus["captures"],
                    "torn_capture_id": first["capture_id"],
                    "torn_market_id": market_id,
                }
                cursor = connection.execute(
                    """
                    INSERT INTO match_forecasts (
                        forecast_run_id, match_id, forecast_key, market_type,
                        period, selection_key, selection_name, line,
                        predicted_probability, probability_low, probability_high,
                        fair_odds, calibration_sample_size, feature_as_of, features_json
                    ) VALUES (?, ?, ?, ?, 'ordinary_time', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        final_run_id,
                        int(first["match_id"]),
                        forecast_key,
                        descriptor["kind"],
                        role,
                        row["selection_name"],
                        descriptor["line"],
                        probability,
                        probability_low,
                        probability_high,
                        1 / probability,
                        int(consensus["book_count"]),
                        first["capture_observed_at"],
                        json.dumps(features, sort_keys=True, separators=(",", ":")),
                    ),
                )
                forecast_id = int(cursor.lastrowid)
                decision_id = f"decision:{stable_hash(final_run_id, market_id, role)}"
                rejection_reasons = [] if action == "paper_pick" else ["conservative_ev_below_threshold"]
                connection.execute(
                    """
                    INSERT INTO decision_records (
                        decision_id, forecast_id, event_id, selection_id,
                        bankroll_snapshot_id, decided_at, bookmaker, observed_odds,
                        reference_odds, implied_probability, conservative_probability,
                        edge, expected_value, action, recommended_stake, stake_rule,
                        rejection_reasons_json, notes
                    ) VALUES (?, ?, ?, ?, ?, ?, 'Torn Bookie', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        decision_id,
                        forecast_id,
                        event_id,
                        int(row["selection_id"]),
                        bankroll_snapshot_id,
                        created_at,
                        odds,
                        1 / probability,
                        implied_probability,
                        probability_low,
                        probability_low - implied_probability,
                        conservative_ev,
                        action,
                        stake,
                        f"{kelly_fraction:g} Kelly; cap {max_bankroll_fraction:.2%} bankroll and $1B Torn option limit",
                        json.dumps(rejection_reasons, separators=(",", ":")),
                        "Paper-only external-price benchmark; no Torn bet was placed.",
                    ),
                )
                counts["decisions"] += 1
                counts[action] += 1
                if action == "paper_pick":
                    pick_rows.append({
                        "event": first["event_title"],
                        "market": first["market_name"],
                        "selection": row["selection_name"],
                        "odds": odds,
                        "consensus_ev": consensus_ev,
                        "conservative_ev": conservative_ev,
                        "stake": stake,
                        "books": consensus["book_count"],
                    })
    counts["events_without_markets"] = max(
        0, int(slate["events"]) - len({event_id for event_id, _ in grouped})
    )
    return {
        "run_id": final_run_id,
        "slate_id": slate["slate_id"],
        "review_date": resolved_date,
        "events": slate["events"],
        "slate_capture_complete": slate["capture_complete"],
        "bankroll": bankroll,
        "counts": dict(counts),
        "paper_picks": pick_rows,
        "config": config,
    }


def render_daily_paper_review(result: dict[str, Any]) -> str:
    counts = result["counts"]
    lines = [
        f"# BMG daily paper review — {result['review_date']}",
        "",
        f"- Run: `{result['run_id']}`",
        f"- Snapshot label: {result['config'].get('snapshot_label') or 'unlabeled'}",
        f"- Frozen slate: `{result['slate_id']}`",
        f"- Events: {result['events']}",
        f"- Displayed markets reviewed: {counts.get('markets', 0)}",
        f"- Captured events with no displayed markets: {counts.get('events_without_markets', 0)}",
        f"- Price-comparable markets: {counts.get('eligible', 0)}",
        f"- Decisions: {counts.get('decisions', 0)} ({counts.get('paper_pick', 0)} paper picks, {counts.get('pass', 0)} passes)",
        f"- Entire source slate claimed complete: {'yes' if result['slate_capture_complete'] else 'no'}",
        "",
        "## Market-depth disposition",
        "",
        "| Status | Markets |",
        "|---|---:|",
    ]
    statuses = (
        "eligible", "partial_torn", "unsupported_market", "settlement_mismatch",
        "unmapped_event", "no_external_market", "insufficient_books", "selection_mismatch",
    )
    for status in statuses:
        lines.append(f"| {status.replace('_', ' ')} | {counts.get(status, 0)} |")
    lines.extend(["", "## Paper picks", ""])
    if not result["paper_picks"]:
        lines.append("No selection cleared the conservative expected-value threshold. No bet was placed.")
    else:
        lines.extend([
            "| Event | Market | Selection | Torn odds | Consensus EV | Conservative EV | Paper stake | Books |",
            "|---|---|---|---:|---:|---:|---:|---:|",
        ])
        for pick in sorted(result["paper_picks"], key=lambda row: row["conservative_ev"], reverse=True):
            lines.append(
                f"| {pick['event']} | {pick['market']} | {pick['selection']} | "
                f"{pick['odds']:.3f} | {pick['consensus_ev']:.2%} | "
                f"{pick['conservative_ev']:.2%} | {money(pick['stake'])} | {pick['books']} |"
            )
        lines.extend(["", "These are paper observations only. No Torn bet was placed."])
    lines.extend([
        "",
        "The engine does not assume a standard market menu. Missing markets are absent, displayed but unsupported markets are retained in coverage, and only complete settlement-compatible surfaces with enough timestamp-safe bookmaker comparisons can create decisions.",
        "",
    ])
    return "\n".join(lines)


def forecast_review_descriptor(market_type: Any, line: Any) -> dict[str, Any] | None:
    market_kind = canonical(market_type).replace(" ", "_")
    if market_kind == "three_way":
        return {
            "kind": "three_way",
            "external_market": "Match Winner",
            "external_market_aliases": ("1X2",),
            "roles": ("home", "draw", "away"),
            "line": None,
        }
    if market_kind == "both_teams_to_score":
        return {
            "kind": "both_teams_to_score",
            "external_market": "Both Teams Score",
            "external_market_aliases": ("Both Teams to Score",),
            "roles": ("yes", "no"),
            "line": None,
        }
    if market_kind == "total":
        parsed_line = optional_float(line)
        if parsed_line is None:
            return None
        return {
            "kind": "total",
            "external_market": "Goals Over/Under",
            "external_market_aliases": (f"Over/Under {parsed_line:g}",),
            "roles": ("over", "under"),
            "line": parsed_line,
        }
    return None


def fixture_settlement_disposition(status: Any, home_score: Any, away_score: Any) -> str:
    normalized = canonical(status)
    if normalized == "finished" and optional_float(home_score) is not None and optional_float(away_score) is not None:
        return "finished"
    if normalized in {"canc", "cancelled", "canceled", "void"}:
        return "void"
    if normalized in {
        "awarded", "walkover", "abandoned",
        "finished after extra time", "finished after penalties",
    }:
        return "manual_review"
    return "pending"


def football_selection_result(
    market_type: Any,
    selection_key: Any,
    line: Any,
    home_score: Any,
    away_score: Any,
) -> str:
    market_kind = canonical(market_type).replace(" ", "_")
    selection = canonical(selection_key)
    home = optional_float(home_score)
    away = optional_float(away_score)
    if home is None or away is None:
        return "unknown"
    if market_kind == "three_way":
        winner = "draw"
        if home > away:
            winner = "home"
        elif away > home:
            winner = "away"
        return "win" if selection == winner else "loss" if selection in {"home", "draw", "away"} else "unknown"
    if market_kind == "both_teams_to_score":
        outcome = "yes" if home > 0 and away > 0 else "no"
        return "win" if selection == outcome else "loss" if selection in {"yes", "no"} else "unknown"
    if market_kind == "total":
        parsed_line = optional_float(line)
        if parsed_line is None or selection not in {"over", "under"}:
            return "unknown"
        total = home + away
        if math.isclose(total, parsed_line, abs_tol=1e-9):
            return "push"
        won = total > parsed_line if selection == "over" else total < parsed_line
        return "win" if won else "loss"
    return "unknown"


def resolve_forecast_run(connection: sqlite3.Connection, run_id: str | None) -> str:
    if run_id:
        row = connection.execute(
            "SELECT forecast_run_id FROM forecast_runs WHERE forecast_run_id = ?", (run_id,)
        ).fetchone()
    else:
        row = connection.execute(
            """
            SELECT fr.forecast_run_id
            FROM forecast_runs fr
            WHERE EXISTS (
                SELECT 1 FROM match_forecasts mf
                JOIN decision_records dr ON dr.forecast_id = mf.forecast_id
                WHERE mf.forecast_run_id = fr.forecast_run_id
            )
            ORDER BY fr.created_at DESC, fr.forecast_run_id DESC
            LIMIT 1
            """
        ).fetchone()
    if not row:
        raise ValueError("No forecast run with decisions was found.")
    return str(row[0])


def settle_review(
    connection: sqlite3.Connection,
    *,
    run_id: str | None = None,
    evaluated_at: str | None = None,
) -> dict[str, Any]:
    """Settle final fixtures and score an immutable paper-review decision set."""
    final_run_id = resolve_forecast_run(connection, run_id)
    if evaluated_at:
        parsed_evaluation_time = parse_iso_datetime(evaluated_at)
        if parsed_evaluation_time is None:
            raise ValueError("evaluated_at must be an ISO date-time.")
        now = parsed_evaluation_time.isoformat().replace("+00:00", "Z")
    else:
        now = utc_now()
    rows = connection.execute(
        """
        SELECT dr.decision_id, dr.action, dr.recommended_stake, dr.observed_odds,
               mf.forecast_id, mf.match_id, mf.market_type, mf.period,
               mf.selection_key, mf.selection_name, mf.line,
               mf.predicted_probability, mf.feature_as_of,
               sm.scheduled_at, sm.status AS match_status,
               sm.home_score, sm.away_score, sm.last_observed_at,
               ht.name AS home_team, at.name AS away_team,
               COALESCE((
                   SELECT GROUP_CONCAT(ordered_source.reference, ',')
                   FROM (
                       SELECT ms.source || ':' || ms.source_match_id AS reference
                       FROM match_sources ms
                       WHERE ms.match_id = sm.match_id
                       ORDER BY ms.source, ms.source_match_id
                   ) ordered_source
               ), 'canonical-reference') AS result_sources
        FROM match_forecasts mf
        JOIN decision_records dr ON dr.forecast_id = mf.forecast_id
        JOIN sports_matches sm ON sm.match_id = mf.match_id
        JOIN sports_teams ht ON ht.team_id = sm.home_team_id
        JOIN sports_teams at ON at.team_id = sm.away_team_id
        WHERE mf.forecast_run_id = ?
        ORDER BY mf.match_id, mf.forecast_id
        """,
        (final_run_id,),
    ).fetchall()
    if not rows:
        raise ValueError(f"Forecast run {final_run_id!r} has no decisions.")

    fixture_rows: dict[int, sqlite3.Row] = {}
    for row in rows:
        fixture_rows[int(row["match_id"])] = row
    fixture_counts: dict[str, int] = defaultdict(int)
    pending_fixtures: list[dict[str, Any]] = []
    for match_id, row in fixture_rows.items():
        disposition = fixture_settlement_disposition(
            row["match_status"], row["home_score"], row["away_score"]
        )
        fixture_counts[disposition] += 1
        if disposition in {"pending", "manual_review"}:
            pending_fixtures.append({
                "match_id": match_id,
                "event": f"{row['home_team']} v {row['away_team']}",
                "scheduled_at": row["scheduled_at"],
                "status": row["match_status"],
                "disposition": disposition,
            })

    counts: dict[str, int] = defaultdict(int)
    ruleset = "bmg-football-ordinary-time-v1"
    with connection:
        for row in rows:
            counts["decisions"] += 1
            disposition = fixture_settlement_disposition(
                row["match_status"], row["home_score"], row["away_score"]
            )
            if disposition in {"pending", "manual_review"}:
                counts[disposition] += 1
                continue
            result = "void" if disposition == "void" else football_selection_result(
                row["market_type"],
                row["selection_key"],
                row["line"],
                row["home_score"],
                row["away_score"],
            )
            line_key = "" if row["line"] is None else f"{float(row['line']):g}"
            settlement_key = (
                f"{canonical(row['market_type'])}:{canonical(row['period'])}:"
                f"{canonical(row['selection_key'])}:line:{line_key}"
            )
            raw_settlement = {
                "match_status": row["match_status"],
                "home_team": row["home_team"],
                "away_team": row["away_team"],
                "home_score": row["home_score"],
                "away_score": row["away_score"],
                "scheduled_at": row["scheduled_at"],
                "last_observed_at": row["last_observed_at"],
                "result_sources": row["result_sources"],
            }
            existing_settlement = connection.execute(
                """
                SELECT settlement_id, result, raw_json
                FROM match_market_settlements
                WHERE match_id = ? AND settlement_key = ? AND ruleset = ?
                """,
                (int(row["match_id"]), settlement_key, ruleset),
            ).fetchone()
            raw_json = json.dumps(raw_settlement, sort_keys=True, separators=(",", ":"))
            connection.execute(
                """
                INSERT INTO match_market_settlements (
                    match_id, settlement_key, market_type, period, selection_key,
                    line, ruleset, result, settled_at, source, raw_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'canonical-reference', ?)
                ON CONFLICT(match_id, settlement_key, ruleset) DO UPDATE SET
                    result = excluded.result,
                    settled_at = excluded.settled_at,
                    source = excluded.source,
                    raw_json = excluded.raw_json
                """,
                (
                    int(row["match_id"]),
                    settlement_key,
                    row["market_type"],
                    row["period"],
                    row["selection_key"],
                    row["line"],
                    ruleset,
                    result,
                    row["last_observed_at"] or now,
                    raw_json,
                ),
            )
            settlement = connection.execute(
                """
                SELECT settlement_id FROM match_market_settlements
                WHERE match_id = ? AND settlement_key = ? AND ruleset = ?
                """,
                (int(row["match_id"]), settlement_key, ruleset),
            ).fetchone()
            if existing_settlement is None:
                counts["settlements_inserted"] += 1
            elif existing_settlement["result"] != result or existing_settlement["raw_json"] != raw_json:
                counts["settlements_updated"] += 1
            else:
                counts["settlements_existing"] += 1
            counts[result] += 1
            if result == "unknown":
                continue

            actual_outcome = 1.0 if result == "win" else 0.0 if result == "loss" else None
            predicted_probability = min(max(float(row["predicted_probability"]), 1e-12), 1 - 1e-12)
            brier_score = None
            log_loss = None
            if actual_outcome is not None:
                brier_score = (predicted_probability - actual_outcome) ** 2
                log_loss = -(
                    actual_outcome * math.log(predicted_probability)
                    + (1 - actual_outcome) * math.log(1 - predicted_probability)
                )

            stake = int(row["recommended_stake"] or 0)
            odds = optional_float(row["observed_odds"])
            realized_profit = None
            if row["action"] in {"paper_pick", "bet"} and result in {"win", "loss", "push", "void"}:
                if result == "win" and odds is not None:
                    realized_profit = int(round(stake * (odds - 1)))
                elif result == "loss":
                    realized_profit = -stake
                else:
                    realized_profit = 0
            elif row["action"] in {"pass", "reject"}:
                realized_profit = 0

            closing_odds = None
            closing_line_value = None
            closing_consensus: dict[str, Any] = {
                "book_count": 0, "probabilities": {}, "captures": []
            }
            descriptor = forecast_review_descriptor(row["market_type"], row["line"])
            closing_cutoff = row["scheduled_at"]
            if descriptor is not None and closing_cutoff:
                closing_consensus = external_market_consensus(
                    connection,
                    match_id=int(row["match_id"]),
                    descriptor=descriptor,
                    home_team=row["home_team"],
                    away_team=row["away_team"],
                    information_cutoff=closing_cutoff,
                )
                role = canonical(row["selection_key"])
                closing_probability = closing_consensus["probabilities"].get(role)
                if closing_probability and float(closing_probability) > 0:
                    closing_odds = 1 / float(closing_probability)
                    if odds is not None:
                        closing_line_value = odds / closing_odds - 1

            evaluation_metadata = {
                "closing_definition": "normalized median of latest complete per-bookmaker de-vigged probabilities observed no later than scheduled kickoff",
                "closing_formula": "accepted_torn_decimal_odds / closing_consensus_fair_odds - 1",
                "closing_cutoff": closing_cutoff,
                "closing_bookmaker_count": int(closing_consensus["book_count"]),
                "closing_capture_ids": closing_consensus["captures"],
                "forecast_feature_as_of": row["feature_as_of"],
                "result_sources": row["result_sources"],
            }
            metadata_json = json.dumps(evaluation_metadata, sort_keys=True, separators=(",", ":"))
            existing_evaluation = connection.execute(
                "SELECT * FROM forecast_evaluations WHERE decision_id = ?", (row["decision_id"],)
            ).fetchone()
            connection.execute(
                """
                INSERT INTO forecast_evaluations (
                    decision_id, settlement_id, evaluated_at, actual_outcome,
                    realized_profit, brier_score, log_loss, closing_odds,
                    closing_line_value, notes, evaluation_metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(decision_id) DO UPDATE SET
                    settlement_id = excluded.settlement_id,
                    evaluated_at = excluded.evaluated_at,
                    actual_outcome = excluded.actual_outcome,
                    realized_profit = excluded.realized_profit,
                    brier_score = excluded.brier_score,
                    log_loss = excluded.log_loss,
                    closing_odds = excluded.closing_odds,
                    closing_line_value = excluded.closing_line_value,
                    notes = excluded.notes,
                    evaluation_metadata_json = excluded.evaluation_metadata_json
                """,
                (
                    row["decision_id"],
                    int(settlement["settlement_id"]),
                    now,
                    actual_outcome,
                    realized_profit,
                    brier_score,
                    log_loss,
                    closing_odds,
                    closing_line_value,
                    "Paper settlement evaluation; no wager is inferred from a paper decision.",
                    metadata_json,
                ),
            )
            counts["evaluations_updated" if existing_evaluation else "evaluations_inserted"] += 1

    metrics = connection.execute(
        """
        SELECT COUNT(fe.decision_id) AS evaluations,
               SUM(CASE WHEN dr.action = 'paper_pick' AND fe.decision_id IS NOT NULL THEN 1 ELSE 0 END) AS settled_picks,
               SUM(CASE WHEN dr.action = 'paper_pick' AND mms.result = 'win' THEN 1 ELSE 0 END) AS pick_wins,
               SUM(CASE WHEN dr.action = 'paper_pick' AND mms.result = 'loss' THEN 1 ELSE 0 END) AS pick_losses,
               SUM(CASE WHEN dr.action = 'paper_pick' AND mms.result = 'push' THEN 1 ELSE 0 END) AS pick_pushes,
               SUM(CASE WHEN dr.action = 'paper_pick' AND mms.result = 'void' THEN 1 ELSE 0 END) AS pick_voids,
               SUM(CASE WHEN dr.action = 'paper_pick' AND mms.result IN ('win', 'loss')
                        THEN dr.recommended_stake ELSE 0 END) AS stake_at_risk,
               SUM(CASE WHEN dr.action = 'paper_pick' THEN COALESCE(fe.realized_profit, 0) ELSE 0 END) AS paper_profit,
               AVG(fe.brier_score) AS average_brier,
               AVG(fe.log_loss) AS average_log_loss,
               AVG(CASE WHEN dr.action = 'paper_pick' THEN fe.closing_line_value END) AS average_pick_clv,
               SUM(CASE WHEN fe.closing_odds IS NOT NULL THEN 1 ELSE 0 END) AS closing_prices
        FROM match_forecasts mf
        JOIN decision_records dr ON dr.forecast_id = mf.forecast_id
        LEFT JOIN forecast_evaluations fe ON fe.decision_id = dr.decision_id
        LEFT JOIN match_market_settlements mms ON mms.settlement_id = fe.settlement_id
        WHERE mf.forecast_run_id = ?
        """,
        (final_run_id,),
    ).fetchone()
    return {
        "run_id": final_run_id,
        "evaluated_at": now,
        "fixtures": {
            "total": len(fixture_rows),
            **{key: int(value) for key, value in fixture_counts.items()},
        },
        "pending_fixtures": pending_fixtures,
        "counts": dict(counts),
        "metrics": {key: metrics[key] for key in metrics.keys()},
    }


def render_settlement_review(result: dict[str, Any]) -> str:
    fixtures = result["fixtures"]
    metrics = result["metrics"]
    stake_at_risk = int(metrics["stake_at_risk"] or 0)
    profit = int(metrics["paper_profit"] or 0)
    roi = profit / stake_at_risk if stake_at_risk else None
    lines = [
        f"# BMG settlement review — {result['run_id']}",
        "",
        f"- Evaluated at: {result['evaluated_at']}",
        f"- Fixtures: {fixtures.get('total', 0)} total; {fixtures.get('finished', 0)} finished; {fixtures.get('void', 0)} void; {fixtures.get('pending', 0)} pending; {fixtures.get('manual_review', 0)} manual review",
        f"- Evaluated decisions: {int(metrics['evaluations'] or 0)}",
        f"- Paper picks settled: {int(metrics['settled_picks'] or 0)} ({int(metrics['pick_wins'] or 0)} wins, {int(metrics['pick_losses'] or 0)} losses, {int(metrics['pick_pushes'] or 0)} pushes, {int(metrics['pick_voids'] or 0)} voids)",
        f"- Paper stake at risk: {money(stake_at_risk)}",
        f"- Hypothetical profit/loss: {money(profit)}",
        f"- Paper ROI: {roi:.2%}" if roi is not None else "- Paper ROI: not available",
        f"- Mean Brier score: {float(metrics['average_brier']):.6f}" if metrics["average_brier"] is not None else "- Mean Brier score: not available",
        f"- Mean log loss: {float(metrics['average_log_loss']):.6f}" if metrics["average_log_loss"] is not None else "- Mean log loss: not available",
        f"- Mean paper-pick closing-line value: {float(metrics['average_pick_clv']):.2%}" if metrics["average_pick_clv"] is not None else "- Mean paper-pick closing-line value: not available",
        f"- Decisions with closing consensus: {int(metrics['closing_prices'] or 0)}",
    ]
    if result["pending_fixtures"]:
        lines.extend(["", "## Not settled", "", "| Fixture | Scheduled | Provider status | Disposition |", "|---|---|---|---|"])
        for fixture in result["pending_fixtures"]:
            lines.append(
                f"| {fixture['event']} | {fixture['scheduled_at'] or 'unknown'} | "
                f"{fixture['status'] or 'unknown'} | {fixture['disposition'].replace('_', ' ')} |"
            )
    lines.extend([
        "",
        "Closing-line value compares the recorded Torn price with the normalized median consensus from each bookmaker's latest complete surface observed no later than scheduled kickoff. Later observations are excluded.",
        "",
    ])
    return "\n".join(lines)


def split_torn_league_label(value: Any) -> tuple[str, str]:
    text = clean_text(value)
    jurisdiction = ""
    match = re.search(r"\s*\(([^()]*)\)\s*$", text)
    if match:
        jurisdiction = clean_text(match.group(1))
        text = clean_text(text[: match.start()])
    family = re.sub(r"\b(?:19|20)\d{2}(?:\s*/\s*(?:19|20)?\d{2})?\b", "", text)
    family = clean_text(family).strip(" -/")
    return family or text or "Unknown competition", jurisdiction


def build_collection_plan(
    connection: sqlite3.Connection,
    *,
    plan_id: str,
    name: str,
    sport: str = "football",
    history_years: int = 3,
    source: str = "flashscore-visible-browser",
    notes: str = "",
) -> dict[str, int | str]:
    if history_years <= 0:
        raise ValueError("history_years must be positive.")
    clean_plan_id = clean_text(plan_id)
    if not clean_plan_id:
        raise ValueError("plan_id cannot be empty.")
    now = utc_now()
    rows = connection.execute(
        """
        SELECT e.league,
               COUNT(*) AS wager_count,
               COUNT(DISTINCT e.event_id) AS event_count,
               SUM(b.stake) AS staked,
               SUM(CASE WHEN EXISTS (
                   SELECT 1 FROM event_match_links eml
                   WHERE eml.event_id = e.event_id AND eml.confirmed = 1
               ) THEN 1 ELSE 0 END) AS linked_wager_count
        FROM bets b JOIN events e ON e.event_id = b.event_id
        WHERE e.sport = ? AND e.league <> ''
        GROUP BY e.league
        ORDER BY staked DESC, wager_count DESC, e.league
        """,
        (canonical(sport),),
    ).fetchall()
    aggregates: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        family, jurisdiction = split_torn_league_label(row["league"])
        key = (canonical(family), canonical(jurisdiction))
        aggregate = aggregates.setdefault(
            key,
            {
                "family": family,
                "jurisdiction": jurisdiction,
                "representative": row["league"],
                "representative_staked": -1,
                "wager_count": 0,
                "event_count": 0,
                "staked": 0,
                "linked_wager_count": 0,
                "labels": [],
            },
        )
        row_staked = int(row["staked"] or 0)
        if row_staked > aggregate["representative_staked"]:
            aggregate["representative"] = row["league"]
            aggregate["representative_staked"] = row_staked
        aggregate["wager_count"] += int(row["wager_count"] or 0)
        aggregate["event_count"] += int(row["event_count"] or 0)
        aggregate["staked"] += row_staked
        aggregate["linked_wager_count"] += int(row["linked_wager_count"] or 0)
        aggregate["labels"].append(row)
    generated_target_ids = {
        "target:" + stable_hash(clean_plan_id, aggregate["family"], aggregate["jurisdiction"])
        for aggregate in aggregates.values()
    }
    with connection:
        connection.execute(
            """
            INSERT INTO collection_plans (
                plan_id, name, sport, history_years, source, created_at, updated_at, status, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
            ON CONFLICT(plan_id) DO UPDATE SET
                name = excluded.name,
                history_years = excluded.history_years,
                source = excluded.source,
                updated_at = excluded.updated_at,
                notes = CASE WHEN excluded.notes <> '' THEN excluded.notes ELSE collection_plans.notes END
            """,
            (
                clean_plan_id,
                clean_text(name) or clean_plan_id,
                canonical(sport),
                history_years,
                clean_text(source),
                now,
                now,
                clean_text(notes),
            ),
        )
        old_targets = connection.execute(
            "SELECT target_id FROM collection_targets WHERE plan_id = ?", (clean_plan_id,)
        ).fetchall()
        for old_target in old_targets:
            old_target_id = str(old_target["target_id"])
            if old_target_id in generated_target_ids:
                connection.execute(
                    "DELETE FROM collection_target_league_labels WHERE target_id = ?", (old_target_id,)
                )
                continue
            has_runs = connection.execute(
                "SELECT 1 FROM collection_run_targets WHERE target_id = ? LIMIT 1", (old_target_id,)
            ).fetchone()
            if not has_runs:
                connection.execute("DELETE FROM collection_targets WHERE target_id = ?", (old_target_id,))
        for aggregate in aggregates.values():
            family = aggregate["family"]
            jurisdiction = aggregate["jurisdiction"]
            target_id = "target:" + stable_hash(clean_plan_id, family, jurisdiction)
            staked = int(aggregate["staked"])
            wager_count = int(aggregate["wager_count"])
            event_count = int(aggregate["event_count"])
            linked = int(aggregate["linked_wager_count"])
            priority_score = float(staked + wager_count * 1_000_000 + event_count * 250_000)
            status = "reconciled" if wager_count > 0 and linked >= wager_count else "queued"
            connection.execute(
                """
                INSERT INTO collection_targets (
                    target_id, plan_id, torn_league_label, competition_family, jurisdiction,
                    wager_count, event_count, staked, linked_wager_count, priority_score,
                    planned_seasons, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(target_id) DO UPDATE SET
                    torn_league_label = excluded.torn_league_label,
                    competition_family = excluded.competition_family,
                    jurisdiction = excluded.jurisdiction,
                    wager_count = excluded.wager_count,
                    event_count = excluded.event_count,
                    staked = excluded.staked,
                    linked_wager_count = excluded.linked_wager_count,
                    priority_score = excluded.priority_score,
                    planned_seasons = excluded.planned_seasons,
                    status = CASE
                        WHEN excluded.status = 'reconciled' THEN 'reconciled'
                        WHEN collection_targets.status IN ('queued', 'reconciled') THEN excluded.status
                        ELSE collection_targets.status
                    END,
                    updated_at = excluded.updated_at
                """,
                (
                    target_id,
                    clean_plan_id,
                    aggregate["representative"],
                    family,
                    jurisdiction,
                    wager_count,
                    event_count,
                    staked,
                    linked,
                    priority_score,
                    history_years,
                    status,
                    now,
                    now,
                ),
            )
            for label_row in aggregate["labels"]:
                connection.execute(
                    """
                    INSERT INTO collection_target_league_labels (
                        target_id, torn_league_label, wager_count, event_count, staked, linked_wager_count
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(target_id, torn_league_label) DO UPDATE SET
                        wager_count = excluded.wager_count,
                        event_count = excluded.event_count,
                        staked = excluded.staked,
                        linked_wager_count = excluded.linked_wager_count
                    """,
                    (
                        target_id,
                        label_row["league"],
                        int(label_row["wager_count"] or 0),
                        int(label_row["event_count"] or 0),
                        int(label_row["staked"] or 0),
                        int(label_row["linked_wager_count"] or 0),
                    ),
                )
    return {
        "plan_id": clean_plan_id,
        "targets": len(aggregates),
        "wagers": sum(int(aggregate["wager_count"]) for aggregate in aggregates.values()),
        "staked": sum(int(aggregate["staked"]) for aggregate in aggregates.values()),
    }


def map_collection_target(
    connection: sqlite3.Connection, target_id: str, source_url: str, source_competition_id: str = ""
) -> None:
    cursor = connection.execute(
        """
        UPDATE collection_targets
        SET source_url = ?, source_competition_id = ?, status = 'mapped', updated_at = ?
        WHERE target_id = ?
        """,
        (clean_text(source_url), clean_text(source_competition_id), utc_now(), clean_text(target_id)),
    )
    if cursor.rowcount != 1:
        raise ValueError(f"Unknown collection target {target_id!r}.")
    connection.commit()


def start_collection_run(
    connection: sqlite3.Connection,
    *,
    plan_id: str,
    target_id: str,
    season_name: str,
    mode: str = "foreground",
    notes: str = "",
) -> str:
    plan = connection.execute(
        "SELECT source FROM collection_plans WHERE plan_id = ?", (clean_text(plan_id),)
    ).fetchone()
    target = connection.execute(
        "SELECT 1 FROM collection_targets WHERE plan_id = ? AND target_id = ?",
        (clean_text(plan_id), clean_text(target_id)),
    ).fetchone()
    if not plan or not target:
        raise ValueError("The collection plan or target does not exist.")
    started_at = utc_now()
    run_id = "collection:" + stable_hash(plan_id, target_id, season_name, started_at)
    with connection:
        connection.execute(
            """
            INSERT INTO collection_runs (
                run_id, plan_id, source, mode, started_at, status, notes
            ) VALUES (?, ?, ?, ?, ?, 'running', ?)
            """,
            (run_id, clean_text(plan_id), plan["source"], canonical(mode), started_at, clean_text(notes)),
        )
        connection.execute(
            """
            INSERT INTO collection_run_targets (
                run_id, target_id, season_name, started_at, status, notes
            ) VALUES (?, ?, ?, ?, 'running', ?)
            """,
            (run_id, clean_text(target_id), clean_text(season_name), started_at, clean_text(notes)),
        )
        connection.execute(
            "UPDATE collection_targets SET status = 'collecting', updated_at = ? WHERE target_id = ?",
            (started_at, clean_text(target_id)),
        )
    return run_id


def add_collection_checkpoint(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    phase: str,
    page_url: str = "",
    items_visible: int = 0,
    elapsed_seconds: float = 0,
    note: str = "",
) -> None:
    row = connection.execute(
        "SELECT target_id FROM collection_run_targets WHERE run_id = ? ORDER BY started_at LIMIT 1",
        (clean_text(run_id),),
    ).fetchone()
    if not row:
        raise ValueError(f"Unknown collection run {run_id!r}.")
    connection.execute(
        """
        INSERT INTO collection_checkpoints (
            run_id, target_id, observed_at, phase, page_url, items_visible, elapsed_seconds, note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            clean_text(run_id),
            row["target_id"],
            utc_now(),
            clean_text(phase),
            clean_text(page_url),
            max(0, items_visible),
            max(0.0, elapsed_seconds),
            clean_text(note),
        ),
    )
    connection.commit()


def finish_collection_run(connection: sqlite3.Connection, args: argparse.Namespace) -> None:
    run = connection.execute(
        "SELECT started_at FROM collection_runs WHERE run_id = ?", (clean_text(args.run_id),)
    ).fetchone()
    target = connection.execute(
        "SELECT target_id FROM collection_run_targets WHERE run_id = ? ORDER BY started_at LIMIT 1",
        (clean_text(args.run_id),),
    ).fetchone()
    if not run or not target:
        raise ValueError(f"Unknown collection run {args.run_id!r}.")
    finished_at = args.finished_at or utc_now()
    active_seconds = args.active_seconds
    if active_seconds is None:
        start = datetime.fromisoformat(str(run["started_at"]).replace("Z", "+00:00"))
        finish = datetime.fromisoformat(finished_at.replace("Z", "+00:00"))
        active_seconds = max(0.0, (finish - start).total_seconds())
    target_status = args.target_status
    with connection:
        connection.execute(
            """
            UPDATE collection_runs SET
                finished_at = ?, active_seconds = ?, status = ?, pages_visited = ?,
                matches_captured = ?, standings_rows = ?, stat_rows = ?, h2h_rows = ?,
                bytes_exported = ?, notes = CASE WHEN ? <> '' THEN ? ELSE notes END
            WHERE run_id = ?
            """,
            (
                finished_at,
                active_seconds,
                args.status,
                args.pages,
                args.matches,
                args.standings,
                args.stats,
                args.h2h,
                args.bytes,
                clean_text(args.notes),
                clean_text(args.notes),
                clean_text(args.run_id),
            ),
        )
        connection.execute(
            """
            UPDATE collection_run_targets SET
                finished_at = ?, active_seconds = ?, status = ?, pages_visited = ?,
                matches_captured = ?, standings_rows = ?, stat_rows = ?, h2h_rows = ?,
                notes = CASE WHEN ? <> '' THEN ? ELSE notes END
            WHERE run_id = ?
            """,
            (
                finished_at,
                active_seconds,
                args.status,
                args.pages,
                args.matches,
                args.standings,
                args.stats,
                args.h2h,
                clean_text(args.notes),
                clean_text(args.notes),
                clean_text(args.run_id),
            ),
        )
        connection.execute(
            "UPDATE collection_targets SET status = ?, updated_at = ? WHERE target_id = ?",
            (target_status, finished_at, target["target_id"]),
        )


def print_collection_progress(connection: sqlite3.Connection, plan_id: str, limit: int = 20) -> None:
    plan = connection.execute(
        "SELECT * FROM collection_plans WHERE plan_id = ?", (clean_text(plan_id),)
    ).fetchone()
    if not plan:
        raise ValueError(f"Unknown collection plan {plan_id!r}.")
    totals = connection.execute(
        """
        SELECT COUNT(*) AS targets, SUM(planned_seasons) AS target_seasons,
               SUM(wager_count) AS wagers, SUM(event_count) AS events, SUM(staked) AS staked,
               SUM(linked_wager_count) AS linked,
               SUM(CASE WHEN status = 'reconciled' THEN 1 ELSE 0 END) AS reconciled_targets,
               SUM(CASE WHEN status IN ('captured', 'imported', 'reconciled') THEN 1 ELSE 0 END) AS progressed_targets
        FROM collection_targets WHERE plan_id = ?
        """,
        (clean_text(plan_id),),
    ).fetchone()
    outcome_units = int(
        connection.execute(
            """
            SELECT COUNT(*)
            FROM collection_target_league_labels ctl
            JOIN collection_targets ct ON ct.target_id = ctl.target_id
            WHERE ct.plan_id = ?
            """,
            (clean_text(plan_id),),
        ).fetchone()[0]
    )
    benchmark = connection.execute(
        """
        SELECT SUM(crt.active_seconds) AS seconds,
               COUNT(*) AS target_seasons,
               SUM(crt.matches_captured) AS matches,
               SUM(crt.pages_visited) AS pages
        FROM collection_run_targets crt
        JOIN collection_runs cr ON cr.run_id = crt.run_id
        WHERE cr.plan_id = ? AND crt.status = 'complete' AND crt.active_seconds > 0
          AND (crt.matches_captured > 1 OR crt.standings_rows > 0)
        """,
        (clean_text(plan_id),),
    ).fetchone()
    detail_benchmark = connection.execute(
        """
        SELECT SUM(crt.active_seconds) AS seconds,
               COUNT(*) AS matches,
               SUM(crt.stat_rows) AS stats,
               SUM(crt.h2h_rows) AS h2h
        FROM collection_run_targets crt
        JOIN collection_runs cr ON cr.run_id = crt.run_id
        WHERE cr.plan_id = ? AND crt.status = 'complete' AND crt.active_seconds > 0
          AND crt.matches_captured = 1 AND (crt.stat_rows > 0 OR crt.h2h_rows > 0)
        """,
        (clean_text(plan_id),),
    ).fetchone()
    print(f"Collection plan {plan['plan_id']}: {plan['name']} ({plan['history_years']} years)")
    print(
        f"  targets={int(totals['targets'] or 0):,}; target-seasons={int(totals['target_seasons'] or 0):,}; "
        f"wager-season labels={outcome_units:,}; "
        f"wagers={int(totals['wagers'] or 0):,}; staked={money(int(totals['staked'] or 0))}"
    )
    print(
        f"  progressed targets={int(totals['progressed_targets'] or 0):,}; "
        f"fully reconciled targets={int(totals['reconciled_targets'] or 0):,}; "
        f"linked wagers={int(totals['linked'] or 0):,}/{int(totals['wagers'] or 0):,}"
    )
    seconds = float(benchmark["seconds"] or 0)
    completed_units = int(benchmark["target_seasons"] or 0)
    if seconds > 0 and completed_units > 0:
        seconds_per_unit = seconds / completed_units
        remaining_units = max(0, int(totals["target_seasons"] or 0) - completed_units)
        remaining_hours = remaining_units * seconds_per_unit / 3600
        outcome_remaining_units = max(0, outcome_units - completed_units)
        outcome_remaining_hours = outcome_remaining_units * seconds_per_unit / 3600
        print(
            f"  measured league-season={completed_units}, {int(benchmark['matches'] or 0):,} matches, "
            f"{seconds:.1f}s active"
        )
        print(
            f"  projected remaining active time: outcome-first={outcome_remaining_hours:.1f}h; "
            f"full three-year build={remaining_hours:.1f}h"
        )
        print("  Projection is provisional until several large, small, playoff, and cup targets are sampled.")
    else:
        print("  No completed timed target-season yet; projection unavailable.")
    detail_seconds = float(detail_benchmark["seconds"] or 0)
    detail_matches = int(detail_benchmark["matches"] or 0)
    if detail_seconds > 0 and detail_matches > 0:
        seconds_per_match = detail_seconds / detail_matches
        event_count = int(totals["events"] or 0)
        detail_remaining_hours = max(0, event_count - detail_matches) * seconds_per_match / 3600
        print(
            f"  match-detail benchmark={detail_matches}, {int(detail_benchmark['stats'] or 0):,} stats, "
            f"{int(detail_benchmark['h2h'] or 0):,} H2H rows, {detail_seconds:.1f}s active"
        )
        print(
            f"  enriching all {event_count:,} wager-events at that rate would add "
            f"about {detail_remaining_hours:.1f}h active"
        )
    rows = connection.execute(
        """
        SELECT target_id, torn_league_label, wager_count, event_count, staked,
               linked_wager_count, planned_seasons, status, source_url
        FROM collection_targets WHERE plan_id = ?
        ORDER BY priority_score DESC, torn_league_label LIMIT ?
        """,
        (clean_text(plan_id), max(1, limit)),
    ).fetchall()
    print("Top targets")
    for row in rows:
        print(
            f"  {row['target_id']} [{row['status']}] {row['torn_league_label']} — "
            f"bets={int(row['wager_count']):,}, events={int(row['event_count']):,}, "
            f"staked={money(int(row['staked']))}, linked={int(row['linked_wager_count']):,}"
        )


def risk_limits(bankroll: int) -> dict[str, int]:
    return {
        "reserve": math.floor(bankroll * 0.70),
        "deployable": math.floor(bankroll * 0.30),
        "single_option": min(math.floor(bankroll * 0.02), TORN_OPTION_CAP),
        "single_event": math.floor(bankroll * 0.03),
        "open_exposure": math.floor(bankroll * 0.10),
        "daily_stop_loss": math.floor(bankroll * 0.03),
    }


def money(value: int | float) -> str:
    return f"${value:,.0f}"


def print_risk(connection: sqlite3.Connection) -> None:
    row = latest_bankroll(connection)
    if not row:
        raise RuntimeError("No bankroll snapshot. Run init or bankroll first.")
    bankroll = int(row["total"])
    limits = risk_limits(bankroll)
    print(f"Bankroll at {row['observed_at']}: {money(bankroll)}")
    print(f"  reserve (70%):          {money(limits['reserve'])}")
    print(f"  deployable (30%):       {money(limits['deployable'])}")
    print(f"  one option (2% / cap):  {money(limits['single_option'])}")
    print(f"  one event (3%):         {money(limits['single_event'])}")
    print(f"  all open bets (10%):    {money(limits['open_exposure'])}")
    print(f"  daily stop-loss (3%):   {money(limits['daily_stop_loss'])}")


def print_summary(connection: sqlite3.Connection) -> None:
    tables = [
        "capture_runs",
        "events",
        "markets",
        "market_captures",
        "selections",
        "odds_observations",
        "event_outcomes",
        "bets",
        "history_event_details",
        "bankroll_snapshots",
        "reference_capture_runs",
        "sports_competitions",
        "competition_seasons",
        "sports_teams",
        "team_aliases",
        "team_alias_evidence",
        "sports_matches",
        "standings_snapshots",
        "standing_rows",
        "match_stats",
        "h2h_snapshots",
        "h2h_snapshot_matches",
        "capture_events",
        "event_match_links",
        "match_markets",
        "match_market_selections",
        "match_odds_observations",
        "research_slates",
        "research_slate_events",
        "model_versions",
        "team_rating_snapshots",
        "forecast_runs",
        "match_forecasts",
        "decision_records",
        "market_review_coverage",
        "match_market_settlements",
        "forecast_evaluations",
        "backtest_runs",
        "backtest_metrics",
        "collection_plans",
        "collection_targets",
        "collection_target_league_labels",
        "collection_runs",
        "collection_run_targets",
        "collection_checkpoints",
    ]
    for table in tables:
        count = connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        print(f"{table:22} {count:>8,}")
    bankroll = latest_bankroll(connection)
    if bankroll:
        print(f"latest bankroll         {money(int(bankroll['total'])):>12}  ({bankroll['observed_at']})")


def print_sports_summary(connection: sqlite3.Connection) -> None:
    seasons = connection.execute(
        """
        SELECT cs.season_id, sc.sport, sc.country, sc.name AS competition, cs.name AS season,
               cs.start_date, cs.end_date, cs.is_current
        FROM competition_seasons cs
        JOIN sports_competitions sc ON sc.competition_id = cs.competition_id
        ORDER BY cs.start_date, sc.country, sc.name
        """
    ).fetchall()
    if not seasons:
        print("No sports-reference seasons imported.")
        return
    for row in seasons:
        season_id = int(row["season_id"])
        teams = int(
            connection.execute("SELECT COUNT(*) FROM season_teams WHERE season_id = ?", (season_id,)).fetchone()[0]
        )
        match_counts = connection.execute(
            """
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN status = 'finished' THEN 1 ELSE 0 END) AS finished,
                   SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled,
                   SUM(CASE WHEN scheduled_at IS NOT NULL THEN 1 ELSE 0 END) AS exact_times
            FROM sports_matches WHERE season_id = ?
            """,
            (season_id,),
        ).fetchone()
        standing_rows = int(
            connection.execute(
                """
                SELECT COUNT(*) FROM standing_rows sr
                JOIN standings_snapshots ss ON ss.standings_snapshot_id = sr.standings_snapshot_id
                WHERE ss.season_id = ?
                """,
                (season_id,),
            ).fetchone()[0]
        )
        marker = " current" if row["is_current"] else ""
        print(f"{row['sport']} / {row['country']} / {row['competition']} {row['season']}{marker}")
        print(
            f"  teams={teams}, matches={int(match_counts['total'] or 0)}, "
            f"finished={int(match_counts['finished'] or 0)}, scheduled={int(match_counts['scheduled'] or 0)}, "
            f"exact_times={int(match_counts['exact_times'] or 0)}, standings={standing_rows}"
        )
    stats = int(connection.execute("SELECT COUNT(*) FROM match_stats").fetchone()[0])
    h2h = int(connection.execute("SELECT COUNT(*) FROM h2h_snapshot_matches").fetchone()[0])
    competitions = int(connection.execute("SELECT COUNT(*) FROM sports_competitions").fetchone()[0])
    teams = int(connection.execute("SELECT COUNT(*) FROM sports_teams").fetchone()[0])
    matches = int(connection.execute("SELECT COUNT(*) FROM sports_matches").fetchone()[0])
    print(f"reference totals: competitions={competitions}, teams={teams}, matches={matches}, stats={stats}, h2h_rows={h2h}")


def print_modeling_summary(connection: sqlite3.Connection) -> None:
    values = {
        "finished reference matches": connection.execute(
            "SELECT COUNT(*) FROM sports_matches WHERE status = 'finished' AND home_score IS NOT NULL AND away_score IS NOT NULL"
        ).fetchone()[0],
        "reference match-stat rows": connection.execute("SELECT COUNT(*) FROM match_stats").fetchone()[0],
        "confirmed Torn/match links": connection.execute(
            "SELECT COUNT(*) FROM event_match_links WHERE confirmed = 1"
        ).fetchone()[0],
        "candidate Torn/match links": connection.execute(
            "SELECT COUNT(*) FROM event_match_links WHERE confirmed = 0"
        ).fetchone()[0],
        "reconciled Torn outcomes": connection.execute(
            "SELECT COUNT(*) FROM event_outcomes WHERE capture_id LIKE 'outcome-reconciliation:%'"
        ).fetchone()[0],
        "Torn odds observations": connection.execute("SELECT COUNT(*) FROM odds_observations").fetchone()[0],
        "external odds observations": connection.execute(
            "SELECT COUNT(*) FROM match_odds_observations"
        ).fetchone()[0],
        "research slates": connection.execute("SELECT COUNT(*) FROM research_slates").fetchone()[0],
        "model versions": connection.execute("SELECT COUNT(*) FROM model_versions").fetchone()[0],
        "team rating snapshots": connection.execute("SELECT COUNT(*) FROM team_rating_snapshots").fetchone()[0],
        "forecasts": connection.execute("SELECT COUNT(*) FROM match_forecasts").fetchone()[0],
        "decisions (picks and passes)": connection.execute("SELECT COUNT(*) FROM decision_records").fetchone()[0],
        "market coverage decisions": connection.execute(
            "SELECT COUNT(*) FROM market_review_coverage"
        ).fetchone()[0],
        "evaluated decisions": connection.execute("SELECT COUNT(*) FROM forecast_evaluations").fetchone()[0],
        "backtest runs": connection.execute("SELECT COUNT(*) FROM backtest_runs").fetchone()[0],
    }
    print("BMG modeling database coverage")
    for label, value in values.items():
        print(f"  {label:31} {int(value):>10,}")
    linked_bets = int(
        connection.execute(
            """
            SELECT COUNT(DISTINCT b.external_bet_id)
            FROM bets b JOIN event_match_links eml ON eml.event_id = b.event_id
            WHERE eml.confirmed = 1
            """
        ).fetchone()[0]
    )
    total_bets = int(connection.execute("SELECT COUNT(*) FROM bets").fetchone()[0])
    print(f"  linked historical wagers       {linked_bets:>10,} / {total_bets:,}")
    print("Data readiness is not model validation; forecasts still require chronological out-of-sample testing.")


def print_reconciliation_review(connection: sqlite3.Connection) -> None:
    rows = connection.execute(
        """
        SELECT e.source_event_id, e.title AS torn_title, e.league, e.scheduled_at AS torn_scheduled,
               e.settled_at AS torn_settled, eml.confidence, eml.confirmed, eml.link_method,
               sm.match_id, sm.scheduled_at, sm.scheduled_date, sm.status,
               ht.name AS home_team, at.name AS away_team, sc.name AS competition,
               sm.home_score, sm.away_score
        FROM event_match_links eml
        JOIN events e ON e.event_id = eml.event_id
        JOIN sports_matches sm ON sm.match_id = eml.match_id
        JOIN sports_teams ht ON ht.team_id = sm.home_team_id
        JOIN sports_teams at ON at.team_id = sm.away_team_id
        LEFT JOIN sports_competitions sc ON sc.competition_id = sm.competition_id
        ORDER BY eml.confirmed DESC, eml.confidence DESC,
                 COALESCE(sm.scheduled_at, sm.scheduled_date), e.source_event_id
        """
    ).fetchall()
    if not rows:
        print("No Torn/reference reconciliation candidates.")
        return
    for row in rows:
        marker = "CONFIRMED" if row["confirmed"] else "candidate"
        score = ""
        if row["home_score"] is not None and row["away_score"] is not None:
            score = f" {row['home_score']:g}-{row['away_score']:g}"
        print(f"[{marker} {float(row['confidence']):.2f}] Torn {row['source_event_id']}: {row['torn_title']}")
        print(
            f"  -> match {row['match_id']}: {row['home_team']} v {row['away_team']} "
            f"({row['competition'] or 'unknown'}, {row['scheduled_at'] or row['scheduled_date']}){score}"
        )
        print(f"  method={row['link_method']}; Torn time={row['torn_scheduled'] or row['torn_settled'] or 'unknown'}")


def performance_rows(
    connection: sqlite3.Connection, group_expression: str, sport: str | None = None
) -> list[sqlite3.Row]:
    sport_filter = canonical(sport) if sport else ""
    return connection.execute(
        f"""
        SELECT {group_expression} AS segment,
               COUNT(*) AS bets,
               SUM(CASE WHEN b.status IN ('win', 'loss') THEN 1 ELSE 0 END) AS resolved,
               SUM(CASE WHEN b.status = 'win' THEN 1 ELSE 0 END) AS wins,
               SUM(CASE WHEN b.status = 'loss' THEN 1 ELSE 0 END) AS losses,
               SUM(CASE WHEN b.status = 'refund' THEN 1 ELSE 0 END) AS refunds,
               SUM(b.stake) AS staked,
               SUM(COALESCE(
                   b.profit,
                   CASE
                       WHEN b.status = 'win' AND b.payout IS NOT NULL THEN b.payout - b.stake
                       WHEN b.status = 'loss' THEN -b.stake
                       WHEN b.status = 'refund' THEN 0
                   END,
                   0
               )) AS net
        FROM bets b
        LEFT JOIN events e ON e.event_id = b.event_id
        LEFT JOIN markets m ON m.market_id = b.market_id
        WHERE b.status IN ('win', 'loss', 'refund')
          AND (? = '' OR e.sport = ?)
        GROUP BY segment
        HAVING COUNT(*) > 0
        ORDER BY SUM(b.stake) DESC, COUNT(*) DESC
        """,
        (sport_filter, sport_filter),
    ).fetchall()


def print_performance_section(title: str, rows: list[sqlite3.Row], limit: int = 20) -> None:
    print(title)
    if not rows:
        print("  no settled bets")
        return
    for row in rows[:limit]:
        resolved = int(row["resolved"] or 0)
        wins = int(row["wins"] or 0)
        staked = int(row["staked"] or 0)
        net = int(row["net"] or 0)
        win_rate = wins / resolved if resolved else 0
        roi = net / staked if staked else 0
        print(
            f"  {clean_text(row['segment']) or 'unknown':38.38} "
            f"bets={int(row['bets']):>5,} win={win_rate:>6.1%} "
            f"staked={money(staked):>15} net={money(net):>15} ROI={roi:>7.2%}"
        )


def print_history_performance(connection: sqlite3.Connection, sport: str | None = None) -> None:
    label = f" ({canonical(sport)})" if sport else ""
    print_performance_section(
        f"Historical settled-wager performance{label}", performance_rows(connection, "'overall'", sport), 1
    )
    if not sport:
        print_performance_section(
            "By sport", performance_rows(connection, "COALESCE(NULLIF(e.sport, ''), 'unknown')")
        )
    print_performance_section(
        "By Torn market type",
        performance_rows(connection, "COALESCE(NULLIF(m.market_type, ''), 'unknown')", sport),
    )
    odds_band = """
        CASE
            WHEN b.odds_decimal IS NULL THEN 'unknown odds'
            WHEN b.odds_decimal < 1.25 THEN '1.00-1.24'
            WHEN b.odds_decimal < 1.50 THEN '1.25-1.49'
            WHEN b.odds_decimal < 2.00 THEN '1.50-1.99'
            WHEN b.odds_decimal < 3.00 THEN '2.00-2.99'
            WHEN b.odds_decimal < 5.00 THEN '3.00-4.99'
            ELSE '5.00+'
        END
    """
    print_performance_section("By accepted decimal-odds band", performance_rows(connection, odds_band, sport))
    print_performance_section(
        "Largest historical league samples",
        performance_rows(connection, "COALESCE(NULLIF(e.league, ''), 'unknown')", sport),
    )
    print("Descriptive only: these segments reveal behavior and data-quality targets, not a causal betting edge.")


def latest_market_odds(connection: sqlite3.Connection) -> Iterable[sqlite3.Row]:
    return connection.execute(
        """
        WITH latest_market_capture AS (
            SELECT
                mc.capture_id,
                mc.market_id,
                mc.captured_as_complete,
                cr.observed_at,
                ROW_NUMBER() OVER (
                    PARTITION BY mc.market_id
                    ORDER BY cr.observed_at DESC, cr.capture_id DESC
                ) AS rank_number
            FROM market_captures mc
            JOIN capture_runs cr ON cr.capture_id = mc.capture_id
        )
        SELECT
            e.event_uid,
            e.title AS event_title,
            e.scheduled_at,
            m.market_id,
            m.name AS market_name,
            m.market_type,
            lmc.captured_as_complete,
            s.name AS selection_name,
            oo.odds_decimal,
            oo.suspended,
            oo.available,
            oo.observed_at
        FROM latest_market_capture lmc
        JOIN markets m ON m.market_id = lmc.market_id
        JOIN selections s ON s.market_id = m.market_id
        JOIN odds_observations oo
            ON oo.selection_id = s.selection_id
            AND oo.capture_id = lmc.capture_id
        JOIN events e ON e.event_id = m.event_id
        WHERE lmc.rank_number = 1
        ORDER BY e.scheduled_at, e.title, m.name, s.name
        """
    )


def opportunity_market_is_exhaustive(rows: list[Any]) -> bool:
    """Return true only for complete market shapes whose selections cover every outcome."""
    if not rows or not all(bool(row["captured_as_complete"]) for row in rows):
        return False
    market_types = {canonical(row["market_type"]) for row in rows}
    if len(market_types) != 1:
        return False
    market_type = next(iter(market_types))
    names = [canonical(row["selection_name"]) for row in rows]
    if market_type == "three way":
        return len(names) == 3 and sum(name == "draw" for name in names) == 1
    if market_type == "moneyline":
        return len(names) == 2
    if market_type == "both teams to score":
        return len(names) == 2 and set(names) == {"yes", "no"}
    if market_type == "total":
        return (
            len(names) == 2
            and sum(name.startswith("over ") for name in names) == 1
            and sum(name.startswith("under ") for name in names) == 1
        )
    return False


def print_opportunities(connection: sqlite3.Connection) -> None:
    grouped: dict[int, list[sqlite3.Row]] = defaultdict(list)
    for row in latest_market_odds(connection):
        if not row["suspended"] and row["available"] and float(row["odds_decimal"]) > 1:
            grouped[int(row["market_id"])].append(row)
    candidates = 0
    for rows in grouped.values():
        if not opportunity_market_is_exhaustive(rows):
            continue
        implied = sum(1 / float(row["odds_decimal"]) for row in rows)
        if implied >= 1:
            continue
        candidates += 1
        first = rows[0]
        completeness = "captured complete" if first["captured_as_complete"] else "PARTIAL/UNKNOWN"
        print(f"{first['event_title']} — {first['market_name']}")
        print(f"  reciprocal sum {implied:.6f}; theoretical margin {(1 / implied - 1) * 100:.3f}%; {completeness}")
        for row in rows:
            print(f"  - {row['selection_name']}: x{float(row['odds_decimal']):.4f}")
    if not candidates:
        print("No latest provably exhaustive market has a reciprocal-odds sum below 1.0.")
    print(
        "Review only: recheck settlement rules, pushes/refunds, live availability, "
        "stake allocation, and caps before any bet."
    )


def add_bankroll_snapshot(connection: sqlite3.Connection, args: argparse.Namespace) -> None:
    components = [args.wallet, args.bookie, args.stocks, args.other_liquid]
    total = args.total if args.total is not None else sum(components)
    if any(value < 0 for value in components) or total < 0:
        raise ValueError("Bankroll values cannot be negative.")
    connection.execute(
        """
        INSERT INTO bankroll_snapshots (
            observed_at, wallet, bookie, stocks, other_liquid, total, source, note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            args.observed_at or utc_now(),
            args.wallet,
            args.bookie,
            args.stocks,
            args.other_liquid,
            total,
            args.source,
            args.note,
        ),
    )
    connection.commit()
    print(f"Recorded bankroll snapshot: {money(total)}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Bookie Master Grind local data CLI")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help=f"SQLite path (default: {DEFAULT_DB})")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init", help="initialize schema and starting bankroll")
    init_parser.add_argument("--starting-bankroll", type=int, default=STARTING_BANKROLL)

    import_parser = subparsers.add_parser("import", help="import one or more userscript JSON exports")
    import_parser.add_argument("paths", type=Path, nargs="+")

    detail_parser = subparsers.add_parser("import-details", help="import expanded My Bets NDJSON details")
    detail_parser.add_argument("paths", type=Path, nargs="+")

    reference_parser = subparsers.add_parser(
        "import-flashscore", help="import one or more foreground Flashscore league captures"
    )
    reference_parser.add_argument("paths", type=Path, nargs="+")

    odds_parser = subparsers.add_parser(
        "import-odds", help="import source-neutral timestamped market-odds captures"
    )
    odds_parser.add_argument("paths", type=Path, nargs="+")

    subparsers.add_parser("summary", help="show database row counts and latest bankroll")
    subparsers.add_parser("sports-summary", help="show imported league, season, match, stats, and H2H coverage")
    subparsers.add_parser("modeling-summary", help="show reconciliation, odds, forecast, and backtest readiness")
    subparsers.add_parser("reconciliation-review", help="show every Torn/reference match-link candidate")
    history_parser = subparsers.add_parser(
        "history-performance", help="describe settled wager results by market, odds band, and league"
    )
    history_parser.add_argument("--sport", help="optional canonical sport filter, such as football")
    subparsers.add_parser("risk", help="show bankroll guardrails")
    subparsers.add_parser("opportunities", help="show latest mathematical market-review candidates")

    reconcile_parser = subparsers.add_parser(
        "reconcile", help="link Torn football events to imported canonical matches"
    )
    reconcile_parser.add_argument("--sport", default="football")
    reconcile_parser.add_argument("--max-day-gap", type=int, default=1)
    reconcile_parser.add_argument(
        "--confirm-exact",
        action="store_true",
        help="confirm only unique exact-team, same-date or time-aligned matches; otherwise store review candidates",
    )

    alias_audit_parser = subparsers.add_parser(
        "team-alias-audit",
        help="find evidence-backed Torn/provider team aliases without applying fuzzy pairs",
    )
    alias_audit_parser.add_argument("--sport", default="football")
    alias_audit_parser.add_argument("--max-time-gap-hours", type=float, default=6.0)
    alias_audit_parser.add_argument("--output", type=Path, default=DEFAULT_TEAM_ALIAS_AUDIT)

    alias_apply_parser = subparsers.add_parser(
        "team-alias-apply", help="apply only the reproducible automatic aliases from an audit"
    )
    alias_apply_parser.add_argument("audit", type=Path, nargs="?", default=DEFAULT_TEAM_ALIAS_AUDIT)

    review_apply_parser = subparsers.add_parser(
        "event-match-review-apply",
        help="apply drift-checked confirmed/rejected event-match review decisions",
    )
    review_apply_parser.add_argument(
        "registry", type=Path, nargs="?", default=DEFAULT_EVENT_MATCH_REVIEW
    )

    subparsers.add_parser(
        "sync-outcomes", help="copy scores from confirmed match links into auditable Torn outcomes"
    )

    slate_parser = subparsers.add_parser(
        "slate", help="create/update a research slate from one Torn capture"
    )
    slate_parser.add_argument("capture_id")
    slate_parser.add_argument("--slate-id")
    slate_parser.add_argument("--sport", default="football")
    slate_parser.add_argument("--complete", action="store_true")
    slate_parser.add_argument("--note", default="")

    model_parser = subparsers.add_parser("model-register", help="register an auditable model version")
    model_parser.add_argument("name")
    model_parser.add_argument("version")
    model_parser.add_argument("--sport", default="football")
    model_parser.add_argument("--algorithm", required=True)
    model_parser.add_argument("--feature-spec", default="{}")
    model_parser.add_argument("--training-cutoff")
    model_parser.add_argument("--active", action="store_true")
    model_parser.add_argument("--notes", default="")

    daily_review_parser = subparsers.add_parser(
        "daily-review",
        help="create a depth-aware external-price paper ledger for one captured UTC date",
    )
    daily_review_parser.add_argument("--date", help="UTC date (YYYY-MM-DD); defaults to latest research slate")
    daily_review_parser.add_argument("--sport", default="football")
    daily_review_parser.add_argument("--min-books", type=int, default=5)
    daily_review_parser.add_argument("--min-ev", type=float, default=0.03)
    daily_review_parser.add_argument("--kelly-fraction", type=float, default=0.25)
    daily_review_parser.add_argument("--max-bankroll-fraction", type=float, default=0.01)
    daily_review_parser.add_argument(
        "--snapshot-label", default="", help="stage such as morning, pre-kickoff, or ad-hoc"
    )
    daily_review_parser.add_argument("--run-id")
    daily_review_parser.add_argument("--notes", default="")
    daily_review_parser.add_argument(
        "--output", type=Path, help="optional Markdown report path (BMG/data is ignored by Git)"
    )

    settle_review_parser = subparsers.add_parser(
        "settle-review",
        help="settle final fixtures and evaluate a paper-review run against pre-kickoff closing prices",
    )
    settle_review_parser.add_argument(
        "run_id", nargs="?", help="forecast run ID; defaults to the latest run with decisions"
    )
    settle_review_parser.add_argument("--evaluated-at", help="optional UTC ISO evaluation timestamp")
    settle_review_parser.add_argument(
        "--output", type=Path, help="optional Markdown report path (BMG/data is ignored by Git)"
    )

    collection_plan_parser = subparsers.add_parser(
        "collection-plan", help="build/update a ranked historical-data backlog from Torn wagers"
    )
    collection_plan_parser.add_argument("plan_id")
    collection_plan_parser.add_argument("--name", default="Football historical outcomes")
    collection_plan_parser.add_argument("--sport", default="football")
    collection_plan_parser.add_argument("--years", type=int, default=3)
    collection_plan_parser.add_argument("--source", default="flashscore-visible-browser")
    collection_plan_parser.add_argument("--notes", default="")

    collection_map_parser = subparsers.add_parser(
        "collection-map", help="attach an approved source URL to a collection target"
    )
    collection_map_parser.add_argument("target_id")
    collection_map_parser.add_argument("source_url")
    collection_map_parser.add_argument("--source-competition-id", default="")

    collection_start_parser = subparsers.add_parser(
        "collection-start", help="start a timed foreground collection run"
    )
    collection_start_parser.add_argument("plan_id")
    collection_start_parser.add_argument("target_id")
    collection_start_parser.add_argument("season_name")
    collection_start_parser.add_argument("--mode", choices=("foreground", "benchmark"), default="foreground")
    collection_start_parser.add_argument("--notes", default="")

    checkpoint_parser = subparsers.add_parser(
        "collection-checkpoint", help="record progress inside a timed collection run"
    )
    checkpoint_parser.add_argument("run_id")
    checkpoint_parser.add_argument("phase")
    checkpoint_parser.add_argument("--page-url", default="")
    checkpoint_parser.add_argument("--items", type=int, default=0)
    checkpoint_parser.add_argument("--elapsed-seconds", type=float, default=0)
    checkpoint_parser.add_argument("--note", default="")

    collection_finish_parser = subparsers.add_parser(
        "collection-finish", help="finish a timed collection run and store measured throughput"
    )
    collection_finish_parser.add_argument("run_id")
    collection_finish_parser.add_argument("--status", choices=("complete", "partial", "failed"), default="complete")
    collection_finish_parser.add_argument(
        "--target-status",
        choices=("mapped", "collecting", "captured", "imported", "reconciled", "blocked"),
        default="captured",
    )
    collection_finish_parser.add_argument("--finished-at")
    collection_finish_parser.add_argument("--active-seconds", type=float)
    collection_finish_parser.add_argument("--pages", type=int, default=0)
    collection_finish_parser.add_argument("--matches", type=int, default=0)
    collection_finish_parser.add_argument("--standings", type=int, default=0)
    collection_finish_parser.add_argument("--stats", type=int, default=0)
    collection_finish_parser.add_argument("--h2h", type=int, default=0)
    collection_finish_parser.add_argument("--bytes", type=int, default=0)
    collection_finish_parser.add_argument("--notes", default="")

    collection_progress_parser = subparsers.add_parser(
        "collection-progress", help="show ranked backlog, measured throughput, and provisional ETA"
    )
    collection_progress_parser.add_argument("plan_id")
    collection_progress_parser.add_argument("--limit", type=int, default=20)

    bankroll_parser = subparsers.add_parser("bankroll", help="record a manual/API bankroll snapshot")
    bankroll_parser.add_argument("--wallet", type=int, default=0)
    bankroll_parser.add_argument("--bookie", type=int, default=0)
    bankroll_parser.add_argument("--stocks", type=int, default=0)
    bankroll_parser.add_argument("--other-liquid", type=int, default=0)
    bankroll_parser.add_argument("--total", type=int)
    bankroll_parser.add_argument("--observed-at")
    bankroll_parser.add_argument("--source", default="manual")
    bankroll_parser.add_argument("--note", default="")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    connection = open_database(args.db.resolve())
    try:
        if args.command == "init":
            if args.starting_bankroll < 0:
                raise ValueError("Starting bankroll cannot be negative.")
            seeded = initialize_database(connection, args.starting_bankroll)
            print(f"Initialized {args.db.resolve()}")
            print("Starting bankroll recorded." if seeded else "Existing bankroll snapshot preserved.")
        else:
            apply_schema(connection)
            if args.command == "import":
                total: dict[str, int] = {}
                for path in args.paths:
                    merge_counts(total, import_file(connection, path.resolve()))
                ordered = ["captures", "events", "markets", "selections", "odds", "outcomes", "bets"]
                print("Imported " + ", ".join(f"{key}={total.get(key, 0)}" for key in ordered))
            elif args.command == "import-details":
                total = {}
                for path in args.paths:
                    merge_counts(total, import_history_details_file(connection, path.resolve()))
                ordered = ["details", "captures", "events", "markets", "selections", "odds"]
                print("Imported " + ", ".join(f"{key}={total.get(key, 0)}" for key in ordered))
            elif args.command == "import-flashscore":
                total = {}
                for path in args.paths:
                    merge_counts(total, import_flashscore_file(connection, path.resolve()))
                ordered = [
                    "captures",
                    "competitions",
                    "seasons",
                    "teams",
                    "matches",
                    "standings",
                    "stats",
                    "h2h_matches",
                ]
                print("Imported " + ", ".join(f"{key}={total.get(key, 0)}" for key in ordered))
            elif args.command == "import-odds":
                total = {}
                for path in args.paths:
                    merge_counts(total, import_market_odds_file(connection, path.resolve()))
                ordered = ["captures", "matches", "markets", "selections", "odds"]
                print("Imported " + ", ".join(f"{key}={total.get(key, 0)}" for key in ordered))
            elif args.command == "summary":
                print_summary(connection)
            elif args.command == "sports-summary":
                print_sports_summary(connection)
            elif args.command == "modeling-summary":
                print_modeling_summary(connection)
            elif args.command == "reconciliation-review":
                print_reconciliation_review(connection)
            elif args.command == "history-performance":
                print_history_performance(connection, args.sport)
            elif args.command == "risk":
                print_risk(connection)
            elif args.command == "opportunities":
                print_opportunities(connection)
            elif args.command == "reconcile":
                result = reconcile_event_matches(
                    connection,
                    sport=args.sport,
                    max_day_gap=args.max_day_gap,
                    confirm_exact=args.confirm_exact,
                )
                print("Reconciled " + ", ".join(f"{key}={value}" for key, value in result.items()))
            elif args.command == "team-alias-audit":
                result = build_team_alias_audit(
                    connection,
                    sport=args.sport,
                    max_time_gap_hours=args.max_time_gap_hours,
                )
                args.output.parent.mkdir(parents=True, exist_ok=True)
                temporary = args.output.with_suffix(args.output.suffix + ".tmp")
                temporary.write_text(
                    json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                temporary.replace(args.output)
                values = result["summary"]
                print(
                    f"Team alias audit automatic={values['automatic_aliases']}, "
                    f"evidence_events={values['automatic_evidence_events']}, "
                    f"review={values['review_matches']}, conflicts={values['conflicts']}; "
                    f"report={args.output}"
                )
            elif args.command == "team-alias-apply":
                audit = json.loads(args.audit.read_text(encoding="utf-8"))
                result = apply_team_alias_audit(connection, audit)
                print("Applied team aliases " + ", ".join(f"{key}={value}" for key, value in result.items()))
            elif args.command == "event-match-review-apply":
                registry = json.loads(args.registry.read_text(encoding="utf-8"))
                result = apply_reviewed_event_match_decisions(connection, registry)
                print(
                    "Applied reviewed event matches "
                    + ", ".join(f"{key}={value}" for key, value in result.items())
                )
            elif args.command == "sync-outcomes":
                result = sync_confirmed_outcomes(connection)
                print("Synced " + ", ".join(f"{key}={value}" for key, value in result.items()))
            elif args.command == "slate":
                result = create_research_slate(
                    connection,
                    args.capture_id,
                    slate_id=args.slate_id,
                    sport=args.sport,
                    capture_complete=args.complete,
                    note=args.note,
                )
                print(f"Recorded {result['slate_id']} with {result['events']} events.")
            elif args.command == "model-register":
                register_model_version(connection, args)
            elif args.command == "daily-review":
                result = run_daily_paper_review(
                    connection,
                    review_date=args.date,
                    sport=args.sport,
                    min_books=args.min_books,
                    min_ev=args.min_ev,
                    kelly_fraction=args.kelly_fraction,
                    max_bankroll_fraction=args.max_bankroll_fraction,
                    snapshot_label=args.snapshot_label,
                    run_id=args.run_id,
                    notes=args.notes,
                )
                report = render_daily_paper_review(result)
                print(report)
                if args.output:
                    output = args.output.resolve()
                    output.parent.mkdir(parents=True, exist_ok=True)
                    temporary = output.with_suffix(output.suffix + ".tmp")
                    temporary.write_text(report, encoding="utf-8")
                    temporary.replace(output)
                    print(f"Report written to {output}")
            elif args.command == "settle-review":
                result = settle_review(
                    connection,
                    run_id=args.run_id,
                    evaluated_at=args.evaluated_at,
                )
                report = render_settlement_review(result)
                print(report)
                if args.output:
                    output = args.output.resolve()
                    output.parent.mkdir(parents=True, exist_ok=True)
                    temporary = output.with_suffix(output.suffix + ".tmp")
                    temporary.write_text(report, encoding="utf-8")
                    temporary.replace(output)
                    print(f"Report written to {output}")
            elif args.command == "collection-plan":
                result = build_collection_plan(
                    connection,
                    plan_id=args.plan_id,
                    name=args.name,
                    sport=args.sport,
                    history_years=args.years,
                    source=args.source,
                    notes=args.notes,
                )
                print(
                    f"Recorded {result['plan_id']}: targets={result['targets']}, "
                    f"wagers={result['wagers']}, staked={money(int(result['staked']))}."
                )
            elif args.command == "collection-map":
                map_collection_target(
                    connection, args.target_id, args.source_url, args.source_competition_id
                )
                print(f"Mapped {args.target_id} to {args.source_url}.")
            elif args.command == "collection-start":
                run_id = start_collection_run(
                    connection,
                    plan_id=args.plan_id,
                    target_id=args.target_id,
                    season_name=args.season_name,
                    mode=args.mode,
                    notes=args.notes,
                )
                print(run_id)
            elif args.command == "collection-checkpoint":
                add_collection_checkpoint(
                    connection,
                    run_id=args.run_id,
                    phase=args.phase,
                    page_url=args.page_url,
                    items_visible=args.items,
                    elapsed_seconds=args.elapsed_seconds,
                    note=args.note,
                )
                print(f"Checkpoint recorded for {args.run_id}.")
            elif args.command == "collection-finish":
                finish_collection_run(connection, args)
                print(f"Finished {args.run_id} with status={args.status}.")
            elif args.command == "collection-progress":
                print_collection_progress(connection, args.plan_id, args.limit)
            elif args.command == "bankroll":
                add_bankroll_snapshot(connection, args)
        return 0
    except (OSError, json.JSONDecodeError, sqlite3.Error, ValueError, RuntimeError) as error:
        print(f"BMG error: {error}", file=sys.stderr)
        return 1
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
