#!/usr/bin/env python3
"""BMG local database, import, bankroll, and odds-math CLI."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


PROJECT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DB = PROJECT_DIR / "data" / "bmg.sqlite"
SCHEMA_FILES = sorted((PROJECT_DIR / "schema").glob("[0-9][0-9][0-9]_*.sql"))
STARTING_BANKROLL = 57_365_830
TORN_OPTION_CAP = 1_000_000_000
CAPTURE_SCHEMA = "bmg.capture.v1"


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
    }
    for table, columns in migrations.items():
        existing = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
        for column, declaration in columns.items():
            if column not in existing:
                connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_bets_settled_at ON bets (settled_at DESC)")
    connection.execute("PRAGMA user_version = 3")


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
    event_stub = {
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
    event_id = upsert_event(connection, event_stub, observed_at)
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
    if capture.get("schema_version") != "bmg.flashscore-league.v1":
        raise ValueError("Unsupported Flashscore capture schema.")
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
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    total: dict[str, int] = {}
    with connection:
        for capture in flashscore_capture_objects(payload):
            merge_counts(total, import_flashscore_capture(connection, capture))
    return total


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
        "sports_matches",
        "standings_snapshots",
        "standing_rows",
        "match_stats",
        "h2h_snapshots",
        "h2h_snapshot_matches",
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


def print_opportunities(connection: sqlite3.Connection) -> None:
    grouped: dict[int, list[sqlite3.Row]] = defaultdict(list)
    for row in latest_market_odds(connection):
        if not row["suspended"] and row["available"] and float(row["odds_decimal"]) > 1:
            grouped[int(row["market_id"])].append(row)
    candidates = 0
    for rows in grouped.values():
        if len(rows) < 2:
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
        print("No latest market has a reciprocal-odds sum below 1.0.")
    print("Review only: verify exhaustive outcomes, identical settlement rules, availability, and caps before any bet.")


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

    subparsers.add_parser("summary", help="show database row counts and latest bankroll")
    subparsers.add_parser("sports-summary", help="show imported league, season, match, stats, and H2H coverage")
    subparsers.add_parser("risk", help="show bankroll guardrails")
    subparsers.add_parser("opportunities", help="show latest mathematical market-review candidates")

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
            elif args.command == "summary":
                print_summary(connection)
            elif args.command == "sports-summary":
                print_sports_summary(connection)
            elif args.command == "risk":
                print_risk(connection)
            elif args.command == "opportunities":
                print_opportunities(connection)
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
