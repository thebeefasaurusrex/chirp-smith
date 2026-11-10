import { spawnSync } from 'node:child_process';
import seedrandom from 'seedrandom';
import jsfxr, { sfxr } from 'jsfxr';

// ZzFX creates its browser playback context on import. We only use its PCM generator.
let zzfx;
const needsStub = typeof globalThis.AudioContext === 'undefined';
if (needsStub) globalThis.AudioContext = class {};
try {
  ({ ZZFX: zzfx } = await import('zzfx'));
} finally {
  if (needsStub) delete globalThis.AudioContext;
}

const jsfxrPresets = new Set([
  'pickupCoin', 'laserShoot', 'explosion', 'powerUp', 'hitHurt', 'jump',
  'blipSelect', 'synth', 'tone', 'click', 'random',
]);
const zzfxPresets = {
  thump: [1, .12, 105, .005, .04, .45, 4, 1, -.12, 0, 0, 0, 0, .8],
  bell: [1, .045, 660, .008, .06, .52, 0, 1, 0, 0, 0, 0, 0, 0, .6],
  tap: [1, .12, 240, .003, .035, .18, 1, 2, -1],
};
const zzfxFields = [
  'volume', 'randomness', 'frequency', 'attack', 'sustain', 'release',
  'shape', 'shapeCurve', 'slide', 'deltaSlide', 'pitchJump', 'pitchJumpTime',
  'repeatTime', 'noise', 'modulation', 'bitCrush', 'delay', 'sustainVolume',
  'decay', 'tremolo', 'filter',
];
const sampleRate = 44100;

function synthesize(recipe, variant) {
  const originalRandom = Math.random;
  Math.random = seedrandom(JSON.stringify([recipe.seed, variant]));
  try {
    if (recipe.engine === 'jsfxr') {
      if (recipe.preset && !jsfxrPresets.has(recipe.preset)) throw new Error('Unknown jsfxr preset');
      if (recipe.params && (typeof recipe.params !== 'object' || Array.isArray(recipe.params))) {
        throw new Error('jsfxr params must be an object');
      }
      const settings = recipe.preset ? sfxr.generate(recipe.preset) : new jsfxr.Params();
      for (const [name, value] of Object.entries(recipe.params ?? {})) {
        if (!Object.hasOwn(settings, name) || (name !== 'oldParams' && !Number.isFinite(value))) {
          throw new Error('Invalid jsfxr parameter ' + name);
        }
        if (/^p_env_(attack|sustain|decay)$/.test(name) && (value < 0 || value > 2)) {
          throw new Error(name + ' must be between 0 and 2');
        }
        settings[name] = value;
      }
      return sfxr.toWave({ ...settings, sample_rate: sampleRate, sample_size: 16 }).buffer;
    }
    if (recipe.preset && !Object.hasOwn(zzfxPresets, recipe.preset)) throw new Error('Unknown ZzFX preset');
    const settings = [...(zzfxPresets[recipe.preset] ?? [])];
    for (const [name, value] of Object.entries(recipe.params ?? {})) {
      const index = Array.isArray(recipe.params) ? Number(name) : zzfxFields.indexOf(name);
      if (index < 0 || index >= zzfxFields.length || (value !== null && !Number.isFinite(value))) {
        throw new Error('Invalid ZzFX parameter ' + name);
      }
      if ([3, 4, 5, 16, 18].includes(index) && (value < 0 || value > 5)) {
        throw new Error(zzfxFields[index] + ' must be between 0 and 5 seconds');
      }
      settings[index] = value ?? undefined;
    }
    return zzfx.buildSamples(...settings);
  } finally {
    // Both engines synthesize synchronously, including jsfxr's internal noise.
    Math.random = originalRandom;
  }
}

export function wav(samples, gain = 1) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let index = 0; index < samples.length; index++) {
    if (!Number.isFinite(samples[index])) throw new Error('Synth returned an invalid sample');
    const sample = Math.round(samples[index] * gain * 32768);
    bytes.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), 44 + index * 2);
  }
  return bytes;
}

const ffmpeg = () => process.env.GT_FFMPEG || 'ffmpeg';
const runFfmpeg = (args, input) => {
  const result = spawnSync(ffmpeg(), args, { input, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (result.error) throw new Error('ffmpeg: ' + result.error.message);
  if (result.status !== 0) throw new Error('ffmpeg: ' + result.stderr.trim().split(/\r?\n/).slice(-3).join(' '));
  return result;
};
export const ffmpegVersion = () => runFfmpeg(['-version']).stdout.split(/\r?\n/)[0];

export function inspectAudio(fileOrBytes) {
  const input = Buffer.isBuffer(fileOrBytes) ? 'pipe:0' : fileOrBytes;
  // Pad only the loudness branch to one EBU measurement block for short effects.
  const graph = '[0:a:0]asplit[a][b];[a]apad=whole_dur=0.4,ebur128=peak=true[loud];' +
    '[b]astats,silencedetect=n=-50dB:d=0.03[raw]';
  const { stderr: log } = runFfmpeg([
    '-hide_banner', '-nostdin', '-nostats', '-i', input, '-filter_complex', graph,
    '-map', '[loud]', '-map', '[raw]', '-f', 'null', '-',
  ], input === 'pipe:0' ? fileOrBytes : undefined);
  const rate = Number(log.match(/Stream #0:[^\r\n]+Audio:[^\r\n]+?(\d+) Hz/)?.[1]);
  const sampleCount = Number(log.match(/Number of samples:\s*([\d.]+)/)?.[1]);
  const length = sampleCount / rate;
  const loudness = Number(log.match(/Integrated loudness:\s*I:\s*([-.\d]+) LUFS/)?.[1]);
  const peak = log.match(/True peak:\s*Peak:\s*(\S+) dBFS/)?.[1];
  const truePeak = peak === '-inf' ? null : Number(peak);
  if (!(length > 0) || !Number.isFinite(loudness) || (truePeak !== null && !Number.isFinite(truePeak))) {
    throw new Error('Could not read audio measurements');
  }
  const silence = Array.from(log.matchAll(/silence_start:\s*([\d.-]+)|silence_end:\s*([\d.-]+)/g));
  const startsAt = Number(silence[0]?.[1]);
  const endsAt = Number(silence.at(-1)?.[2]);
  const leading = Math.abs(startsAt) < 0.001 ? Number(silence[1]?.[2] ?? length) : 0;
  const trailing = Math.abs(endsAt - length) < 0.001 ? length - Number(silence.at(-2)?.[1] ?? 0) : 0;
  const stats = (label) => Array.from(log.matchAll(new RegExp(label + ':\\s*([-.\\d]+)', 'g')), (match) => Number(match[1]));
  return {
    log,
    metrics: {
      loudness, truePeak, length, leading, trailing,
      dc: Math.max(0, ...stats('DC offset').map(Math.abs)),
      clipping: stats('Peak level dB').some((value) => value >= -0.00001) ||
        (truePeak !== null && truePeak >= 0),
    },
  };
}

export function render(recipe, variant) {
  const samples = synthesize(recipe, variant);
  if (!samples.length) throw new Error('Synth produced no audio');
  let gain = recipe.gain;
  if (recipe.target_lufs !== undefined) {
    // Normalize from an unclipped reference so even a loud recipe can be turned down.
    const largest = samples.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0);
    const referenceGain = Math.min(gain, 0.95 / largest);
    const { loudness } = inspectAudio(wav(samples, referenceGain)).metrics;
    if (loudness <= -70) throw new Error('Sound is too quiet to normalize');
    gain = referenceGain * 10 ** ((recipe.target_lufs - loudness) / 20);
  }
  return wav(samples, gain);
}
