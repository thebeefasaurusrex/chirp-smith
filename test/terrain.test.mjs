import assert from 'node:assert/strict';
import test from 'node:test';
import { spectrum } from '../sound/terrain.js';
const makeBuffer = (channels) => ({ numberOfChannels: channels.length, sampleRate: 44100, length: channels[0].length, getChannelData: (i) => channels[i] });
test('Terrain preserves opposite-phase stereo energy and distinguishes silence', () => {
  const positive = Float32Array.from({ length: 2048 }, (_, i) => .7 * Math.sin(2 * Math.PI * 1000 * i / 44100));
  const negative = positive.map((v) => -v);
  const mono = spectrum(makeBuffer([positive]));
  const stereo = spectrum(makeBuffer([positive, negative]));
  assert.deepEqual(stereo.field, mono.field);
  assert.ok(Math.max(...stereo.field) > .8);
  assert.equal(Math.max(...spectrum(makeBuffer([new Float32Array(2048)])).field), 0);
  const bass = spectrum(makeBuffer([Float32Array.from({ length: 2048 }, (_, i) => .7 * Math.sin(2 * Math.PI * 200 * i / 44100))]));
  assert.notDeepEqual(bass.field, mono.field);
});
