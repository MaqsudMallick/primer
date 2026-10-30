from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
from time import perf_counter
from typing import Annotated
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.observability import log_metric

MAX_AUDIO_BYTES = 15 * 1024 * 1024
MODEL_PATH = Path(__file__).parents[1] / "models" / "ggml-base.en.bin"


class TranscriptionMetrics(BaseModel):
    recording_ms: int | None
    request_read_ms: int
    conversion_ms: int
    transcription_ms: int
    total_ms: int


class TranscriptionResponse(BaseModel):
    request_id: str
    text: str
    metrics: TranscriptionMetrics


app = FastAPI(title="Voice Agent Starter API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-Recording-Duration-Ms", "X-Request-ID"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


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
) -> TranscriptionResponse:
    request_id = client_request_id or uuid4().hex
    started = perf_counter()
    stage = "request"
    audio_bytes = 0
    media_type = request.headers.get("content-type", "unknown").split(";", 1)[0]
    request_read_ms = 0
    conversion_ms = 0
    transcription_ms = 0

    try:
        read_started = perf_counter()
        audio = await read_audio(request)
        request_read_ms = round((perf_counter() - read_started) * 1000)
        audio_bytes = len(audio)

        stage = "preflight"
        ffmpeg = require_local_tool("ffmpeg")
        whisper = require_local_tool("whisper-cli")
        if not MODEL_PATH.is_file():
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "The Whisper model is not installed.")

        with TemporaryDirectory(prefix="voice-agent-") as directory:
            workdir = Path(directory)
            source = workdir / "audio"
            wav = workdir / "audio.wav"
            output = workdir / "transcript"
            source.write_bytes(audio)

            stage = "conversion"
            conversion_started = perf_counter()
            subprocess.run(
                [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", source, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav],
                check=True,
                capture_output=True,
                timeout=30,
            )
            conversion_ms = round((perf_counter() - conversion_started) * 1000)

            stage = "transcription"
            transcription_started = perf_counter()
            subprocess.run(
                [whisper, "-m", MODEL_PATH, "-f", wav, "-l", "en", "-ng", "-nt", "-otxt", "-of", output],
                check=True,
                capture_output=True,
                timeout=120,
            )
            transcription_ms = round((perf_counter() - transcription_started) * 1000)
            text = Path(f"{output}.txt").read_text().strip()
    except HTTPException as error:
        log_metric(
            "transcription.failed",
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
            "transcription.failed",
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
            "transcription.failed",
            request_id=request_id,
            stage=stage,
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            audio_bytes=audio_bytes,
            media_type=media_type,
            total_ms=round((perf_counter() - started) * 1000),
            error_type=type(error).__name__,
        )
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "Audio processing failed.") from error

    total_ms = round((perf_counter() - started) * 1000)
    metrics = TranscriptionMetrics(
        recording_ms=recording_ms,
        request_read_ms=request_read_ms,
        conversion_ms=conversion_ms,
        transcription_ms=transcription_ms,
        total_ms=total_ms,
    )
    response.headers["X-Request-ID"] = request_id
    log_metric(
        "transcription.completed",
        request_id=request_id,
        audio_bytes=audio_bytes,
        media_type=media_type,
        model=MODEL_PATH.name,
        execution="cpu",
        transcript_characters=len(text),
        **metrics.model_dump(),
    )
    return TranscriptionResponse(request_id=request_id, text=text, metrics=metrics)
