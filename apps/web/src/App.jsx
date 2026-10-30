import { useEffect, useRef, useState } from "react";

import { buildLatencyStages } from "./metrics.js";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8001";

function App() {
  const [state, setState] = useState({ kind: "idle" });
  const [history, setHistory] = useState({ kind: "loading", runs: [] });
  const [historyVersion, setHistoryVersion] = useState(0);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const buttonRef = useRef(null);
  const recordingStartedRef = useRef(0);
  const requestIdRef = useRef("");

  useEffect(() => () => streamRef.current?.getTracks().forEach((track) => track.stop()), []);
  useEffect(() => {
    let active = true;

    fetch(`${API_URL}/api/runs`)
      .then((response) => {
        if (!response.ok) throw new Error("Run history is unavailable.");
        return response.json();
      })
      .then((runs) => active && setHistory({ kind: "ready", runs }))
      .catch(() => active && setHistory({ kind: "error", runs: [] }));

    return () => { active = false; };
  }, [historyVersion]);

  async function transcribe(blob, recordingMs, requestId) {
    setState({ kind: "transcribing" });
    const roundTripStarted = performance.now();

    try {
      const response = await fetch(`${API_URL}/api/transcriptions`, {
        method: "POST",
        headers: {
          "Content-Type": blob.type || "application/octet-stream",
          "X-Recording-Duration-Ms": String(recordingMs),
          "X-Request-ID": requestId,
        },
        body: blob,
      });
      const result = await response.json();
      const roundTripMs = Math.round(performance.now() - roundTripStarted);

      if (!response.ok) throw new Error(result.detail ?? "Transcription failed.");
      const metrics = { ...result.metrics, roundTripMs };
      console.info(JSON.stringify({ event: "transcription.rendered", request_id: result.request_id, ...metrics }));
      setState({ kind: "success", requestId: result.request_id, text: result.text, metrics });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "Transcription failed." });
    } finally {
      setHistoryVersion((version) => version + 1);
      buttonRef.current?.focus();
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      recordingStartedRef.current = performance.now();
      requestIdRef.current = crypto.randomUUID();
      recorder.ondataavailable = (event) => event.data.size && chunksRef.current.push(event.data);
      recorder.onstop = () => {
        const recordingMs = Math.round(performance.now() - recordingStartedRef.current);
        transcribe(new Blob(chunksRef.current, { type: recorder.mimeType }), recordingMs, requestIdRef.current);
      };
      recorder.start();
      setState({ kind: "recording" });
    } catch {
      setState({ kind: "error", message: "Microphone access is required." });
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    recorderRef.current = null;
    streamRef.current = null;
  }

  const isRecording = state.kind === "recording";
  const isTranscribing = state.kind === "transcribing";
  const status = isRecording ? "Listening" : isTranscribing ? "Transcribing" : "Ready";
  const latencyStages = state.kind === "success" ? buildLatencyStages(state.metrics) : [];

  return (
    <main>
      <header>
        <span aria-hidden="true" />
        <p>VOICE / LOCAL</p>
        <small>WHISPER BASE.EN</small>
      </header>

      <section className="panel">
        <div className="intro">
          <p className="eyebrow">ONE TURN · LOCAL TRANSCRIPTION</p>
          <h1>Say one thing.<br />See what Whisper heard.</h1>
          <p>Audio stays on this Mac. The API removes each temporary recording after transcription.</p>
        </div>

        <div className="control">
          <div className={`status ${isRecording ? "recording" : ""}`} aria-live="polite">
            <span aria-hidden="true" />
            {status}
          </div>
          <button
            ref={buttonRef}
            type="button"
            onClick={isRecording ? stopRecording : startRecording}
            disabled={isTranscribing}
          >
            {isRecording ? "Stop and transcribe" : isTranscribing ? "Working…" : "Start recording"}
          </button>
          <p className="hint">Speak for a few seconds. Then stop the recording.</p>
        </div>
      </section>

      <section className="result" aria-live="polite" aria-atomic="true">
        <div>
          <p className="eyebrow">TRANSCRIPT</p>
          {state.kind === "success" && <small>Request {state.requestId}</small>}
        </div>
        <p className={state.kind === "error" ? "error" : "transcript"}>
          {state.kind === "success" ? state.text || "No speech was detected." : state.kind === "error" ? state.message : "Your transcript will appear here."}
        </p>
        {state.kind === "success" && (
          <div className="metrics" aria-label="Latency breakdown">
            <div className="metrics-summary">
              <div><span>Recording</span><strong>{state.metrics.recording_ms} ms</strong></div>
              <div><span>After stop</span><strong>{state.metrics.roundTripMs} ms</strong></div>
              <div><span>Backend</span><strong>{state.metrics.total_ms} ms</strong></div>
            </div>
            <div className="breakdown-heading">
              <p>AFTER-STOP LATENCY</p>
              <small>Longer bar means more time</small>
            </div>
            <ol className="breakdown">
              {latencyStages.map((stage) => (
                <li key={stage.key}>
                  <div>
                    <span>{stage.label}</span>
                    {stage.isBottleneck && <em>Bottleneck</em>}
                    <strong>{stage.ms} ms</strong>
                  </div>
                  <span className="track" aria-hidden="true">
                    <span style={{ width: `${stage.percent}%` }} />
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>

      <section className="history">
        <div className="history-heading">
          <p className="eyebrow">RUN HISTORY</p>
          <small>SQLITE · NEWEST 50</small>
        </div>
        {history.kind === "loading" && <p className="history-note">Loading stored runs…</p>}
        {history.kind === "error" && <p className="history-note error">Run history is unavailable.</p>}
        {history.kind === "ready" && history.runs.length === 0 && <p className="history-note">No stored runs yet.</p>}
        {history.kind === "ready" && history.runs.length > 0 && (
          <div className="history-table-wrap">
            <table>
              <caption>Stored transcription runs</caption>
              <thead>
                <tr><th>Time</th><th>Status</th><th>Backend</th><th>Whisper</th><th>Slowest stage</th><th>Request</th></tr>
              </thead>
              <tbody>
                {history.runs.map((run) => {
                  const slowest = run.status === "failed"
                    ? `Failed at ${run.failure_stage}`
                    : buildLatencyStages({ ...run, roundTripMs: run.total_ms }).find((stage) => stage.isBottleneck).label;
                  return (
                    <tr key={run.id}>
                      <td><time dateTime={run.created_at}>{new Date(run.created_at).toLocaleString()}</time></td>
                      <td className={run.status === "failed" ? "failed" : ""}>{run.status}</td>
                      <td>{run.total_ms} ms</td>
                      <td>{run.transcription_ms} ms</td>
                      <td>{slowest}</td>
                      <td>{run.request_id}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

export default App;
