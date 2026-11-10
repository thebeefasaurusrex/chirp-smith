/* Brain Melt kit: fps-chip.js
 * Frames-per-second and graphics-chip readout. Use while building or checking device performance;
 * hide it on client sites (show it only with ?fps in the URL, see bmFpsWanted).
 *
 * Usage:
 *   if (bmFpsWanted()) bmFpsChip(document.body);           // adds a small fixed chip in the bottom right
 *   bmFpsChip(myEl, { inline: true });                      // or fill an element you placed yourself
 *
 * Note: headless Chrome reports a software chip (SwiftShader) and low fps. Real numbers only come from real devices.
 */
export const bmFpsWanted = () => /[?&]fps\b/.test(location.search);

export function bmGpuName() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
    if (!gl) return 'no WebGL';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    let name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    name = name.replace(/^ANGLE \(|\)$/g, '').split(',').slice(0, 2).join(',')
      .replace(/Direct3D.*$|\(0x[0-9a-f]+\)|Vulkan [\d.]+ ?/gi, '').replace(/\s+/g, ' ').trim();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name.slice(0, 48);
  } catch { return 'unknown'; }
}

export function bmFpsChip(host = document.body, { inline = false } = {}) {
  const chip = document.createElement('div');
  chip.setAttribute('role', 'status');
  chip.style.cssText = (inline ? '' : 'position:fixed;right:12px;bottom:12px;z-index:9999;') +
    'font:500 11px/1 ui-monospace,Consolas,monospace;padding:7px 10px;border-radius:99px;background:rgba(10,10,15,.88);color:#f4f1ea;border:1px solid rgba(255,255,255,.14);pointer-events:none';
  chip.textContent = '-- fps';
  host.appendChild(chip);
  const gpu = bmGpuName();
  let frames = 0, last = performance.now(), stopped = false;
  (function tick(t) {
    if (stopped) return;
    frames++;
    if (t - last >= 1000) {
      const fps = Math.round(frames * 1000 / (t - last));
      chip.textContent = `${fps} fps · ${gpu}`;
      chip.style.color = fps < 30 ? '#ff6b6b' : fps < 50 ? '#ffb020' : '#c8ff3d';
      frames = 0; last = t;
    }
    requestAnimationFrame(tick);
  })(performance.now());
  return { el: chip, stop() { stopped = true; chip.remove(); } };
}
