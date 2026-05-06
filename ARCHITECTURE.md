# Architecture

This document describes how the visualizer works internally — the per-frame pipeline, the detection algorithms, and why the structure is the way it is. The README covers what it does from a user's perspective; this covers how it does it.

## High-level structure

The visualizer is a single file (`visualizer.js`) organized as one IIFE (immediately-invoked function expression). It has no module system, no external dependencies, and no build pipeline. The structure inside the IIFE is sectioned by purpose:

1. **DOM references** — grab all the controls and canvas
2. **Per-path defaults** — characterized profiles per path, applied on switch
3. **Audio context state** — WebAudio nodes, FFT buffers
4. **Canvas / geometry state** — sizing, DPR, wedge counts
5. **Detector parameters** — constants for each detector
6. **Path geometry registry** — declarative shape definitions
7. **Detector / animation state** — runtime state for spiral spin, register tracking, pulse lists
8. **Sizing and resize handling** — debounced, render pauses but audio doesn't
9. **Audio setup and playback** — file loading, demo oscillator
10. **Pitch utilities** — bin → MIDI → register conversions
11. **Path sampling** — `pointAt()` for parametric position + outward normal
12. **Frequency mapping** — mel-scale path-position → FFT bin
13. **Per-bin normalization** — local + global ceiling, asymmetric tracking
14. **Envelope tracking** — RMS in time domain
15. **Onset strength functions** — log-mel onset for kick and snare
16. **Onset detectors** — peak-picking with refractory windows
17. **Bass register tracking** — multi-stage state machine
18. **Pulse spawning** — torus halo, tail flick, generic pulses
19. **Pulse rendering** — animation curves for each pulse type
20. **Main render loop** — the per-frame pipeline

## Per-frame pipeline

Each `requestAnimationFrame` tick:

1. **Pull audio data** from the AnalyserNode (frequency-domain `getByteFrequencyData`, time-domain `getByteTimeDomainData`).
2. **Update envelope** — RMS over the time-domain buffer with asymmetric attack/release.
3. **Update register** (lissajous-relevant but always runs so state is current when path switches in). This includes the multi-stage state machine that may fire a torus pulse on commit.
4. **Update spiral animation state** — only when on the spiral path. Velocity tracks `avgEnv`; angle integrates velocity.
5. **Pause check** — if mid-resize, return early (audio analysis above keeps running).
6. **Background draw** — full clear OR transparent fill (the trail effect).
7. **Read controls** — slider values for reach, gain, mix, gamma, bar fraction, sensitivity.
8. **Compute hue** — cycles slowly with time, modulates with bass energy.
9. **Draw rest path** — the path's "ground truth" geometry.
10. **Compute bars and tip points** — per-wedge max-pooled spectrum value, gamma-curved, gain-multiplied, projected outward.
11. **Run path-specific detector** — kick (polygon), snare (spiral), high-onset (circle). Spawn pulses when fired.
12. **Draw bars** — wedge quads filled and stroked.
13. **Draw envelope silhouette** — polyline through bar tips.
14. **Draw path-specific pulses** — torus halos for lissajous, tail flicks for spiral.
15. **Draw generic pulses** — circle expand-out, hex collapse-in.
16. **Update meter** — env value and FPS readout.

The painter's algorithm matters: rest path first (deepest layer), bars on top, envelope silhouette on top of those, pulses last so they're never occluded.

## Audio analysis

### FFT
WebAudio's `AnalyserNode.fftSize = 2048` gives us 1024 frequency bins covering 0 Hz to Nyquist (sample-rate / 2). At 44.1 kHz sample rate that's about 21.5 Hz per bin. Smoothing time constant is 0.78 — moderate, lets transient onsets through but reduces frame-to-frame jitter on sustained content.

### Frequency-to-path mapping
Wedges along a path are distributed in mel space, not linearly. Mel scale compresses high frequencies and expands low frequencies, matching how humans perceive pitch. Closed paths use folded mapping `u = |2t-1|` so the bass appears at both `t=0` and `t=1`, meeting smoothly at the seam.

### Per-bin normalization
A naive division by the global maximum makes high frequencies disappear (most energy in music is in the bass). A naive per-bin local max makes everything saturate. We use a `mix` parameter that interpolates between them: `ceiling = local^(1-mix) * global^mix`. The line path uses `mix=0.95` (mostly global) for honest readout; everything else uses `mix=0` (pure local) for visual dynamism.

### Envelope
RMS of the time-domain samples, mapped to [0,1], with asymmetric attack (0.4 alpha) and release (0.04 alpha). Peaks rise immediately, decay slowly. `avgEnv` is a long-term average used for spiral velocity targeting.

## Detectors

There are four detectors, each targeting a different musical phenomenon. The first three follow the same template (log-mel onset strength + peak-picking with refractory); the fourth is structurally different.

### Onset strength template (used by kick and snare)

For each FFT bin in the band, compute `log(1 + 10 * value)` for current and previous frames, take the difference, half-wave rectify (only positive deltas count), sum across the band. This is essentially librosa's `onset_strength`. The log compression means the detector is robust to overall loudness changes.

For peak-picking, we maintain a ring buffer of recent onset strengths. A frame fires if and only if:
- It's outside the refractory period from the last fire
- Its strength exceeds `mean × sensitivity` AND `ABS_FLOOR`
- Its strength exceeds the recent local max (last 3 frames)

The local-max requirement is critical. Without it, slow rises produce continuous fires. With it, only true peaks count.

### Kick (polygon path)
- **Band**: bins 2-14 (~43-301 Hz)
- **Refractory**: 200ms
- **Floor**: 0.15

This catches kick fundamentals (60-80 Hz) and the click extending up to ~300 Hz. The wide band makes it robust to different kick drum tunings.

### Snare/hi-hat (spiral path)
- **Band**: bins 8-260 (~170 Hz - 5.5 kHz)
- **Refractory**: 90ms (shorter — hi-hats can be 16th notes)
- **Floor**: 0.25 (higher — upper-mid is naturally busier than bass)

Catches snare fundamentals, snare wire noise, and the bulk of hi-hat content. Wide enough that one detector handles both snares and hi-hats — they're both upper-mid percussion and visually we want them to read as the same kind of event (tail flicks).

### High onset (circle path)
- **Band**: top 60% of bins (above ~4 kHz)
- **Refractory**: 200ms
- **Floor**: 0.015 on flux

Different algorithm: tracks running averages of energy and flux, fires when flux exceeds `flux_avg * sensitivity` and energy is above 0.1. Used because broad treble events (cymbals, sibilance) read better as flux than as log-mel onsets — they don't always have the sharp magnitude jumps that the onset detector keys on.

### Bass register (lissajous path)
This is the most complex detector and the one that produces the most interesting behavior. It's a multi-stage state machine that filters spectral wobble from genuine register changes.

#### Stage 1: Find the dominant local peak
Search the bass band (bins 4-80, ~86 Hz - 1.7 kHz) for the bin with the highest **prominence** — defined as `value - average_of_nearby_bins`. We require it to be a strict local max (greater than both immediate neighbors) and have prominence > 0.10. This finds the bass synth's strongest harmonic, which is typically more stable than its fundamental.

#### Stage 2: Bin stability gate
The peak bin must be ±1 of itself across `STABLE_FRAMES` (3) consecutive frames before being considered. This filters frame-to-frame jitter at the source — when the bass synth's energy is between two adjacent FFT bins, those bins trade places frame to frame, but their median is stable.

#### Stage 3: Whole-tone quantization
The stable peak's MIDI note number is divided by `REGISTER_QUANTUM_SEMITONES` (2). So C2 and C#2 both become register 12; D2 and D#2 both become register 13. A bass note vibrating between two adjacent semitones stays in one register.

#### Stage 4: Minimum-jump filter
A new candidate register is only considered if it differs from the current by ≥ `MIN_REGISTER_JUMP + 1` quanta. Adjacent registers (1 quantum apart, 2 semitones) are treated as wobble and *extend the current hold* rather than starting a candidate counter.

#### Stage 5: Recent-register memory
The last 3 committed registers are remembered for 500ms. If a candidate matches one we just left, it's treated as bounce-back oscillation and rejected.

#### Stage 6: Lock duration
A surviving candidate must persist for `REGISTER_LOCK_FRAMES` (15, ~250ms at 60fps) before committing. On commit, the previous register is pushed into the recent-register history and a torus pulse fires using the figure's *current* state (rotation, size) before any of those interpolate to new values.

The result of these six stages stacked: the detector only fires when the spectral landscape has *demonstrably* reorganized — which musically corresponds to chord changes, structural transitions, and drops. It functions as a compositional-phase detector more than a bass-note detector, even though the spec was the latter.

## Path geometry

Each path is declared in `PATH_CFG` with three fields:
- `closed` — whether the path closes back on itself (affects mel folding)
- `outwardSign` — +1 for paths where bars push away from the centroid, -1 for paths where bars push downward (line)
- `geometry(W, H, m)` — pure function returning sized properties from canvas dimensions

Geometry uses sublinear scaling: `sqrt(m * REF_MIN)`. At reference size (`m = 420`) this equals 420, so reference-size geometry is unchanged. At smaller sizes the result is larger relative to `m` (so the shape doesn't disappear); at larger sizes it's smaller relative to `m` (so pulses have room to expand without dominating).

`pointAt(name, t, time)` is the path's parametric sampler — given `t ∈ [0,1]`, returns position and outward normal. For the lissajous and spiral paths, `pointAt` is dynamic — it depends on register state and rotation respectively.

## Wedge bars

Each frame, the path is divided into `nWedges` slots. For each slot:
1. Compute the FFT bin range covered by the slot's t-range (mel-scaled).
2. Max-pool the FFT bin values in that range.
3. Apply per-bin normalization with the current `mix` parameter.
4. Apply gamma curve (`pow(v, gamma)`) — values above 1 compress, values below 1 expand.
5. Multiply by gain.
6. Multiply by `envelope * reach * minDim` to get the bar's outward distance.

A bar quad is drawn centered at the slot's midpoint, with width = `barFrac * slotWidth`, extending outward by the computed distance. This produces visible chunkiness at high resolutions — a feature, not a bug, because it preserves the spectrum's structure visually.

`nWedges` scales with canvas pixel area: `nWedges = REF_WEDGES * sqrt(REF_PIXELS / pixels)`, clamped to [120, 480]. So small embeds get more wedges, large screens get fewer — visual density stays consistent.

## Envelope silhouette

A polyline through the bar tips. On a circle this produces a smooth jagged ring. On a polygon, it produces visible zigzag artifacts at vertex transitions because the outward normal flips abruptly — that's why the polygon's default has envelope OFF.

## Pulses

Three pulse types, each with its own animation and rendering:

### Generic pulse (circle, polygon)
A snapshot of the current bar tip points is captured at trigger time. On animation:
- **Circle**: each tip translates outward radially from canvas center, scaling distance by progress
- **Hex**: each tip translates inward toward canvas center

Alpha decays as `(1-progress)²` for a quick fade.

### Tail flick (spiral)
The spiral's outer 12% (28 sample points) is captured. The tip's parametric tangent at `t=1` is computed mathematically (derivative of the spiral parameterization). A rotational momentum vector is added — perpendicular to the radius at the tip, weighted by `spiralVel × tipR × ROT_MOMENTUM_SCALE`. The combined direction is normalized.

Animation: rigid-body translation along the captured direction. No widening — it's a fragment that detached, not an emanating wave. Speed scales with `spiralVel` (faster spin = farther throw).

### Torus halo (lissajous)
At trigger time, two arcs are sampled from the figure's lobes — one centered at `t=0.125` (top lobe apex) and one at `t=0.375` (bottom apex), each spanning ±7% of the parametric range. The eject direction is perpendicular to the figure's current rotation axis: `(-sin(angle), cos(angle))`.

Animation: each arc translates along the eject direction (top arc in `+`, bottom in `-`). The arc widens laterally (centroid-relative scaling) from 1.0 to 2.8× over its lifetime. Brightness peaks at progress=0.5 (the moment the widening would close the figure's openings), then quadratically fades.

Each torus pulse is drawn as two strokes — a wide outer glow (low alpha, 6px) and a narrow inner bright stroke (high alpha, 2px). This is what makes them read as halos rather than thin lines.

## Color

A single hue value drives all coloring per frame:

```
hue = (200 + bass * 120 + time * 0.02) % 360
```

So all paths share the same color cycle — what changes per path is the rendering choices, not the palette. This means a screen recording of any path looks like the same "instrument" expressed in different geometries.

## Why these specific algorithms

The detection algorithms in this codebase aren't arbitrary. They're essentially librosa transcribed to JavaScript:
- The kick and snare onset detectors are `librosa.onset.onset_strength` band-limited
- The peak-picking with local-max requirement is `librosa.util.peak_pick`
- The bass register prominence detection is similar to `scipy.signal.find_peaks` with prominence parameter

We're not innovating on the math — we're applying well-tested DSP to specific musical use cases. What's worth noting is that each detector required experimentation to figure out the *right* band, sensitivity, and refractory for the musical phenomenon we wanted to catch. The kick band is narrower than you'd think, the snare band is wider than you'd think, and the bass register state machine grew from 1 stage to 6 stages over the development process to filter wobble.

## Performance considerations

- **WebAudio's AnalyserNode** runs the FFT in native code. Free.
- **Canvas2D** is GPU-accelerated for path operations on modern browsers.
- **Bar drawing** is the hottest loop — at `nWedges=360` we're issuing 360 path commands per frame plus a single `fill()` and `stroke()` call.
- **DPR is capped** at lower values for large canvases. Full DPR everywhere would tank framerate at 4K.
- **Resize is debounced** (150ms) and pauses rendering during the storm; audio analysis keeps running so envelope and register state stay current.
- **Trail effect** is a single `fillRect` with `rgba(10,10,15,0.18)` per frame — much cheaper than blurring or particle systems.

At reference size (680×420) the visualizer holds 60fps comfortably on any modern machine. Fullscreen on a 4K monitor with the spiral path active is the most expensive case and still typically holds 60fps with DPR capped at 1.

## Possible extensions

- **More paths**: A torus-knot, a heart, an arbitrary user-supplied SVG. The pattern is: `pointAt(name, t, time)` returns position + outward normal, and the system handles the rest.
- **More detectors**: A "section-level energy" detector (averaged envelope over 4-8 second windows) could drive a slow background animation, giving the visualization a fourth musical timescale.
- **Output integrations**: Detected events (kick, snare, register change) could be emitted as MIDI messages, OSC messages, or DMX commands, turning the visualizer into a control surface for synced lighting/visuals.
- **Recording**: A `MediaRecorder` capturing the canvas would produce a video file synchronized with the audio. Useful for sharing what the visualization actually does.
