const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8001";

async function readResponse(response, fallbackMessage) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail ?? fallbackMessage);
  return body;
}

export async function transcribeAudio(blob, recordingMs, requestId, model) {
  const started = performance.now();
  const response = await fetch(`${API_URL}/api/transcriptions`, {
    method: "POST",
    headers: {
      "Content-Type": blob.type || "application/octet-stream",
      "X-Recording-Duration-Ms": String(recordingMs),
      "X-Request-ID": requestId,
      "X-Whisper-Model": model,
    },
    body: blob,
  });
  const result = await readResponse(response, "Voice turn failed.");
  return {
    ...result,
    metrics: { ...result.metrics, roundTripMs: Math.round(performance.now() - started) },
  };
}

export async function fetchRunData() {
  const [runsResponse, summaryResponse] = await Promise.all([
    fetch(`${API_URL}/api/runs`),
    fetch(`${API_URL}/api/runs/summary`),
  ]);
  return {
    runs: await readResponse(runsResponse, "Run history is unavailable."),
    summary: await readResponse(summaryResponse, "Run summary is unavailable."),
  };
}

export async function saveReference(runId, text) {
  const response = await fetch(`${API_URL}/api/runs/${runId}/reference`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return readResponse(response, "Accuracy label could not be saved.");
}
