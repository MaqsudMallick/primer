import sqlite3

import pytest

from app import runs
from app.runs import percentile, word_error_stats


def test_word_error_stats_counts_insertions_deletions_and_substitutions() -> None:
    assert word_error_stats("hello brave new world", "hello blue world") == (2, 4, 0.5)


def test_word_error_stats_rejects_empty_reference() -> None:
    with pytest.raises(ValueError, match="at least one word"):
        word_error_stats("...", "hello")


def test_percentile_interpolates_ordered_values() -> None:
    assert percentile([100, 200, 300, 400], 0.5) == 250
    assert percentile([100, 200, 300, 400], 0.95) == 385
    assert percentile([], 0.95) is None


def test_list_runs_migrates_a_duration_only_database(monkeypatch, tmp_path) -> None:
    database = tmp_path / "runs.db"
    with sqlite3.connect(database) as connection:
        connection.execute(
            """
            CREATE TABLE runs (
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
        connection.execute(
            """
            INSERT INTO runs VALUES (
                1, 'old-run', '2026-01-01T00:00:00Z', 'completed', NULL,
                1000, 1, 20, 100, 125, 1000, 'audio/wav', 'base.en', 'cpu', 5
            )
            """
        )
    monkeypatch.setattr(runs, "DB_PATH", database)

    record = runs.list_runs(1)[0]

    assert len(record["trace_id"]) == 32
    assert len(record["root_span_id"]) == 16
    assert record["transcript"] is None
    assert record["spans"] == []
