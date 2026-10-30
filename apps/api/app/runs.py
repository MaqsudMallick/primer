from datetime import UTC, datetime
import os
from pathlib import Path
import sqlite3
from typing import Any


DB_PATH = Path(os.getenv("RUNS_DB_PATH", "data/runs.db"))


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL,
            failure_stage TEXT,
            recording_ms INTEGER,
            request_read_ms INTEGER NOT NULL,
            conversion_ms INTEGER NOT NULL,
            transcription_ms INTEGER NOT NULL,
            total_ms INTEGER NOT NULL,
            audio_bytes INTEGER NOT NULL,
            media_type TEXT NOT NULL,
            model TEXT NOT NULL,
            execution TEXT NOT NULL,
            transcript_characters INTEGER
        )
        """
    )
    return connection


def save_run(**fields: Any) -> None:
    values = {"created_at": datetime.now(UTC).isoformat(), **fields}
    with connect() as connection:
        connection.execute(
            """
            INSERT INTO runs (
                request_id, created_at, status, failure_stage, recording_ms,
                request_read_ms, conversion_ms, transcription_ms, total_ms,
                audio_bytes, media_type, model, execution, transcript_characters
            ) VALUES (
                :request_id, :created_at, :status, :failure_stage, :recording_ms,
                :request_read_ms, :conversion_ms, :transcription_ms, :total_ms,
                :audio_bytes, :media_type, :model, :execution, :transcript_characters
            )
            """,
            values,
        )


def list_runs(limit: int) -> list[dict[str, Any]]:
    with connect() as connection:
        rows = connection.execute(
            "SELECT * FROM runs ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]
