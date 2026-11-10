import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { wav } from '../sound/audio.mjs';
import { startBoard } from '../sound/board.mjs';
import { findSounds } from '../sound/files.mjs';

const cli = fileURLToPath(new URL('../bin/chirp-smith.mjs', import.meta.url));

function workspace(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'chirp-smith-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function sfx(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30_000 });
  if (result.error) throw result.error;
  return result;
}

function sine(amplitude, lead = 0, tail = 0) {
  return Array.from({ length: 26_460 + lead + tail }, (_, index) =>
    index < lead || index >= lead + 26_460 ? 0 : amplitude * Math.sin((index - lead) * Math.PI * 2 * 440 / 44100));
}

test('ChirpSmith keeps reproducible WAVs and pins the game, revision and source task', async (t) => {
  const project = workspace(t);
  writeFileSync(path.join(project, 'gt.json'), JSON.stringify({ name: 'Example Game' }));
  const directory = path.join(project, 'audition');
  mkdirSync(directory);
  const recipe = path.join(directory, 'sounds.json');
  const lock = path.join(directory, 'sounds.lock.json');
  writeFileSync(recipe, JSON.stringify({ sounds: [
    { id: 'boom', engine: 'jsfxr', preset: 'explosion', seed: 'a', variants: 2, gain: .35 },
    { id: 'tap', engine: 'zzfx', params: { frequency: 245, randomness: .2 }, seed: 4, variants: 2, gain: .4 },
  ] }));
  const make = () => {
    const result = sfx('make', recipe, '--revision', 'Build 12', '--task', 'Impact sound audition');
    assert.equal(result.status, 0, result.stderr);
    const bytes = readFileSync(lock);
    const audio = JSON.parse(bytes).sounds.map(({ file }) => readFileSync(path.join(directory, file)));
    return { bytes, audio };
  };
  const first = make();
  assert.notDeepEqual(first.audio[0], first.audio[1]);
  assert.notDeepEqual(first.audio[2], first.audio[3]);
  assert.deepEqual(first, make());
  const { server, url } = await startBoard(directory, findSounds(directory, { verifyLock: true }));
  try {
    const { context } = await fetch(url + '/api/sounds').then((response) => response.json());
    assert.match(context.set, /^[a-f0-9]{10}$/);
    assert.deepEqual(context, {
      game: 'Example Game', revision: 'Build 12', task: 'Impact sound audition', set: context.set,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const changed = path.join(directory, 'out', 'boom-1.wav');
  writeFileSync(changed, wav(sine(.2)));
  const stale = sfx('lint', directory);
  assert.equal(stale.status, 3, stale.stderr);
  assert.match(stale.stdout, /STALE/);
});

test('ChirpSmith lint flags clipping, quiet audio and 400 ms of leading silence', (t) => {
  const directory = workspace(t);
  const fixtures = {
    'good.wav': sine(.2), 'clip.wav': sine(1.5), 'quiet.wav': sine(.003),
    'late.wav': sine(.2, 17_640), 'tail.wav': sine(.2, 0, 17_640),
  };
  for (const [name, samples] of Object.entries(fixtures)) writeFileSync(path.join(directory, name), wav(samples));
  const result = sfx('lint', directory, '--full');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /clip\.wav[^\n]*CLIP/);
  assert.match(result.stdout, /quiet\.wav[^\n]*QUIET/);
  assert.match(result.stdout, /late\.wav[^\n]*400\/0ms[^\n]*LEAD/);
  assert.match(result.stdout, /tail\.wav[^\n]*0\/400ms[^\n]*TAIL/);
  assert.match(result.stdout, /good\.wav[^\n]*OK/);
});

test('ChirpSmith serves playable WAVs and reloads a choice from disk after restart', async (t) => {
  const directory = workspace(t);
  const file = path.join(directory, 'pick.wav');
  writeFileSync(file, wav(sine(.2)));
  const open = () => startBoard(directory, [file]);
  let running = await open();
  const close = () => new Promise((resolve, reject) => running.server.close((error) => error ? reject(error) : resolve()));
  try {
    const home = await fetch(running.url);
    const html = await home.text();
    assert.match(html, /<h1 id="game">/);
    const iconPath = html.match(/<link rel="icon" href="([^"]+)"/)?.[1];
    assert.ok(iconPath);
    const icon = await fetch(running.url + iconPath);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
    assert.match(await icon.text(), /^<svg /);
    const { token, context, sounds: [sound] } = await fetch(running.url + '/api/sounds').then((response) => response.json());
    assert.equal(context.game, path.basename(directory));
    assert.equal(context.revision, undefined);
    assert.equal(context.task, undefined);
    assert.equal(sound.choice, null);
    const sample = await fetch(running.url + sound.url, { headers: { Range: 'bytes=0-3' } });
    assert.equal(sample.status, 206);
    assert.equal(await sample.text(), 'RIFF');
    const body = JSON.stringify({ id: sound.id, decision: 'keep', note: 'Keep the low end 🎵' });
    const post = await fetch(running.url + '/api/choice', {
      method: 'POST',
      headers: { Origin: running.url, 'X-Board-Token': token, 'Content-Type': 'application/json' }, body,
    });
    assert.equal(post.status, 200, await post.text());
    const { choices } = JSON.parse(readFileSync(running.choicesFile, 'utf8'));
    assert.equal(choices['pick.wav'].note, 'Keep the low end 🎵');
    await close();
    running = await open();
    const { context: reopenedContext, sounds } = await fetch(running.url + '/api/sounds').then((response) => response.json());
    assert.equal(reopenedContext.set, context.set);
    assert.equal(sounds[0].choice.decision, 'keep');
    assert.equal(sounds[0].choice.note, 'Keep the low end 🎵');
  } finally {
    if (running.server.listening) await close();
  }
});
