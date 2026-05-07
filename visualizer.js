/* ============================================================================
 * Spectrogram Path Visualizer
 * ----------------------------------------------------------------------------
 * Real-time audio visualization. Audio drives wedge bars, envelope silhouettes,
 * and event-based pulses laid out along five distinct geometric paths. Each
 * path has a characterized profile (default settings + a path-specific pulse
 * detector) that gives it a distinct visual identity.
 *
 * Architecture overview:
 *   - WebAudio AnalyserNode does the FFT (frequencyBinCount = 1024 bins).
 *   - Each frame: pull frequency data, update envelope, run path-specific
 *     detector, draw rest path + bars + envelope + pulses + path-specific
 *     pulse animation.
 *   - Geometry is recomputed on resize and cached per-path; pointAt() reads
 *     from the cache rather than recomputing per sample.
 *
 * Path / detector / pulse mapping:
 *   line      -> diagnostic broadband readout (no detector, no pulses)
 *   circle    -> highs (treble flux). Pulses expand radially outward.
 *   polygon   -> kick (log-mel onset on bass band). Pulses collapse inward.
 *   spiral    -> snare/hi-hat (log-mel onset on upper-mid band). Pulses are
 *                "tail flicks" — the spiral's outer end detaches and flies
 *                off along its tangent direction, with rotational momentum.
 *   lissajous -> bass register (note-level state machine, not pitch class).
 *                Pulses are "torus halos" — the figure's two lobes eject
 *                arcs perpendicular to its rotation axis when the bass
 *                changes register.
 * ============================================================================
 */

(function(){
  'use strict';

  // =========================================================================
  // DOM REFERENCES
  // =========================================================================
  const canvas = document.getElementById('viz');
  const wrap = document.getElementById('vizWrap');
  const resizeBadge = document.getElementById('resizeBadge');
  const ctx = canvas.getContext('2d');
  const status = document.getElementById('status');
  const meter = document.getElementById('meter');
  const playBtn = document.getElementById('playBtn');
  const loadBtn = document.getElementById('loadBtn');
  const demoBtn = document.getElementById('demoBtn');
  const fsBtn = document.getElementById('fsBtn');
  const fileInput = document.getElementById('fileInput');
  const pathSel = document.getElementById('pathSel');
  const trailChk = document.getElementById('trailChk');
  const envChk = document.getElementById('envChk');
  const pulseChk = document.getElementById('pulseChk');
  const sensSlider = document.getElementById('sensSlider');
  const barSlider = document.getElementById('barSlider');
  const reachSlider = document.getElementById('reachSlider');
  const gainSlider = document.getElementById('gainSlider');
  const mixSlider = document.getElementById('mixSlider');
  const gammaSlider = document.getElementById('gammaSlider');
  const morphSlider = document.getElementById('morphSlider');
  const advancedControls = document.getElementById('advancedControls');
  const settingsToggle = document.getElementById('settingsToggle');
  const resetBtn = document.getElementById('resetBtn');

  // =========================================================================
  // PER-PATH DEFAULT PROFILES
  // -------------------------------------------------------------------------
  // Each path has a complete characterized profile. Switching paths via the
  // selector applies that path's defaults to all controls. This is what makes
  // each path feel like its own visualization rather than one generic engine.
  //
  // Values were tuned by listening through reference tracks (progressive
  // house, specifically) and locking down what felt right.
  // =========================================================================
  const PATH_DEFAULTS = {
    line: {
      // Diagnostic spectrogram readout. No envelope/pulses — just bars.
      // High mix value (~0.95) = pure global normalization, smooth decay across bins.
      trail: false, envelope: false, pulses: false,
      sens: 1.0, bar: 0.55, reach: 0.30, gain: 1.0, mix: 0.95, curve: 0.45, morph: 0.6
    },
    circle: {
      // Sun/corona character. Slim bars, low reach, low sensitivity to make the
      // refractory period itself function as a metronome on busy treble.
      trail: false, envelope: true, pulses: true,
      sens: 0.4, bar: 0.15, reach: 0.15, gain: 0.7, mix: 0, curve: 0.4, morph: 0.6
    },
    lissajous: {
      // Form-level harmonic visualization. Trail accumulates the rotation
      // history into a 3D-ish funnel of past frames. Envelope on for the silhouette.
      trail: true, envelope: true, pulses: true,
      sens: 1.4, bar: 0.15, reach: 0.15, gain: 0.7, mix: 0, curve: 0.4, morph: 0.6
    },
    spiral: {
      // Trail-on turns the spiral into a glowing torus/donut as the spinning
      // path overwrites itself with bars in every angular position.
      trail: true, envelope: true, pulses: true,
      sens: 1.4, bar: 0.40, reach: 0.25, gain: 1.2, mix: 0, curve: 0.4, morph: 0.6
    },
    polygon: {
      // Aggressive heroic profile. Big bars extend far past the hex into
      // empty space. Envelope OFF — its silhouette polyline produces zigzag
      // artifacts at vertex transitions on this geometry.
      trail: false, envelope: false, pulses: true,
      sens: 1.4, bar: 0.45, reach: 0.40, gain: 1.5, mix: 0, curve: 0.4, morph: 0.6
    }
  };

  /** Apply a path's default profile to all controls. */
  function applyDefaults(pathName) {
    const d = PATH_DEFAULTS[pathName];
    if (!d) return;
    trailChk.checked = d.trail;
    envChk.checked = d.envelope;
    pulseChk.checked = d.pulses;
    sensSlider.value = d.sens;
    barSlider.value = d.bar;
    reachSlider.value = d.reach;
    gainSlider.value = d.gain;
    mixSlider.value = d.mix;
    gammaSlider.value = d.curve;
    morphSlider.value = d.morph;
  }

  // Path-switch resets controls to that path's profile
  pathSel.addEventListener('change', () => applyDefaults(pathSel.value));

  // Apply current path's defaults at boot
  applyDefaults(pathSel.value);

  // Settings panel toggle (collapsed by default)
  settingsToggle.addEventListener('click', () => {
    advancedControls.classList.toggle('visible');
  });

  // Reset button — re-apply current path's defaults
  resetBtn.addEventListener('click', () => applyDefaults(pathSel.value));

  // =========================================================================
  // AUDIO CONTEXT STATE
  // =========================================================================
  let audioCtx = null;
  let analyser = null;
  let currentNode = null;       // The currently playing source node
  let isPlaying = false;
  let buffer = null;            // Decoded audio buffer (when playing a file)
  let demoMode = false;         // True when using the demo oscillator instead

  const FFT = 2048;             // FFT size — gives ~21.5Hz/bin at 44.1kHz
  let freqData = null;          // Uint8Array, current frame's frequency data
  let timeData = null;          // Uint8Array, current frame's time-domain data
  let prevFreqData = null;      // Previous frame's frequency data (for flux/onset)
  let t0 = performance.now();   // Start time, used for time-based phase shifts

  // =========================================================================
  // CANVAS / GEOMETRY STATE
  // =========================================================================
  let W = 680, H = 420;         // Canvas dimensions in CSS pixels
  let minDim = 420;             // min(W, H) — drives geometry scaling
  let dpr = 1;                  // Device pixel ratio (capped per resolution)
  let isResizing = false;       // Pause rendering during resize storms
  let resizeTimer = null;
  const RESIZE_DEBOUNCE_MS = 150;

  // Reference dimensions used to scale wedge counts and DPR caps
  const REF_PIXELS = 680 * 420;
  const REF_MIN = 420;
  const REF_WEDGES = 360;       // Reference wedge count at REF_MIN
  const MIN_WEDGES = 120;       // Hard minimum (small embeds)
  const MAX_WEDGES = 480;       // Hard maximum (large screens)
  let nWedges = REF_WEDGES;     // Current number of wedges, set in applySize()

  // =========================================================================
  // DETECTOR PARAMETERS
  // -------------------------------------------------------------------------
  // Each detector targets a specific FFT bin range and uses log-mel onset
  // strength (librosa-style): sum of half-wave-rectified positive deltas in
  // log magnitude across the band. Peak-pick by requiring current frame to
  // exceed both the running mean × sensitivity AND the local maximum over
  // the last few frames.
  // =========================================================================

  // KICK (polygon path): bins 2-14, ~43-301Hz. Low refractory floor catches
  // both kick fundamentals (60-80Hz) and the click extending up to ~300Hz.
  const KICK_FFT_LO = 2;
  const KICK_FFT_HI = 14;
  const ONSET_HISTORY_FRAMES = 30;
  const ABS_ONSET_FLOOR = 0.15;
  const PEAK_LOOKBACK_FRAMES = 3;

  // SNARE/HI-HAT (spiral path): bins 8-260, ~170Hz-5.5kHz. Catches snare
  // fundamentals, snare wire noise, and the bulk of hi-hat content.
  const SNARE_FFT_LO = 8;
  const SNARE_FFT_HI = 260;
  const SNARE_ONSET_HISTORY_FRAMES = 30;
  const SNARE_ABS_ONSET_FLOOR = 0.25;   // Higher than kick — upper-mid is busier
  const SNARE_PEAK_LOOKBACK_FRAMES = 3;
  const SNARE_REFRACTORY_MS = 90;       // Shorter — hi-hats can be 16th notes

  // HIGH (circle path): top 60% of bins, broadband treble. Uses flux against
  // a running energy average (different from the log-mel onset detectors above).
  const HIGH_BIN_FRAC_START = 0.4;
  const ABS_FLUX_FLOOR_HIGH = 0.015;

  // BASS REGISTER (lissajous path): bins 4-80, ~86Hz-1.7kHz. Tracks the
  // dominant local-peak prominence to find the bass synth's strongest harmonic.
  // Then quantizes to whole-tone register and applies a state machine with
  // hysteresis to filter wobble.
  const BASS_SEARCH_LO = 4;
  const BASS_SEARCH_HI = 80;
  const REGISTER_LOCK_FRAMES = 15;       // ~250ms a candidate must hold
  const HOLD_FRAME_CAP = 180;            // ~3sec — beyond this, figure stops growing
  const BASS_ENERGY_FLOOR = 0.5;         // Total bass-band energy required
  const PROMINENCE_FLOOR = 0.10;         // Peak must rise this much above neighbors
  const STABLE_FRAMES = 3;               // Peak bin must be ±1 stable for this long
  const REGISTER_QUANTUM_SEMITONES = 2;  // Whole-tone quantization (wobble filter)
  const MIN_REGISTER_JUMP = 1;           // Candidate must jump ≥ this many quanta
  const RECENT_REGISTERS_SIZE = 3;       // History to detect bounce-back oscillation
  const RECENT_REGISTER_FORGET_MS = 500; // Ignore register match within this window

  // =========================================================================
  // PATH GEOMETRY REGISTRY
  // -------------------------------------------------------------------------
  // Each path declares:
  //   closed: whether it closes back on itself (affects mel-band folding)
  //   outwardSign: +1 = bars extend away from path centroid, -1 = below
  //   geometry(W, H, m): pure function returning sized properties from canvas
  //
  // The sublinear sqrt(m * REF_MIN) factor: at REF_MIN=420 it equals 420,
  // so reference-size geometry is unchanged. At smaller sizes the result is
  // larger relative to minDim (so the shape doesn't disappear at small sizes);
  // at larger sizes it's smaller relative to minDim (so pulses have room to
  // expand outward without dominating the canvas).
  // =========================================================================
  const PATH_CFG = {
    line: {
      closed: false, outwardSign: -1,
      geometry: (W, H, m) => ({
        marginX: W * 0.08,
        spanX: W * 0.84
      })
    },
    circle: {
      closed: true, outwardSign: 1,
      geometry: (W, H, m) => {
        const k = Math.sqrt(m * REF_MIN) * 0.30;
        return { radius: Math.max(60, Math.min(m * 0.35, k)) };
      }
    },
    lissajous: {
      closed: true, outwardSign: 1,
      geometry: (W, H, m) => {
        const k = Math.sqrt(m * REF_MIN);
        return {
          baseAx: Math.max(120, Math.min(m * 0.55, k * 0.50)),
          baseAy: Math.max(70,  Math.min(m * 0.32, k * 0.28))
        };
      }
    },
    spiral: {
      closed: false, outwardSign: 1,
      geometry: (W, H, m) => {
        const k = Math.sqrt(m * REF_MIN);
        const rMax = Math.max(80, Math.min(m * 0.40, k * 0.36));
        return { rMin: rMax * 0.20, rMax: rMax, turns: 3 };
      }
    },
    polygon: {
      closed: true, outwardSign: 1,
      geometry: (W, H, m) => {
        const k = Math.sqrt(m * REF_MIN);
        return {
          radius: Math.max(70, Math.min(m * 0.38, k * 0.34)),
          sides: 6
        };
      }
    }
  };

  // Cached geometry per path. Refreshed on resize.
  const geom = {};
  function recomputeGeometry() {
    for (const name in PATH_CFG) {
      geom[name] = PATH_CFG[name].geometry(W, H, minDim);
    }
  }

  // =========================================================================
  // DETECTOR / ANIMATION STATE
  // =========================================================================

  // Spiral rotation state — driven by avg envelope, decays to zero in silence
  let spiralAngle = 0;
  let spiralVel = 0;
  let avgEnv = 0;

  // Generic pulse system (used by circle/polygon)
  const MAX_PULSES = 6;
  const PULSE_DURATION = 1500;
  // Visual brightness multiplier applied to all pulse types (generic / torus /
  // tail) at render time. 1.0 = original behavior; >1 makes pulses brighter.
  // Applied to the alpha output, so values above 1 cause early-life alpha to
  // saturate at the canvas maximum, making pulses pop harder at peak moments.
  const PULSE_INTENSITY = 1.7;
  let pulses = [];

  // Refractory shared by circle high-flux detector and polygon kick detector
  const REFRACTORY_MS = 200;

  // Circle high-onset state
  const highState = { energyAvg: 0.1, fluxAvg: 0.005, lastTrigger: 0 };

  // Polygon kick onset history (ring buffer)
  const onsetHistory = new Float32Array(ONSET_HISTORY_FRAMES);
  let onsetHistoryIdx = 0;
  const kickState = { lastTrigger: 0 };

  // Spiral snare onset history (separate ring buffer + state)
  const snareOnsetHistory = new Float32Array(SNARE_ONSET_HISTORY_FRAMES);
  let snareOnsetHistoryIdx = 0;
  const snareState = { lastTrigger: 0 };

  // Spiral tail-flick pulses (snares fling fragments off the spiral's outer end)
  const TAIL_PULSE_DURATION = 700;
  const MAX_TAIL_PULSES = 8;
  let tailPulses = [];

  // Lissajous register state machine
  const recentBins = new Int32Array(STABLE_FRAMES);  // Recent peak-bin samples
  let recentBinsIdx = 0;
  let currentRegister = -1;          // Current locked register (-1 = silent)
  let currentRegisterAngle = 0;       // Smoothed rotation of the figure
  let candidateRegister = -1;         // Pending candidate awaiting lock
  let candidateFrames = 0;            // Frames the candidate has been stable
  let holdFrames = 0;                 // Frames current register has been held
  let registerSize = 0;               // 0..1, drives figure expansion
  let targetAngle = 0;                // Target rotation for the current register
  const recentCommittedRegisters = []; // Recent register history (bounce filter)

  // Lissajous register-change pulses (two halos eject through the figure's lobes)
  const TORUS_PULSE_DURATION = 900;
  const MAX_TORUS_PULSES = 4;
  let torusPulses = [];

  // =========================================================================
  // CANVAS SIZING & RESIZE HANDLING
  // -------------------------------------------------------------------------
  // Wedge count and DPR scale with canvas pixel area, so visual density stays
  // consistent across viewport sizes. Resize is debounced — render pauses
  // during a resize storm but audio analysis keeps running so envelope and
  // spiral velocity stay current.
  // =========================================================================
  function applySize(){
    const rect = wrap.getBoundingClientRect();
    W = rect.width;
    H = rect.height;
    minDim = Math.min(W, H);

    // Wedge count: more wedges at small sizes, fewer at large sizes.
    // sqrt scaling keeps visual density similar across resolutions.
    const pixelRatio = Math.sqrt(REF_PIXELS / (W * H));
    nWedges = Math.max(MIN_WEDGES, Math.min(MAX_WEDGES, Math.round(REF_WEDGES * pixelRatio)));

    // DPR cap: full DPR on small embeds, capped at large sizes for framerate.
    const nativeDpr = window.devicePixelRatio || 1;
    if (W * H < 1000 * 700) dpr = Math.min(nativeDpr, 2);
    else if (W * H < 2000 * 1200) dpr = Math.min(nativeDpr, 1.5);
    else dpr = 1;

    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    recomputeGeometry();
  }

  function onResize(){
    if (!isResizing) {
      isResizing = true;
      resizeBadge.classList.add('visible');
    }
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      applySize();
      isResizing = false;
      resizeBadge.classList.remove('visible');
      resizeTimer = null;
    }, RESIZE_DEBOUNCE_MS);
  }

  const ro = new ResizeObserver(onResize);
  ro.observe(wrap);
  window.addEventListener('resize', onResize);
  document.addEventListener('fullscreenchange', onResize);
  applySize();

  fsBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else wrap.requestFullscreen();
  };

  // =========================================================================
  // AUDIO SETUP & PLAYBACK
  // =========================================================================
  function ensureCtx(){
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = FFT;
      analyser.smoothingTimeConstant = 0.78;
      freqData = new Uint8Array(analyser.frequencyBinCount);
      prevFreqData = new Uint8Array(analyser.frequencyBinCount);
      timeData = new Uint8Array(analyser.fftSize);
      analyser.connect(audioCtx.destination);
    }
  }

  loadBtn.onclick = () => fileInput.click();

  fileInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    ensureCtx();
    status.textContent = 'Decoding ' + file.name + '...';
    try {
      const arr = await file.arrayBuffer();
      buffer = await audioCtx.decodeAudioData(arr);
      demoMode = false;
      playBtn.disabled = false;
      status.textContent = file.name + ' loaded (' + buffer.duration.toFixed(1) + 's). Press Play.';
    } catch (err) {
      status.textContent = 'Could not decode that file: ' + err.message;
    }
  };

  demoBtn.onclick = () => {
    ensureCtx();
    demoMode = true;
    buffer = null;
    playBtn.disabled = false;
    status.textContent = 'Demo tone ready. Press Play.';
  };

  /** Build the audio source — either a buffer player or the demo oscillators. */
  function startSource(){
    if (demoMode) {
      // Two oscillators with an LFO modulating one — gives some spectral motion
      // for testing the visualization without needing a real audio file.
      const osc1 = audioCtx.createOscillator();
      const osc2 = audioCtx.createOscillator();
      const lfo = audioCtx.createOscillator();
      const lfoGain = audioCtx.createGain();
      const mix = audioCtx.createGain();
      osc1.type = 'sawtooth'; osc1.frequency.value = 110;
      osc2.type = 'square'; osc2.frequency.value = 220;
      lfo.frequency.value = 0.5;
      lfoGain.gain.value = 80;
      lfo.connect(lfoGain).connect(osc2.frequency);
      mix.gain.value = 0.18;
      osc1.connect(mix); osc2.connect(mix);
      mix.connect(analyser);
      osc1.start(); osc2.start(); lfo.start();
      currentNode = { stop: () => { osc1.stop(); osc2.stop(); lfo.stop(); } };
    } else if (buffer) {
      const src = audioCtx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.connect(analyser);
      src.start();
      currentNode = src;
    }
  }

  playBtn.onclick = async () => {
    ensureCtx();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    if (isPlaying) {
      if (currentNode) currentNode.stop();
      currentNode = null;
      isPlaying = false;
      playBtn.textContent = 'Play';
    } else {
      startSource();
      isPlaying = true;
      playBtn.textContent = 'Stop';
    }
  };

  // =========================================================================
  // PITCH / NOTE / REGISTER UTILITIES
  // -------------------------------------------------------------------------
  // Used by the lissajous path's bass register tracker.
  // =========================================================================

  /** FFT bin index → MIDI note number (rounded). 440Hz = MIDI 69 = A4. */
  function binToMidiNote(bin) {
    const sr = audioCtx ? audioCtx.sampleRate : 44100;
    const freq = bin * sr / FFT;
    if (freq < 20) return -1;
    return Math.round(69 + 12 * Math.log2(freq / 440));
  }

  /** MIDI note → quantized register index (every REGISTER_QUANTUM_SEMITONES semitones). */
  function midiToRegister(midi) {
    if (midi < 0) return -1;
    return Math.floor(midi / REGISTER_QUANTUM_SEMITONES);
  }

  /** Quantized register → angle on a 24-position ring (covers ~3 octaves). */
  function registerToAngle(reg) {
    if (reg < 0) return 0;
    return ((reg % 18) / 18) * Math.PI * 2;
  }

  // =========================================================================
  // PATH SAMPLING — pointAt(name, t, time)
  // -------------------------------------------------------------------------
  // For parameter t in [0, 1], returns { x, y, nx, ny } for the path:
  //   x, y: position on the rest path
  //   nx, ny: outward unit normal at that point (for placing wedge bars)
  //
  // The lissajous path is dynamic: it morphs based on register state. The
  // spiral path is dynamic too: it rotates by spiralAngle. Other paths are
  // static.
  // =========================================================================
  function pointAt(name, t, time) {
    const cx = W/2, cy = H/2;
    const g = geom[name];

    if (name === 'line') {
      return { x: g.marginX + t * g.spanX, y: cy, nx: 0, ny: 1 };
    }

    if (name === 'circle') {
      const a = t * Math.PI * 2 - Math.PI/2;
      return {
        x: cx + Math.cos(a)*g.radius,
        y: cy + Math.sin(a)*g.radius,
        nx: Math.cos(a),
        ny: Math.sin(a)
      };
    }

    if (name === 'lissajous') {
      // The figure expands/contracts based on registerSize (driven by hold time)
      // and rotates to currentRegisterAngle (the rotation lerp target).
      const morph = parseFloat(morphSlider.value);
      const minScale = 1.0 - morph * 0.50;
      const maxScale = 1.0 + morph * 0.30;
      const sizeFactor = minScale + (maxScale - minScale) * Math.min(1, registerSize);
      const ax = g.baseAx * sizeFactor;
      const ay = g.baseAy * sizeFactor;
      const a = 3, b = 2, ph = time * 0.0003;
      const T = t * Math.PI * 2;
      // Raw figure-8, then rotated by currentRegisterAngle
      const rawX = Math.sin(a*T + ph) * ax;
      const rawY = Math.sin(b*T) * ay;
      const cosR = Math.cos(currentRegisterAngle), sinR = Math.sin(currentRegisterAngle);
      const x = cx + rawX * cosR - rawY * sinR;
      const y = cy + rawX * sinR + rawY * cosR;
      // Compute normal via finite difference, transformed by same rotation
      const dT = 0.001;
      const rawX2 = Math.sin(a*(T+dT) + ph) * ax;
      const rawY2 = Math.sin(b*(T+dT)) * ay;
      const x2 = cx + rawX2 * cosR - rawY2 * sinR;
      const y2 = cy + rawX2 * sinR + rawY2 * cosR;
      const dx = x2 - x, dy = y2 - y;
      const m = Math.hypot(dx, dy) || 1;
      let nx = -dy/m, ny = dx/m;
      // Flip normal if pointing toward centroid (we want it outward)
      const towardCentroid = (cx - x) * nx + (cy - y) * ny;
      if (towardCentroid > 0) { nx = -nx; ny = -ny; }
      return { x, y, nx, ny };
    }

    if (name === 'spiral') {
      const a = t * Math.PI * 2 * g.turns + spiralAngle;
      const r = g.rMin + t * (g.rMax - g.rMin);
      return {
        x: cx + Math.cos(a)*r,
        y: cy + Math.sin(a)*r,
        nx: Math.cos(a),
        ny: Math.sin(a)
      };
    }

    if (name === 'polygon') {
      // Walk around the polygon's perimeter. seg = current edge index + fraction.
      const seg = t * g.sides;
      const i2 = Math.floor(seg) % g.sides;
      const f = seg - Math.floor(seg);
      const a1 = (i2 / g.sides) * Math.PI * 2 - Math.PI/2;
      const a2 = ((i2+1) / g.sides) * Math.PI * 2 - Math.PI/2;
      const x1 = cx + Math.cos(a1)*g.radius, y1 = cy + Math.sin(a1)*g.radius;
      const x2 = cx + Math.cos(a2)*g.radius, y2 = cy + Math.sin(a2)*g.radius;
      const x = x1 + (x2-x1)*f, y = y1 + (y2-y1)*f;
      const dx = x2-x1, dy = y2-y1;
      const m = Math.hypot(dx,dy) || 1;
      let nx = -dy/m, ny = dx/m;
      const towardCentroid = (cx - x) * nx + (cy - y) * ny;
      if (towardCentroid > 0) { nx = -nx; ny = -ny; }
      return { x, y, nx, ny };
    }
  }

  /** Build a high-resolution polyline of the rest path for drawing. */
  function buildRestPath(name, time) {
    const RES = 360;
    const out = new Array(RES);
    for (let i = 0; i < RES; i++) {
      out[i] = pointAt(name, i / (RES - 1), time);
    }
    return out;
  }

  // =========================================================================
  // FREQUENCY → PATH BIN MAPPING (mel scale)
  // -------------------------------------------------------------------------
  // For parameter t in [0, 1] along the path, return the FFT bin index that
  // corresponds. Uses mel scale so low frequencies (where music lives) get
  // more path real estate than highs.
  //
  // Closed paths use folded mapping u = |2t-1|: u=1 at the seam (t=0 and t=1)
  // maps to high frequency, u=0 at the midpoint (t=0.5) maps to low frequency.
  // So bass occupies the central region of a closed path while treble meets
  // smoothly across the seam.
  // =========================================================================
  function binAt(t, isClosed, bins) {
    let u = isClosed ? Math.abs(2 * t - 1) : t;
    const sr = audioCtx ? audioCtx.sampleRate : 44100;
    const fMin = 40, fMax = Math.min(sr/2, 16000);
    const mMin = 2595 * Math.log10(1 + fMin/700);
    const mMax = 2595 * Math.log10(1 + fMax/700);
    const mel = mMin + u * (mMax - mMin);
    const f = 700 * (Math.pow(10, mel/2595) - 1);
    const bin = Math.round(f / (sr / FFT));
    return Math.max(0, Math.min(bins - 1, bin));
  }

  // =========================================================================
  // PER-BIN NORMALIZATION
  // -------------------------------------------------------------------------
  // Hybrid local + global ceiling. mix=0 is pure per-bin local normalization
  // (highs over-saturated). mix=1 is pure global ceiling (highs invisible).
  // Slow asymmetric tracking: ceiling rises fast, decays slow, prevents
  // threshold drift on sustained loud passages.
  // =========================================================================
  let binMax = null;
  let globalMax = 0.05;
  function normalizedBinValue(rawV, bin, mix) {
    if (!binMax) binMax = new Float32Array(freqData.length);
    binMax[bin] *= 0.995;
    if (rawV > binMax[bin]) binMax[bin] = rawV;
    if (rawV > globalMax) globalMax = rawV;
    globalMax *= 0.9995;
    const localCeiling = Math.max(binMax[bin], 0.05);
    const globalCeiling = Math.max(globalMax, 0.05);
    const ceiling = Math.pow(localCeiling, 1 - mix) * Math.pow(globalCeiling, mix);
    return rawV / ceiling;
  }

  /** Max-pool over the FFT bins covered by a slot, then normalize. */
  function wedgeValue(tStart, tEnd, isClosed, bins, mix) {
    const bStart = binAt(tStart, isClosed, bins);
    const bEnd   = binAt(tEnd,   isClosed, bins);
    const lo = Math.min(bStart, bEnd);
    const hi = Math.max(bStart, bEnd);
    let m = 0;
    for (let b = lo; b <= hi; b++) {
      const v = freqData[b] / 255;
      if (v > m) m = v;
    }
    const centerBin = (lo + hi) >> 1;
    return normalizedBinValue(m, centerBin, mix);
  }

  // =========================================================================
  // ENVELOPE TRACKING (RMS in time domain)
  // -------------------------------------------------------------------------
  // Used by spiral rotation (drives target velocity) and pulse intensity.
  // Asymmetric attack/release so peaks rise fast and decay slowly.
  // =========================================================================
  let envelope = 0;
  function updateEnvelope() {
    if (!timeData) return;
    analyser.getByteTimeDomainData(timeData);
    let sum = 0;
    for (let i = 0; i < timeData.length; i++) {
      const s = (timeData[i] - 128) / 128;
      sum += s * s;
    }
    const rms = Math.sqrt(sum / timeData.length);
    const target = Math.min(1, rms * 4);
    if (target > envelope) envelope += (target - envelope) * 0.4;   // fast attack
    else                   envelope += (target - envelope) * 0.04;  // slow decay
    avgEnv = avgEnv * 0.995 + envelope * 0.005;                      // long-term avg
  }

  // =========================================================================
  // ONSET STRENGTH FUNCTIONS (librosa-style)
  // -------------------------------------------------------------------------
  // Sum of half-wave-rectified positive deltas in log magnitude across a
  // band. log(1 + 10x) compresses dynamic range so the detector is robust
  // to overall loudness changes.
  // =========================================================================
  function computeKickOnsetStrength() {
    let strength = 0;
    for (let b = KICK_FFT_LO; b <= KICK_FFT_HI; b++) {
      const curr = Math.log(1 + freqData[b] / 255 * 10);
      const prev = Math.log(1 + prevFreqData[b] / 255 * 10);
      const delta = curr - prev;
      if (delta > 0) strength += delta;
    }
    return strength;
  }

  function computeSnareOnsetStrength() {
    let strength = 0;
    const hi = Math.min(SNARE_FFT_HI, freqData.length - 1);
    for (let b = SNARE_FFT_LO; b <= hi; b++) {
      const curr = Math.log(1 + freqData[b] / 255 * 10);
      const prev = Math.log(1 + prevFreqData[b] / 255 * 10);
      const delta = curr - prev;
      if (delta > 0) strength += delta;
    }
    return strength;
  }

  // Onset history utilities (parameterized so kick and snare share them)
  function onsetRunningMean(history, n) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += history[i];
    return sum / n;
  }

  function onsetRecentMax(history, idx, n, lookback) {
    let m = 0;
    for (let i = 1; i <= lookback; i++) {
      const j = (idx - i + n) % n;
      if (history[j] > m) m = history[j];
    }
    return m;
  }

  // =========================================================================
  // ONSET DETECTORS
  // -------------------------------------------------------------------------
  // Each fires when current onset strength exceeds BOTH the running mean ×
  // sensitivity AND the local maximum over the last few frames. The local-max
  // requirement is critical — without it, slow rises produce continuous fires.
  // =========================================================================

  function detectKick(now, sensitivity) {
    const strength = computeKickOnsetStrength();
    if (now - kickState.lastTrigger < REFRACTORY_MS) {
      onsetHistory[onsetHistoryIdx] = strength;
      onsetHistoryIdx = (onsetHistoryIdx + 1) % ONSET_HISTORY_FRAMES;
      return { strength, fired: false };
    }
    const mean = onsetRunningMean(onsetHistory, ONSET_HISTORY_FRAMES);
    const recentMax = onsetRecentMax(onsetHistory, onsetHistoryIdx, ONSET_HISTORY_FRAMES, PEAK_LOOKBACK_FRAMES);
    const threshold = Math.max(mean * sensitivity, ABS_ONSET_FLOOR);
    onsetHistory[onsetHistoryIdx] = strength;
    onsetHistoryIdx = (onsetHistoryIdx + 1) % ONSET_HISTORY_FRAMES;
    if (strength > threshold && strength > recentMax) {
      kickState.lastTrigger = now;
      return { strength, fired: true };
    }
    return { strength, fired: false };
  }

  function detectSnare(now, sensitivity) {
    const strength = computeSnareOnsetStrength();
    if (now - snareState.lastTrigger < SNARE_REFRACTORY_MS) {
      snareOnsetHistory[snareOnsetHistoryIdx] = strength;
      snareOnsetHistoryIdx = (snareOnsetHistoryIdx + 1) % SNARE_ONSET_HISTORY_FRAMES;
      return { strength, fired: false };
    }
    const mean = onsetRunningMean(snareOnsetHistory, SNARE_ONSET_HISTORY_FRAMES);
    const recentMax = onsetRecentMax(snareOnsetHistory, snareOnsetHistoryIdx, SNARE_ONSET_HISTORY_FRAMES, SNARE_PEAK_LOOKBACK_FRAMES);
    const threshold = Math.max(mean * sensitivity, SNARE_ABS_ONSET_FLOOR);
    snareOnsetHistory[snareOnsetHistoryIdx] = strength;
    snareOnsetHistoryIdx = (snareOnsetHistoryIdx + 1) % SNARE_ONSET_HISTORY_FRAMES;
    if (strength > threshold && strength > recentMax) {
      snareState.lastTrigger = now;
      return { strength, fired: true };
    }
    return { strength, fired: false };
  }

  /** Circle's high-band detector: flux against running average. */
  function detectHighOnset(state, energy, flux, sensitivity, now) {
    const eAlpha = energy > state.energyAvg ? 0.005 : 0.05;
    const fAlpha = flux   > state.fluxAvg   ? 0.005 : 0.05;
    state.energyAvg += (energy - state.energyAvg) * eAlpha;
    state.fluxAvg   += (flux   - state.fluxAvg)   * fAlpha;
    if (now - state.lastTrigger < REFRACTORY_MS) return false;
    const fluxThresh = Math.max(state.fluxAvg * sensitivity, ABS_FLUX_FLOOR_HIGH);
    if (flux > fluxThresh && energy > 0.1) {
      state.lastTrigger = now;
      return true;
    }
    return false;
  }

  // =========================================================================
  // BASS REGISTER TRACKING (lissajous path)
  // -------------------------------------------------------------------------
  // Multi-stage state machine that filters wobble from real register changes:
  //   1. Find the most prominent local peak in the bass band
  //   2. Stability gate: peak bin must be ±1 stable for STABLE_FRAMES
  //   3. Quantize MIDI note to whole-tone register
  //   4. Minimum-jump filter: candidate must differ from current by ≥ MIN_REGISTER_JUMP+1
  //   5. Recent-register memory: reject bounce-back to a recent register
  //   6. Lock duration: candidate must hold REGISTER_LOCK_FRAMES before committing
  // Result: detector fires on compositional-significant changes, not on
  // spectral noise within a held note.
  // =========================================================================

  /** Find the most prominent local peak in the bass search range. */
  function dominantBassPeak() {
    let totalEnergy = 0;
    for (let b = BASS_SEARCH_LO; b <= BASS_SEARCH_HI; b++) {
      totalEnergy += freqData[b] / 255;
    }
    if (totalEnergy < BASS_ENERGY_FLOOR) return -1;
    let bestBin = -1;
    let bestProminence = 0;
    for (let b = BASS_SEARCH_LO + 1; b < BASS_SEARCH_HI; b++) {
      const v = freqData[b] / 255;
      const left = freqData[b-1] / 255;
      const right = freqData[b+1] / 255;
      // Must be a local maximum (taller than both immediate neighbors)
      if (v <= left || v <= right) continue;
      // Prominence: how much taller than the average of nearby bins (skipping the peak itself)
      let neighborSum = 0, neighborCount = 0;
      for (let n = Math.max(0, b - 5); n <= Math.min(freqData.length - 1, b + 5); n++) {
        if (Math.abs(n - b) <= 1) continue;
        neighborSum += freqData[n] / 255;
        neighborCount++;
      }
      const neighborAvg = neighborCount > 0 ? neighborSum / neighborCount : 0;
      const prominence = v - neighborAvg;
      if (prominence > bestProminence) {
        bestProminence = prominence;
        bestBin = b;
      }
    }
    if (bestBin < 0 || bestProminence < PROMINENCE_FLOOR) return -1;
    return bestBin;
  }

  /** Returns median bin if recent N bins agree to within ±1, else -1. */
  function stableBin() {
    let valid = 0;
    let minB = 999, maxB = -1;
    for (let i = 0; i < STABLE_FRAMES; i++) {
      const b = recentBins[i];
      if (b < 0) continue;
      valid++;
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
    }
    if (valid < STABLE_FRAMES) return -1;
    if (maxB - minB > 1) return -1;
    return Math.round((minB + maxB) / 2);
  }

  /** Update register state machine and fire torus pulse on commit. */
  function updateRegister(now, time) {
    const peakBin = dominantBassPeak();
    recentBins[recentBinsIdx] = peakBin;
    recentBinsIdx = (recentBinsIdx + 1) % STABLE_FRAMES;

    const stable = stableBin();
    if (stable < 0) {
      // Peak is unstable — don't switch but don't drop current register either
      candidateRegister = -1;
      candidateFrames = 0;
      if (currentRegister < 0) return;
      return;
    }

    const midi = binToMidiNote(stable);
    const dom = midiToRegister(midi);

    if (dom < 0) {
      currentRegister = -1;
      candidateRegister = -1;
      candidateFrames = 0;
      holdFrames = 0;
      return;
    }

    // First activation from silence — adopt register without firing pulse
    if (currentRegister < 0) {
      currentRegister = dom;
      targetAngle = registerToAngle(dom);
      holdFrames = 0;
      candidateRegister = -1;
      candidateFrames = 0;
      return;
    }

    // Same register — increment hold counter
    if (dom === currentRegister) {
      holdFrames = Math.min(HOLD_FRAME_CAP, holdFrames + 1);
      candidateRegister = -1;
      candidateFrames = 0;
      return;
    }

    // Adjacent register — likely wobble. Keep holding current.
    const jump = Math.abs(dom - currentRegister);
    if (jump < MIN_REGISTER_JUMP + 1) {
      holdFrames = Math.min(HOLD_FRAME_CAP, holdFrames + 1);
      candidateRegister = -1;
      candidateFrames = 0;
      return;
    }

    // Recent-register bounce check — rejects oscillation between two notes
    let recentBounce = false;
    for (let i = 0; i < recentCommittedRegisters.length; i++) {
      const past = recentCommittedRegisters[i];
      if (now - past.time < RECENT_REGISTER_FORGET_MS && past.reg === dom) {
        recentBounce = true;
        break;
      }
    }
    if (recentBounce) {
      candidateRegister = -1;
      candidateFrames = 0;
      holdFrames = Math.min(HOLD_FRAME_CAP, holdFrames + 1);
      return;
    }

    // Real candidate — accumulate frames toward lock
    if (dom === candidateRegister) {
      candidateFrames++;
      if (candidateFrames >= REGISTER_LOCK_FRAMES) {
        // COMMIT: fire torus pulse using the figure's CURRENT state
        // (before angle/size start interpolating to the new values)
        if (currentRegister >= 0 && pathSel.value === 'lissajous') {
          const morph = parseFloat(morphSlider.value);
          const minScale = 1.0 - morph * 0.50;
          const maxScale = 1.0 + morph * 0.30;
          const sizeFactor = minScale + (maxScale - minScale) * Math.min(1, registerSize);
          spawnTorusPulse(now, currentRegisterAngle, sizeFactor, time);
        }
        recentCommittedRegisters.push({ reg: currentRegister, time: now });
        while (recentCommittedRegisters.length > RECENT_REGISTERS_SIZE) {
          recentCommittedRegisters.shift();
        }
        currentRegister = dom;
        targetAngle = registerToAngle(dom);
        holdFrames = 0;
        candidateRegister = -1;
        candidateFrames = 0;
      }
    } else {
      candidateRegister = dom;
      candidateFrames = 1;
    }
  }

  // =========================================================================
  // PULSE SPAWNING
  // =========================================================================

  /** Generic pulse for circle (expand outward) and polygon (collapse inward). */
  function spawnPulse(kind, snapshot, intensity, now) {
    if (pulses.length >= MAX_PULSES) pulses.shift();
    const frozen = new Array(snapshot.length);
    for (let i = 0; i < snapshot.length; i++) {
      frozen[i] = { x: snapshot[i].x, y: snapshot[i].y };
    }
    pulses.push({ kind, snapshot: frozen, born: now, intensity });
  }

  /**
   * Lissajous torus pulse: capture two arcs from the figure's lobes,
   * eject them perpendicular to the figure's rotation axis. They expand
   * laterally as they go, briefly closing the figure's openings before fading.
   */
  function spawnTorusPulse(now, rotationAngle, sizeFactor, time) {
    if (torusPulses.length >= MAX_TORUS_PULSES) torusPulses.shift();
    const cx = W/2, cy = H/2;
    const g = geom.lissajous;
    if (!g) return;
    const ax = g.baseAx * sizeFactor;
    const ay = g.baseAy * sizeFactor;
    const a = 3, b = 2, ph = time * 0.0003;
    const SAMPLES_PER_ARC = 32;
    const ARC_HALF_WIDTH = 0.07;

    function sampleArc(centerT) {
      const arc = [];
      for (let i = 0; i < SAMPLES_PER_ARC; i++) {
        const f = i / (SAMPLES_PER_ARC - 1);
        const t = centerT + (f - 0.5) * 2 * ARC_HALF_WIDTH;
        const T = t * Math.PI * 2;
        const rawX = Math.sin(a*T + ph) * ax;
        const rawY = Math.sin(b*T) * ay;
        const cosR = Math.cos(rotationAngle), sinR = Math.sin(rotationAngle);
        const x = rawX * cosR - rawY * sinR;
        const y = rawX * sinR + rawY * cosR;
        arc.push({ x, y });
      }
      return arc;
    }
    // For a 3:2 lissajous, sin(2*2π*t) hits ±1 at t=0.125 and t=0.375 — the lobe apices
    const topArc = sampleArc(0.125);
    const bottomArc = sampleArc(0.375);
    // Eject direction: perpendicular to the figure's major axis
    const ejectX = -Math.sin(rotationAngle);
    const ejectY = Math.cos(rotationAngle);
    torusPulses.push({ born: now, cx, cy, topArc, bottomArc, ejectX, ejectY, sizeFactor });
  }

  /**
   * Spiral tail-flick pulse: capture the spiral's outer end (last 12% of path)
   * and eject it as a rigid body. Direction combines:
   *   - parametric tangent (small, the spiral's natural curve direction)
   *   - rotational momentum (dominant when spiralVel is high)
   * This produces "sparks off a turning wheel" behavior.
   */
  function spawnTailPulse(now, intensity) {
    if (tailPulses.length >= MAX_TAIL_PULSES) tailPulses.shift();
    const cx = W/2, cy = H/2;
    const g = geom.spiral;
    if (!g) return;

    const TAIL_SAMPLES = 28;
    const TAIL_T_START = 0.88;
    const TAIL_T_END = 1.00;
    const arc = [];
    for (let i = 0; i < TAIL_SAMPLES; i++) {
      const f = i / (TAIL_SAMPLES - 1);
      const t = TAIL_T_START + f * (TAIL_T_END - TAIL_T_START);
      const a = t * Math.PI * 2 * g.turns + spiralAngle;
      const r = g.rMin + t * (g.rMax - g.rMin);
      arc.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    const tip = arc[arc.length - 1];

    // Parametric tangent at the tip — derivative of spiral at t=1
    const tipA = Math.PI * 2 * g.turns + spiralAngle;
    const tipR = g.rMax;
    const dr = (g.rMax - g.rMin);
    const dxdt = -Math.sin(tipA) * (2 * Math.PI * g.turns) * tipR + Math.cos(tipA) * dr;
    const dydt =  Math.cos(tipA) * (2 * Math.PI * g.turns) * tipR + Math.sin(tipA) * dr;
    const tm = Math.hypot(dxdt, dydt) || 1;
    const tangentX = dxdt / tm;
    const tangentY = dydt / tm;

    // Rotational momentum contribution — perpendicular to radius at tip
    const rotPerpX = -Math.sin(tipA);
    const rotPerpY = Math.cos(tipA);
    const ROT_MOMENTUM_SCALE = 18.0;
    const rotMomentumX = rotPerpX * spiralVel * tipR * ROT_MOMENTUM_SCALE;
    const rotMomentumY = rotPerpY * spiralVel * tipR * ROT_MOMENTUM_SCALE;

    // Combine — rotational dominates when spinning, tangent takes over at rest
    const PARAMETRIC_SCALE = 0.3;
    let vx = tangentX * PARAMETRIC_SCALE + rotMomentumX;
    let vy = tangentY * PARAMETRIC_SCALE + rotMomentumY;
    const vm = Math.hypot(vx, vy) || 1;
    const dirX = vx / vm;
    const dirY = vy / vm;

    // Speed scales with rotational velocity (faster spin = farther throw)
    const speedFactor = 0.7 + Math.min(1.0, Math.abs(spiralVel) * 12);

    tailPulses.push({ born: now, arc, tipX: tip.x, tipY: tip.y, dirX, dirY, speedFactor, intensity });
  }

  // =========================================================================
  // PULSE RENDERING
  // =========================================================================

  /**
   * Lissajous torus pulse rendering: two arcs eject perpendicular to the
   * figure's axis, widening laterally as they go. Brightness peaks at
   * progress=0.5 (closure moment) then fades.
   */
  function renderTorusPulse(pulse, now, hue) {
    const progress = (now - pulse.born) / TORUS_PULSE_DURATION;
    if (progress >= 1) return false;
    const baseTravel = (geom.lissajous.baseAx + geom.lissajous.baseAy) * 0.6 * pulse.sizeFactor;
    const travel = progress * baseTravel;
    const widening = 1.0 + progress * 1.8;
    let alpha;
    if (progress < 0.5) {
      alpha = (progress * 2) * 0.95 * PULSE_INTENSITY;             // build to peak
    } else {
      const decay = (progress - 0.5) * 2;
      alpha = (1 - decay * decay) * 0.95 * PULSE_INTENSITY;        // quadratic falloff after peak
    }

    function drawArc(arc, sign) {
      const ox = pulse.ejectX * travel * sign;
      const oy = pulse.ejectY * travel * sign;
      let cxA = 0, cyA = 0;
      for (let i = 0; i < arc.length; i++) { cxA += arc[i].x; cyA += arc[i].y; }
      cxA /= arc.length; cyA /= arc.length;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // Outer glow stroke (wide, low alpha)
      ctx.strokeStyle = 'hsla(' + hue + ', 100%, 80%, ' + (alpha * 0.4) + ')';
      ctx.lineWidth = 6;
      ctx.beginPath();
      for (let i = 0; i < arc.length; i++) {
        const dx = arc[i].x - cxA;
        const dy = arc[i].y - cyA;
        const x = pulse.cx + cxA + dx * widening + ox;
        const y = pulse.cy + cyA + dy * widening + oy;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // Inner bright stroke (narrow, high alpha)
      ctx.strokeStyle = 'hsla(' + hue + ', 100%, 92%, ' + alpha + ')';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < arc.length; i++) {
        const dx = arc[i].x - cxA;
        const dy = arc[i].y - cyA;
        const x = pulse.cx + cxA + dx * widening + ox;
        const y = pulse.cy + cyA + dy * widening + oy;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    drawArc(pulse.topArc, 1);
    drawArc(pulse.bottomArc, -1);
    return true;
  }

  /**
   * Spiral tail pulse rendering: rigid body translation along the captured
   * direction. Shape preserved (no widening — a fragment that detached, not
   * a wave).
   */
  function renderTailPulse(pulse, now, hue) {
    const progress = (now - pulse.born) / TAIL_PULSE_DURATION;
    if (progress >= 1) return false;
    const baseTravel = geom.spiral.rMax * 1.4 * pulse.speedFactor;
    const travel = progress * baseTravel;
    const ox = pulse.dirX * travel;
    const oy = pulse.dirY * travel;
    let alpha;
    if (progress < 0.08) {
      alpha = (progress / 0.08) * 0.95 * pulse.intensity * PULSE_INTENSITY;
    } else {
      const decay = (progress - 0.08) / 0.92;
      alpha = (1 - decay) * (1 - decay) * 0.95 * pulse.intensity * PULSE_INTENSITY;
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'hsla(' + hue + ', 100%, 78%, ' + (alpha * 0.4) + ')';
    ctx.lineWidth = 5;
    ctx.beginPath();
    for (let i = 0; i < pulse.arc.length; i++) {
      const x = pulse.arc[i].x + ox;
      const y = pulse.arc[i].y + oy;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.strokeStyle = 'hsla(' + hue + ', 100%, 92%, ' + alpha + ')';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < pulse.arc.length; i++) {
      const x = pulse.arc[i].x + ox;
      const y = pulse.arc[i].y + oy;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    return true;
  }

  // =========================================================================
  // UTILITIES
  // =========================================================================

  /** Lerp between angles along the shortest arc. */
  function angleLerp(current, target, alpha) {
    let diff = target - current;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return current + diff * alpha;
  }

  let fpsCounter = 0;
  let fpsLast = performance.now();
  let fps = 60;

  // =========================================================================
  // MAIN RENDER LOOP
  // -------------------------------------------------------------------------
  // Per-frame: pull audio, update detectors and animation state, draw
  // everything in painter's-algorithm order:
  //   1. Background (full clear OR transparent fill for trail effect)
  //   2. Rest path
  //   3. Wedge bars
  //   4. Envelope silhouette polyline
  //   5. Path-specific pulses (torus halos, tail flicks)
  //   6. Generic pulses (circle/polygon)
  // =========================================================================
  function draw(){
    requestAnimationFrame(draw);
    const time = performance.now() - t0;
    const now = performance.now();

    // FPS counter (updates display every ~500ms)
    fpsCounter++;
    if (now - fpsLast > 500) {
      fps = fpsCounter / ((now - fpsLast) / 1000);
      fpsLast = now;
      fpsCounter = 0;
    }

    // ----- Audio analysis (always runs, even during resize) -----
    if (analyser) {
      analyser.getByteFrequencyData(freqData);
      updateEnvelope();
      updateRegister(now, time);

      // Lissajous size + rotation interpolation toward register targets
      if (currentRegister >= 0) {
        currentRegisterAngle = angleLerp(currentRegisterAngle, targetAngle, 0.08);
        const targetSize = holdFrames / HOLD_FRAME_CAP;
        // Slightly slower expansion than contraction so register changes feel decisive
        const sizeAlpha = targetSize > registerSize ? 0.05 : 0.10;
        registerSize += (targetSize - registerSize) * sizeAlpha;
      } else {
        registerSize += (0 - registerSize) * 0.12;
      }

      // Spiral rotation — only when spiral is selected, decays otherwise
      const pathName = pathSel.value;
      if (pathName === 'spiral') {
        const targetVel = avgEnv * 0.06;
        const accel = (targetVel > spiralVel) ? 0.04 : 0.01;
        spiralVel += (targetVel - spiralVel) * accel;
        if (envelope < 0.02) spiralVel *= 0.97;
        spiralAngle += spiralVel;
      } else {
        spiralVel *= 0.9;
      }
    }

    // Pause rendering during resize storm — but audio analysis above keeps running
    if (isResizing) return;

    const pathName = pathSel.value;
    const cfg = PATH_CFG[pathName];

    // ----- Pre-audio state: just draw the rest path in dim red -----
    if (!analyser) {
      ctx.fillStyle = '#0a0a0f';
      ctx.fillRect(0, 0, W, H);
      const restPts = buildRestPath(pathName, time);
      ctx.strokeStyle = '#cc4444';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < restPts.length; i++) {
        const p = restPts[i];
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      if (cfg.closed) ctx.closePath();
      ctx.stroke();
      return;
    }

    // ----- Background: full clear or trail-blend -----
    if (trailChk.checked) {
      // Transparent fill — accumulates motion blur across frames
      ctx.fillStyle = 'rgba(10, 10, 15, 0.18)';
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = '#0a0a0f';
      ctx.fillRect(0, 0, W, H);
    }

    // ----- Read controls -----
    const reach = parseFloat(reachSlider.value) * minDim;
    const gain = parseFloat(gainSlider.value);
    const mix = parseFloat(mixSlider.value);
    const gamma = parseFloat(gammaSlider.value);
    const barFrac = parseFloat(barSlider.value);
    const sensitivity = parseFloat(sensSlider.value);
    const bins = freqData.length;

    // Hue cycles slowly with time and modulates with bass energy
    let bass = 0;
    for (let i = 0; i < 8; i++) bass += freqData[i];
    bass /= (8 * 255);
    const hue = (200 + bass * 120 + time * 0.02) % 360;

    // ----- Draw rest path -----
    const restPts = buildRestPath(pathName, time);
    ctx.strokeStyle = 'hsl(' + hue + ', 75%, 55%)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < restPts.length; i++) {
      const p = restPts[i];
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    if (cfg.closed) ctx.closePath();
    ctx.stroke();

    // ----- Compute wedge bars and envelope tip points -----
    const envDist = envelope * reach;
    const N = nWedges;
    const tipPts = new Array(N);
    const wedgeBars = new Array(N);

    for (let i = 0; i < N; i++) {
      const slotStart = i / N;
      const slotEnd = (i + 1) / N;
      const slotWidth = slotEnd - slotStart;
      const slotCenter = (slotStart + slotEnd) / 2;

      // Get max-pooled spectrum value for this slot, apply gamma curve, gain
      let v = wedgeValue(slotStart, slotEnd, cfg.closed, bins, mix);
      v = Math.pow(Math.max(0, v), gamma);
      v *= gain;
      const dist = v * envDist;

      // Tip point at slot center, pushed outward by `dist`
      const pCenter = pointAt(pathName, slotCenter, time);
      const ox = pCenter.nx * cfg.outwardSign;
      const oy = pCenter.ny * cfg.outwardSign;
      tipPts[i] = { x: pCenter.x + ox * dist, y: pCenter.y + oy * dist };

      // Bar quad sides (centered in slot, width = barFrac of slot width)
      if (dist >= 0.5) {
        const halfBar = barFrac / 2;
        wedgeBars[i] = {
          tA: slotCenter - slotWidth * halfBar,
          tB: slotCenter + slotWidth * halfBar,
          dist
        };
      }
    }

    // ----- Pulse detection (spawns new pulses for current path) -----
    let snareResult = null;
    if (pulseChk.checked) {
      // High-band readings (used by circle and to keep histories warm on other paths)
      const hiStart = Math.floor(bins * HIGH_BIN_FRAC_START);
      let hiSum = 0;
      for (let b = hiStart; b < bins; b++) hiSum += freqData[b];
      const hiEnergy = (hiSum / (bins - hiStart)) / 255;
      const hiFlux = Math.max(0, hiEnergy - highState.energyAvg);

      if (pathName === 'circle' && detectHighOnset(highState, hiEnergy, hiFlux, sensitivity, now)) {
        spawnPulse('circle', tipPts, Math.min(1, hiEnergy * 2), now);
      } else if (pathName === 'polygon') {
        const result = detectKick(now, sensitivity);
        if (result.fired) {
          spawnPulse('hex', tipPts, Math.min(1, result.strength / 2), now);
        }
      } else if (pathName === 'spiral') {
        snareResult = detectSnare(now, sensitivity);
        if (snareResult.fired) {
          spawnTailPulse(now, Math.min(1, snareResult.strength / 3));
        }
      } else {
        // For other paths (line, lissajous): keep history buffers updating so
        // detectors are calibrated when path is switched.
        const ea = hiEnergy > highState.energyAvg ? 0.005 : 0.05;
        highState.energyAvg += (hiEnergy - highState.energyAvg) * ea;
        const strength = computeKickOnsetStrength();
        onsetHistory[onsetHistoryIdx] = strength;
        onsetHistoryIdx = (onsetHistoryIdx + 1) % ONSET_HISTORY_FRAMES;
        const sStrength = computeSnareOnsetStrength();
        snareOnsetHistory[snareOnsetHistoryIdx] = sStrength;
        snareOnsetHistoryIdx = (snareOnsetHistoryIdx + 1) % SNARE_ONSET_HISTORY_FRAMES;
      }
      prevFreqData.set(freqData);
    }

    // ----- Draw wedge bars (fill + stroke) -----
    if (envDist > 0.5) {
      ctx.fillStyle = 'hsla(' + hue + ', 90%, 60%, 0.85)';
      ctx.strokeStyle = 'hsl(' + hue + ', 95%, 70%)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        const wb = wedgeBars[i];
        if (!wb) continue;
        const pA = pointAt(pathName, wb.tA, time);
        const pB = pointAt(pathName, wb.tB, time);
        const oxA = pA.nx * cfg.outwardSign, oyA = pA.ny * cfg.outwardSign;
        const oxB = pB.nx * cfg.outwardSign, oyB = pB.ny * cfg.outwardSign;
        ctx.moveTo(pA.x, pA.y);
        ctx.lineTo(pA.x + oxA * wb.dist, pA.y + oyA * wb.dist);
        ctx.lineTo(pB.x + oxB * wb.dist, pB.y + oyB * wb.dist);
        ctx.lineTo(pB.x, pB.y);
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
    }

    // ----- Draw envelope silhouette (polyline through bar tips) -----
    if (envChk.checked) {
      ctx.strokeStyle = 'hsla(' + hue + ', 100%, 75%, 0.9)';
      ctx.lineWidth = 1.4;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        const tp = tipPts[i];
        if (i === 0) ctx.moveTo(tp.x, tp.y); else ctx.lineTo(tp.x, tp.y);
      }
      if (cfg.closed) ctx.closePath();
      ctx.stroke();
    }

    // ----- Draw lissajous torus pulses (only when on lissajous path) -----
    if (pathName === 'lissajous') {
      const torusSurvivors = [];
      for (let p = 0; p < torusPulses.length; p++) {
        if (renderTorusPulse(torusPulses[p], now, hue)) {
          torusSurvivors.push(torusPulses[p]);
        }
      }
      torusPulses = torusSurvivors;
    } else {
      torusPulses = []; // Clear when off-path
    }

    // ----- Draw spiral tail pulses (only when on spiral path) -----
    if (pathName === 'spiral') {
      const tailSurvivors = [];
      for (let p = 0; p < tailPulses.length; p++) {
        if (renderTailPulse(tailPulses[p], now, hue)) {
          tailSurvivors.push(tailPulses[p]);
        }
      }
      tailPulses = tailSurvivors;
    } else {
      tailPulses = [];
    }

    // ----- Draw generic pulses (circle expand, polygon collapse) -----
    const cx = W/2, cy = H/2;
    const maxRadius = Math.hypot(W, H) * 0.6;
    const survivors = [];
    for (let p = 0; p < pulses.length; p++) {
      const pulse = pulses[p];
      const progress = (now - pulse.born) / PULSE_DURATION;
      if (progress >= 1) continue;
      survivors.push(pulse);
      const alpha = (1 - progress) * (1 - progress) * 0.7 * Math.min(1, pulse.intensity * 1.5) * PULSE_INTENSITY;
      ctx.strokeStyle = 'hsla(' + hue + ', 100%, 80%, ' + alpha + ')';
      ctx.lineWidth = 1.2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const snap = pulse.snapshot;
      for (let i = 0; i < snap.length; i++) {
        const s = snap[i];
        let x, y;
        if (pulse.kind === 'circle') {
          // Circle pulse expands radially outward from canvas center
          const dx = s.x - cx, dy = s.y - cy;
          const r = Math.hypot(dx, dy) || 1;
          const scale = 1 + progress * (maxRadius / r - 1);
          x = cx + dx * scale;
          y = cy + dy * scale;
        } else {
          // Hex pulse collapses inward toward canvas center
          x = s.x + (cx - s.x) * progress;
          y = s.y + (cy - s.y) * progress;
        }
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
    pulses = survivors;

    // ----- Update meter readout -----
    meter.textContent = 'env: ' + envelope.toFixed(2) + '   fps: ' + fps.toFixed(0);
  }

  // Kick off the render loop
  draw();

})();
