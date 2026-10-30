import assert from "node:assert/strict";
import test from "node:test";

import { buildLatencyStages } from "./metrics.js";

test("builds a complete latency breakdown and marks the longest stage", () => {
  const stages = buildLatencyStages({
    request_read_ms: 5,
    conversion_ms: 50,
    transcription_ms: 600,
    total_ms: 700,
    roundTripMs: 800,
  });

  assert.deepEqual(stages.map(({ label, ms, isBottleneck }) => ({ label, ms, isBottleneck })), [
    { label: "Transport + browser", ms: 100, isBottleneck: false },
    { label: "Request read", ms: 5, isBottleneck: false },
    { label: "Audio conversion", ms: 50, isBottleneck: false },
    { label: "Whisper", ms: 600, isBottleneck: true },
    { label: "Backend overhead", ms: 45, isBottleneck: false },
  ]);
});

test("does not report negative remainder stages", () => {
  const stages = buildLatencyStages({
    request_read_ms: 1,
    conversion_ms: 10,
    transcription_ms: 90,
    total_ms: 100,
    roundTripMs: 99,
  });

  assert.equal(stages.find((stage) => stage.key === "transport").ms, 0);
  assert.equal(stages.find((stage) => stage.key === "overhead").ms, 0);
});
