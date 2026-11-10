import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const fileSha = (file) => sha(readFileSync(file));
export const json = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

export function writeAtomic(file, bytes) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, bytes);
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function writeJson(file, data) {
  writeAtomic(file, JSON.stringify(data, null, 2) + '\n');
}

export function findSounds(input, { verifyLock = false } = {}) {
  const root = path.resolve(input);
  if (!statSync(root).isDirectory()) throw new Error('Expected a sound folder');
  const lock = path.join(root, 'sounds.lock.json');
  if (verifyLock && existsSync(lock)) {
    try {
      const saved = json(lock);
      if (saved.version !== 1 || path.basename(saved.recipe) !== saved.recipe ||
          !Array.isArray(saved.sounds) || saved.recipeSha256 !== fileSha(path.join(root, saved.recipe))) return null;
      for (const item of saved.sounds) {
        if (!/^out\/[a-z0-9_-]+-\d+\.wav$/.test(item.file) ||
            fileSha(path.join(root, item.file)) !== item.sha256) return null;
      }
      return saved.sounds.map(({ file }) => path.join(root, file));
    } catch {
      return null;
    }
  }
  return [root, path.join(root, 'out')].filter(existsSync).flatMap((directory) =>
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.wav$/i.test(entry.name))
      .map((entry) => path.join(directory, entry.name)).sort());
}

function git(root, ...args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

export function auditionContext(root, labels = {}, { making = false } = {}) {
  const lock = path.join(root, 'sounds.lock.json');
  const saved = !making && existsSync(lock) ? json(lock).audition : null;
  const gitRoot = git(root, 'rev-parse', '--show-toplevel');
  let game;
  for (let directory = root; ; directory = path.dirname(directory)) {
    const config = path.join(directory, 'gt.json');
    if (existsSync(config)) {
      try {
        const name = json(config).name;
        if (typeof name === 'string') game = name.trim() || undefined;
      } catch {
        // Project configuration is optional for sound commands.
      }
      break;
    }
    if (path.dirname(directory) === directory) break;
  }
  return {
    game: labels.game ?? saved?.game ?? game ?? (gitRoot ? path.basename(gitRoot) : undefined),
    revision: labels.revision ?? saved?.revision ?? (making ? git(root, 'rev-parse', '--short=10', 'HEAD') ?? undefined : undefined),
    task: labels.task ?? saved?.task,
  };
}

export function evidence(root, command, args, engine, sources, start, seed = null) {
  const directory = path.join(root, '.gt', 'sfx', command);
  mkdirSync(directory, { recursive: true });
  const commit = git(root, 'rev-parse', 'HEAD');
  writeJson(path.join(directory, 'stamp.json'), {
    tool: '0.1.0', git: commit ? { commit, dirty: Boolean(git(root, 'status', '--porcelain')) } : null,
    sources: sources.map((file) => ({ file: path.relative(root, file), sha256: fileSha(file) })),
    engine, renderer: null, device: null, seed, args, wallMs: Date.now() - start,
  });
  return directory;
}
