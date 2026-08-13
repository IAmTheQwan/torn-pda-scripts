"""Leakage-safe recency-weighted football score model and market payoff math."""

from __future__ import annotations

import math
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any


def parse_utc(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = datetime.fromisoformat(text[:10])
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


@dataclass(frozen=True)
class TrainingMatch:
    match_id: int
    played_at: datetime
    competition_id: int | None
    home_team_id: int
    away_team_id: int
    home_goals: float
    away_goals: float
    weight: float


@dataclass(frozen=True)
class ScorePrediction:
    home_expected_goals: float
    away_expected_goals: float
    score_probabilities: dict[tuple[int, int], float]
    home_effective_matches: float
    away_effective_matches: float
    log_rate_uncertainty: float


@dataclass(frozen=True)
class FittedScoreModel:
    cutoff: str
    window_start: str
    matches_included: int
    base_home_goals: float
    base_away_goals: float
    attack: dict[int, float]
    defense: dict[int, float]
    effective_matches: dict[int, float]
    competition_rates: dict[int, tuple[float, float]]
    half_life_days: float
    shrinkage_matches: float
    dixon_coles_rho: float
    result_availability_lag_hours: float

    def expected_goals(
        self,
        home_team_id: int,
        away_team_id: int,
        competition_id: int | None = None,
    ) -> tuple[float, float]:
        base_home, base_away = self.competition_rates.get(
            int(competition_id) if competition_id is not None else -1,
            (self.base_home_goals, self.base_away_goals),
        )
        home_rate = base_home * self.attack.get(home_team_id, 1.0) * self.defense.get(away_team_id, 1.0)
        away_rate = base_away * self.attack.get(away_team_id, 1.0) * self.defense.get(home_team_id, 1.0)
        return min(max(home_rate, 0.15), 5.5), min(max(away_rate, 0.15), 5.5)

    def predict(
        self,
        home_team_id: int,
        away_team_id: int,
        competition_id: int | None = None,
        *,
        max_goals: int = 12,
    ) -> ScorePrediction:
        home_rate, away_rate = self.expected_goals(home_team_id, away_team_id, competition_id)
        home_effective = self.effective_matches.get(home_team_id, 0.0)
        away_effective = self.effective_matches.get(away_team_id, 0.0)
        thin_sample = min(home_effective, away_effective)
        uncertainty = min(0.60, 0.08 + 0.95 / math.sqrt(thin_sample + self.shrinkage_matches))
        return ScorePrediction(
            home_expected_goals=home_rate,
            away_expected_goals=away_rate,
            score_probabilities=score_distribution(
                home_rate,
                away_rate,
                max_goals=max_goals,
                dixon_coles_rho=self.dixon_coles_rho,
            ),
            home_effective_matches=home_effective,
            away_effective_matches=away_effective,
            log_rate_uncertainty=uncertainty,
        )


def load_training_matches(
    connection: sqlite3.Connection,
    *,
    cutoff: str,
    window_days: int,
    half_life_days: float,
    result_availability_lag_hours: float,
) -> tuple[datetime, datetime, list[TrainingMatch]]:
    cutoff_time = parse_utc(cutoff)
    if cutoff_time is None:
        raise ValueError("cutoff must be an ISO date-time.")
    if window_days <= 0 or half_life_days <= 0 or result_availability_lag_hours < 0:
        raise ValueError("window, half-life, and result lag must be valid.")
    window_start = cutoff_time - timedelta(days=window_days)
    result_knowledge_cutoff = cutoff_time - timedelta(hours=result_availability_lag_hours)
    rows = connection.execute(
        """
        SELECT match_id, competition_id, home_team_id, away_team_id,
               scheduled_at, scheduled_date, home_score, away_score
        FROM sports_matches
        WHERE status = 'finished'
          AND home_score IS NOT NULL AND away_score IS NOT NULL
          AND home_score >= 0 AND away_score >= 0
          AND home_score <= 20 AND away_score <= 20
          AND COALESCE(scheduled_at, scheduled_date, '') <> ''
          AND COALESCE(scheduled_at, scheduled_date) < ?
          AND COALESCE(scheduled_at, scheduled_date) >= ?
        ORDER BY COALESCE(scheduled_at, scheduled_date), match_id
        """,
        (
            result_knowledge_cutoff.isoformat().replace("+00:00", "Z"),
            window_start.date().isoformat(),
        ),
    ).fetchall()
    decay = math.log(2) / half_life_days
    matches: list[TrainingMatch] = []
    for row in rows:
        played_at = parse_utc(row["scheduled_at"] or row["scheduled_date"])
        if played_at is None or played_at >= result_knowledge_cutoff or played_at < window_start:
            continue
        age_days = max(0.0, (cutoff_time - played_at).total_seconds() / 86400)
        matches.append(TrainingMatch(
            match_id=int(row["match_id"]),
            played_at=played_at,
            competition_id=int(row["competition_id"]) if row["competition_id"] is not None else None,
            home_team_id=int(row["home_team_id"]),
            away_team_id=int(row["away_team_id"]),
            home_goals=float(row["home_score"]),
            away_goals=float(row["away_score"]),
            weight=math.exp(-decay * age_days),
        ))
    return cutoff_time, window_start, matches


def fit_score_model(
    connection: sqlite3.Connection,
    *,
    cutoff: str,
    window_days: int = 1095,
    half_life_days: float = 180.0,
    shrinkage_matches: float = 8.0,
    competition_shrinkage: float = 80.0,
    iterations: int = 18,
    dixon_coles_rho: float = -0.06,
    result_availability_lag_hours: float = 6.0,
) -> FittedScoreModel:
    if shrinkage_matches <= 0 or competition_shrinkage <= 0 or iterations <= 0:
        raise ValueError("shrinkage and iteration parameters must be positive.")
    cutoff_time, window_start, matches = load_training_matches(
        connection,
        cutoff=cutoff,
        window_days=window_days,
        half_life_days=half_life_days,
        result_availability_lag_hours=result_availability_lag_hours,
    )
    if not matches:
        raise ValueError("No finished matches are available before the model cutoff.")
    total_weight = sum(match.weight for match in matches)
    base_home = sum(match.weight * match.home_goals for match in matches) / total_weight
    base_away = sum(match.weight * match.away_goals for match in matches) / total_weight
    base_home = max(base_home, 0.2)
    base_away = max(base_away, 0.2)

    competition_totals: dict[int, list[float]] = {}
    for match in matches:
        if match.competition_id is None:
            continue
        values = competition_totals.setdefault(match.competition_id, [0.0, 0.0, 0.0])
        values[0] += match.weight
        values[1] += match.weight * match.home_goals
        values[2] += match.weight * match.away_goals
    competition_rates: dict[int, tuple[float, float]] = {}
    for competition_id, (weight, home_goals, away_goals) in competition_totals.items():
        competition_rates[competition_id] = (
            (home_goals + competition_shrinkage * base_home) / (weight + competition_shrinkage),
            (away_goals + competition_shrinkage * base_away) / (weight + competition_shrinkage),
        )

    team_ids = {
        team_id
        for match in matches
        for team_id in (match.home_team_id, match.away_team_id)
    }
    attack = {team_id: 1.0 for team_id in team_ids}
    defense = {team_id: 1.0 for team_id in team_ids}
    effective_matches = {team_id: 0.0 for team_id in team_ids}
    for match in matches:
        effective_matches[match.home_team_id] += match.weight
        effective_matches[match.away_team_id] += match.weight

    neutral_goal_rate = (base_home + base_away) / 2
    pseudo_goals = shrinkage_matches * neutral_goal_rate
    for _ in range(iterations):
        attack_goals = {team_id: pseudo_goals for team_id in team_ids}
        attack_expected = {team_id: pseudo_goals for team_id in team_ids}
        for match in matches:
            match_home, match_away = competition_rates.get(
                match.competition_id if match.competition_id is not None else -1,
                (base_home, base_away),
            )
            attack_goals[match.home_team_id] += match.weight * match.home_goals
            attack_expected[match.home_team_id] += match.weight * match_home * defense[match.away_team_id]
            attack_goals[match.away_team_id] += match.weight * match.away_goals
            attack_expected[match.away_team_id] += match.weight * match_away * defense[match.home_team_id]
        attack = {
            team_id: min(max(attack_goals[team_id] / attack_expected[team_id], 0.25), 4.0)
            for team_id in team_ids
        }

        defense_goals = {team_id: pseudo_goals for team_id in team_ids}
        defense_expected = {team_id: pseudo_goals for team_id in team_ids}
        for match in matches:
            match_home, match_away = competition_rates.get(
                match.competition_id if match.competition_id is not None else -1,
                (base_home, base_away),
            )
            defense_goals[match.away_team_id] += match.weight * match.home_goals
            defense_expected[match.away_team_id] += match.weight * match_home * attack[match.home_team_id]
            defense_goals[match.home_team_id] += match.weight * match.away_goals
            defense_expected[match.home_team_id] += match.weight * match_away * attack[match.away_team_id]
        defense = {
            team_id: min(max(defense_goals[team_id] / defense_expected[team_id], 0.25), 4.0)
            for team_id in team_ids
        }

        normalization_weight = sum(effective_matches.values())
        if normalization_weight > 0:
            log_mean = sum(
                effective_matches[team_id] * math.log(attack[team_id]) for team_id in team_ids
            ) / normalization_weight
            scale = math.exp(log_mean)
            attack = {team_id: value / scale for team_id, value in attack.items()}
            defense = {team_id: value * scale for team_id, value in defense.items()}

    return FittedScoreModel(
        cutoff=cutoff_time.isoformat().replace("+00:00", "Z"),
        window_start=window_start.isoformat().replace("+00:00", "Z"),
        matches_included=len(matches),
        base_home_goals=base_home,
        base_away_goals=base_away,
        attack=attack,
        defense=defense,
        effective_matches=effective_matches,
        competition_rates=competition_rates,
        half_life_days=half_life_days,
        shrinkage_matches=shrinkage_matches,
        dixon_coles_rho=dixon_coles_rho,
        result_availability_lag_hours=result_availability_lag_hours,
    )


def poisson_probabilities(rate: float, max_goals: int) -> list[float]:
    values = [math.exp(-rate)]
    for goals in range(1, max_goals + 1):
        values.append(values[-1] * rate / goals)
    return values


def score_distribution(
    home_rate: float,
    away_rate: float,
    *,
    max_goals: int = 12,
    dixon_coles_rho: float = -0.06,
) -> dict[tuple[int, int], float]:
    home = poisson_probabilities(home_rate, max_goals)
    away = poisson_probabilities(away_rate, max_goals)
    grid: dict[tuple[int, int], float] = {}
    for home_goals, home_probability in enumerate(home):
        for away_goals, away_probability in enumerate(away):
            adjustment = 1.0
            if (home_goals, away_goals) == (0, 0):
                adjustment = 1 - home_rate * away_rate * dixon_coles_rho
            elif (home_goals, away_goals) == (0, 1):
                adjustment = 1 + home_rate * dixon_coles_rho
            elif (home_goals, away_goals) == (1, 0):
                adjustment = 1 + away_rate * dixon_coles_rho
            elif (home_goals, away_goals) == (1, 1):
                adjustment = 1 - dixon_coles_rho
            grid[(home_goals, away_goals)] = max(0.0, home_probability * away_probability * adjustment)
    total = sum(grid.values())
    if total <= 0:
        raise ValueError("Score distribution has no probability mass.")
    return {score: probability / total for score, probability in grid.items()}


def split_quarter_line(line: float) -> tuple[float, ...]:
    quarters = round(line * 4)
    if not math.isclose(line * 4, quarters, abs_tol=1e-8):
        raise ValueError("Asian lines must use quarter-goal increments.")
    if quarters % 2 == 0:
        return (quarters / 4,)
    return ((quarters - 1) / 4, (quarters + 1) / 4)


def component_result(value: float) -> str:
    if math.isclose(value, 0.0, abs_tol=1e-9):
        return "push"
    return "win" if value > 0 else "loss"


def combine_component_results(results: tuple[str, ...]) -> str:
    if len(results) == 1:
        return results[0]
    states = set(results)
    if states == {"win"}:
        return "win"
    if states == {"loss"}:
        return "loss"
    if states == {"push"}:
        return "push"
    if states == {"win", "push"}:
        return "half_win"
    if states == {"loss", "push"}:
        return "half_loss"
    raise ValueError(f"Unsupported split-line result combination: {sorted(states)}")


def asian_result(margin: float, handicap: float) -> str:
    return combine_component_results(tuple(
        component_result(margin + component) for component in split_quarter_line(handicap)
    ))


def total_result(goals: float, line: float, side: str) -> str:
    direction = 1 if side == "over" else -1 if side == "under" else 0
    if not direction:
        return "unknown"
    return combine_component_results(tuple(
        component_result(direction * (goals - component)) for component in split_quarter_line(line)
    ))


def empty_outcomes() -> dict[str, float]:
    return {"win": 0.0, "half_win": 0.0, "push": 0.0, "half_loss": 0.0, "loss": 0.0}


def market_outcomes(
    score_probabilities: dict[tuple[int, int], float],
    *,
    kind: str,
    selection: str,
    line: float | None = None,
    handicap: float | None = None,
    subject: str = "match",
) -> dict[str, float]:
    outcomes = empty_outcomes()
    for (home, away), probability in score_probabilities.items():
        result = "unknown"
        if kind == "three_way":
            winner = "home" if home > away else "away" if away > home else "draw"
            result = "win" if selection == winner else "loss"
        elif kind == "both_teams_to_score":
            actual = "yes" if home > 0 and away > 0 else "no"
            result = "win" if selection == actual else "loss"
        elif kind == "double_chance":
            winner = "home" if home > away else "away" if away > home else "draw"
            result = "win" if winner in selection.split("+") else "loss"
        elif kind == "draw_no_bet":
            if home == away:
                result = "push"
            else:
                winner = "home" if home > away else "away"
                result = "win" if selection == winner else "loss"
        elif kind == "total" and line is not None:
            goals = home + away if subject == "match" else home if subject == "home" else away
            result = total_result(goals, line, selection)
        elif kind == "asian_handicap" and handicap is not None:
            margin = home - away if selection == "home" else away - home
            result = asian_result(margin, handicap)
        elif kind == "win_to_nil":
            won = (selection == "home" and home > away and away == 0) or (
                selection == "away" and away > home and home == 0
            )
            result = "win" if won else "loss"
        if result in outcomes:
            outcomes[result] += probability
    total = sum(outcomes.values())
    if total > 0 and not math.isclose(total, 1.0, abs_tol=1e-9):
        outcomes = {key: value / total for key, value in outcomes.items()}
    return outcomes


def expected_value(outcomes: dict[str, float], odds: float) -> float:
    win_equivalent = outcomes.get("win", 0.0) + 0.5 * outcomes.get("half_win", 0.0)
    loss_equivalent = outcomes.get("loss", 0.0) + 0.5 * outcomes.get("half_loss", 0.0)
    return win_equivalent * (odds - 1) - loss_equivalent


def fair_odds(outcomes: dict[str, float]) -> float | None:
    win_equivalent = outcomes.get("win", 0.0) + 0.5 * outcomes.get("half_win", 0.0)
    loss_equivalent = outcomes.get("loss", 0.0) + 0.5 * outcomes.get("half_loss", 0.0)
    if win_equivalent <= 0:
        return None
    return 1 + loss_equivalent / win_equivalent


def probability_scenarios(
    prediction: ScorePrediction,
    *,
    max_goals: int = 12,
    dixon_coles_rho: float = -0.06,
) -> list[dict[tuple[int, int], float]]:
    uncertainty = prediction.log_rate_uncertainty
    scenarios = [prediction.score_probabilities]
    for home_direction, away_direction in ((-1, -1), (-1, 1), (1, -1), (1, 1)):
        scenarios.append(score_distribution(
            min(max(prediction.home_expected_goals * math.exp(home_direction * uncertainty), 0.15), 5.5),
            min(max(prediction.away_expected_goals * math.exp(away_direction * uncertainty), 0.15), 5.5),
            max_goals=max_goals,
            dixon_coles_rho=dixon_coles_rho,
        ))
    return scenarios


def three_way_probabilities(
    score_probabilities: dict[tuple[int, int], float],
) -> dict[str, float]:
    values = {"home": 0.0, "draw": 0.0, "away": 0.0}
    for (home_goals, away_goals), probability in score_probabilities.items():
        role = "home" if home_goals > away_goals else "away" if away_goals > home_goals else "draw"
        values[role] += probability
    return values


def anchor_three_way_distribution(
    score_probabilities: dict[tuple[int, int], float],
    target_probabilities: dict[str, float],
    *,
    strength: float = 1.0,
) -> dict[tuple[int, int], float]:
    """Reweight score cells toward a timestamp-safe external 1X2 anchor."""
    if not 0 <= strength <= 1:
        raise ValueError("anchor strength must be between zero and one.")
    current = three_way_probabilities(score_probabilities)
    required = {"home", "draw", "away"}
    if set(target_probabilities) != required or any(target_probabilities[key] <= 0 for key in required):
        raise ValueError("A complete positive home/draw/away anchor is required.")
    target_total = sum(float(target_probabilities[key]) for key in required)
    target = {key: float(target_probabilities[key]) / target_total for key in required}
    factors = {
        key: (target[key] / max(current[key], 1e-12)) ** strength
        for key in required
    }
    adjusted: dict[tuple[int, int], float] = {}
    for (home_goals, away_goals), probability in score_probabilities.items():
        role = "home" if home_goals > away_goals else "away" if away_goals > home_goals else "draw"
        adjusted[(home_goals, away_goals)] = probability * factors[role]
    total = sum(adjusted.values())
    return {score: probability / total for score, probability in adjusted.items()}


def chronological_backtest(
    connection: sqlite3.Connection,
    *,
    test_start: str,
    test_end: str,
    window_days: int = 1095,
    half_life_days: float = 180.0,
    shrinkage_matches: float = 8.0,
    competition_shrinkage: float = 80.0,
    iterations: int = 18,
    dixon_coles_rho: float = -0.06,
    result_availability_lag_hours: float = 6.0,
) -> dict[str, float | int | str]:
    """Evaluate one frozen pre-period fit on a later chronological holdout."""
    start = parse_utc(test_start)
    end = parse_utc(test_end)
    if start is None or end is None or start >= end:
        raise ValueError("test_start and test_end must be increasing ISO date-times.")
    model = fit_score_model(
        connection,
        cutoff=start.isoformat().replace("+00:00", "Z"),
        window_days=window_days,
        half_life_days=half_life_days,
        shrinkage_matches=shrinkage_matches,
        competition_shrinkage=competition_shrinkage,
        iterations=iterations,
        dixon_coles_rho=dixon_coles_rho,
        result_availability_lag_hours=result_availability_lag_hours,
    )
    rows = connection.execute(
        """
        SELECT match_id, competition_id, home_team_id, away_team_id,
               scheduled_at, scheduled_date, home_score, away_score
        FROM sports_matches
        WHERE status = 'finished'
          AND home_score IS NOT NULL AND away_score IS NOT NULL
          AND home_score >= 0 AND away_score >= 0
          AND home_score <= 20 AND away_score <= 20
          AND COALESCE(scheduled_at, scheduled_date, '') >= ?
          AND COALESCE(scheduled_at, scheduled_date, '') < ?
        ORDER BY COALESCE(scheduled_at, scheduled_date), match_id
        """,
        (
            start.isoformat().replace("+00:00", "Z"),
            end.isoformat().replace("+00:00", "Z"),
        ),
    ).fetchall()
    model_brier = baseline_brier = model_log_loss = baseline_log_loss = 0.0
    model_score_log_loss = baseline_score_log_loss = 0.0
    model_btts_brier = baseline_btts_brier = 0.0
    model_total_brier = baseline_total_brier = 0.0
    home_goal_error = away_goal_error = 0.0
    known_team_sample = thin_team_sample = 0
    calibration = [[0.0, 0.0, 0] for _ in range(10)]
    sample = 0
    for row in rows:
        played_at = parse_utc(row["scheduled_at"] or row["scheduled_date"])
        if played_at is None or played_at < start or played_at >= end:
            continue
        home_team_id = int(row["home_team_id"])
        away_team_id = int(row["away_team_id"])
        competition_id = int(row["competition_id"]) if row["competition_id"] is not None else None
        prediction = model.predict(home_team_id, away_team_id, competition_id)
        probabilities = three_way_probabilities(prediction.score_probabilities)
        base_home, base_away = model.competition_rates.get(
            competition_id if competition_id is not None else -1,
            (model.base_home_goals, model.base_away_goals),
        )
        baseline_grid = score_distribution(
            base_home,
            base_away,
            dixon_coles_rho=dixon_coles_rho,
        )
        baseline = three_way_probabilities(baseline_grid)
        actual = (
            "home" if float(row["home_score"]) > float(row["away_score"])
            else "away" if float(row["away_score"]) > float(row["home_score"])
            else "draw"
        )
        model_brier += sum((probabilities[role] - (1.0 if role == actual else 0.0)) ** 2 for role in probabilities)
        baseline_brier += sum((baseline[role] - (1.0 if role == actual else 0.0)) ** 2 for role in baseline)
        model_log_loss -= math.log(max(probabilities[actual], 1e-12))
        baseline_log_loss -= math.log(max(baseline[actual], 1e-12))
        score = (int(row["home_score"]), int(row["away_score"]))
        model_score_log_loss -= math.log(max(prediction.score_probabilities.get(score, 0.0), 1e-12))
        baseline_score_log_loss -= math.log(max(baseline_grid.get(score, 0.0), 1e-12))
        actual_btts = 1.0 if score[0] > 0 and score[1] > 0 else 0.0
        model_btts = sum(
            probability for (home_goals, away_goals), probability in prediction.score_probabilities.items()
            if home_goals > 0 and away_goals > 0
        )
        baseline_btts = sum(
            probability for (home_goals, away_goals), probability in baseline_grid.items()
            if home_goals > 0 and away_goals > 0
        )
        model_btts_brier += (model_btts - actual_btts) ** 2
        baseline_btts_brier += (baseline_btts - actual_btts) ** 2
        actual_over = 1.0 if sum(score) > 2.5 else 0.0
        model_over = sum(
            probability for (home_goals, away_goals), probability in prediction.score_probabilities.items()
            if home_goals + away_goals > 2.5
        )
        baseline_over = sum(
            probability for (home_goals, away_goals), probability in baseline_grid.items()
            if home_goals + away_goals > 2.5
        )
        model_total_brier += (model_over - actual_over) ** 2
        baseline_total_brier += (baseline_over - actual_over) ** 2
        home_goal_error += abs(prediction.home_expected_goals - float(row["home_score"]))
        away_goal_error += abs(prediction.away_expected_goals - float(row["away_score"]))
        if min(prediction.home_effective_matches, prediction.away_effective_matches) >= 5:
            known_team_sample += 1
        else:
            thin_team_sample += 1
        for role, probability in probabilities.items():
            bin_index = min(9, int(probability * 10))
            calibration[bin_index][0] += probability
            calibration[bin_index][1] += 1.0 if role == actual else 0.0
            calibration[bin_index][2] += 1
        sample += 1
    if sample == 0:
        raise ValueError("No finished matches are available in the backtest period.")
    calibration_error = sum(
        count * abs(predicted / count - actual / count)
        for predicted, actual, count in calibration
        if count
    ) / (sample * 3)
    model_brier /= sample
    baseline_brier /= sample
    model_log_loss /= sample
    baseline_log_loss /= sample
    model_score_log_loss /= sample
    baseline_score_log_loss /= sample
    model_btts_brier /= sample
    baseline_btts_brier /= sample
    model_total_brier /= sample
    baseline_total_brier /= sample
    return {
        "training_start": model.window_start,
        "training_end": model.cutoff,
        "test_start": start.isoformat().replace("+00:00", "Z"),
        "test_end": end.isoformat().replace("+00:00", "Z"),
        "training_matches": model.matches_included,
        "sample_size": sample,
        "known_team_sample": known_team_sample,
        "thin_team_sample": thin_team_sample,
        "model_brier": model_brier,
        "baseline_brier": baseline_brier,
        "brier_improvement": baseline_brier - model_brier,
        "model_log_loss": model_log_loss,
        "baseline_log_loss": baseline_log_loss,
        "log_loss_improvement": baseline_log_loss - model_log_loss,
        "model_score_log_loss": model_score_log_loss,
        "baseline_score_log_loss": baseline_score_log_loss,
        "score_log_loss_improvement": baseline_score_log_loss - model_score_log_loss,
        "model_btts_brier": model_btts_brier,
        "baseline_btts_brier": baseline_btts_brier,
        "btts_brier_improvement": baseline_btts_brier - model_btts_brier,
        "model_total_2_5_brier": model_total_brier,
        "baseline_total_2_5_brier": baseline_total_brier,
        "total_2_5_brier_improvement": baseline_total_brier - model_total_brier,
        "calibration_error": calibration_error,
        "home_goal_mae": home_goal_error / sample,
        "away_goal_mae": away_goal_error / sample,
    }
