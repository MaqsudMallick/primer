from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from app import main, runs
from app.main import MAX_AUDIO_BYTES, app

client = TestClient(app)


@pytest.fixture(autouse=True)
def isolated_run_database(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(runs, "DB_PATH", tmp_path / "runs.db")


def test_health() -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_empty_audio_is_rejected() -> None:
    response = client.post("/api/transcriptions", content=b"")

    assert response.status_code == 400
    assert response.json() == {"detail": "Audio is required."}
    assert client.get("/api/runs").json()[0]["status"] == "failed"


def test_declared_large_audio_is_rejected() -> None:
    response = client.post(
        "/api/transcriptions",
        content=b"small",
        headers={"content-length": str(MAX_AUDIO_BYTES + 1)},
    )

    assert response.status_code == 413


def test_unknown_model_is_rejected() -> None:
    response = client.post(
        "/api/transcriptions",
        content=b"audio",
        headers={"x-whisper-model": "large.en"},
    )

    assert response.status_code == 422


def test_success_returns_and_logs_metrics(monkeypatch, tmp_path) -> None:
    model = tmp_path / "model.bin"
    model.write_bytes(b"model")
    events = []

    def fake_run(arguments, **_options) -> None:
        if "-of" in arguments:
            output = arguments[arguments.index("-of") + 1]
            Path(f"{output}.txt").write_text("Hello world.")

    monkeypatch.setitem(main.MODEL_PATHS, "base.en", model)
    monkeypatch.setattr(main, "require_local_tool", lambda name: name)
    monkeypatch.setattr(main.subprocess, "run", fake_run)
    monkeypatch.setattr(main, "log_metric", lambda event, **fields: events.append({"event": event, **fields}))

    response = client.post(
        "/api/transcriptions",
        content=b"audio",
        headers={
            "content-type": "audio/webm;codecs=opus",
            "x-recording-duration-ms": "1250",
            "x-request-id": "test-request-1",
            "x-whisper-model": "base.en",
        },
    )

    assert response.status_code == 200
    assert response.headers["x-request-id"] == "test-request-1"
    assert response.json()["request_id"] == "test-request-1"
    assert response.json()["text"] == "Hello world."
    assert response.json()["model"] == "model.bin"
    assert response.json()["metrics"]["recording_ms"] == 1250
    assert len(response.json()["trace_id"]) == 32
    assert [span["name"] for span in response.json()["spans"]] == [
        "http.request.read",
        "runtime.preflight",
        "audio.prepare",
        "audio.convert",
        "speech.transcribe",
    ]
    assert all(span["parent_span_id"] for span in response.json()["spans"])
    assert events[0]["event"] == "transcription.completed"
    assert events[0]["request_id"] == "test-request-1"
    assert events[0]["media_type"] == "audio/webm"

    stored_run = client.get("/api/runs").json()[0]
    assert stored_run["request_id"] == "test-request-1"
    assert stored_run["status"] == "completed"
    assert stored_run["recording_ms"] == 1250
    assert stored_run["transcript_characters"] == 12
    assert stored_run["transcript"] == "Hello world."
    assert len(stored_run["spans"]) == 5

    labeled_run = client.put(
        f"/api/runs/{stored_run['id']}/reference",
        json={"text": "Hello brave world"},
    )
    assert labeled_run.status_code == 200
    assert labeled_run.json()["word_errors"] == 1
    assert labeled_run.json()["reference_words"] == 3
    assert labeled_run.json()["word_error_rate"] == 0.3333

    summary = client.get("/api/runs/summary").json()
    assert summary["total_runs"] == 1
    assert summary["models"][0]["labeled_runs"] == 1
    assert summary["models"][0]["word_error_rate"] == 0.3333
