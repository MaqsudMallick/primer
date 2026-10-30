import { useEffect, useRef, useState } from "react";

import { fetchRunData, saveReference, transcribeAudio } from "./api.js";
import { buildLegacySpans, slowestSpan, spanLabel } from "./metrics.js";

const MODEL_NAME = import.meta.env.VITE_WHISPER_MODEL ?? "small.en";

function formatMs(value) {
  return `${Math.round(value)} ms`;
}

function formatRate(value) {
  return value == null ? "Not labeled" : `${(value * 100).toFixed(1)}%`;
}

function renderTraceTimeline(run) {
  const exact = run.spans?.length > 0;
  const spans = exact ? run.spans : buildLegacySpans(run);
  const totalMs = Math.max(run.total_ms, ...spans.map((span) => span.ended_ms), 1);
  const slowest = slowestSpan(spans);
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="trace" aria-label="Backend trace timeline">
      <div className="trace-heading">
        <div>
          <p className="eyebrow">BACKEND TRACE</p>
          <small>{exact ? "Exact span timestamps" : "Estimated from duration-only legacy data"}</small>
        </div>
        <strong>{formatMs(totalMs)} total</strong>
      </div>
      <div className="trace-axis" aria-hidden="true">
        {ticks.map((tick) => <span key={tick}>{formatMs(totalMs * tick)}</span>)}
      </div>
      <div className="trace-track">
        {spans.map((span, index) => {
          const isSlowest = span === slowest;
          const tooltip = `${spanLabel(span.name)} · ${formatMs(span.started_ms)} to ${formatMs(span.ended_ms)} · ${formatMs(span.duration_ms)}`;
          return (
            <button
              className={`trace-span trace-span-${index % 4} ${isSlowest ? "slowest" : ""} ${span.status === "error" ? "span-error" : ""}`}
              data-tooltip={tooltip}
              key={span.span_id ?? `${span.name}-${index}`}
              type="button"
              style={{
                left: `${(span.started_ms / totalMs) * 100}%`,
                width: `${(span.duration_ms / totalMs) * 100}%`,
              }}
              aria-label={tooltip}
            />
          );
        })}
      </div>
      <ol className="trace-legend">
        {spans.map((span, index) => (
          <li key={span.span_id ?? `${span.name}-${index}`}>
            <span className={`trace-key trace-span-${index % 4} ${span === slowest ? "slowest" : ""}`} aria-hidden="true" />
            <span>{spanLabel(span.name)}</span>
            <small>{formatMs(span.started_ms)} → {formatMs(span.ended_ms)}</small>
            <strong>{formatMs(span.duration_ms)}</strong>
          </li>
        ))}
      </ol>
    </div>
  );
}

function App() {
  const [state, setState] = useState({ kind: "idle" });
  const [modelName, setModelName] = useState(MODEL_NAME);
  const [history, setHistory] = useState({ kind: "loading", runs: [], summary: null });
  const [historyVersion, setHistoryVersion] = useState(0);
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [detailPhase, setDetailPhase] = useState("opening");
  const [referenceInput, setReferenceInput] = useState({ runId: null, text: "" });
  const [referenceStatus, setReferenceStatus] = useState({ kind: "idle" });
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const buttonRef = useRef(null);
  const recordingStartedRef = useRef(0);
  const requestIdRef = useRef("");

  useEffect(() => () => streamRef.current?.getTracks().forEach((track) => track.stop()), []);
  useEffect(() => {
    let active = true;
    fetchRunData()
      .then(({ runs, summary }) => {
        if (!active) return;
        setHistory({ kind: "ready", runs, summary });
      })
      .catch(() => active && setHistory({ kind: "error", runs: [], summary: null }));
    return () => { active = false; };
  }, [historyVersion]);

  const liveRun = state.kind === "success" ? state.run : null;
  const selectedRun = history.runs.find((run) => run.id === selectedRunId)
    ?? (liveRun?.id === selectedRunId ? liveRun : null);

  const referenceText = referenceInput.runId === selectedRun?.id
    ? referenceInput.text
    : selectedRun?.reference_text ?? "";

  async function transcribe(blob, recordingMs, requestId) {
    setState({ kind: "transcribing" });
    try {
      const result = await transcribeAudio(blob, recordingMs, requestId, modelName);
      const run = {
        id: result.run_id,
        trace_id: result.trace_id,
        request_id: result.request_id,
        created_at: new Date().toISOString(),
        status: "completed",
        failure_stage: null,
        model: result.model,
        transcript: result.text,
        reference_text: null,
        word_errors: null,
        reference_words: null,
        word_error_rate: null,
        recording_ms: result.metrics.recording_ms,
        request_read_ms: result.metrics.request_read_ms,
        conversion_ms: result.metrics.conversion_ms,
        transcription_ms: result.metrics.transcription_ms,
        total_ms: result.metrics.total_ms,
        spans: result.spans,
      };
      console.info(JSON.stringify({ event: "transcription.rendered", trace_id: result.trace_id, request_id: result.request_id, ...result.metrics }));
      setState({ kind: "success", run, roundTripMs: result.metrics.roundTripMs });
      setSelectedRunId(result.run_id);
      setDetailPhase("opening");
      setReferenceInput({ runId: result.run_id, text: "" });
      setReferenceStatus({ kind: "idle" });
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

  async function labelRun(event) {
    event.preventDefault();
    if (!selectedRun) return;
    setReferenceStatus({ kind: "saving" });
    try {
      await saveReference(selectedRun.id, referenceText.trim());
      setReferenceStatus({ kind: "saved" });
      setHistoryVersion((version) => version + 1);
    } catch (error) {
      setReferenceStatus({ kind: "error", message: error instanceof Error ? error.message : "The label could not be saved." });
    }
  }

  function toggleRun(runId) {
    setReferenceStatus({ kind: "idle" });
    if (runId !== selectedRunId) {
      setSelectedRunId(runId);
      setDetailPhase("opening");
      return;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setSelectedRunId(null);
      return;
    }
    setDetailPhase("closing");
  }

  function finishDetailAnimation(event) {
    if (event.target === event.currentTarget && detailPhase === "closing") {
      setSelectedRunId(null);
      setDetailPhase("opening");
    }
  }

  const isRecording = state.kind === "recording";
  const isTranscribing = state.kind === "transcribing";
  const status = isRecording ? "Listening" : isTranscribing ? "Transcribing" : "Ready";

  return (
    <main>
      <header>
        <span aria-hidden="true" />
        <p>VOICE / LOCAL</p>
        <small>WHISPER {modelName.toUpperCase()}</small>
      </header>

      <section className="panel">
        <div className="intro">
          <p className="eyebrow">ONE TURN · LOCAL TRANSCRIPTION</p>
          <h1>Say one thing.<br />Inspect every stage.</h1>
          <p>The API deletes the audio after transcription. It stores the transcript and trace in local SQLite.</p>
        </div>
        <div className="control">
          <div className={`status ${isRecording ? "recording" : ""}`} aria-live="polite">
            <span aria-hidden="true" />{status}
          </div>
          <label className="model-choice">
            <span>Model</span>
            <select value={modelName} onChange={(event) => setModelName(event.target.value)} disabled={isRecording || isTranscribing}>
              <option value="base.en">Base.en · faster</option>
              <option value="small.en">Small.en · more accurate</option>
            </select>
          </label>
          <button ref={buttonRef} type="button" onClick={isRecording ? stopRecording : startRecording} disabled={isTranscribing}>
            {isRecording ? "Stop and transcribe" : isTranscribing ? "Working…" : "Start recording"}
          </button>
          <p className="hint">Speak for a few seconds. Then stop the recording.</p>
          {state.kind === "error" && <p className="control-error" role="alert">{state.message}</p>}
        </div>
      </section>

      <section className="trends">
        <div className="section-heading">
          <p className="eyebrow">TRENDS</p>
          <small>{history.summary && history.summary.total_runs < 20 ? "EARLY SAMPLE · USE WITH CARE" : "ALL STORED RUNS"}</small>
        </div>
        {history.summary && (
          <>
            <div className="trend-summary">
              <div><span>Runs</span><strong>{history.summary.total_runs}</strong></div>
              <div><span>Success rate</span><strong>{formatRate(history.summary.success_rate)}</strong></div>
              <div><span>Failed</span><strong>{history.summary.failed_runs}</strong></div>
            </div>
            <div className="history-table-wrap">
              <table>
                <caption>Aggregate transcription metrics by model</caption>
                <thead><tr><th>Model</th><th>Runs</th><th>Total P50</th><th>Total P95</th><th>Whisper P50</th><th>Whisper P95</th><th>Labeled</th><th>WER</th></tr></thead>
                <tbody>{history.summary.models.map((model) => (
                  <tr key={model.model}>
                    <td>{model.model}</td><td>{model.runs}</td><td>{formatMs(model.p50_total_ms)}</td><td>{formatMs(model.p95_total_ms)}</td>
                    <td>{formatMs(model.p50_transcription_ms)}</td><td>{formatMs(model.p95_transcription_ms)}</td><td>{model.labeled_runs}</td><td>{formatRate(model.word_error_rate)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="history">
        <div className="section-heading">
          <p className="eyebrow">RUN HISTORY</p>
          <small>SQLITE · NEWEST 50</small>
        </div>
        {history.kind === "loading" && <p className="history-note">Loading stored runs…</p>}
        {history.kind === "error" && <p className="history-note error">Run history is unavailable.</p>}
        {history.kind === "ready" && history.runs.length === 0 && <p className="history-note">No stored runs exist.</p>}
        {history.kind === "ready" && history.runs.length > 0 && (
          <div className="history-table-wrap">
            <table>
              <caption>Stored transcription runs</caption>
              <thead><tr><th>Time</th><th>Model</th><th>Backend</th><th>Whisper</th><th>WER</th><th>Request</th></tr></thead>
              <tbody>{history.runs.map((run) => ([
                  <tr className={`run-row ${run.id === selectedRunId && detailPhase !== "closing" ? "selected" : ""}`} key={`${run.id}-row`}>
                    <td><button type="button" aria-expanded={run.id === selectedRunId && detailPhase !== "closing"} aria-label={`${run.id === selectedRunId ? "Close" : "Open"} run from ${new Date(run.created_at).toLocaleString()}`} onClick={() => toggleRun(run.id)}><time dateTime={run.created_at}>{new Date(run.created_at).toLocaleString()}</time></button></td>
                    <td>{run.model}</td><td>{formatMs(run.total_ms)}</td><td>{formatMs(run.transcription_ms)}</td><td>{formatRate(run.word_error_rate)}</td><td>{run.request_id}</td>
                  </tr>,
                  run.id === selectedRunId && selectedRun && (
                    <tr className={`run-expansion ${detailPhase}`} key={`${run.id}-detail`}>
                      <td colSpan="6">
                        <div className="run-expansion-motion" onAnimationEnd={finishDetailAnimation}>
                          <div className="run-expansion-clip">
                            <div className="run-detail" aria-live="polite">
                          <div className="run-context">
                            <p>TRACE {selectedRun.trace_id}</p>
                            <small>{selectedRun.status}{liveRun?.id === selectedRun.id ? ` · ${formatMs(state.roundTripMs)} round trip` : ""}</small>
                          </div>
                          {renderTraceTimeline(selectedRun)}
                          {selectedRun.transcript
                            ? <p className="transcript">{selectedRun.transcript}</p>
                            : <p className="transcript-missing">{selectedRun.transcript === null ? "Transcript unavailable for this legacy run." : "No speech was detected."}</p>}
                          {selectedRun.transcript != null && (
                            <form className="reference" onSubmit={labelRun}>
                              <div>
                                <label htmlFor="reference-text">WHAT I ACTUALLY SAID</label>
                                <p>Use this label to measure word error rate. The label stays in local SQLite.</p>
                              </div>
                              <div>
                                <textarea id="reference-text" value={referenceText} onChange={(event) => setReferenceInput({ runId: selectedRun.id, text: event.target.value })} required maxLength="2000" rows="3" />
                                <div className="reference-actions">
                                  <button type="submit" disabled={referenceStatus.kind === "saving" || !referenceText.trim()}>{referenceStatus.kind === "saving" ? "Saving…" : "Save accuracy label"}</button>
                                  <strong>{formatRate(selectedRun.word_error_rate)}</strong>
                                </div>
                                {selectedRun.reference_words != null && <small>{selectedRun.word_errors} word errors across {selectedRun.reference_words} reference words.</small>}
                                {referenceStatus.kind === "saved" && <small className="success">Label saved.</small>}
                                {referenceStatus.kind === "error" && <small className="error" role="alert">{referenceStatus.message}</small>}
                              </div>
                            </form>
                          )}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )
              ]))}</tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

export default App;
