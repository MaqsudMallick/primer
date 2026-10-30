import assert from "node:assert/strict";
import test from "node:test";

import { buildLegacySpans, slowestSpan, spanLabel } from "./metrics.js";

test("builds sequential estimated spans for a legacy run", () => {
  const spans = buildLegacySpans({
    status: "completed",
    failure_stage: null,
    request_read_ms: 5,
    conversion_ms: 50,
    transcription_ms: 600,
    total_ms: 700,
  });

  assert.deepEqual(spans.map(({ name, started_ms, ended_ms }) => ({ name, started_ms, ended_ms })), [
    { name: "http.request.read", started_ms: 0, ended_ms: 5 },
    { name: "audio.convert", started_ms: 5, ended_ms: 55 },
    { name: "speech.transcribe", started_ms: 55, ended_ms: 655 },
    { name: "legacy.uninstrumented", started_ms: 655, ended_ms: 700 },
  ]);
});

test("finds the slowest span and gives it a stable label", () => {
  const spans = buildLegacySpans({
    status: "completed",
    failure_stage: null,
    request_read_ms: 5,
    conversion_ms: 50,
    transcription_ms: 600,
    total_ms: 700,
  });

  assert.equal(spanLabel(slowestSpan(spans).name), "Whisper");
});

test("does not create a negative legacy remainder", () => {
  const spans = buildLegacySpans({
    status: "completed",
    failure_stage: null,
    request_read_ms: 10,
    conversion_ms: 20,
    transcription_ms: 80,
    total_ms: 100,
  });

  assert.equal(spans.some((span) => span.name === "legacy.uninstrumented"), false);
});
