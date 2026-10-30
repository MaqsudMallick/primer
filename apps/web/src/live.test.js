import assert from "node:assert/strict";
import test from "node:test";

import { buildSetupMessage, float32ToPcm16, parseLiveMessage, pcm16ToFloat32 } from "./live.js";

test("puts Live response settings inside generationConfig", () => {
  const message = buildSetupMessage("gemini-3.8-live");

  assert.equal(message.setup.model, "models/gemini-3.8-live");
  assert.deepEqual(message.setup.generationConfig.responseModalities, ["AUDIO"]);
  assert.equal(message.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Kore");
  assert.equal(message.setup.responseModalities, undefined);
});

test("reads text and binary Live messages", async () => {
  assert.deepEqual(await parseLiveMessage('{"setupComplete":{}}'), { setupComplete: {} });
  assert.deepEqual(await parseLiveMessage(new Blob(['{"serverContent":{"turnComplete":true}}'])), {
    serverContent: { turnComplete: true },
  });
});

test("converts browser samples to little-endian PCM values", () => {
  const pcm = float32ToPcm16(new Float32Array([-1, -0.5, 0, 0.5, 1]));

  assert.deepEqual([...pcm], [-32768, -16384, 0, 16383, 32767]);
});

test("converts little-endian PCM bytes to browser samples", () => {
  const pcm = new Int16Array([-32768, 0, 16384, 32767]);
  const samples = pcm16ToFloat32(new Uint8Array(pcm.buffer));

  assert.equal(samples[0], -1);
  assert.equal(samples[1], 0);
  assert.equal(samples[2], 0.5);
  assert.ok(samples[3] > 0.99);
});
