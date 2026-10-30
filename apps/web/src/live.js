const LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";

export function float32ToPcm16(samples) {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm;
}

export function pcm16ToFloat32(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  }
  return samples;
}

export async function parseLiveMessage(data) {
  return JSON.parse(typeof data === "string" ? data : await data.text());
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function relativeMs(time, startedAt) {
  return Math.max(0, Math.round(time - startedAt));
}

export function buildSetupMessage(model) {
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
      },
      systemInstruction: { parts: [{ text: "You are a concise voice assistant. Reply in one short sentence." }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 2000 } },
    },
  };
}

export function createLiveTurn({ fetchToken, onReady, onSpeaking, onComplete, onError }) {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  const startedAt = performance.now();
  const playbackContext = new AudioContext({ sampleRate: 24000 });
  playbackContext.resume();

  let websocket;
  let captureContext;
  let mediaStream;
  let processor;
  let audioBytes = 0;
  let tokenAt = 0;
  let recordingAt = 0;
  let stoppedAt = 0;
  let firstAudioAt = 0;
  let nextPlaybackAt = 0;
  let inputTranscript = "";
  let outputTranscript = "";
  let closed = false;
  let completed = false;

  function fail(error) {
    if (closed || completed) return;
    close();
    onError(error instanceof Error ? error : new Error("The Live session failed."));
  }

  function send(message) {
    if (websocket?.readyState === WebSocket.OPEN) websocket.send(JSON.stringify(message));
  }

  function stopCapture() {
    if (processor) processor.onaudioprocess = null;
    processor?.disconnect();
    mediaStream?.getTracks().forEach((track) => track.stop());
    captureContext?.close();
    processor = null;
    mediaStream = null;
    captureContext = null;
  }

  function close() {
    if (closed) return;
    closed = true;
    stopCapture();
    if (websocket?.readyState === WebSocket.OPEN) websocket.close(1000, "Turn complete");
  }

  function finishAfterPlayback() {
    if (completed) return;
    const delay = Math.max(0, (nextPlaybackAt - playbackContext.currentTime) * 1000);
    setTimeout(() => {
      if (completed) return;
      completed = true;
      const endedAt = performance.now();
      const effectiveStopAt = stoppedAt || firstAudioAt || endedAt;
      const effectiveFirstAudioAt = firstAudioAt || endedAt;
      const spans = [
        { name: "live.token", started_ms: 0, ended_ms: relativeMs(tokenAt, startedAt), status: "ok" },
        { name: "live.connect", started_ms: relativeMs(tokenAt, startedAt), ended_ms: relativeMs(recordingAt, startedAt), status: "ok" },
        { name: "audio.stream", started_ms: relativeMs(recordingAt, startedAt), ended_ms: relativeMs(effectiveStopAt, startedAt), status: "ok" },
        { name: "agent.first_audio", started_ms: relativeMs(effectiveStopAt, startedAt), ended_ms: relativeMs(effectiveFirstAudioAt, startedAt), status: "ok" },
        { name: "audio.playback", started_ms: relativeMs(effectiveFirstAudioAt, startedAt), ended_ms: relativeMs(endedAt, startedAt), status: "ok" },
      ];
      close();
      playbackContext.close();
      onComplete({
        recording_ms: relativeMs(effectiveStopAt, recordingAt),
        generation_ms: relativeMs(effectiveFirstAudioAt, effectiveStopAt),
        total_ms: relativeMs(endedAt, startedAt),
        audio_bytes: audioBytes,
        transcript: inputTranscript.trim(),
        response_text: outputTranscript.trim(),
        spans,
      });
    }, delay + 40);
  }

  function playAudio(base64Audio) {
    const samples = pcm16ToFloat32(base64ToBytes(base64Audio));
    const buffer = playbackContext.createBuffer(1, samples.length, 24000);
    buffer.copyToChannel(samples, 0);
    const source = playbackContext.createBufferSource();
    source.buffer = buffer;
    source.connect(playbackContext.destination);
    const playAt = Math.max(playbackContext.currentTime + 0.02, nextPlaybackAt);
    source.start(playAt);
    nextPlaybackAt = playAt + buffer.duration;
  }

  async function startCapture() {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    captureContext = new AudioContext({ sampleRate: 16000 });
    await captureContext.resume();
    const source = captureContext.createMediaStreamSource(mediaStream);
    // shortcut: ScriptProcessor keeps this prototype small; use AudioWorklet before production.
    processor = captureContext.createScriptProcessor(2048, 1, 1);
    const mute = captureContext.createGain();
    mute.gain.value = 0;
    processor.onaudioprocess = (event) => {
      const pcm = float32ToPcm16(event.inputBuffer.getChannelData(0));
      const bytes = new Uint8Array(pcm.buffer);
      audioBytes += bytes.byteLength;
      send({
        realtimeInput: {
          audio: {
            data: bytesToBase64(bytes),
            mimeType: `audio/pcm;rate=${captureContext.sampleRate}`,
          },
        },
      });
    };
    source.connect(processor);
    processor.connect(mute);
    mute.connect(captureContext.destination);
    recordingAt = performance.now();
    onReady();
  }

  async function connect() {
    try {
      const credentials = await fetchToken();
      tokenAt = performance.now();
      websocket = new WebSocket(`${LIVE_URL}?access_token=${encodeURIComponent(credentials.token)}`);
      websocket.onerror = () => fail(new Error("The Gemini Live connection failed."));
      websocket.onclose = (event) => {
        if (!closed && !completed) fail(new Error(event.reason || "The Gemini Live connection closed."));
      };
      websocket.onopen = () => send(buildSetupMessage(credentials.model));
      websocket.onmessage = async (event) => {
        try {
          const message = await parseLiveMessage(event.data);
          if (message.setupComplete) {
            await startCapture();
            return;
          }
          const content = message.serverContent;
          if (!content) return;
          if (content.inputTranscription?.text) inputTranscript += content.inputTranscription.text;
          if (content.outputTranscription?.text) outputTranscript += content.outputTranscription.text;
          for (const part of content.modelTurn?.parts ?? []) {
            if (!part.inlineData?.data) continue;
            if (!firstAudioAt) {
              firstAudioAt = performance.now();
              if (!stoppedAt) {
                stoppedAt = firstAudioAt;
                stopCapture();
              }
              onSpeaking();
            }
            playAudio(part.inlineData.data);
          }
          if (content.turnComplete) finishAfterPlayback();
        } catch (error) {
          fail(error);
        }
      };
    } catch (error) {
      fail(error);
    }
  }

  function stop() {
    if (!recordingAt || stoppedAt) return;
    stoppedAt = performance.now();
    stopCapture();
    send({ realtimeInput: { audioStreamEnd: true } });
  }

  connect();
  return { stop, close };
}
