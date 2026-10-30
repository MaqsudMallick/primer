const LABELS = {
  "http.request.read": "Request read",
  "runtime.preflight": "Preflight",
  "audio.prepare": "Audio prepare",
  "audio.convert": "Audio conversion",
  "speech.transcribe": "Whisper",
  "legacy.uninstrumented": "Uninstrumented",
};

export function spanLabel(name) {
  return LABELS[name] ?? name;
}

export function buildLegacySpans(run) {
  const durations = [
    ["http.request.read", run.request_read_ms],
    ["audio.convert", run.conversion_ms],
    ["speech.transcribe", run.transcription_ms],
  ];
  let startedMs = 0;
  const spans = durations.map(([name, duration]) => {
    const span = {
      name,
      started_ms: startedMs,
      ended_ms: startedMs + duration,
      duration_ms: duration,
      status: run.status === "failed" && run.failure_stage === name ? "error" : "ok",
    };
    startedMs = span.ended_ms;
    return span;
  });
  const remainder = Math.max(0, run.total_ms - startedMs);
  if (remainder) {
    spans.push({
      name: "legacy.uninstrumented",
      started_ms: startedMs,
      ended_ms: startedMs + remainder,
      duration_ms: remainder,
      status: "ok",
    });
  }
  return spans;
}

export function slowestSpan(spans) {
  return spans.reduce((slowest, span) => (
    !slowest || span.duration_ms > slowest.duration_ms ? span : slowest
  ), null);
}
