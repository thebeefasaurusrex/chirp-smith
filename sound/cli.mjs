import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ffmpegVersion, inspectAudio, render } from './audio.mjs';
import { auditionContext, evidence, fileSha, findSounds, json, sha, writeAtomic, writeJson } from './files.mjs';
import { board } from './board.mjs';

const defaults = {
  min_lufs: -34, max_true_peak: -1, min_seconds: 0.035, max_seconds: 3,
  max_leading_seconds: 0.12, max_trailing_seconds: 0.2, max_dc: 0.035,
};

function recipeFile(file) {
  const definition = json(file);
  const sounds = Array.isArray(definition) ? definition : definition.sounds;
  if (!Array.isArray(sounds) || sounds.length === 0) throw new Error('Expected a nonempty sounds array');
  const ids = new Set();
  for (const sound of sounds) {
    if (!sound || typeof sound.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(sound.id) || ids.has(sound.id)) {
      throw new Error('Each sound needs a unique lowercase id');
    }
    ids.add(sound.id);
    if (!['jsfxr', 'zzfx'].includes(sound.engine) || !['string', 'number'].includes(typeof sound.seed) ||
        !Number.isInteger(sound.variants) || sound.variants < 1 || sound.variants > 32 ||
        !Number.isFinite(sound.gain) || sound.gain < 0 || sound.gain > 16 ||
        (sound.target_lufs !== undefined && (!Number.isFinite(sound.target_lufs) || sound.target_lufs < -60 || sound.target_lufs > 0)) ||
        (sound.preset !== undefined && typeof sound.preset !== 'string') ||
        (sound.params !== undefined && (!sound.params || typeof sound.params !== 'object')) ||
        (sound.preset === undefined && sound.params === undefined)) {
      throw new Error('Invalid recipe for ' + sound.id + '. Supply engine, preset or params, seed, variants and gain.');
    }
  }
  return { definition, sounds };
}

function make(input, args, start, labels) {
  const file = path.resolve(input);
  const root = path.dirname(file);
  const { sounds } = recipeFile(file);
  const audition = auditionContext(root, labels, { making: true });
  const generated = [];
  for (const sound of [...sounds].sort((a, b) => a.id < b.id ? -1 : 1)) {
    for (let variant = 1; variant <= sound.variants; variant++) {
      const relative = 'out/' + sound.id + '-' + variant + '.wav';
      try {
        generated.push({ relative, bytes: render(sound, variant) });
      } catch (error) {
        throw new Error(relative + ': ' + error.message);
      }
    }
  }
  mkdirSync(path.join(root, 'out'), { recursive: true });
  for (const { relative, bytes } of generated) writeAtomic(path.join(root, relative), bytes);
  const lock = path.join(root, 'sounds.lock.json');
  writeJson(lock, {
    version: 1, recipe: path.basename(file), recipeSha256: fileSha(file),
    sounds: generated.map(({ relative, bytes }) => ({ file: relative, sha256: sha(bytes) })),
    ...(Object.values(audition).some(Boolean) ? { audition } : {}),
  });
  const engine = {
    node: process.version, path: process.execPath, jsfxr: '1.4.1', zzfx: '1.4.0', seedrandom: '3.0.5',
    ...(sounds.some((sound) => sound.target_lufs !== undefined) ? { ffmpeg: ffmpegVersion() } : {}),
  };
  const output = evidence(root, 'make', args, engine, [file, lock], start,
    sounds.map(({ id, seed }) => ({ id, seed })));
  console.log('PASS Made ' + generated.length + ' WAVs');
  console.log('WAVs: ' + path.join(root, 'out'));
  console.log('Hashes: ' + lock);
  console.log('Evidence: ' + output);
  return 0;
}

function limitsAt(file) {
  const parent = path.dirname(file);
  const root = path.basename(parent) === 'out' ? path.dirname(parent) : parent;
  const recipe = path.join(root, 'sounds.json');
  const custom = existsSync(recipe) ? json(recipe).limits : null;
  for (const [name, value] of Object.entries(custom ?? {})) {
    if (!Object.hasOwn(defaults, name) || !Number.isFinite(value)) throw new Error('Invalid lint limit ' + name);
  }
  return { limits: { ...defaults, ...custom }, recipe: existsSync(recipe) ? recipe : null };
}

function lint(inputs, args, full, start) {
  const first = path.resolve(inputs[0]);
  const isFolder = inputs.length === 1 && statSync(first).isDirectory();
  const root = isFolder ? first : path.dirname(first);
  const files = isFolder ? findSounds(root, { verifyLock: true }) : [...new Set(inputs.map((file) => path.resolve(file)))].sort();
  if (files === null) {
    console.log('STALE Sound hashes changed. Run chirp-smith make again.');
    console.log('Sounds: ' + root);
    return 3;
  }
  if (!files.length) throw new Error('No WAVs found');
  if (files.some((file) => !/\.wav$/i.test(file) || !statSync(file).isFile())) throw new Error('Expected WAV files');
  const logs = [];
  const recipes = new Set();
  const results = files.map((file) => {
    const { limits, recipe } = limitsAt(file);
    if (recipe) recipes.add(recipe);
    const { metrics, log } = inspectAudio(file);
    logs.push({ file: path.relative(root, file), log });
    const { loudness, truePeak, clipping, length, leading, trailing, dc } = metrics;
    const flags = [];
    if (clipping) flags.push('CLIP');
    if (truePeak !== null && truePeak > limits.max_true_peak) flags.push('PEAK');
    if (loudness < limits.min_lufs) flags.push('QUIET');
    if (length < limits.min_seconds || length > limits.max_seconds) flags.push('LENGTH');
    if (leading > limits.max_leading_seconds) flags.push('LEAD');
    if (trailing > limits.max_trailing_seconds) flags.push('TAIL');
    if (dc > limits.max_dc) flags.push('DC');
    return { file: path.relative(root, file), ...metrics, flags };
  });
  const output = evidence(root, 'lint', args, { ffmpeg: ffmpegVersion(), path: process.env.GT_FFMPEG || 'ffmpeg' },
    [...files, ...recipes], start);
  writeJson(path.join(output, 'lint.json'), results);
  writeAtomic(path.join(output, 'ffmpeg.log'), logs.map(({ file, log }) => '=== ' + file + ' ===\n' + log).join('\n'));
  const failed = results.filter(({ flags }) => flags.length).length;
  console.log((failed ? 'FAIL' : 'PASS') + ' ' + (results.length - failed) + '/' + results.length + ' WAVs passed');
  const ranked = full ? results : [...results].sort((a, b) => Number(Boolean(b.flags.length)) - Number(Boolean(a.flags.length)));
  for (const { file, loudness, truePeak, length, leading, trailing, dc, flags } of ranked.slice(0, full ? results.length : 13)) {
    console.log([file, loudness + ' LUFS', (truePeak ?? '-inf') + ' dBTP', Math.round(length * 1000) + 'ms',
      'lead/tail ' + Math.round(leading * 1000) + '/' + Math.round(trailing * 1000) + 'ms', 'DC ' + dc.toFixed(4),
      flags.join(',') || 'OK'].join(' | '));
  }
  console.log('Evidence' + (!full && results.length > 13 ? ' (all ' + results.length + ' WAVs)' : '') + ': ' + output);
  return failed ? 1 : 0;
}

export async function sfx(args) {
  const start = Date.now();
  const [command, ...rest] = args;
  if (command === 'make' || command === 'board') {
    const options = {
      game: { type: 'string' }, revision: { type: 'string' }, task: { type: 'string' },
      ...(command === 'board' ? { open: { type: 'boolean' } } : {}),
    };
    const { values: { open, ...labels }, positionals } = parseArgs({ args: rest, options, allowPositionals: true });
    for (const [key, value] of Object.entries(labels)) {
      labels[key] = value.trim();
      if (!labels[key]) throw new Error('--' + key + ' needs a nonempty value');
    }
    if (positionals.length === 1) {
      return command === 'make'
        ? make(positionals[0], args, start, labels)
        : board(positionals[0], open, args, start, labels);
    }
  }
  const inputs = rest.filter((arg) => !arg.startsWith('--'));
  const flags = rest.filter((arg) => arg.startsWith('--'));
  if (command === 'lint' && inputs.length && flags.every((flag) => flag === '--full')) {
    return lint(inputs, args, flags.includes('--full'), start);
  }
  console.log('Usage: chirp-smith make <sounds.json> | chirp-smith lint <folder|wav...> [--full] | chirp-smith board <folder> [--open]');
  console.log('Make and board accept [--game "Game title"] [--revision "Build or revision"] [--task "Source chat or task"]');
  return args.length && !['--help', '-h'].includes(command) ? 2 : 0;
}
