#!/usr/bin/env python3
"""BMG local database, import, bankroll, and odds-math CLI."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


PROJECT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DB = PROJECT_DIR / "data" / "bmg.sqlite"
SCHEMA_FILE = PROJECT_DIR / "schema" / "001_initial.sql"
STARTING_BANKROLL = 57_365_830
TORN_OPTION_CAP = 1_000_000_000
CAPTURE_SCHEMA = "bmg.capture.v1"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def clean_text(value: Any) -> str:
    return " ".join(str(value or "").split())


def canonical(value: Any) -> str:
    return " ".join(
        "".join(character.lower() if character.isalnum() else " " for character in clean_text(value)).split()
    )


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
    connection.executescript(SCHEMA_FILE.read_text(encoding="utf-8"))


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
        "visible_status": clean_text(event.get("visible_status") or event.get("status")),
        "observed_at": observed_at,
        "raw_state_text": clean_text(event.get("raw_state_text")),
    }
    connection.execute(
        """
        INSERT INTO events (
            event_uid, source_event_id, sport, title, league, home_team, away_team,
            scheduled_at, visible_status, first_observed_at, last_observed_at, raw_state_text
        ) VALUES (
            :event_uid, :source_event_id, :sport, :title, :league, :home_team, :away_team,
            :scheduled_at, :visible_status, :observed_at, :observed_at, :raw_state_text
        )
        ON CONFLICT(event_uid) DO UPDATE SET
            source_event_id = CASE WHEN excluded.source_event_id <> '' THEN excluded.source_event_id ELSE events.source_event_id END,
            sport = CASE WHEN excluded.sport <> 'unknown' THEN excluded.sport ELSE events.sport END,
            title = CASE WHEN excluded.title <> 'Unknown Torn Bookie event' THEN excluded.title ELSE events.title END,
            league = CASE WHEN excluded.league <> '' THEN excluded.league ELSE events.league END,
            home_team = CASE WHEN excluded.home_team <> '' THEN excluded.home_team ELSE events.home_team END,
            away_team = CASE WHEN excluded.away_team <> '' THEN excluded.away_team ELSE events.away_team END,
            scheduled_at = COALESCE(excluded.scheduled_at, events.scheduled_at),
            visible_status = CASE WHEN excluded.visible_status <> '' THEN excluded.visible_status ELSE events.visible_status END,
            last_observed_at = excluded.last_observed_at,
            raw_state_text = CASE WHEN excluded.raw_state_text <> '' THEN excluded.raw_state_text ELSE events.raw_state_text END
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            last_observed_at = excluded.last_observed_at,
            raw_text = CASE WHEN excluded.raw_text <> '' THEN excluded.raw_text ELSE bets.raw_text END
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
        "bankroll_snapshots",
    ]
    for table in tables:
        count = connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        print(f"{table:22} {count:>8,}")
    bankroll = latest_bankroll(connection)
    if bankroll:
        print(f"latest bankroll         {money(int(bankroll['total'])):>12}  ({bankroll['observed_at']})")


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

    subparsers.add_parser("summary", help="show database row counts and latest bankroll")
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
            elif args.command == "summary":
                print_summary(connection)
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
