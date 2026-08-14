"""Validate and import prompted pulls from the private BMG capture inbox."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Any

import bmg


FORBIDDEN_KEYS = {
    "api_key",
    "apikey",
    "authorization",
    "cookie",
    "cookies",
    "password",
    "secret",
    "token",
    "torn_key",
}


def normalized_key(value: Any) -> str:
    text = "".join(character.lower() if character.isalnum() else "_" for character in str(value))
    return "_".join(part for part in text.split("_") if part)


def contains_forbidden_key(value: Any) -> bool:
    if isinstance(value, list):
        return any(contains_forbidden_key(item) for item in value)
    if not isinstance(value, dict):
        return False
    return any(
        normalized_key(key) in FORBIDDEN_KEYS or contains_forbidden_key(child)
        for key, child in value.items()
    )


def validate_inbox_export(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(payload, dict) or payload.get("schema_version") != "bmg.export.v1":
        raise ValueError(f"{path} is not a bmg.export.v1 document.")
    if contains_forbidden_key(payload):
        raise ValueError(f"{path} contains a credential-like field.")
    captures = payload.get("captures")
    if not isinstance(captures, list) or not 1 <= len(captures) <= 30:
        raise ValueError(f"{path} must contain between 1 and 30 captures.")
    seen: set[str] = set()
    for index, capture in enumerate(captures, start=1):
        if not isinstance(capture, dict) or capture.get("schema_version") != "bmg.capture.v1":
            raise ValueError(f"{path} capture {index} has an unsupported schema.")
        capture_id = str(capture.get("capture_id") or "").strip()
        observed_at = str(capture.get("observed_at") or "").strip()
        source = str(capture.get("source") or "").strip()
        if not capture_id or capture_id in seen:
            raise ValueError(f"{path} capture {index} has a missing or duplicate ID.")
        if not observed_at.endswith("Z") or "T" not in observed_at:
            raise ValueError(f"{path} capture {index} has an invalid observation time.")
        if not source.startswith("torn-visible-"):
            raise ValueError(f"{path} capture {index} has an unexpected source.")
        if not (capture.get("events") or capture.get("bets")):
            raise ValueError(f"{path} capture {index} contains no events or bets.")
        seen.add(capture_id)
    return payload


def incoming_files(repository: Path) -> list[Path]:
    root = repository.resolve() / "incoming"
    if not root.exists():
        return []
    return sorted(path for path in root.rglob("*.json") if path.is_file())


def processed_path(repository: Path, source: Path) -> Path:
    relative = source.resolve().relative_to((repository.resolve() / "incoming"))
    return repository.resolve() / "processed" / relative


def process_inbox(repository: Path, database: Path, *, dry_run: bool = False) -> dict[str, int]:
    files = incoming_files(repository)
    totals = {
        "files": len(files),
        "processed": 0,
        "captures": 0,
        "events": 0,
        "markets": 0,
        "selections": 0,
        "odds": 0,
        "outcomes": 0,
        "bets": 0,
    }
    if dry_run:
        for path in files:
            validate_inbox_export(path)
        return totals

    connection = bmg.open_database(database.resolve())
    try:
        bmg.apply_schema(connection)
        for path in files:
            validate_inbox_export(path)
            counts = bmg.import_file(connection, path)
            destination = processed_path(repository, path)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists():
                if destination.read_bytes() != path.read_bytes():
                    raise ValueError(f"Processed path collision: {destination}")
                path.unlink()
            else:
                shutil.move(str(path), str(destination))
            totals["processed"] += 1
            for key, value in counts.items():
                totals[key] = totals.get(key, 0) + value
    finally:
        connection.close()
    return totals


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Process the private BMG Git capture inbox")
    parser.add_argument("repository", type=Path, help="local checkout of bmg-capture-inbox")
    parser.add_argument("--db", type=Path, default=bmg.DEFAULT_DB)
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    totals = process_inbox(args.repository, args.db, dry_run=args.dry_run)
    print(", ".join(f"{key}={value}" for key, value in totals.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
