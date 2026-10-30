import { useEffect, useRef, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8001";

function App() {
  const [state, setState] = useState({ kind: "idle" });
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const buttonRef = useRef(null);
  const recordingStartedRef = useRef(0);
  const requestIdRef = useRef("");

  useEffect(() => () => streamRef.current?.getTracks().forEach((track) => track.stop()), []);

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
          <dl className="metrics" aria-label="Turn metrics">
            <div><dt>Recording</dt><dd>{state.metrics.recording_ms} ms</dd></div>
            <div><dt>Request read</dt><dd>{state.metrics.request_read_ms} ms</dd></div>
            <div><dt>Conversion</dt><dd>{state.metrics.conversion_ms} ms</dd></div>
            <div><dt>Whisper</dt><dd>{state.metrics.transcription_ms} ms</dd></div>
            <div><dt>Backend total</dt><dd>{state.metrics.total_ms} ms</dd></div>
            <div><dt>Round trip</dt><dd>{state.metrics.roundTripMs} ms</dd></div>
          </dl>
        )}
      </section>
    </main>
  );
}

export default App;
