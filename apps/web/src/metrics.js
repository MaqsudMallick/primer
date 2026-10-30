export function buildLatencyStages(metrics) {
  const backendStages = [
    { key: "request", label: "Request read", ms: metrics.request_read_ms },
    { key: "conversion", label: "Audio conversion", ms: metrics.conversion_ms },
    { key: "whisper", label: "Whisper", ms: metrics.transcription_ms },
  ];
  const measuredBackendMs = backendStages.reduce((total, stage) => total + stage.ms, 0);
  const stages = [
    { key: "transport", label: "Transport + browser", ms: Math.max(0, metrics.roundTripMs - metrics.total_ms) },
    ...backendStages,
    { key: "overhead", label: "Backend overhead", ms: Math.max(0, metrics.total_ms - measuredBackendMs) },
  ];
  const scaleMs = Math.max(metrics.roundTripMs, stages.reduce((total, stage) => total + stage.ms, 0), 1);
  const bottleneckMs = Math.max(...stages.map((stage) => stage.ms));

  return stages.map((stage) => ({
    ...stage,
    percent: (stage.ms / scaleMs) * 100,
    isBottleneck: stage.ms === bottleneckMs,
  }));
}
