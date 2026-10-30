# Voice agent starter

This project records one browser audio turn and transcribes it with local Whisper.

## Run both applications with Docker

Install Docker Desktop. Confirm that this model file exists:

```text
apps/api/models/ggml-base.en.bin
```

Run this command from the repository root:

```sh
docker compose up --build
```

Open `http://localhost:5173`. The API runs at `http://localhost:8001`.

The first build compiles `whisper.cpp`. Later builds use the Docker build cache.

Stop both applications with `docker compose down`.

## Structure

```text
apps/
  web/  React and Vite
  api/  FastAPI and whisper.cpp
```

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
- `apps/api/models/ggml-base.en.bin`

The API removes temporary audio and transcript files after each request.

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

The browser shows an after-stop latency breakdown. It marks the longest stage as the bottleneck. The recording duration is separate because the user controls it.

The application does not use a telemetry database. The API writes each result to standard output. Railway captures this output after deployment. Use the request ID to correlate the browser result and the API event.
