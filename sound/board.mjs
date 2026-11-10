import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { evidence, fileSha, findSounds, json, sha, writeJson } from './files.mjs';

const html = readFileSync(new URL('./board.html', import.meta.url));
const script = readFileSync(new URL('./board-ui.js', import.meta.url));
const styles = readFileSync(new URL('./board.css', import.meta.url));
const icon = readFileSync(new URL('./favicon.svg', import.meta.url));
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

export async function startBoard(root, files) {
  const token = randomUUID();
  const choicesFile = path.join(root, 'choices.json');
  const sounds = files.map((file) => ({
    file, id: path.relative(root, file).split(path.sep).join('/'), sha256: fileSha(file),
  }));
  const known = new Map(sounds.map((sound) => [sound.id, sound]));
  const readChoices = () => {
    if (!existsSync(choicesFile)) return {};
    const saved = json(choicesFile);
    if (saved.version !== 1 || !saved.choices || Array.isArray(saved.choices) || typeof saved.choices !== 'object') {
      throw new Error('Invalid choices.json');
    }
    return saved.choices;
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const host = '127.0.0.1:' + server.address().port;
      if (request.headers.host !== host) return sendJson(response, 403, { error: 'Use the local board URL' });
      if (request.method === 'GET' && request.url === '/') {
        return response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
      }
      if (request.method === 'GET' && request.url === '/board-ui.js') {
        return response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(script);
      }
      if (request.method === 'GET' && request.url === '/board.css') {
        return response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' }).end(styles);
      }
      if (request.method === 'GET' && request.url === '/favicon.svg') {
        return response.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(icon);
      }
      if (request.method === 'GET' && request.url === '/api/sounds') {
        const choices = readChoices();
        return sendJson(response, 200, {
          token, folder: path.basename(root),
          sounds: sounds.map(({ id, sha256 }, index) => ({
            id, url: '/wav/' + index, choice: choices[id]?.sha256 === sha256 ? choices[id] : null,
          })),
        });
      }
      const audioMatch = request.url.match(/^\/wav\/(\d+)$/);
      if (request.method === 'GET' && audioMatch) {
        const sound = sounds[Number(audioMatch[1])];
        if (!sound) return sendJson(response, 404, { error: 'Sound not found' });
        const bytes = readFileSync(sound.file);
        if (sha(bytes) !== sound.sha256) return sendJson(response, 409, { error: 'Sound changed. Restart the board.' });
        return serveWav(response, request, bytes);
      }
      if (request.method === 'POST' && request.url === '/api/choice') {
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
  return { server, url: 'http://127.0.0.1:' + server.address().port, choicesFile };
}

export async function board(input, open, args, start) {
  const root = path.resolve(input);
  const files = findSounds(root, { verifyLock: true });
  if (files === null) {
    console.log('STALE Sound hashes changed. Run chirp-smith make again.');
    console.log('Sounds: ' + root);
    return 3;
  }
  if (!files.length) throw new Error('No WAVs found');
  const stamp = evidence(root, 'board', args, { node: process.version, path: process.execPath }, files, start);
  const { url, choicesFile } = await startBoard(root, files);
  console.log('ChirpSmith: ' + url);
  console.log('Choices: ' + choicesFile);
  console.log('Evidence: ' + stamp);
  if (open && process.platform === 'win32') {
    const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', windowsHide: true });
    browser.on('error', () => console.error('Open the ChirpSmith URL in your browser.'));
    browser.unref();
  }
  return 0;
}
