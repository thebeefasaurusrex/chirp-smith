import { createTerrain, spectrum } from './terrain.js';

const width = 600;
const center = 90;
const points = 240;

function envelope(buffer) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  const top = [];
  const bottom = [];
  for (let i = 0; i < points; i++) {
    const start = Math.floor(i * buffer.length / points);
    const end = Math.min(buffer.length, Math.max(start + 1, Math.floor((i + 1) * buffer.length / points)));
    let low = 0;
    let high = 0;
    for (const samples of channels) {
      for (let index = start; index < end; index++) {
        low = Math.min(low, samples[index]);
        high = Math.max(high, samples[index]);
      }
    }
    const x = (i * width / (points - 1)).toFixed(1);
    top.push(x + ' ' + (center - high * 82).toFixed(1));
    bottom.push(x + ' ' + (center - low * 82).toFixed(1));
  }
  return 'M' + [...top, ...bottom.reverse()].join('L') + 'Z';
}

export function createScope() {
  const wave = document.querySelector('#wave');
  const head = document.querySelector('#playhead');
  const name = document.querySelector('#scope-name');
  const time = document.querySelector('#scope-time');
  const ticks = [...document.querySelectorAll('#scope-scale span')].slice(1);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const previews = new WeakMap();
  const terrain = createTerrain(document.querySelector('.terrain'));
  const seek = document.querySelector('#scope-seek');
  const signalState = document.querySelector('#signal-state');
  const format = document.querySelector('#signal-format');
  seek.addEventListener('input', () => {
    if (audio && Number.isFinite(duration)) {
      audio.currentTime = Number(seek.value) / 1000 * duration;
      update();
    }
  });
  let audio;
  let duration;
  let frame;
  let visible = false;
  let request;

  function update() {
    cancelAnimationFrame(frame);
    if (!audio || !Number.isFinite(duration) || duration <= 0) return;
    const current = audio.currentTime;
    const position = Math.min(1, current / duration) * width;
    head.setAttribute('x1', position);
    head.setAttribute('x2', position);
    head.setAttribute('visibility', 'visible');
    seek.value = Math.round(position / width * 1000);
    seek.setAttribute('aria-valuetext', current.toFixed(2) + ' of ' + duration.toFixed(2) + ' seconds');
    signalState.textContent = audio.paused ? 'READY' : 'PLAYING';
    wave.closest('.scope').classList.toggle('signal-playing', !audio.paused);
    if (visible && !document.hidden) terrain.render(reduced.matches ? -1 : position / width);
    time.textContent = current.toFixed(2) + ' / ' + duration.toFixed(2) + ' s';
    if (!audio.paused && visible && !document.hidden && !reduced.matches) frame = requestAnimationFrame(update);
  }

  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    update();
  });
  observer.observe(wave.closest('figure'));
  document.addEventListener('visibilitychange', update);
  reduced.addEventListener('change', update);

  function draw(preview) {
    duration = preview.duration;
    seek.disabled = false;
    const upper = terrain.set(preview.terrain);
    document.querySelector('#spectrum-range').textContent = '80 Hz · ' + (upper / 1000).toFixed(0) + ' kHz';
    format.textContent = '512 FFT / ' + preview.channels;
    wave.setAttribute('d', preview.path);
    for (const [index, tick] of ticks.entries()) {
      tick.textContent = (duration * (index + 1) / ticks.length).toFixed(2);
    }
    update();
  }

  async function select(player, title) {
    if (audio === player) return update();
    if (audio) {
      for (const event of ['timeupdate', 'pause', 'ended', 'seeking']) audio.removeEventListener(event, update);
    }
    audio = player;
    for (const event of ['timeupdate', 'pause', 'ended', 'seeking']) audio.addEventListener(event, update);
    request?.abort();
    duration = undefined;
    seek.disabled = true;
    seek.value = 0;
    signalState.textContent = 'READING';
    format.textContent = 'Reading WAV…';
    terrain.clear();
    cancelAnimationFrame(frame);
    wave.setAttribute('d', 'M0 90H600');
    for (const tick of ticks) tick.textContent = '';
    head.setAttribute('visibility', 'hidden');
    name.textContent = title;
    time.textContent = 'Reading signal…';
    const cached = previews.get(player);
    if (cached) return draw(cached);
    const controller = new AbortController();
    request = controller;
    try {
      const response = await fetch(player.src, { signal: controller.signal });
      if (!response.ok) throw new Error('Waveform unavailable');
      const data = await response.arrayBuffer();
      const decoder = new OfflineAudioContext(1, 1, 44100);
      const buffer = await decoder.decodeAudioData(data);
      if (controller.signal.aborted) return;
      const preview = {
        path: envelope(buffer), duration: buffer.duration, terrain: spectrum(buffer),
        channels: buffer.numberOfChannels === 1 ? 'MONO' : buffer.numberOfChannels + ' CH',
      };
      previews.set(player, preview);
      draw(preview);
    } catch {
      if (!controller.signal.aborted) {
        time.textContent = 'Waveform unavailable';
        signalState.textContent = 'UNAVAILABLE';
        format.textContent = 'Native playback available';
      }
    }
  }

  return select;
}
