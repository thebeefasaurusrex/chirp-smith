import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { auditionContext, evidence, fileSha, findSounds, json, sha, writeJson } from './files.mjs';

const assets = new Map([
  ['/', 'board.html', 'text/html; charset=utf-8'],
  ['/board-ui.js', 'board-ui.js', 'text/javascript; charset=utf-8'],
  ['/board.css', 'board.css', 'text/css; charset=utf-8'],
  ['/scope.js', 'scope.js', 'text/javascript; charset=utf-8'],
  ['/terrain.js', 'terrain.js', 'text/javascript; charset=utf-8'],
  ['/fps-chip.js', 'fps-chip.js', 'text/javascript; charset=utf-8'],
  ['/favicon.svg', 'favicon.svg', 'image/svg+xml'],
  ['/fonts/saira-stencil-one-latin.woff2', 'fonts/saira-stencil-one-latin.woff2', 'font/woff2'],
  ['/fonts/chakra-petch-600-latin.woff2', 'fonts/chakra-petch-600-latin.woff2', 'font/woff2'],
].map(([route, file, type]) => [route, { type, bytes: readFileSync(new URL('./' + file, import.meta.url)) }]));
const sendJson = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

function serveWav(response, request, bytes) {
  const total = bytes.length;
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
    if (start >= total || end < start) {
      response.writeHead(416, { 'Content-Range': 'bytes */' + total }).end();
      return;
    }
    response.writeHead(206, {
      'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes',
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total, 'Content-Length': end + 1 - start,
    });
    response.end(bytes.subarray(start, end + 1));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': total }).end(bytes);
}

function soundSet({ id, root, files, labels }) {
  const choicesFile = path.join(root, 'choices.json');
  const sounds = files.map((file) => ({
    file, id: path.relative(root, file).split(path.sep).join('/'), sha256: fileSha(file),
  }));
  const folder = path.basename(root);
  const context = auditionContext(root, labels);
  const set = sha(JSON.stringify(sounds.map(({ id, sha256 }) => [id, sha256]))).slice(0, 10);
  const known = new Map(sounds.map((sound) => [sound.id, sound]));
  const readChoices = () => {
    if (!existsSync(choicesFile)) return {};
    const saved = json(choicesFile);
    if (saved.version !== 1 || !saved.choices || Array.isArray(saved.choices) || typeof saved.choices !== 'object') {
      throw new Error('Invalid choices.json');
    }
    return saved.choices;
  };
  return { id, choicesFile, folder, context: { ...context, game: context.game ?? folder, set }, sounds, known, readChoices };
}

export function startBoard(root, files, labels) {
  return startLibrary([{ id: 'default', root, files, labels }]);
}

export async function startLibrary(entries, initial = entries[0]?.id) {
  const token = randomUUID();
  const sets = new Map(entries.map((entry) => [entry.id, soundSet(entry)]));
  if (!sets.has(initial) || sets.size !== entries.length) throw new Error('Invalid sound library selection');
  const boards = [...sets.values()].map(({ id, context }) => ({ id, ...context }));
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const host = '127.0.0.1:' + server.address().port;
      if (request.headers.host !== host) return sendJson(response, 403, { error: 'Use the local board URL' });
      const url = new URL(request.url, 'http://' + host);
      const asset = assets.get(url.pathname);
      if (request.method === 'GET' && asset) {
        return response.writeHead(200, { 'Content-Type': asset.type }).end(asset.bytes);
      }
      const board = url.searchParams.get('board') ?? initial;
      const entry = sets.get(board);
      if (!entry) return sendJson(response, 404, { error: 'Sound board not found' });
      const { choicesFile, folder, context, sounds, known, readChoices } = entry;
      if (request.method === 'GET' && url.pathname === '/api/sounds') {
        const choices = readChoices();
        return sendJson(response, 200, {
          token, folder, context, board, boards,
          sounds: sounds.map(({ id, sha256 }, index) => ({
            id, url: '/wav/' + index + (sets.size > 1 ? '?board=' + encodeURIComponent(board) : ''),
            choice: choices[id]?.sha256 === sha256 ? choices[id] : null,
          })),
        });
      }
      const audioMatch = url.pathname.match(/^\/wav\/(\d+)$/);
      if (request.method === 'GET' && audioMatch) {
        const sound = sounds[Number(audioMatch[1])];
        if (!sound) return sendJson(response, 404, { error: 'Sound not found' });
        const bytes = readFileSync(sound.file);
        if (sha(bytes) !== sound.sha256) return sendJson(response, 409, { error: 'Sound changed. Restart the board.' });
        return serveWav(response, request, bytes);
      }
      if (request.method === 'POST' && url.pathname === '/api/choice') {
        if (request.headers.origin !== 'http://' + host || request.headers['x-board-token'] !== token) {
          return sendJson(response, 403, { error: 'Open the local board to save choices' });
        }
        request.setEncoding('utf8');
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 16_384) return sendJson(response, 413, { error: 'Note is too long' });
        }
        let choice;
        try {
          choice = JSON.parse(body);
        } catch {
          return sendJson(response, 400, { error: 'Choice must be JSON' });
        }
        const { id, decision, note } = choice ?? {};
        const sound = known.get(id);
        if (!sound || !['keep', 'redo', null].includes(decision) || typeof note !== 'string' || note.length > 2000) {
          return sendJson(response, 400, { error: 'Invalid choice' });
        }
        if (fileSha(sound.file) !== sound.sha256) return sendJson(response, 409, { error: 'Sound changed. Restart the board.' });
        const choices = { ...readChoices(), [id]: { sha256: sound.sha256, decision, note } };
        writeJson(choicesFile, { version: 1, choices });
        return sendJson(response, 200, { saved: true });
      }
      return sendJson(response, 404, { error: 'Page not found' });
    } catch (error) {
      return sendJson(response, 500, { error: 'Could not read or save this board: ' + error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, url: 'http://127.0.0.1:' + server.address().port, choicesFile: sets.get(initial).choicesFile };
}

export async function board(input, open, args, start, labels, library, initial) {
  let entries = [{ id: 'default', root: path.resolve(input ?? '.'), labels }];
  if (library) {
    const file = path.resolve(library);
    const saved = json(file);
    if (!Array.isArray(saved) || !saved.length) throw new Error('A sound library needs at least one board');
    entries = saved.map(({ id, folder, game, revision, task }) => {
      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id) || typeof folder !== 'string' || !folder.trim()) {
        throw new Error('Each library board needs a lowercase id and a sound folder');
      }
      return { id, root: path.resolve(path.dirname(file), folder), labels: { game, revision, task } };
    });
    const ids = new Set(entries.map(({ id }) => id));
    if (ids.size !== entries.length) throw new Error('Library board ids must be unique');
    if (initial && !ids.has(initial)) throw new Error('Unknown sound board: ' + initial);
  }
  for (const entry of entries) {
    entry.files = findSounds(entry.root, { verifyLock: true });
    if (entry.files === null) {
      console.log('STALE Sound hashes changed. Run chirp-smith make again.');
      console.log('Sounds: ' + entry.root);
      return 3;
    }
    if (!entry.files.length) throw new Error('No WAVs found in ' + entry.root);
  }
  const stamps = entries.map(({ root, files }) =>
    evidence(root, 'board', args, { node: process.version, path: process.execPath }, files, start));
  const { url, choicesFile } = await startLibrary(entries, initial);
  console.log('ChirpSmith: ' + url);
  if (entries.length === 1) {
    console.log('Choices: ' + choicesFile);
    console.log('Evidence: ' + stamps[0]);
  } else {
    console.log(entries.length + ' sound boards. Choices and evidence stay with each sound folder.');
  }
  if (open && process.platform === 'win32') {
    const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', windowsHide: true });
    browser.on('error', () => console.error('Open the ChirpSmith URL in your browser.'));
    browser.unref();
  }
  return 0;
}
