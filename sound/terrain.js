/* ChirpSmith signal topography. Original WebGL2 / Canvas2D, no external assets.
 * The surface is a short-time Fourier transform of the decoded local WAV.
 * WebGL2 follows Brain Melt's signature-shader route; DPR capped at 1.75.
 */
const COLS = 80, ROWS = 48, FFT = 512;
export function spectrum(buffer) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const field = new Float32Array(COLS * ROWS);
  const upper = Math.min(20000, buffer.sampleRate / 2);
  for (let x = 0; x < COLS; x++) {
    for (const channel of channels) {
      const real = new Float64Array(FFT);
      const imag = new Float64Array(FFT);
      const start = Math.round(x / (COLS - 1) * Math.max(0, buffer.length - FFT));
      for (let i = 0; i < FFT; i++) {
        real[i] = channel[start + i] || 0;
        real[i] *= .5 - .5 * Math.cos(2 * Math.PI * i / (FFT - 1));
      }
      for (let i = 1, j = 0; i < FFT; i++) {
        let bit = FFT >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) [real[i], real[j]] = [real[j], real[i]];
      }
      for (let size = 2; size <= FFT; size *= 2) {
        for (let start = 0; start < FFT; start += size) {
          for (let k = 0; k < size / 2; k++) {
            const angle = -2 * Math.PI * k / size;
            const c = Math.cos(angle), s = Math.sin(angle), a = start + k, b = a + size / 2;
            const tr = c * real[b] - s * imag[b], ti = s * real[b] + c * imag[b];
            real[b] = real[a] - tr;
            imag[b] = imag[a] - ti;
            real[a] += tr;
            imag[a] += ti;
          }
        }
      }
      for (let y = 0; y < ROWS; y++) {
        const hz = 80 * (upper / 80) ** (y / (ROWS - 1));
        const bin = Math.min(FFT / 2 - 1, Math.max(1, Math.round(hz * FFT / buffer.sampleRate)));
        const magnitude = Math.hypot(real[bin], imag[bin]) * 4 / FFT;
        // Max across channels preserves energy in opposite-phase stereo.
        const energy = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(1e-6, magnitude)) + 72) / 72));
        field[y * COLS + x] = Math.max(field[y * COLS + x], energy);
      }
    }
  }
  return { field, upper };
}
export function createTerrain(canvas) {
  let dirty = true, lastPosition;
  let data, position = -1, gl, program, vertices, playUniform, wireUniform, count = 0, lineCount = 0;
  try { gl = canvas.getContext('webgl2', { alpha: true, antialias: true, powerPreference: 'low-power' }); } catch {}
  if (gl) {
    const shader = (type, source) => {
      const result = gl.createShader(type); gl.shaderSource(result, source); gl.compileShader(result);
      if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) throw new Error('Terrain shader unavailable');
      return result;
    };
    try {
      program = gl.createProgram();
      gl.attachShader(program, shader(gl.VERTEX_SHADER, `#version 300 es
      in vec3 a; out vec3 v;
      void main(){
        float depth = a.y;
        float perspective = 1.0 - depth * .26;
        float x = (a.x * 1.72 - .86 + depth * .22) * perspective;
        float y = -.85 + depth * 1.5 + a.z * .75;
        gl_Position = vec4(x,y,depth*.4-a.z*.12,1.); v = a;
      }`));
      gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float; in vec3 v; out vec4 color; uniform float play; uniform float wire;
      void main(){
        vec3 copper = vec3(1.,.62,.30), cyan = vec3(.35,.95,.85);
        vec3 base = mix(copper,cyan,smoothstep(.47,.69,v.y));
        float cursorLight = 1. - smoothstep(.001,.01,abs(v.x-play));
        float contour = 1.-smoothstep(.015,.07,abs(fract(v.z*9.)-.5));
        float light = .09 + v.z*.3 + wire*.55 + contour*.1;
        color = vec4(base*light + vec3(1.,.94,.75)*cursorLight*.95, 1.);
      }`));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Terrain program unavailable');
      playUniform = gl.getUniformLocation(program, 'play');
      wireUniform = gl.getUniformLocation(program, 'wire');
      vertices = gl.createBuffer();
      gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
      const location = gl.getAttribLocation(program, 'a');
      gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 0, 0);
    } catch {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      gl = null;
    }
  }
  // Context failures use a separate canvas so an already requested WebGL context cannot block 2D.
  let fallback;
  if (!gl) {
    fallback = document.createElement('canvas'); fallback.className = canvas.className;
    fallback.setAttribute('aria-hidden', 'true'); canvas.after(fallback); canvas.hidden = true;
  }
  const target = fallback || canvas;
  const context2d = fallback?.getContext('2d');
  if (!gl && !context2d) {
    return { set: (analysis) => analysis.upper, render() {}, clear() {} };
  }
  target.dataset.renderer = gl ? 'webgl2' : 'canvas2d';
  function render(nextPosition = position) {
    position = nextPosition;
    if (!data) return;
    const rect = target.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 1.75);
    const w = Math.max(1, Math.round(rect.width * dpr)), h = Math.max(1, Math.round(rect.height * dpr));
    const resized = target.width !== w || target.height !== h;
    if (!dirty && !resized && position === lastPosition) return;
    if (resized) { target.width = w; target.height = h; }
    dirty = false;
    lastPosition = position;
    if (gl) {
      gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
      gl.useProgram(program); gl.uniform1f(playUniform, position);
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1,1);
      gl.uniform1f(wireUniform, 0); gl.drawArrays(gl.TRIANGLES, 0, count);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.uniform1f(wireUniform, 1); gl.drawArrays(gl.LINES, count, lineCount);
    } else {
      const ctx = context2d;
      ctx.clearRect(0, 0, w, h);
      for (let y = ROWS - 1; y >= 0; y--) {
        const depth = y / (ROWS - 1); ctx.beginPath();
        for (let x = 0; x < COLS; x++) {
          const height = data.field[y * COLS + x];
          const px = (((x / (COLS - 1) * 1.72 - .86 + depth * .22) * (1 - depth * .26)) + 1) / 2 * w;
          const py = (1 - (-.85 + depth * 1.5 + height * .75)) / 2 * h;
          if (x === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.strokeStyle = `hsla(${30 + depth * 140},85%,65%,.65)`; ctx.lineWidth = dpr * .65; ctx.stroke();
      }
    }
  }
  const resize = new ResizeObserver(() => render()); resize.observe(target);
  return {
    set(analysis) {
      data = analysis;
      position = -1;
      dirty = true;
      if (gl) {
        const vertex = (x,y) => [x / (COLS - 1), y / (ROWS - 1), data.field[y * COLS + x]];
        const array = [];
        // A depth-tested surface keeps individual ridges clear.
        for (let y = ROWS - 2; y >= 0; y--) {
          for (let x = 0; x < COLS - 1; x++) {
            array.push(
              ...vertex(x, y), ...vertex(x + 1, y), ...vertex(x, y + 1),
              ...vertex(x + 1, y), ...vertex(x + 1, y + 1), ...vertex(x, y + 1),
            );
          }
        }
        // The front skirt anchors energy ridges to the zero-energy plane.
        for (let x = 0; x < COLS - 1; x++) {
          const a = vertex(x,0), b = vertex(x+1,0), c = [a[0],0,0], d = [b[0],0,0];
          array.push(...a,...c,...b,...b,...c,...d);
        }
        count = array.length / 3;
        for (let y = 0; y < ROWS; y++) {
          for (let x = 0; x < COLS - 1; x++) array.push(...vertex(x, y), ...vertex(x + 1, y));
        }
        for (let x = 0; x <= 10; x++) array.push(x/10,0,0, x/10,1,0);
        for (let y = 0; y <= 6; y++) array.push(0,y/6,0, 1,y/6,0);
        lineCount = array.length / 3 - count;
        gl.bindBuffer(gl.ARRAY_BUFFER, vertices); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(array), gl.STATIC_DRAW);
      }
      target.dataset.ready = 'true'; render();
      return data.upper;
    },
    render,
    clear() {
      data = undefined;
      dirty = true;
      target.removeAttribute('data-ready');
      if (gl) gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      else context2d.clearRect(0, 0, target.width, target.height);
    },
  };
}
