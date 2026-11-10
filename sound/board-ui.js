const status = document.querySelector('#status');
const list = document.querySelector('#sounds');
const template = document.querySelector('#sound-row');

try {
  const response = await fetch('/api/sounds');
  const { sounds, folder, context, token, error } = await response.json();
  if (!response.ok) throw new Error(error);
  const { game, revision, task, set } = context;
  document.title = game + ' · ' + (revision ?? 'Sound set ' + set) + ' · ChirpSmith';
  document.querySelector('#game').textContent = game;
  const details = {
    revision: revision ? 'Game revision ' + revision : 'Game revision unavailable',
    task: task && 'Source task · ' + task,
    'board-detail': 'Sound set ' + set + (folder === game ? '' : ' · ' + folder),
  };
  for (const [id, value] of Object.entries(details)) {
    const element = document.getElementById(id);
    element.textContent = value ?? '';
    element.hidden = !value;
  }
  status.textContent = sounds.length + ' sounds. Choices save to this folder.';
  for (const sound of sounds) {
    const row = template.content.cloneNode(true);
    const title = row.querySelector('h2');
    title.textContent = sound.id.split('/').at(-1).replace(/\.wav$/i, '').replaceAll('-', ' ');
    const audio = row.querySelector('audio');
    audio.src = sound.url;
    audio.setAttribute('aria-label', 'Play ' + title.textContent);
    audio.addEventListener('play', () => {
      for (const other of list.querySelectorAll('audio')) if (other !== audio) other.pause();
    });
    audio.addEventListener('error', () => { status.textContent = 'Could not play ' + title.textContent + '. Reopen the board if the file changed.'; });
    const note = row.querySelector('textarea');
    note.value = sound.choice?.note ?? '';
    const buttons = [...row.querySelectorAll('button')];
    let decision = sound.choice?.decision ?? null;
    let pending = Promise.resolve();
    let noteEdited = false;
    const highlight = () => {
      for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.decision === decision));
    };
    const save = () => {
      noteEdited = false;
      const body = JSON.stringify({ id: sound.id, decision, note: note.value });
      pending = pending.then(async () => {
        const response = await fetch('/api/choice', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Board-Token': token }, body,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        status.textContent = 'Saved ' + title.textContent + '.';
      }).catch((error) => { status.textContent = error.message; });
    };
    for (const button of buttons) {
      button.addEventListener('click', () => {
        decision = decision === button.dataset.decision ? null : button.dataset.decision;
        highlight();
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
    highlight();
    list.append(row);
  }
} catch (error) {
  status.textContent = error.message;
}
