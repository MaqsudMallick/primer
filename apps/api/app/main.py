from contextlib import contextmanager
from datetime import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
from time import perf_counter
from typing import Annotated, Any, Iterator, Literal
from urllib.error import HTTPError, URLError
from urllib.request import Request as UrlRequest, urlopen
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException, Query, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app import runs
from app.observability import log_metric

MAX_AUDIO_BYTES = 15 * 1024 * 1024
MODEL_DIR = Path(os.getenv("WHISPER_MODEL_DIR", Path(__file__).parents[1] / "models"))
MODEL_PATHS = {
    "base.en": MODEL_DIR / "ggml-base.en.bin",
    "small.en": MODEL_DIR / "ggml-small.en.bin",
}
DEFAULT_WHISPER_MODEL = os.getenv("DEFAULT_WHISPER_MODEL", "small.en")
if DEFAULT_WHISPER_MODEL not in MODEL_PATHS:
    raise RuntimeError("DEFAULT_WHISPER_MODEL must be base.en or small.en.")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
GEMINI_TIMEOUT_SECONDS = 20


class TranscriptionMetrics(BaseModel):
    recording_ms: int | None
    request_read_ms: int
    conversion_ms: int
    transcription_ms: int
    generation_ms: int
    total_ms: int


class SpanRecord(BaseModel):
    trace_id: str
    span_id: str
    parent_span_id: str
    name: str
    started_ms: float
    ended_ms: float
    duration_ms: float
    status: Literal["ok", "error"]


class TranscriptionResponse(BaseModel):
    run_id: int
    trace_id: str
    request_id: str
    model: str
    text: str
    response_model: str | None
    response_text: str
    metrics: TranscriptionMetrics
    spans: list[SpanRecord]


class RunRecord(BaseModel):
    id: int
    trace_id: str
    root_span_id: str
    request_id: str
    created_at: datetime
    status: Literal["completed", "failed"]
    failure_stage: str | None
    recording_ms: int | None
    request_read_ms: int
    conversion_ms: int
    transcription_ms: int
    generation_ms: int | None
    total_ms: int
    audio_bytes: int
    media_type: str
    model: str
    execution: str
    transcript_characters: int | None
    transcript: str | None
    response_model: str | None
    response_text: str | None
    reference_text: str | None
    word_errors: int | None
    reference_words: int | None
    word_error_rate: float | None
    spans: list[SpanRecord]


class ModelSummary(BaseModel):
    model: str
    runs: int
    p50_total_ms: int | None
    p95_total_ms: int | None
    p50_transcription_ms: int | None
    p95_transcription_ms: int | None
    labeled_runs: int
    word_error_rate: float | None


class RunSummary(BaseModel):
    total_runs: int
    completed_runs: int
    failed_runs: int
    success_rate: float | None
    models: list[ModelSummary]


class ReferenceInput(BaseModel):
    text: str = Field(min_length=1, max_length=2_000)


app = FastAPI(title="Voice Agent Starter API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST", "PUT"],
    allow_headers=["Content-Type", "X-Recording-Duration-Ms", "X-Request-ID", "X-Whisper-Model"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/runs", response_model=list[RunRecord])
def get_runs(limit: Annotated[int, Query(ge=1, le=500)] = 50) -> list[dict[str, Any]]:
    return runs.list_runs(limit)


@app.get("/api/runs/summary", response_model=RunSummary)
def get_run_summary() -> dict[str, Any]:
    return runs.get_summary()


@app.put("/api/runs/{run_id}/reference", response_model=RunRecord)
def update_run_reference(run_id: int, body: ReferenceInput) -> dict[str, Any]:
    try:
        return runs.save_reference(run_id, body.text)
    except KeyError as error:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Run not found.") from error
    except ValueError as error:
        raise HTTPException(status.HTTP_409_CONFLICT, str(error)) from error


async def read_audio(request: Request) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length and content_length.isdigit() and int(content_length) > MAX_AUDIO_BYTES:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Audio must be 15 MB or smaller.")

    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_AUDIO_BYTES:
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "Audio must be 15 MB or smaller.")
        chunks.append(chunk)

    audio = b"".join(chunks)
    if not audio:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Audio is required.")
    return audio


def require_local_tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, f"{name} is not installed.")
    return path


def generate_response(text: str) -> str:
    if not GEMINI_API_KEY:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Gemini is not configured.")

    payload = json.dumps(
        {
            "contents": [{"parts": [{"text": text}]}],
            "systemInstruction": {
                "parts": [{"text": "You are a concise voice assistant. Reply in one short sentence. Do not use Markdown."}]
            },
            "generationConfig": {"maxOutputTokens": 80, "temperature": 0.4},
            "store": False,
        }
    ).encode()
    request = UrlRequest(
        f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
        data=payload,
        headers={"Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY},
        method="POST",
    )
    try:
        with urlopen(request, timeout=GEMINI_TIMEOUT_SECONDS) as provider_response:
            body = json.loads(provider_response.read())
        response_text = "".join(
            part.get("text", "")
            for part in body.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        ).strip()
    except HTTPError as error:
        status_code = status.HTTP_503_SERVICE_UNAVAILABLE if error.code == 429 else status.HTTP_502_BAD_GATEWAY
        raise HTTPException(status_code, "Gemini could not generate a response.") from error
    except (AttributeError, IndexError, TypeError, json.JSONDecodeError, TimeoutError, URLError) as error:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Gemini could not generate a response.") from error

    if not response_text:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Gemini returned an empty response.")
    return response_text


@contextmanager
def measured_span(
    spans: list[dict[str, Any]],
    name: str,
    trace_started: float,
    trace_id: str,
    parent_span_id: str,
) -> Iterator[None]:
    span_started = perf_counter()
    span_status = "ok"
    try:
        yield
    except Exception:
        span_status = "error"
        raise
    finally:
        span_ended = perf_counter()
        started_ms = round((span_started - trace_started) * 1000, 2)
        ended_ms = round((span_ended - trace_started) * 1000, 2)
        spans.append(
            {
                "trace_id": trace_id,
                "span_id": uuid4().hex[:16],
                "parent_span_id": parent_span_id,
                "name": name,
                "started_ms": started_ms,
                "ended_ms": ended_ms,
                "duration_ms": round(ended_ms - started_ms, 2),
                "status": span_status,
            }
        )


@app.post("/api/transcriptions", response_model=TranscriptionResponse)
async def transcribe(
    request: Request,
    response: Response,
    client_request_id: Annotated[
        str | None,
        Header(alias="X-Request-ID", max_length=64, pattern=r"^[A-Za-z0-9-]+$"),
    ] = None,
    recording_ms: Annotated[
        int | None,
        Header(alias="X-Recording-Duration-Ms", ge=0, le=300_000),
    ] = None,
    whisper_model: Annotated[
        Literal["base.en", "small.en"],
        Header(alias="X-Whisper-Model"),
    ] = DEFAULT_WHISPER_MODEL,
) -> TranscriptionResponse:
    request_id = client_request_id or uuid4().hex
    trace_id = uuid4().hex
    root_span_id = uuid4().hex[:16]
    started = perf_counter()
    spans: list[dict[str, Any]] = []
    stage = "http.request.read"
    audio_bytes = 0
    media_type = request.headers.get("content-type", "unknown").split(";", 1)[0]
    request_read_ms = 0
    conversion_ms = 0
    transcription_ms = 0
    generation_ms = 0
    run_status = "failed"
    text = ""
    response_text = ""
    response_model: str | None = None
    model_path = MODEL_PATHS[whisper_model]

    try:
        with measured_span(spans, stage, started, trace_id, root_span_id):
            audio = await read_audio(request)
        request_read_ms = round(spans[-1]["duration_ms"])
        audio_bytes = len(audio)

        stage = "runtime.preflight"
        with measured_span(spans, stage, started, trace_id, root_span_id):
            ffmpeg = require_local_tool("ffmpeg")
            whisper = require_local_tool("whisper-cli")
            if not model_path.is_file():
                raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, f"The {whisper_model} model is not installed.")

        with TemporaryDirectory(prefix="voice-agent-") as directory:
            workdir = Path(directory)
            source = workdir / "audio"
            wav = workdir / "audio.wav"
            output = workdir / "transcript"

            stage = "audio.prepare"
            with measured_span(spans, stage, started, trace_id, root_span_id):
                source.write_bytes(audio)

            stage = "audio.convert"
            with measured_span(spans, stage, started, trace_id, root_span_id):
                subprocess.run(
                    [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", source, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav],
                    check=True,
                    capture_output=True,
                    timeout=30,
                )
            conversion_ms = round(spans[-1]["duration_ms"])

            stage = "speech.transcribe"
            with measured_span(spans, stage, started, trace_id, root_span_id):
                subprocess.run(
                    [whisper, "-m", model_path, "-f", wav, "-l", "en", "-ng", "-nt", "-otxt", "-of", output],
                    check=True,
                    capture_output=True,
                    timeout=120,
                )
                text = Path(f"{output}.txt").read_text().strip()
            transcription_ms = round(spans[-1]["duration_ms"])

        if text:
            stage = "agent.generate"
            response_model = GEMINI_MODEL
            with measured_span(spans, stage, started, trace_id, root_span_id):
                response_text = generate_response(text)
            generation_ms = round(spans[-1]["duration_ms"])
        run_status = "completed"
    except HTTPException as error:
        log_metric(
            "voice_turn.failed",
            trace_id=trace_id,
            request_id=request_id,
            stage=stage,
            status_code=error.status_code,
            audio_bytes=audio_bytes,
            media_type=media_type,
            total_ms=round((perf_counter() - started) * 1000),
        )
        raise
    except subprocess.TimeoutExpired as error:
        log_metric(
            "voice_turn.failed",
            trace_id=trace_id,
            request_id=request_id,
            stage=stage,
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            audio_bytes=audio_bytes,
            media_type=media_type,
            total_ms=round((perf_counter() - started) * 1000),
            error_type=type(error).__name__,
        )
        raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, "Transcription timed out.") from error
    except (subprocess.CalledProcessError, OSError) as error:
        log_metric(
            "voice_turn.failed",
            trace_id=trace_id,
            request_id=request_id,
            stage=stage,
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            audio_bytes=audio_bytes,
            media_type=media_type,
            total_ms=round((perf_counter() - started) * 1000),
            error_type=type(error).__name__,
        )
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Audio processing failed.") from error
    finally:
        generation_span = next((span for span in reversed(spans) if span["name"] == "agent.generate"), None)
        if generation_span:
            generation_ms = round(generation_span["duration_ms"])
        total_ms = round((perf_counter() - started) * 1000)
        stored_run_id = runs.save_run(
            spans,
            trace_id=trace_id,
            root_span_id=root_span_id,
            request_id=request_id,
            status=run_status,
            failure_stage=None if run_status == "completed" else stage,
            recording_ms=recording_ms,
            request_read_ms=request_read_ms,
            conversion_ms=conversion_ms,
            transcription_ms=transcription_ms,
            generation_ms=generation_ms,
            total_ms=total_ms,
            audio_bytes=audio_bytes,
            media_type=media_type,
            model=model_path.name,
            execution="cpu",
            transcript_characters=len(text) if text else None,
            transcript=text or None,
            response_model=response_model,
            response_text=response_text or None,
        )

    metrics = TranscriptionMetrics(
        recording_ms=recording_ms,
        request_read_ms=request_read_ms,
        conversion_ms=conversion_ms,
        transcription_ms=transcription_ms,
        generation_ms=generation_ms,
        total_ms=total_ms,
    )
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Trace-ID"] = trace_id
    log_metric(
        "voice_turn.completed",
        trace_id=trace_id,
        request_id=request_id,
        audio_bytes=audio_bytes,
        media_type=media_type,
        model=model_path.name,
        execution="cpu",
        transcript_characters=len(text),
        response_model=response_model,
        response_characters=len(response_text),
        **metrics.model_dump(),
    )
    return TranscriptionResponse(
        run_id=stored_run_id,
        trace_id=trace_id,
        request_id=request_id,
        model=model_path.name,
        text=text,
        response_model=response_model,
        response_text=response_text,
        metrics=metrics,
        spans=spans,
    )
