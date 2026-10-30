from datetime import UTC, datetime
import os
from pathlib import Path
import re
import sqlite3
from typing import Any


DB_PATH = Path(os.getenv("RUNS_DB_PATH", "data/runs.db"))
WORD_PATTERN = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?")


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trace_id TEXT,
            root_span_id TEXT,
            request_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL,
            failure_stage TEXT,
            recording_ms INTEGER,
            request_read_ms INTEGER NOT NULL,
            conversion_ms INTEGER NOT NULL,
            transcription_ms INTEGER NOT NULL,
            generation_ms INTEGER,
            total_ms INTEGER NOT NULL,
            audio_bytes INTEGER NOT NULL,
            media_type TEXT NOT NULL,
            model TEXT NOT NULL,
            execution TEXT NOT NULL,
            transcript_characters INTEGER,
            transcript TEXT,
            response_model TEXT,
            response_text TEXT,
            reference_text TEXT,
            word_errors INTEGER,
            reference_words INTEGER,
            word_error_rate REAL
        )
        """
    )
    existing_columns = {row["name"] for row in connection.execute("PRAGMA table_info(runs)")}
    for name, data_type in {
        "trace_id": "TEXT",
        "root_span_id": "TEXT",
        "transcript": "TEXT",
        "generation_ms": "INTEGER",
        "response_model": "TEXT",
        "response_text": "TEXT",
        "reference_text": "TEXT",
        "word_errors": "INTEGER",
        "reference_words": "INTEGER",
        "word_error_rate": "REAL",
    }.items():
        if name not in existing_columns:
            connection.execute(f"ALTER TABLE runs ADD COLUMN {name} {data_type}")
    connection.execute("UPDATE runs SET trace_id = lower(hex(randomblob(16))) WHERE trace_id IS NULL")
    connection.execute("UPDATE runs SET root_span_id = lower(hex(randomblob(8))) WHERE root_span_id IS NULL")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS spans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            trace_id TEXT NOT NULL,
            span_id TEXT NOT NULL UNIQUE,
            parent_span_id TEXT NOT NULL,
            name TEXT NOT NULL,
            started_ms REAL NOT NULL,
            ended_ms REAL NOT NULL,
            status TEXT NOT NULL,
            FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
        )
        """
    )
    connection.execute("CREATE INDEX IF NOT EXISTS spans_run_id_idx ON spans(run_id)")
    connection.commit()
    return connection


def save_run(spans: list[dict[str, Any]], **fields: Any) -> int:
    values = {"created_at": datetime.now(UTC).isoformat(), **fields}
    with connect() as connection:
        cursor = connection.execute(
            """
            INSERT INTO runs (
                trace_id, root_span_id, request_id, created_at, status,
                failure_stage, recording_ms, request_read_ms, conversion_ms,
                transcription_ms, generation_ms, total_ms, audio_bytes,
                media_type, model, execution, transcript_characters, transcript,
                response_model, response_text
            ) VALUES (
                :trace_id, :root_span_id, :request_id, :created_at, :status,
                :failure_stage, :recording_ms, :request_read_ms, :conversion_ms,
                :transcription_ms, :generation_ms, :total_ms, :audio_bytes,
                :media_type, :model, :execution, :transcript_characters, :transcript,
                :response_model, :response_text
            )
            """,
            values,
        )
        run_id = cursor.lastrowid
        if run_id is None:
            raise RuntimeError("Run storage did not return an ID.")
        connection.executemany(
            """
            INSERT INTO spans (
                run_id, trace_id, span_id, parent_span_id, name,
                started_ms, ended_ms, status
            ) VALUES (
                :run_id, :trace_id, :span_id, :parent_span_id, :name,
                :started_ms, :ended_ms, :status
            )
            """,
            ({"run_id": run_id, **span} for span in spans),
        )
    return run_id


def _attach_spans(connection: sqlite3.Connection, run_rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    records = [dict(row) for row in run_rows]
    records_by_id = {record["id"]: record for record in records}
    for record in records:
        record["spans"] = []
    if not records:
        return records

    placeholders = ",".join("?" for _ in records)
    span_rows = connection.execute(
        f"SELECT * FROM spans WHERE run_id IN ({placeholders}) ORDER BY started_ms, id",
        tuple(records_by_id),
    ).fetchall()
    for row in span_rows:
        span = dict(row)
        span["duration_ms"] = round(span["ended_ms"] - span["started_ms"], 2)
        records_by_id[span["run_id"]]["spans"].append(span)
    return records


def list_runs(limit: int) -> list[dict[str, Any]]:
    with connect() as connection:
        rows = connection.execute(
            "SELECT * FROM runs ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return _attach_spans(connection, rows)


def get_run(run_id: int) -> dict[str, Any] | None:
    with connect() as connection:
        rows = connection.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchall()
        records = _attach_spans(connection, rows)
    return records[0] if records else None


def word_error_stats(reference: str, hypothesis: str) -> tuple[int, int, float]:
    expected = WORD_PATTERN.findall(reference.lower())
    actual = WORD_PATTERN.findall(hypothesis.lower())
    if not expected:
        raise ValueError("Reference text must contain at least one word.")

    previous = list(range(len(actual) + 1))
    for expected_word in expected:
        current = [previous[0] + 1]
        for index, actual_word in enumerate(actual, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[index] + 1,
                    previous[index - 1] + (expected_word != actual_word),
                )
            )
        previous = current
    errors = previous[-1]
    return errors, len(expected), round(errors / len(expected), 4)


def save_reference(run_id: int, reference_text: str) -> dict[str, Any]:
    with connect() as connection:
        row = connection.execute("SELECT transcript FROM runs WHERE id = ?", (run_id,)).fetchone()
        if row is None:
            raise KeyError(run_id)
        if row["transcript"] is None:
            raise ValueError("This legacy run does not contain a transcript.")
        errors, reference_words, error_rate = word_error_stats(reference_text, row["transcript"])
        connection.execute(
            """
            UPDATE runs
            SET reference_text = ?, word_errors = ?, reference_words = ?, word_error_rate = ?
            WHERE id = ?
            """,
            (reference_text, errors, reference_words, error_rate, run_id),
        )
    record = get_run(run_id)
    if record is None:
        raise KeyError(run_id)
    return record


def percentile(values: list[int], quantile: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * quantile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return round(ordered[lower] * (1 - weight) + ordered[upper] * weight)


def get_summary() -> dict[str, Any]:
    with connect() as connection:
        rows = [dict(row) for row in connection.execute("SELECT * FROM runs ORDER BY id")]
    completed = [row for row in rows if row["status"] == "completed"]
    models = []
    for model in sorted({row["model"] for row in completed}):
        model_rows = [row for row in completed if row["model"] == model]
        labeled = [row for row in model_rows if row["reference_words"]]
        reference_words = sum(row["reference_words"] for row in labeled)
        word_errors = sum(row["word_errors"] for row in labeled)
        models.append(
            {
                "model": model,
                "runs": len(model_rows),
                "p50_total_ms": percentile([row["total_ms"] for row in model_rows], 0.5),
                "p95_total_ms": percentile([row["total_ms"] for row in model_rows], 0.95),
                "p50_transcription_ms": percentile([row["transcription_ms"] for row in model_rows], 0.5),
                "p95_transcription_ms": percentile([row["transcription_ms"] for row in model_rows], 0.95),
                "labeled_runs": len(labeled),
                "word_error_rate": round(word_errors / reference_words, 4) if reference_words else None,
            }
        )
    return {
        "total_runs": len(rows),
        "completed_runs": len(completed),
        "failed_runs": len(rows) - len(completed),
        "success_rate": round(len(completed) / len(rows), 4) if rows else None,
        "models": models,
    }
