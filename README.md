# Voice agent starter

This project records one browser audio turn, transcribes it with local Whisper, and speaks the transcript.

## Run both applications with Docker

Install Docker Desktop. Confirm that these model files exist:

```text
apps/api/models/ggml-small.en.bin
apps/api/models/ggml-base.en.bin
```

Run this command from the repository root:

```sh
docker compose up --build
```

Open `http://localhost:5173`. The API runs at `http://localhost:8001`.

The first build compiles `whisper.cpp`. Later builds use the Docker build cache.

React and FastAPI reload when their source files change. Rebuild the containers only after a dependency, lock file, or Dockerfile changes.

Stop both applications with `docker compose down`.

## Structure

```text
apps/
  web/  React and Vite
  api/  FastAPI and whisper.cpp
```

## Prototype decisions

### Browser text-to-speech

The first echo loop uses the browser `speechSynthesis` API. This choice keeps the prototype free and avoids a TTS service or model.

Do not treat browser speech synthesis as the production TTS design. It has these limits:

- The available voices depend on the browser and operating system.
- Voice quality and behavior are not consistent across devices.
- The application cannot access or stream the generated audio data.
- The backend cannot store complete TTS spans or audio metrics.
- Interruption and playback controls are limited.
- Some browser voices can require network access.

Replace browser speech synthesis with a dedicated TTS model or service when the product needs a consistent voice, streaming audio, interruption support, or complete observability.

## Run the API

```sh
cd apps/api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload --port 8001
```

The API runs at `http://localhost:8001`.

## Run the web application

```sh
cd apps/web
npm install
npm run dev
```

The web application runs at `http://localhost:5173`.

## Local requirements

- `ffmpeg`
- `whisper-cli` from `whisper.cpp`
- `apps/api/models/ggml-small.en.bin`
- `apps/api/models/ggml-base.en.bin`

The API removes temporary audio files after each request.

## Observability

The API writes one structured JSON event to standard output for each completed or failed transcription. It does not log audio or transcript text.

Each successful event includes:

- Request ID
- Recording duration reported by the browser
- Request-body read time
- FFmpeg conversion time
- Whisper transcription time
- Total backend time
- Audio byte count
- Media type
- Model and execution mode

The browser shows one timeline for each backend trace. Each stage is a span. Each span has an exact start time, end time, status, trace ID, span ID, and parent span ID.

The API stores every completed or failed run in SQLite. It stores trace spans, timing, status, media type, audio size, model, and transcript text. It never stores recorded audio.

Select a run to inspect its timeline. Add the text that you said to calculate word error rate. The Trends table shows P50 and P95 latency for each model. It also shows the aggregate word error rate for labeled runs.

The interface lets you select `base.en` or `small.en` for each run. `base.en` is faster. `small.en` needs more memory and time, but it usually gives better English transcripts. The default model is `small.en`.

Old runs stay in the database. Old runs do not contain exact span timestamps or transcript text. The interface marks their timelines as estimated.

Docker stores the SQLite database in the `runs-data` volume. `docker compose down` keeps this volume. `docker compose down -v` deletes it.

The API also writes each result to standard output. Railway captures this output after deployment. Use the trace ID to correlate the browser result, database record, spans, and API event.
