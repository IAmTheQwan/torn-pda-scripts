#!/usr/bin/env python3
"""API-Football collection and coverage-audit tooling for BMG."""

from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import sqlite3
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import bmg


PROJECT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_ENV = PROJECT_DIR / ".env"
DEFAULT_DB = PROJECT_DIR / "data" / "bmg.sqlite"
DEFAULT_CATALOG = PROJECT_DIR / "data" / "api-football-catalog.json"
DEFAULT_AUDIT = PROJECT_DIR / "data" / "api-football-coverage-audit.json"
DEFAULT_BACKFILL_REPORT = PROJECT_DIR / "data" / "api-football-exact-backfill.json"
DEFAULT_BASE_URL = "https://v3.football.api-sports.io"
SOURCE = "api-football"


class ApiFootballError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def load_env(path: Path = DEFAULT_ENV) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        os.environ.setdefault(name.strip(), value.strip().strip('"').strip("'"))


class ApiFootballClient:
    def __init__(self, key: str, base_url: str = DEFAULT_BASE_URL, timeout: int = 45) -> None:
        if not key:
            raise ApiFootballError(
                "API_FOOTBALL_KEY is missing. Put it in BMG/.env; never commit the key."
            )
        self.key = key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.requests_used = 0
        self.last_headers: dict[str, str] = {}
        self.ssl_context = ssl.create_default_context()
        # Python 3.13 enables OpenSSL's strict X.509 mode by default. Some
        # otherwise valid Windows CA chains omit a critical marker on an
        # intermediate certificate. Keep certificate and hostname validation
        # enabled while accepting those pre-3.13-compatible chains.
        if hasattr(ssl, "VERIFY_X509_STRICT"):
            self.ssl_context.verify_flags &= ~ssl.VERIFY_X509_STRICT
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=self.ssl_context)
        )

    def get(self, endpoint: str, parameters: dict[str, Any] | None = None) -> dict[str, Any]:
        query = urllib.parse.urlencode(
            {name: value for name, value in (parameters or {}).items() if value is not None and value != ""}
        )
        url = f"{self.base_url}/{endpoint.lstrip('/')}"
        if query:
            url += "?" + query
        request = urllib.request.Request(
            url,
            headers={"x-apisports-key": self.key, "Accept": "application/json"},
            method="GET",
        )
        for attempt in range(4):
            if self.requests_used:
                time.sleep(0.16)
            try:
                with self.opener.open(request, timeout=self.timeout) as response:
                    self.requests_used += 1
                    self.last_headers = {
                        name.lower(): value
                        for name, value in response.headers.items()
                        if name.lower().startswith("x-ratelimit")
                    }
                    payload = json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as error:
                self.requests_used += 1
                if error.code == 429 and attempt < 3:
                    time.sleep(float(error.headers.get("Retry-After", 2 ** (attempt + 1))))
                    continue
                detail = error.read().decode("utf-8", errors="replace")[:500]
                raise ApiFootballError(f"API-Football HTTP {error.code}: {detail}") from error
            except (urllib.error.URLError, TimeoutError) as error:
                if attempt < 3:
                    time.sleep(2 ** attempt)
                    continue
                raise ApiFootballError(f"API-Football request failed: {error}") from error
            errors = payload.get("errors")
            if errors:
                raise ApiFootballError(f"API-Football returned errors: {errors}")
            return payload
        raise ApiFootballError("API-Football request exhausted its retries.")

    def get_all(self, endpoint: str, parameters: dict[str, Any] | None = None) -> dict[str, Any]:
        combined: list[Any] = []
        page = 1
        first: dict[str, Any] | None = None
        while True:
            query = dict(parameters or {})
            query["page"] = page
            payload = self.get(endpoint, query)
            first = first or payload
            response = payload.get("response")
            if isinstance(response, list):
                combined.extend(response)
            elif response is not None:
                combined.append(response)
            paging = payload.get("paging") if isinstance(payload.get("paging"), dict) else {}
            total = int(paging.get("total") or 1)
            if page >= total:
                break
            page += 1
        result = dict(first or {})
        result["response"] = combined
        result["paging"] = {"current": page, "total": page}
        result["results"] = len(combined)
        return result


def make_client(env_path: Path) -> ApiFootballClient:
    load_env(env_path)
    return ApiFootballClient(
        os.environ.get("API_FOOTBALL_KEY", ""),
        os.environ.get("API_FOOTBALL_BASE_URL", DEFAULT_BASE_URL),
    )


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def fetch_catalog(client: ApiFootballClient, path: Path) -> dict[str, Any]:
    payload = client.get("leagues")
    catalog = {
        "schema_version": "bmg.api-football-catalog.v1",
        "captured_at": utc_now(),
        "source": SOURCE,
        "leagues": payload.get("response") or [],
    }
    write_json(path, catalog)
    return catalog


def read_catalog(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise ApiFootballError(f"No catalog cache at {path}; rerun with --refresh-catalog.")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema_version") != "bmg.api-football-catalog.v1":
        raise ApiFootballError("Unsupported API-Football catalog cache.")
    return payload


def normalized(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(character for character in text if not unicodedata.combining(character))
    text = text.lower().replace("&", " and ")
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


NAME_REPLACEMENTS = {
    "champions league": "champions cup",
    "division intermedia": "division intermedia",
    "first division": "division 1",
    "segunda division": "division 2",
    "premiership": "premier league",
}


COUNTRY_ALIASES = {
    "bolivia": "bolivia",
    "czech republic": "czech republic",
    "england": "england",
    "ivory coast": "ivory coast",
    "korea republic": "south korea",
    "northern ireland": "northern ireland",
    "republic of ireland": "ireland",
    "scotland": "scotland",
    "usa": "usa",
    "united states": "usa",
    "wales": "wales",
    "world championship": "world",
}


def normalized_name(value: Any) -> str:
    result = normalized(value)
    for source, replacement in NAME_REPLACEMENTS.items():
        result = result.replace(source, replacement)
    return " ".join(result.split())


def normalized_country(value: Any) -> str:
    result = normalized(value)
    result = re.sub(r"\s+\d+$", "", result).strip()
    return COUNTRY_ALIASES.get(result, result)


def target_season_year(label: str) -> int | None:
    match = re.search(r"\b(19\d{2}|20\d{2})\b", label)
    return int(match.group(1)) if match else None


def token_similarity(left: str, right: str) -> float:
    left_tokens, right_tokens = set(left.split()), set(right.split())
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / len(left_tokens | right_tokens)


def candidate_score(
    target_name: str,
    target_jurisdiction: str,
    required_seasons: set[int],
    candidate: dict[str, Any],
    *,
    strict_country: bool = False,
) -> dict[str, Any]:
    league = candidate.get("league") if isinstance(candidate.get("league"), dict) else {}
    country = candidate.get("country") if isinstance(candidate.get("country"), dict) else {}
    prepared = candidate.get("_bmg_audit") if isinstance(candidate.get("_bmg_audit"), dict) else {}
    candidate_name = prepared.get("name") or normalized_name(league.get("name"))
    wanted_name = normalized_name(target_name)
    sequence = SequenceMatcher(None, wanted_name, candidate_name).ratio() if wanted_name else 0.0
    tokens = token_similarity(wanted_name, candidate_name)
    name_score = 1.0 if wanted_name and wanted_name == candidate_name else max(sequence, tokens)
    wanted_country = normalized_country(target_jurisdiction)
    candidate_country = prepared.get("country") or normalized_country(country.get("name"))
    country_score = 0.0
    if wanted_country and candidate_country:
        country_score = (
            1.0
            if wanted_country == candidate_country
            else SequenceMatcher(None, wanted_country, candidate_country).ratio()
        )
    available = set(prepared.get("seasons") or ()) or {
        int(season.get("year"))
        for season in (candidate.get("seasons") or [])
        if isinstance(season, dict) and str(season.get("year") or "").isdigit()
    }
    season_score = (
        len(required_seasons & available) / len(required_seasons) if required_seasons else 1.0
    )
    score = 0.72 * name_score + 0.18 * country_score + 0.10 * season_score
    if strict_country:
        if wanted_country != candidate_country:
            score *= 0.55
        else:
            # A renamed competition in the correct country is a useful review
            # candidate, but cannot auto-map without a strong name match.
            score = max(score, 0.40 * name_score + 0.40 + 0.20 * season_score)
    generic = wanted_name in {"premier league", "first division", "division 1", "cup", "super cup"}
    if generic and country_score < 0.95:
        score = min(score, 0.70)
    return {
        "score": round(score, 4),
        "name_score": round(name_score, 4),
        "country_score": round(country_score, 4),
        "season_score": round(season_score, 4),
        "available_seasons": sorted(available),
    }


def summarize_candidate(candidate: dict[str, Any], score: dict[str, Any]) -> dict[str, Any]:
    league = candidate.get("league") if isinstance(candidate.get("league"), dict) else {}
    country = candidate.get("country") if isinstance(candidate.get("country"), dict) else {}
    available = set(score["available_seasons"])
    season_coverage: dict[str, Any] = {}
    for season in candidate.get("seasons") or []:
        if not isinstance(season, dict) or season.get("year") not in available:
            continue
        coverage = season.get("coverage") if isinstance(season.get("coverage"), dict) else {}
        fixtures = coverage.get("fixtures") if isinstance(coverage.get("fixtures"), dict) else {}
        season_coverage[str(season.get("year"))] = {
            "start": season.get("start"),
            "end": season.get("end"),
            "current": bool(season.get("current")),
            "standings": bool(coverage.get("standings")),
            "events": bool(fixtures.get("events")),
            "lineups": bool(fixtures.get("lineups")),
            "fixture_statistics": bool(fixtures.get("statistics_fixtures")),
            "player_statistics": bool(fixtures.get("statistics_players")),
            "predictions": bool(coverage.get("predictions")),
            "odds": bool(coverage.get("odds")),
        }
    return {
        "league_id": league.get("id"),
        "name": league.get("name"),
        "type": league.get("type"),
        "country": country.get("name"),
        **{name: score[name] for name in ("score", "name_score", "country_score", "season_score")},
        "available_seasons": score["available_seasons"],
        "season_coverage": season_coverage,
    }


def collection_targets(connection: sqlite3.Connection, plan_id: str) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT target_id, competition_family, jurisdiction, torn_league_label,
               wager_count, event_count, staked, priority_score
        FROM collection_targets
        WHERE plan_id = ?
        ORDER BY priority_score DESC, target_id
        """,
        (plan_id,),
    ).fetchall()
    labels: dict[str, list[str]] = {}
    for row in connection.execute(
        """
        SELECT ctl.target_id, ctl.torn_league_label
        FROM collection_target_league_labels ctl
        JOIN collection_targets ct ON ct.target_id = ctl.target_id
        WHERE ct.plan_id = ?
        ORDER BY ctl.target_id, ctl.torn_league_label
        """,
        (plan_id,),
    ):
        labels.setdefault(str(row["target_id"]), []).append(str(row["torn_league_label"]))
    return [
        {
            **dict(row),
            "labels": labels.get(str(row["target_id"]), [str(row["torn_league_label"])]),
        }
        for row in rows
    ]


def audit_catalog(
    connection: sqlite3.Connection,
    plan_id: str,
    catalog: dict[str, Any],
) -> dict[str, Any]:
    leagues = [item for item in (catalog.get("leagues") or []) if isinstance(item, dict)]
    provider_countries: set[str] = set()
    for item in leagues:
        league = item.get("league") if isinstance(item.get("league"), dict) else {}
        country = item.get("country") if isinstance(item.get("country"), dict) else {}
        prepared_country = normalized_country(country.get("name"))
        provider_countries.add(prepared_country)
        item["_bmg_audit"] = {
            "name": normalized_name(league.get("name")),
            "country": prepared_country,
            "seasons": tuple(
                int(season.get("year"))
                for season in (item.get("seasons") or [])
                if isinstance(season, dict) and str(season.get("year") or "").isdigit()
            ),
        }
    audited: list[dict[str, Any]] = []
    summary = {
        "targets": 0,
        "automatic": 0,
        "review": 0,
        "unmatched": 0,
        "wagers": 0,
        "automatic_wagers": 0,
        "review_wagers": 0,
        "unmatched_wagers": 0,
        "staked": 0,
        "automatic_staked": 0,
        "review_staked": 0,
        "unmatched_staked": 0,
    }
    for target in collection_targets(connection, plan_id):
        required_seasons = {
            year for year in (target_season_year(label) for label in target["labels"]) if year is not None
        }
        strict_country = normalized_country(target["jurisdiction"]) in provider_countries
        ranked = []
        for league in leagues:
            score = candidate_score(
                str(target["competition_family"]),
                str(target["jurisdiction"]),
                required_seasons,
                league,
                strict_country=strict_country,
            )
            ranked.append((float(score["score"]), league, score))
        ranked.sort(key=lambda item: item[0], reverse=True)
        candidates = [summarize_candidate(item, score) for _, item, score in ranked[:5]]
        best = candidates[0] if candidates else None
        margin = round((best["score"] - candidates[1]["score"]), 4) if len(candidates) > 1 else 1.0
        country_is_safe = not strict_country or best["country_score"] >= 0.999
        if (
            best
            and best["score"] >= 0.86
            and best["name_score"] >= 0.78
            and margin >= 0.04
            and country_is_safe
        ):
            classification = "automatic"
        elif best and best["score"] >= 0.64:
            classification = "review"
        else:
            classification = "unmatched"
        record = {
            "target_id": target["target_id"],
            "competition_family": target["competition_family"],
            "jurisdiction": target["jurisdiction"],
            "labels": target["labels"],
            "required_seasons": sorted(required_seasons),
            "wager_count": target["wager_count"],
            "event_count": target["event_count"],
            "staked": target["staked"],
            "priority_score": target["priority_score"],
            "classification": classification,
            "best_margin": margin,
            "candidates": candidates,
        }
        audited.append(record)
        summary["targets"] += 1
        summary[classification] += 1
        summary["wagers"] += int(target["wager_count"])
        summary[f"{classification}_wagers"] += int(target["wager_count"])
        summary["staked"] += int(target["staked"])
        summary[f"{classification}_staked"] += int(target["staked"])
    return {
        "schema_version": "bmg.api-football-coverage-audit.v1",
        "audited_at": utc_now(),
        "source": SOURCE,
        "catalog_captured_at": catalog.get("captured_at"),
        "plan_id": plan_id,
        "summary": summary,
        "targets": audited,
    }


FINISHED_STATUSES = {"FT", "AET", "PEN"}


def match_status(short: Any) -> str:
    code = str(short or "").upper()
    if code in FINISHED_STATUSES:
        return "finished"
    if code == "AWD":
        return "awarded"
    if code == "WO":
        return "walkover"
    if code in {"PST", "CANC", "ABD", "SUSP", "INT"}:
        return code.lower()
    if code in {"1H", "HT", "2H", "ET", "BT", "P", "LIVE"}:
        return "live"
    return "scheduled"


def season_display_name(season: dict[str, Any], year: int) -> str:
    start = str(season.get("start") or "")[:4]
    end = str(season.get("end") or "")[:4]
    if start.isdigit() and end.isdigit() and start != end:
        return f"{start}/{end}"
    return str(year)


def transform_season_capture(
    league_entry: dict[str, Any],
    season_year: int,
    fixtures: list[dict[str, Any]],
    standings_payload: list[dict[str, Any]],
) -> dict[str, Any]:
    observed_at = utc_now()
    league = league_entry.get("league") if isinstance(league_entry.get("league"), dict) else {}
    country = league_entry.get("country") if isinstance(league_entry.get("country"), dict) else {}
    seasons = [row for row in (league_entry.get("seasons") or []) if isinstance(row, dict)]
    season = next((row for row in seasons if int(row.get("year") or -1) == season_year), {})
    league_id = int(league.get("id"))
    transformed_matches: list[dict[str, Any]] = []
    for item in fixtures:
        fixture = item.get("fixture") if isinstance(item.get("fixture"), dict) else {}
        teams = item.get("teams") if isinstance(item.get("teams"), dict) else {}
        home = teams.get("home") if isinstance(teams.get("home"), dict) else {}
        away = teams.get("away") if isinstance(teams.get("away"), dict) else {}
        goals = item.get("goals") if isinstance(item.get("goals"), dict) else {}
        api_league = item.get("league") if isinstance(item.get("league"), dict) else {}
        status = fixture.get("status") if isinstance(fixture.get("status"), dict) else {}
        scheduled_at = str(fixture.get("date") or "")
        transformed_matches.append(
            {
                "source_match_id": str(fixture.get("id") or ""),
                "source_url": "",
                "round": api_league.get("round") or "",
                "scheduled_at": scheduled_at,
                "scheduled_date": scheduled_at[:10] if scheduled_at else None,
                "raw_scheduled_local": scheduled_at,
                "status": match_status(status.get("short")),
                "provider_status": status,
                "home_team": home.get("name"),
                "home_team_id": str(home.get("id") or ""),
                "away_team": away.get("name"),
                "away_team_id": str(away.get("id") or ""),
                "home_score": goals.get("home"),
                "away_score": goals.get("away"),
                "provider_raw": item,
            }
        )
    standing_snapshots: list[dict[str, Any]] = []
    used_scopes: set[str] = set()
    for wrapper in standings_payload:
        league_data = wrapper.get("league") if isinstance(wrapper.get("league"), dict) else {}
        groups = league_data.get("standings") if isinstance(league_data.get("standings"), list) else []
        for index, group_rows in enumerate(groups):
            if not isinstance(group_rows, list):
                continue
            group_name = next(
                (str(row.get("group")) for row in group_rows if isinstance(row, dict) and row.get("group")),
                "",
            )
            base_scope = "overall" if len(groups) == 1 else f"group:{group_name or index + 1}"
            scope = base_scope
            suffix = 2
            while scope in used_scopes:
                scope = f"{base_scope}:{suffix}"
                suffix += 1
            used_scopes.add(scope)
            rows = []
            for row in group_rows:
                if not isinstance(row, dict):
                    continue
                team = row.get("team") if isinstance(row.get("team"), dict) else {}
                overall = row.get("all") if isinstance(row.get("all"), dict) else {}
                wins = overall.get("win")
                draws = overall.get("draw")
                losses = overall.get("lose")
                goals = overall.get("goals") if isinstance(overall.get("goals"), dict) else {}
                form = [
                    {"result": value}
                    for value in str(row.get("form") or "")
                    if value in {"W", "D", "L"}
                ]
                rows.append(
                    {
                        "rank": row.get("rank"),
                        "team": team.get("name"),
                        "team_id": str(team.get("id") or ""),
                        "played": overall.get("played"),
                        "wins": wins,
                        "draws": draws,
                        "losses": losses,
                        "goals_for": goals.get("for"),
                        "goals_against": goals.get("against"),
                        "goal_difference": row.get("goalsDiff"),
                        "points": row.get("points"),
                        "qualification": row.get("description") or "",
                        "form": form,
                        "provider_raw": row,
                    }
                )
            standing_snapshots.append({"scope": scope, "rows": rows})
    capture_stamp = observed_at.replace(":", "").replace("-", "")
    return {
        "schema_version": "bmg.sports-league.v1",
        "capture_id": f"api-football-{league_id}-{season_year}-{capture_stamp}",
        "observed_at": observed_at,
        "source": SOURCE,
        "page_url": f"{DEFAULT_BASE_URL}/fixtures?league={league_id}&season={season_year}",
        "display_timezone": "UTC",
        "competition": {
            "sport": "football",
            "country": country.get("name") or "",
            "name": league.get("name") or "Unknown competition",
            "source_slug": str(league_id),
            "source_url": "",
            "provider_raw": {"league": league, "country": country},
        },
        "season": {
            "name": season_display_name(season, season_year),
            "source_season_id": f"{league_id}:{season_year}",
            "source_url": "",
            "start_date": season.get("start"),
            "end_date": season.get("end"),
            "is_current": bool(season.get("current")),
            "coverage": season.get("coverage") or {},
        },
        "standings": standing_snapshots,
        "matches": transformed_matches,
        "match_details": [],
    }


def find_league(catalog: dict[str, Any], league_id: int) -> dict[str, Any]:
    for item in catalog.get("leagues") or []:
        if isinstance(item, dict) and int((item.get("league") or {}).get("id") or -1) == league_id:
            return item
    raise ApiFootballError(f"League {league_id} is not present in the cached catalog.")


def collect_season_capture(
    client: ApiFootballClient,
    catalog: dict[str, Any],
    league_id: int,
    season: int,
) -> dict[str, Any]:
    league_entry = find_league(catalog, league_id)
    fixtures_payload = client.get("fixtures", {"league": league_id, "season": season})
    standings_payload = client.get("standings", {"league": league_id, "season": season})
    capture = transform_season_capture(
        league_entry,
        season,
        [row for row in (fixtures_payload.get("response") or []) if isinstance(row, dict)],
        [row for row in (standings_payload.get("response") or []) if isinstance(row, dict)],
    )
    if not capture["matches"]:
        raise ApiFootballError(f"League {league_id} season {season} returned no fixtures.")
    return capture


def import_reference_capture(database: Path, capture: dict[str, Any]) -> dict[str, int]:
    connection = bmg.open_database(database)
    try:
        bmg.initialize_database(connection)
        with connection:
            return bmg.import_flashscore_capture(connection, capture)
    finally:
        connection.close()


def exact_backfill_jobs(audit: dict[str, Any]) -> list[dict[str, Any]]:
    jobs: dict[tuple[int, int], dict[str, Any]] = {}
    for target in audit.get("targets") or []:
        if not isinstance(target, dict) or target.get("classification") != "automatic":
            continue
        candidates = target.get("candidates") if isinstance(target.get("candidates"), list) else []
        best = candidates[0] if candidates and isinstance(candidates[0], dict) else None
        if not best or float(best.get("name_score") or 0) < 0.999:
            continue
        if float(best.get("country_score") or 0) < 0.999:
            continue
        available = {int(value) for value in (best.get("available_seasons") or [])}
        required = {int(value) for value in (target.get("required_seasons") or [])}
        if not required or not required.issubset(available):
            continue
        league_id = int(best["league_id"])
        for season in sorted(required):
            key = (league_id, season)
            job = jobs.setdefault(
                key,
                {
                    "league_id": league_id,
                    "season": season,
                    "provider_name": best.get("name"),
                    "provider_country": best.get("country"),
                    "target_ids": [],
                    "wager_count": 0,
                    "staked": 0,
                },
            )
            job["target_ids"].append(target.get("target_id"))
            job["wager_count"] += int(target.get("wager_count") or 0)
            job["staked"] += int(target.get("staked") or 0)
    return sorted(
        jobs.values(),
        key=lambda job: (-int(job["staked"]), -int(job["wager_count"]), job["league_id"], job["season"]),
    )


def season_is_imported(database: Path, league_id: int, season: int) -> bool:
    if not database.exists():
        return False
    connection = bmg.open_database(database)
    try:
        bmg.apply_schema(connection)
        row = connection.execute(
            "SELECT 1 FROM season_sources WHERE source = ? AND source_season_id = ? LIMIT 1",
            (SOURCE, f"{league_id}:{season}"),
        ).fetchone()
        return row is not None
    finally:
        connection.close()


def print_status(client: ApiFootballClient) -> None:
    payload = client.get("status")
    response = payload.get("response") if isinstance(payload.get("response"), dict) else {}
    subscription = response.get("subscription") if isinstance(response.get("subscription"), dict) else {}
    requests = response.get("requests") if isinstance(response.get("requests"), dict) else {}
    print(f"plan={subscription.get('plan')}; active={subscription.get('active')}; end={subscription.get('end')}")
    print(f"requests={requests.get('current')}/{requests.get('limit_day')} today")


def command_audit(args: argparse.Namespace) -> None:
    client = make_client(args.env)
    catalog = fetch_catalog(client, args.catalog) if args.refresh_catalog or not args.catalog.exists() else read_catalog(args.catalog)
    connection = bmg.open_database(args.db)
    try:
        bmg.apply_schema(connection)
        audit = audit_catalog(connection, args.plan_id, catalog)
    finally:
        connection.close()
    write_json(args.output, audit)
    summary = audit["summary"]
    print(
        f"targets={summary['targets']}; automatic={summary['automatic']}; "
        f"review={summary['review']}; unmatched={summary['unmatched']}"
    )
    print(
        f"wagers automatic={summary['automatic_wagers']}/{summary['wagers']}; "
        f"review={summary['review_wagers']}; unmatched={summary['unmatched_wagers']}"
    )
    print(f"catalog leagues={len(catalog.get('leagues') or [])}; API requests={client.requests_used}")
    print(f"audit={args.output}")
    for target in audit["targets"][:15]:
        best = target["candidates"][0] if target["candidates"] else {}
        print(
            f"[{target['classification']}] {target['competition_family']} ({target['jurisdiction']}) "
            f"-> {best.get('name', 'none')} ({best.get('country', '')}) "
            f"id={best.get('league_id', '')} score={best.get('score', 0):.3f}"
        )


def command_collect_season(args: argparse.Namespace) -> None:
    client = make_client(args.env)
    catalog = fetch_catalog(client, args.catalog) if args.refresh_catalog or not args.catalog.exists() else read_catalog(args.catalog)
    capture = collect_season_capture(client, catalog, args.league_id, args.season)
    output = args.output or (
        PROJECT_DIR
        / "exports"
        / f"api-football-{args.league_id}-{args.season}-{capture['observed_at'][:10]}.json"
    )
    write_json(output, capture)
    print(
        f"league={capture['competition']['name']}; season={capture['season']['name']}; "
        f"matches={len(capture['matches'])}; standings={sum(len(item['rows']) for item in capture['standings'])}; "
        f"API requests={client.requests_used}"
    )
    print(f"capture={output}")
    if args.import_db:
        counts = import_reference_capture(args.import_db, capture)
        print("imported=" + ", ".join(f"{key}:{value}" for key, value in counts.items()))


def command_backfill_exact(args: argparse.Namespace) -> None:
    audit = json.loads(args.audit.read_text(encoding="utf-8"))
    if audit.get("schema_version") != "bmg.api-football-coverage-audit.v1":
        raise ApiFootballError("Unsupported coverage audit; run the audit command again.")
    jobs = exact_backfill_jobs(audit)
    if args.limit is not None:
        jobs = jobs[: max(0, args.limit)]
    if args.dry_run:
        selected_target_ids = {
            target_id for job in jobs for target_id in (job.get("target_ids") or []) if target_id
        }
        selected_targets = [
            target
            for target in (audit.get("targets") or [])
            if isinstance(target, dict) and target.get("target_id") in selected_target_ids
        ]
        print(
            f"exact backfill jobs={len(jobs)}; expected API calls<={len(jobs) * 2}; "
            f"unique targets={len(selected_targets)}; "
            f"wagers={sum(int(target.get('wager_count') or 0) for target in selected_targets)}; "
            f"staked={sum(int(target.get('staked') or 0) for target in selected_targets)}"
        )
        for job in jobs[:20]:
            print(
                f"{job['provider_country']} / {job['provider_name']} {job['season']} "
                f"id={job['league_id']} wagers={job['wager_count']}"
            )
        return
    client = make_client(args.env)
    catalog = fetch_catalog(client, args.catalog) if args.refresh_catalog or not args.catalog.exists() else read_catalog(args.catalog)
    report: dict[str, Any] = {
        "schema_version": "bmg.api-football-backfill.v1",
        "started_at": utc_now(),
        "updated_at": utc_now(),
        "source": SOURCE,
        "audit": str(args.audit),
        "database": str(args.db),
        "jobs_total": len(jobs),
        "completed": [],
        "skipped": [],
        "failed": [],
    }
    for index, job in enumerate(jobs, start=1):
        league_id, season = int(job["league_id"]), int(job["season"])
        job_key = f"{league_id}:{season}"
        if season_is_imported(args.db, league_id, season):
            report["skipped"].append({**job, "job_key": job_key, "reason": "already imported"})
            continue
        try:
            capture = collect_season_capture(client, catalog, league_id, season)
            output = PROJECT_DIR / "exports" / f"api-football-{league_id}-{season}-{capture['observed_at'][:10]}.json"
            write_json(output, capture)
            counts = import_reference_capture(args.db, capture)
            report["completed"].append(
                {
                    **job,
                    "job_key": job_key,
                    "capture": str(output),
                    "matches": len(capture["matches"]),
                    "standings": sum(len(item["rows"]) for item in capture["standings"]),
                    "imported": counts,
                }
            )
            if index == 1 or index % 10 == 0 or index == len(jobs):
                print(
                    f"[{index}/{len(jobs)}] {job['provider_name']} {season}: "
                    f"matches={len(capture['matches'])}, requests={client.requests_used}"
                )
        except (ApiFootballError, OSError, ValueError, sqlite3.Error) as error:
            report["failed"].append({**job, "job_key": job_key, "error": str(error)})
            print(f"[{index}/{len(jobs)}] FAILED {job_key}: {error}")
        report["updated_at"] = utc_now()
        report["requests_used"] = client.requests_used
        write_json(args.report, report)
    report["finished_at"] = utc_now()
    report["updated_at"] = report["finished_at"]
    report["requests_used"] = client.requests_used
    write_json(args.report, report)
    print(
        f"backfill complete={len(report['completed'])}; skipped={len(report['skipped'])}; "
        f"failed={len(report['failed'])}; API requests={client.requests_used}; report={args.report}"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", type=Path, default=DEFAULT_ENV)
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("status", help="show subscription and quota without exposing the key")

    audit = subparsers.add_parser("audit", help="map BMG collection targets to API-Football coverage")
    audit.add_argument("--db", type=Path, default=DEFAULT_DB)
    audit.add_argument("--plan-id", default="football-history-v1")
    audit.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    audit.add_argument("--output", type=Path, default=DEFAULT_AUDIT)
    audit.add_argument("--refresh-catalog", action="store_true")

    collect = subparsers.add_parser("collect-season", help="collect one league-season and optionally import it")
    collect.add_argument("league_id", type=int)
    collect.add_argument("season", type=int)
    collect.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    collect.add_argument("--refresh-catalog", action="store_true")
    collect.add_argument("--output", type=Path)
    collect.add_argument("--import-db", type=Path)

    backfill = subparsers.add_parser(
        "backfill-exact", help="resume the exact name/country/season coverage tier"
    )
    backfill.add_argument("--db", type=Path, default=DEFAULT_DB)
    backfill.add_argument("--audit", type=Path, default=DEFAULT_AUDIT)
    backfill.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    backfill.add_argument("--report", type=Path, default=DEFAULT_BACKFILL_REPORT)
    backfill.add_argument("--refresh-catalog", action="store_true")
    backfill.add_argument("--limit", type=int)
    backfill.add_argument("--dry-run", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "status":
            print_status(make_client(args.env))
        elif args.command == "audit":
            command_audit(args)
        elif args.command == "collect-season":
            command_collect_season(args)
        elif args.command == "backfill-exact":
            command_backfill_exact(args)
        return 0
    except (ApiFootballError, OSError, ValueError, json.JSONDecodeError, sqlite3.Error) as error:
        print(f"API-Football error: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
