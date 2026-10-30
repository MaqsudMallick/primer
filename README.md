# Voice agent starter

This project records one browser audio turn and transcribes it with local Whisper.

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

The browser shows the same timing stages and its total request round-trip time. Use the request ID to correlate browser and API events.
