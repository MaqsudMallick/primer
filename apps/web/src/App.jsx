import { useEffect, useRef, useState } from "react";

import { fetchRunData, saveReference, transcribeAudio } from "./api.js";
import { buildLegacySpans, slowestSpan, spanLabel } from "./metrics.js";

const MODEL_NAME = import.meta.env.VITE_WHISPER_MODEL ?? "small.en";
const RECENT_RUN_COUNT = 4;

function formatMs(value) {
  return `${Math.round(value)} ms`;
}

function formatRate(value) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function formatModelName(value) {
  return value.replace(/^ggml-/, "").replace(/\.bin$/, "");
}

function formatRunTime(value) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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
  const [showAllRuns, setShowAllRuns] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [detailPhase, setDetailPhase] = useState("opening");
  const [referenceInput, setReferenceInput] = useState({ runId: null, text: "" });
  const [referenceStatus, setReferenceStatus] = useState({ kind: "idle" });
  const recorderRef = useRef(null);
  const utteranceRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const buttonRef = useRef(null);
  const recordingStartedRef = useRef(0);
  const recordingStoppedRef = useRef(0);
  const requestIdRef = useRef("");

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    window.speechSynthesis?.cancel();
    utteranceRef.current = null;
  }, []);
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

  const liveRun = state.kind === "success" || state.kind === "speaking" ? state.run : null;
  const selectedRun = history.runs.find((run) => run.id === selectedRunId)
    ?? (liveRun?.id === selectedRunId ? liveRun : null);
  const visibleRuns = showAllRuns ? history.runs : history.runs.slice(0, RECENT_RUN_COUNT);
  const labeledRuns = history.summary?.models.reduce((total, model) => total + model.labeled_runs, 0) ?? 0;
  const maxP95Ms = Math.max(...(history.summary?.models.map((model) => model.p95_transcription_ms ?? 0) ?? []), 1);

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
      const successState = { kind: "success", run, roundTripMs: result.metrics.roundTripMs };
      setSelectedRunId(result.run_id);
      setDetailPhase("opening");
      setReferenceInput({ runId: result.run_id, text: "" });
      setReferenceStatus({ kind: "idle" });
      if (result.text.trim() && window.speechSynthesis && window.SpeechSynthesisUtterance) {
        const utterance = new window.SpeechSynthesisUtterance(result.text);
        let speechStartedAt = 0;
        utterance.lang = navigator.language || "en-US";
        utterance.onstart = () => {
          speechStartedAt = performance.now();
          console.info(JSON.stringify({
            event: "echo.speech_started",
            trace_id: result.trace_id,
            request_id: result.request_id,
            after_stop_ms: Math.round(speechStartedAt - recordingStoppedRef.current),
          }));
        };
        utterance.onend = () => {
          console.info(JSON.stringify({
            event: "echo.speech_finished",
            trace_id: result.trace_id,
            request_id: result.request_id,
            speech_ms: speechStartedAt ? Math.round(performance.now() - speechStartedAt) : 0,
          }));
          utteranceRef.current = null;
          setState(successState);
          buttonRef.current?.focus();
        };
        utterance.onerror = (event) => {
          console.error(JSON.stringify({
            event: "echo.speech_failed",
            trace_id: result.trace_id,
            request_id: result.request_id,
            error: event.error,
          }));
          utteranceRef.current = null;
          setState({ ...successState, speechError: "The browser could not speak the transcript." });
          buttonRef.current?.focus();
        };
        setState({ kind: "speaking", run, roundTripMs: result.metrics.roundTripMs });
        window.speechSynthesis.cancel();
        utteranceRef.current = utterance;
        window.speechSynthesis.speak(utterance);
      } else {
        setState(result.text.trim() ? { ...successState, speechError: "This browser cannot speak the transcript." } : successState);
      }
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
    recordingStoppedRef.current = performance.now();
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

  function toggleRunCount() {
    if (showAllRuns && !history.runs.slice(0, RECENT_RUN_COUNT).some((run) => run.id === selectedRunId)) {
      setSelectedRunId(null);
      setDetailPhase("opening");
    }
    setShowAllRuns((current) => !current);
  }

  const isRecording = state.kind === "recording";
  const isTranscribing = state.kind === "transcribing";
  const isSpeaking = state.kind === "speaking";
  const status = isRecording ? "Listening" : isTranscribing ? "Transcribing" : isSpeaking ? "Speaking" : "Ready";

  return (
    <main>
      <header>
        <span aria-hidden="true" />
        <p>VOICE / LOCAL</p>
        <small>WHISPER {modelName.toUpperCase()}</small>
      </header>

      <section className="panel">
        <div className="intro">
          <p className="eyebrow">ONE TURN · LOCAL ECHO</p>
          <h1>Say one thing.<br />Hear it back.</h1>
          <p>Whisper transcribes your recording. Your browser speaks the transcript. The API then deletes the audio.</p>
        </div>
        <div className="control">
          <div className={`status ${isRecording ? "recording" : isSpeaking ? "speaking" : ""}`} aria-live="polite">
            <span aria-hidden="true" />{status}
          </div>
          <label className="model-choice">
            <span>Model</span>
            <select value={modelName} onChange={(event) => setModelName(event.target.value)} disabled={isRecording || isTranscribing || isSpeaking}>
              <option value="base.en">Base.en · faster</option>
              <option value="small.en">Small.en · more accurate</option>
            </select>
          </label>
          <button ref={buttonRef} type="button" onClick={isRecording ? stopRecording : startRecording} disabled={isTranscribing || isSpeaking}>
            {isRecording ? "Stop and transcribe" : isTranscribing ? "Working…" : isSpeaking ? "Speaking…" : "Start recording"}
          </button>
          <p className="hint">Speak for a few seconds. Stop the recording to hear the transcript.</p>
          {state.kind === "error" && <p className="control-error" role="alert">{state.message}</p>}
          {state.speechError && <p className="control-error" role="alert">{state.speechError}</p>}
        </div>
      </section>

      <section className="history">
        <div className="section-heading">
          <div>
            <p className="eyebrow">INDIVIDUAL RUNS</p>
            <p>Select a run to inspect its transcript and trace.</p>
          </div>
          <small>LATEST {visibleRuns.length} OF {history.runs.length}</small>
        </div>
        {history.kind === "loading" && <p className="history-note">Loading stored runs…</p>}
        {history.kind === "error" && <p className="history-note error">Run history is unavailable.</p>}
        {history.kind === "ready" && history.runs.length === 0 && <p className="history-note">No stored runs exist.</p>}
        {history.kind === "ready" && history.runs.length > 0 && (
          <>
            <ol className="run-list">
              {visibleRuns.map((run) => (
                <li className={`run-item ${run.id === selectedRunId && detailPhase !== "closing" ? "selected" : ""}`} key={run.id}>
                  <button
                    className="run-summary"
                    type="button"
                    aria-expanded={run.id === selectedRunId && detailPhase !== "closing"}
                    aria-controls={`run-detail-${run.id}`}
                    onClick={() => toggleRun(run.id)}
                  >
                    <time className="run-time" dateTime={run.created_at}>{formatRunTime(run.created_at)}</time>
                    <span className="run-model">{formatModelName(run.model)}</span>
                    <span className="run-latency"><small>This run</small><strong>{formatMs(run.total_ms)}</strong></span>
                    <span className="run-accuracy">{run.word_error_rate == null ? "" : `${formatRate(run.word_error_rate)} WER`}</span>
                    <span className="run-toggle" aria-hidden="true">+</span>
                  </button>
                  {run.id === selectedRunId && selectedRun && (
                    <div className={`run-expansion ${detailPhase}`} id={`run-detail-${run.id}`}>
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
                    </div>
                  )}
                </li>
              ))}
            </ol>
            {history.runs.length > RECENT_RUN_COUNT && (
              <button className="history-more" type="button" onClick={toggleRunCount}>
                {showAllRuns ? `Show recent ${RECENT_RUN_COUNT}` : `Show all ${history.runs.length}`}
              </button>
            )}
          </>
        )}
      </section>

      <section className="trends">
        <div className="section-heading">
          <div>
            <p className="eyebrow">AGGREGATE BY MODEL</p>
            <p>P50 and P95 summarize all stored runs for each model.</p>
          </div>
          <small>{history.summary && history.summary.total_runs < 20 ? "EARLY SAMPLE · USE WITH CARE" : "ALL STORED RUNS"}</small>
        </div>
        {history.summary && (
          <>
            <div className="signal-strip">
              <div><strong>{history.summary.total_runs}</strong><span>Runs</span></div>
              <div><strong>{formatRate(history.summary.success_rate)}</strong><span>Successful</span></div>
              <div><strong>{labeledRuns}</strong><span>Accuracy labels</span></div>
            </div>
            <div className="model-benchmarks">
              {history.summary.models.map((model) => {
                const p50Percent = ((model.p50_transcription_ms ?? 0) / maxP95Ms) * 100;
                const p95Percent = ((model.p95_transcription_ms ?? 0) / maxP95Ms) * 100;
                return (
                  <article className="model-benchmark" key={model.model}>
                    <div className="benchmark-heading">
                      <h2>{formatModelName(model.model)}</h2>
                      <small>{model.runs}-run aggregate</small>
                    </div>
                    <div className="benchmark-primary">
                      <strong>{formatMs(model.p50_transcription_ms)}</strong>
                      <span>P50 Whisper time</span>
                    </div>
                    <div className="benchmark-track" role="img" aria-label={`Median ${formatMs(model.p50_transcription_ms)}. P95 ${formatMs(model.p95_transcription_ms)}.`}>
                      <span style={{ width: `${p95Percent}%` }} />
                      <i style={{ left: `${p50Percent}%` }} />
                    </div>
                    <dl>
                      <div><dt>P95</dt><dd>{formatMs(model.p95_transcription_ms)}</dd></div>
                      <div><dt>Accuracy</dt><dd>{model.word_error_rate == null ? "Needs labels" : `${formatRate(model.word_error_rate)} WER`}</dd></div>
                    </dl>
                  </article>
                );
              })}
            </div>
          </>
        )}
      </section>
    </main>
  );
}

export default App;
