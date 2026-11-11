import { createScope } from './scope.js';

const status = document.querySelector('#status');
const list = document.querySelector('#sounds');
const template = document.querySelector('#sound-row');
const scope = createScope();
const scopePanel = document.querySelector('.scope');
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--scope-clearance', scopePanel.offsetHeight + 24 + 'px');
}).observe(scopePanel);

if (window.visualViewport) {
  const fitKeyboard = () => {
    document.documentElement.toggleAttribute('data-keyboard-open',
      document.activeElement instanceof HTMLTextAreaElement && innerHeight - window.visualViewport.height > 120);
  };
  window.visualViewport.addEventListener('resize', fitKeyboard);
  document.addEventListener('focusin', fitKeyboard);
  document.addEventListener('focusout', () => requestAnimationFrame(fitKeyboard));
}
let scopedBadge;
const selectTake = (audio, title, badge) => {
  if (scopedBadge) scopedBadge.hidden = true;
  scopedBadge = badge;
  badge.hidden = false;
  scope(audio, title);
};

const loadVisibleAudio = new IntersectionObserver((entries) => {
  for (const { target, isIntersecting } of entries) {
    if (!isIntersecting) continue;
    target.preload = 'metadata';
    loadVisibleAudio.unobserve(target);
  }
});

if (new URLSearchParams(location.search).has('fps')) {
  import('./fps-chip.js').then(({ bmFpsChip }) => bmFpsChip());
}

try {
  const page = new URL(location.href);
  const requested = page.searchParams.get('board');
  const response = await fetch('/api/sounds' + (requested ? '?board=' + encodeURIComponent(requested) : ''));
  const { sounds, folder, context, token, error, board, boards } = await response.json();
  if (!response.ok) throw new Error(error);
  const choiceUrl = '/api/choice' + (boards.length > 1 ? '?board=' + encodeURIComponent(board) : '');
  const flushNotes = [];
  if (boards.length > 1) {
    const select = document.querySelector('#board-select');
    const repeated = new Set(boards.filter(({ game }, index) =>
      boards.findIndex((other) => other.game === game) !== index).map(({ game }) => game));
    for (const { id, game, revision } of boards) {
      select.add(new Option(repeated.has(game) && revision ? game + ' · ' + revision : game, id));
    }
    select.value = board;
    document.querySelector('#board-picker').hidden = false;
    select.addEventListener('change', async () => {
      const next = select.value;
      select.disabled = true;
      if ((await Promise.all(flushNotes.map((flush) => flush()))).every(Boolean)) {
        page.searchParams.set('board', next);
        location.assign(page.href);
      } else {
        select.value = board;
        select.disabled = false;
        status.textContent = 'A choice could not be saved. Edit the note or choice and try again.';
        status.scrollIntoView({ block: 'center' });
      }
    });
  }
  const { game, revision, task, set } = context;
  document.title = game + ' · ' + (revision ?? 'Sound set ' + set) + ' · ChirpSmith';
  document.querySelector('#game').textContent = game;
  const details = {
    revision: revision ?? 'Unavailable',
    task,
    'board-detail': set + (folder === game ? '' : ' / ' + folder),
  };
  for (const [id, value] of Object.entries(details)) {
    const element = document.getElementById(id);
    element.querySelector('strong').textContent = value ?? '';
    element.hidden = !value;
  }
  status.textContent = sounds.length + ' sounds. Choices save to this folder.';
  const review = document.querySelector('#review');
  const track = document.querySelector('#review-track');
  const totals = { keep: 0, redo: 0 };
  function updateReview() {
    const remaining = sounds.length - totals.keep - totals.redo;
    document.querySelector('#remaining').textContent = remaining;
    document.querySelector('#kept').textContent = totals.keep;
    document.querySelector('#redos').textContent = totals.redo;
    track.style.setProperty('--remaining', remaining);
    track.style.setProperty('--kept', totals.keep);
    track.style.setProperty('--redos', totals.redo);
  }
  for (const [index, sound] of sounds.entries()) {
    const row = template.content.cloneNode(true);
    const card = row.querySelector('.sound');
    const state = row.querySelector('.take-state');
    const badge = row.querySelector('.take-on-scope');
    const length = row.querySelector('.take-length');
    row.querySelector('.take-number').textContent = 'TAKE ' + String(index + 1).padStart(2, '0');
    const title = row.querySelector('h3');
    title.textContent = sound.id.split('/').at(-1).replace(/\.wav$/i, '').replaceAll('-', ' ');
    const audio = row.querySelector('audio');
    audio.src = sound.url;
    audio.setAttribute('aria-label', 'Play ' + title.textContent);
    audio.addEventListener('loadedmetadata', () => {
      if (!Number.isFinite(audio.duration)) return;
      length.textContent = audio.duration.toFixed(2) + ' s';
      audio.classList.toggle('subsecond', audio.duration < 1);
    });
    audio.addEventListener('play', () => {
      for (const other of list.querySelectorAll('audio')) if (other !== audio) other.pause();
      card.classList.add('is-playing');
      selectTake(audio, title.textContent, badge);
    });
    row.querySelector('.show-scope').addEventListener('click', () => {
      for (const other of list.querySelectorAll('audio')) if (other !== audio) other.pause();
      selectTake(audio, title.textContent, badge);
    });
    for (const event of ['pause', 'ended', 'error']) {
      audio.addEventListener(event, () => card.classList.remove('is-playing'));
    }
    audio.addEventListener('error', () => { status.textContent = 'Could not play ' + title.textContent + '. Reopen the board if the file changed.'; });
    const note = row.querySelector('textarea');
    note.value = sound.choice?.note ?? '';
    const buttons = [...row.querySelectorAll('[data-decision]')];
    let decision = sound.choice?.decision ?? null;
    if (decision) totals[decision]++;
    let pending = Promise.resolve(true);
    let noteEdited = false;
    const highlight = () => {
      for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.decision === decision));
      card.dataset.state = decision ?? 'open';
      state.textContent = decision === 'keep' ? 'Kept' : decision === 'redo' ? 'Needs redo' : 'Unreviewed';
    };
    const save = () => {
      noteEdited = false;
      const body = JSON.stringify({ id: sound.id, decision, note: note.value });
      pending = pending.then(async () => {
        const response = await fetch(choiceUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Board-Token': token }, body,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        status.textContent = 'Saved ' + title.textContent + '.';
        return true;
      }).catch((error) => {
        status.textContent = error.message;
        return false;
      });
    };
    for (const button of buttons) {
      button.addEventListener('click', () => {
        if (decision) totals[decision]--;
        decision = decision === button.dataset.decision ? null : button.dataset.decision;
        if (decision) totals[decision]++;
        highlight();
        updateReview();
        save();
      });
    }
    let timer;
    note.addEventListener('input', () => {
      noteEdited = true;
      clearTimeout(timer);
      timer = setTimeout(save, 300);
    });
    note.addEventListener('blur', () => {
      clearTimeout(timer);
      if (noteEdited) save();
    });
    flushNotes.push(() => {
      clearTimeout(timer);
      if (noteEdited) save();
      return pending;
    });
    highlight();
    list.append(row);
    loadVisibleAudio.observe(audio);
    if (index === 0) selectTake(audio, title.textContent, badge);
  }
  updateReview();
  review.hidden = false;
} catch (error) {
  status.textContent = error.message;
}
