/* ============================================================
   PHASER — Motion Editor — script.js
   Vanilla JS. No npm/React/build/server (basic version). Pages ready.
   GSAP + ffmpeg.wasm optional.

   ARTBOARD MODEL (fixes the sizing/frame bugs)
     The artboard element is the REAL export area, sized in real pixels
     (e.g. 1080x1920). A "zoom" factor scales it to fit the window via
     CSS transform — the internal resolution never changes. The canvas
     frame is drawn on the artboard edge (the export boundary), NOT on an
     imported SVG's bounding box. A separate dashed selection box marks
     the selected layer. Every layer stores its transform in artboard
     coordinates (percent of artboard + rotation), so preview and export
     use identical math.

   DEFAULTS
     Transform motion (scale/rotate/large movement) is OFF by default.
     Imported art is centered and fit inside the canvas, never auto-
     rotated or scale-pulsed. Turn on "Allow transform motion" per layer.

   SECTIONS: STATE · ASSETS · LAYERS · TRANSFORM · COLOR · TIMELINE ·
     AUDIO · EFFECTS · RENDER · PRESETS · AI · CONTROLS · BG · FORMAT ·
     ZOOM · EXPORT · WIRING · INIT
   ============================================================ */

(() => {
  "use strict";

  /* ---------------- STATE ---------------- */
  const STATE = {
    // Scene overlay strengths — default all zero.  Users opt in to
    // stylistic effects (flicker, blur, RGB offset, scanlines, noise,
    // glow) by moving the sliders or applying a preset.  A brand-new
    // project should be a neutral motion-graphics workspace.
    // `speed` and `glitch` are input rate controls (not visual overlays)
    // so they keep sensible defaults.
    speed: 45, glitch: 0, flicker: 0, blur: 0, rgbSplit: 0, scanline: 0, noise: 0, glow: 0,
    // beat-sync engine
    beatSensitivity: 55, bassReaction: 70, midReaction: 50, highReaction: 55,
    smoothing: 60, peakThreshold: 60, motionIntensity: 65, syncTightness: 65,
    audioReactive: true, snapBeat: false, autoKeyframes: false, snapFrame: true,
    // v18.8 timeline precision — magnetic snapping for clip edges
    snapPlayhead: true, snapClipEdges: true, snapMarker: false,
    // v19.0 tool mode — "select" is the default; other tools ("text", future
    // "rect"/"ellipse"/"line") temporarily change canvas click behavior.
    tool: "select",
    // output
    bgMode: "custom", bgColor: "#0B0B0F", bgColor2: "#1A1030",
    format: { w: 1080, h: 1080, label: "Post 1:1" },
    duration: 8, fps: 30, playing: false, loop: true,
    exposeSub: false,   // default: group SVG as single layer
    zoom: 1, zoomMode: "fit",
    time: 0,
    // audio mixer (0..1.2)
    mixMaster: 1, mixMusic: 1, mixSfx: 0.9, mixVoice: 1,
    muteMaster: false, muteMusic: false, muteSfx: false, muteVoice: false,
    // BPM estimate (0 = unknown)
    bpm: 0,
    // timeline zoom multiplier (1 = "fill available width")
    tlZoom: 1,
    // event-clip creation options
    attachSfx: false, attachSfxId: "",
    // live audio runtime
    audioLevel: 0, bassLevel: 0, midLevel: 0, highLevel: 0, beat: 0, peak: 0, buildup: 0,
    // S2 — Preview render quality.  Affects internal canvas resolution
    // for WebCodecs-decoded video layers.  Export is unaffected and
    // always uses source resolution.
    previewQuality: "medium",   // "low" | "medium" | "high"
  };

  /* S2 — Preview quality → resolution cap (in vertical pixels).
     "high" leaves the source untouched.  "medium" and "low" cap the
     canvas height so decoded frames scale down before compositing —
     smoother scrubbing on high-res sources, negligible visual loss
     for editing.  Export always uses source resolution regardless. */
  const PREVIEW_QUALITY_CAPS = { low: 360, medium: 540, high: 99999 };
  function previewCanvasSizeFor(natW, natH) {
    const cap = PREVIEW_QUALITY_CAPS[STATE.previewQuality] || PREVIEW_QUALITY_CAPS.medium;
    if (natH <= cap) return { w: natW, h: natH };
    const scale = cap / natH;
    return { w: Math.round(natW * scale), h: Math.round(natH * scale) };
  }

  const CONTROL_GROUPS = {
    beatsync: [
      { key: "beatSensitivity", label: "Beat sensitivity" },
      { key: "bassReaction", label: "Bass reaction" },
      { key: "midReaction", label: "Mid reaction" },
      { key: "highReaction", label: "High reaction" },
      { key: "peakThreshold", label: "Peak threshold" },
      { key: "motionIntensity", label: "Motion intensity" },
    ],
    scene: [
      { key: "flicker", label: "Flicker" },
      { key: "blur", label: "Blur" },
      { key: "rgbSplit", label: "RGB offset" },
      { key: "scanline", label: "Scanlines" },
      { key: "noise", label: "Noise" },
      { key: "glow", label: "Glow" },
    ],
  };

  // Effect modules. transform:true => only active when the layer's
  // allowTransform flag is on (scale/rotate/large translate).
  //
  // v18.7: FX_LIBRARY is now a compatibility shim.  Every effect is a
  // proper timeline clip via FX_EVENTS (see below).  This array
  // remains only so the existing EFFECTS dictionary and the
  // FX_TRANSFORM set continue to resolve the transform-gate check.
  // The right-panel UI no longer renders fx-toggle buttons; every
  // effect creates a clip on the layer's timeline.
  const FX_LIBRARY = [
    { key: "blurIn",        label: "Blur-in",           transform: false },
    { key: "flickerBlocks", label: "Flicker Blocks",    transform: false },
    { key: "rgbOffset",     label: "RGB Offset",        transform: false },
    { key: "hudOverlay",    label: "HUD Overlay",       transform: false },
    { key: "pulseGlow",     label: "Pulse Glow",        transform: false },
    { key: "symbolTrans",   label: "Symbol Transition", transform: false },
    { key: "textFlicker",   label: "Text Flicker",      transform: false },
    { key: "lineDraw",      label: "Line Draw",         transform: false },
    { key: "trimPaths",     label: "Trim Paths",        transform: false },
    { key: "dataStream",    label: "Data Stream",       transform: false },
    { key: "oscilloscope",  label: "Oscilloscope",      transform: false },
    { key: "digitalWave",   label: "Digital Wave",      transform: false },
    { key: "signalShake",   label: "Signal Shake",      transform: true  },
    { key: "hologramTilt",  label: "Hologram Tilt",     transform: true  },
  ];
  const FX_TRANSFORM = new Set(FX_LIBRARY.filter((f) => f.transform).map((f) => f.key));

  // Every effect available to the user is now a timeline clip.  Each
  // entry provides:
  //   key       — internal id used for EVENT_EFFECTS / EFFECTS lookup
  //   label     — user-visible name
  //   defDur    — default duration in seconds, OR "layer" to fill the
  //               layer's remaining duration (used for sustained-style
  //               effects that traditionally applied for the layer's
  //               whole life).
  //   placement — "playhead" (default) creates the clip at the
  //               current playhead; "layerStart" creates it at the
  //               beginning of the layer (for reveal-style entries).
  //   group     — UI grouping tag.
  //   sustained — true = evaluate via EFFECTS[key] with clip-local
  //               wall-clock time (the migrated FX_LIBRARY effects);
  //               false/absent = evaluate via EVENT_EFFECTS[key] with
  //               a progress value p in [0..1] over the clip window.
  const FX_EVENTS = [
    // --- CORE clip events (existing event-style effects) ---
    { key: "focusSnap",       label: "Focus Snap",       defDur: 0.20, group: "core" },
    { key: "signalInterrupt", label: "Signal Interrupt", defDur: 0.10, group: "core" },
    { key: "frameHold",       label: "Frame Hold",       defDur: 0.16, group: "core" },
    { key: "rgbSpike",        label: "RGB Spike",        defDur: 0.12, group: "core" },
    { key: "hardCutEvent",    label: "Hard Cut",         defDur: 0.08, group: "core" },
    { key: "radarSweep",      label: "Radar Sweep",      defDur: 1.50, group: "core" },
    { key: "scanRevealEvent", label: "Scan Reveal",      defDur: 0.90, group: "core", placement: "layerStart", persistEnd: true },
    { key: "coordBlinkEvt",   label: "Coordinate Blink", defDur: 0.30, group: "core" },
    { key: "dataBreakEvent",  label: "Data Break",       defDur: 0.18, group: "core" },
    { key: "pathEnergize",    label: "Path Energize",    defDur: 1.20, group: "core" },
    { key: "layerSwap",       label: "Layer Swap",         defDur: 0.10, group: "core",    persistEnd: true },
    { key: "textReplace",     label: "Text Replace",       defDur: 0.30, group: "core",    persistEnd: true },
    // --- REVEAL effects (migrated from FX_LIBRARY, default at layer start) ---
    { key: "blurIn",       label: "Blur In",           defDur: 0.80, group: "reveal",  placement: "layerStart", sustained: true, persistEnd: true },
    { key: "lineDraw",     label: "Line Draw",         defDur: 1.20, group: "reveal",  placement: "layerStart", sustained: true, persistEnd: true },
    { key: "trimPaths",    label: "Trim Paths",        defDur: 1.00, group: "reveal",  placement: "layerStart", sustained: true, persistEnd: true },
    { key: "symbolTrans",  label: "Symbol Transition", defDur: 0.50, group: "reveal",  sustained: true, persistEnd: true },
    // --- SUSTAINED effects (migrated from FX_LIBRARY, cover full layer by default) ---
    { key: "pulseGlow",    label: "Pulse Glow",   defDur: "layer", group: "sustained", placement: "layerStart", sustained: true },
    { key: "hudOverlay",   label: "HUD Overlay",  defDur: "layer", group: "sustained", placement: "layerStart", sustained: true },
    { key: "dataStream",   label: "Data Stream",  defDur: "layer", group: "sustained", placement: "layerStart", sustained: true },
    { key: "oscilloscope", label: "Oscilloscope", defDur: "layer", group: "sustained", placement: "layerStart", sustained: true },
    { key: "digitalWave",  label: "Digital Wave", defDur: "layer", group: "sustained", placement: "layerStart", sustained: true },
    { key: "flickerBlocks",label: "Flicker Blocks", defDur: "layer", group: "sustained", placement: "layerStart", sustained: true },
    { key: "rgbOffset",    label: "RGB Offset",   defDur: "layer", group: "sustained", placement: "layerStart", sustained: true },
    { key: "textFlicker",  label: "Text Flicker", defDur: "layer", group: "sustained", placement: "layerStart", sustained: true },
    { key: "signalShake",  label: "Signal Shake", defDur: "layer", group: "sustained", placement: "layerStart", sustained: true },
    { key: "hologramTilt", label: "Hologram Tilt",defDur: "layer", group: "sustained", placement: "layerStart", sustained: true },
    // --- MOTION events ---
    { key: "microJitter",     label: "Micro Jitter",     defDur: 0.30, group: "motion" },
    { key: "magneticSnap",    label: "Magnetic Snap",    defDur: 0.15, group: "motion" },
    { key: "vectorLock",      label: "Vector Lock",      defDur: 0.25, group: "motion" },
    { key: "microZoomPop",    label: "Micro Zoom Pop",   defDur: 0.20, group: "motion" },
    { key: "coordShift",      label: "Coordinate Shift", defDur: 0.30, group: "motion" },
    { key: "vectorBeam",      label: "Vector Beam",      defDur: 0.35, group: "motion" },
    // --- OVERLAY events ---
    { key: "hudPulse",        label: "HUD Pulse",        defDur: 0.40, group: "overlay" },
    { key: "gridFlash",       label: "Grid Flash",       defDur: 0.20, group: "overlay" },
    { key: "lineTrace",       label: "Line Trace",       defDur: 1.20, group: "overlay", placement: "layerStart" },
    { key: "targetPing",      label: "Target Ping",      defDur: 0.60, group: "overlay" },
    { key: "waveformBurst",   label: "Waveform Burst",   defDur: 0.35, group: "overlay" },
    { key: "scanlineSurge",   label: "Scanline Surge",   defDur: 0.60, group: "overlay" },
    // --- VECTOR events (v19.8) — animate SVG stroke / fill properties.
    //     Work uniformly on native SHAPE layers and imported SVG.
    //     Text layers deliberately excluded (glyph outlines are complex).
    //     Extensible: new axes (dash-offset, stroke-color, etc.) plug
    //     into the same shapeStyle delta channel with no pipeline
    //     changes — see applyShapeStyleDelta. ---
    { key: "strokeWidthPulse", label: "Stroke Width Pulse", defDur: 0.60, group: "vector" },
    { key: "fillColorFlash",   label: "Fill Color Flash",   defDur: 0.40, group: "vector" },
    // v19.12 Fill Reveal.  Progressively reveals filled SVG geometry
    // via clip-path animation.  Unlike Line Draw (stroke geometry
    // only), this works on any filled artwork — imports, native
    // shapes, text — because it clips at the layer wrap level and
    // never mutates fills / gradients / colors.
    { key: "fillReveal",       label: "Fill Reveal",        defDur: 1.20, group: "vector", placement: "layerStart", persistEnd: true },
    // v19.14 SEGMENT REVEAL — reveals individual primitives inside an
    // SVG sequentially rather than wiping the composite.  Modes:
    // sequential, sequential-reverse, random (seeded), center-out,
    // edges-in.  Falls back to a single-primitive reveal on native
    // SHAPE layers.  Uses per-primitive opacity — preserves fills,
    // gradients, and stroke/fill colors exactly.
    { key: "segmentReveal",    label: "Segment Reveal",     defDur: 1.60, group: "vector", placement: "layerStart", persistEnd: true },
    // v19.14 EXPANSION BUILD — transition from small centered graphic
    // to full-frame visual.  Computes the target scale automatically
    // from the canvas / layer size ratio so the layer fills the frame
    // at p=1.  Optional cross-effects: fade during expansion, rotate
    // during expansion.  This is a transform/opacity delta, not a
    // vector-DOM mutation, so it works on every layer kind.
    { key: "expansionBuild",   label: "Expansion Build",    defDur: 1.50, group: "vector", placement: "layerStart", persistEnd: true },
    // v19.9 Morphing v1 — path-to-path interpolation.  Supports:
    //   rect ↔ rect · circle ↔ circle · ellipse ↔ ellipse · line ↔ line
    //   polygon ↔ polygon (same side count)
    //   rect ↔ circle ↔ ellipse (via 4-cubic-bezier normalization)
    //   SVG import ↔ SVG import (first primitive, matching command count)
    // Not supported v1: polygon side-count mismatch, path command count
    // mismatch, TEXT layers, multi-primitive SVG interpolation.  These
    // cases report through the clip inspector's compatibility badge
    // and skip the morph gracefully.
    { key: "shapeMorph",       label: "Shape Morph",        defDur: 1.00, group: "vector", persistEnd: true },
    // --- SIGNAL / GLITCH events ---
    { key: "terminalBlink",   label: "Terminal Blink",   defDur: 0.35, group: "signal" },
    { key: "signalDrop",      label: "Signal Drop",      defDur: 0.18, group: "signal" },
    { key: "phaseShift",      label: "Phase Shift",      defDur: 0.50, group: "signal" },
    { key: "dataScramble",    label: "Data Scramble",    defDur: 0.30, group: "signal" },
    { key: "frequencyJump",   label: "Frequency Jump",   defDur: 0.25, group: "signal" },
    { key: "digitalTear",     label: "Digital Tear",     defDur: 0.18, group: "signal" },
    { key: "syncFlash",       label: "Sync Flash",       defDur: 0.08, group: "signal" },
    { key: "noiseGate",       label: "Noise Gate",       defDur: 0.30, group: "signal" },
    { key: "ghostFrame",      label: "Ghost Frame",      defDur: 0.25, group: "signal" },
    { key: "lostSignal",      label: "Lost Signal",      defDur: 0.45, group: "signal" },
    { key: "pixelSweep",      label: "Pixel Sweep",      defDur: 0.60, group: "signal" },

    // --- v19.41 TEXT FX PACK + universal Weird / RGB Split (Pro) ---
    // Every entry declares category + supportedLayerTypes for the
    // Effect Capability System (see below).  UI panel filters the
    // picker automatically — no hardcoded rules.  paramDefs drive
    // the inspector's control generation.
    { key: "textScramble",   label: "Text Scramble",   defDur: 1.20, group: "text",
      category: "text", supportedLayerTypes: ["TEXT"], placement: "layerStart", persistEnd: true,
      paramDefs: [
        { key: "intensity",  label: "Intensity",  type: "range", min: 0, max: 100, step: 1, default: 60 },
        { key: "charset",    label: "Charset",    type: "select", options: ["alnum","binary","matrix","symbols","hex"], default: "matrix" },
        { key: "target",     label: "Target",     type: "select", options: ["char","word","line"], default: "char" },
        { key: "speed",      label: "Speed",      type: "range", min: 1, max: 60, step: 1, default: 24 },
        { key: "seed",       label: "Seed",       type: "range", min: 0, max: 1000, step: 1, default: 42 },
      ] },
    { key: "bulkTyping",     label: "Bulk Typing",     defDur: 2.00, group: "text",
      category: "text", supportedLayerTypes: ["TEXT"], placement: "layerStart", persistEnd: true,
      paramDefs: [
        { key: "cps",        label: "Chars/Sec",  type: "range", min: 1, max: 60, step: 1, default: 20 },
        { key: "cursor",     label: "Cursor",     type: "select", options: ["none","underscore","block","bar"], default: "underscore" },
        { key: "cursorBlink",label: "Blink Hz",   type: "range", min: 0, max: 8, step: 0.5, default: 2 },
        { key: "pausePunct", label: "Pause on . , ; :", type: "range", min: 0, max: 500, step: 10, default: 120 },
        { key: "backspace",  label: "Backspace At", type: "range", min: 0, max: 100, step: 1, default: 0 },
        { key: "backspaceAmt",label: "Backspace Chars", type: "range", min: 0, max: 40, step: 1, default: 6 },
      ] },
    { key: "animatedCounter",label: "Animated Counter",defDur: 1.60, group: "text",
      category: "text", supportedLayerTypes: ["TEXT"], persistEnd: true,
      paramDefs: [
        { key: "from",       label: "From",       type: "number", default: 0 },
        { key: "to",         label: "To",         type: "number", default: 1000 },
        { key: "decimals",   label: "Decimals",   type: "range", min: 0, max: 6, step: 1, default: 0 },
        { key: "separator",  label: "Thousands",  type: "select", options: ["none",",",".","'"," "], default: "," },
        { key: "prefix",     label: "Prefix",     type: "text", default: "" },
        { key: "suffix",     label: "Suffix",     type: "text", default: "" },
        { key: "easing",     label: "Easing",     type: "select", options: ["linear","easeOut","easeInOut","expoOut"], default: "easeOut" },
      ] },
    { key: "odometer",       label: "Odometer",        defDur: 1.60, group: "text",
      category: "text", supportedLayerTypes: ["TEXT"], persistEnd: true,
      paramDefs: [
        { key: "from",       label: "From",       type: "number", default: 0 },
        { key: "to",         label: "To",         type: "number", default: 100 },
        { key: "digits",     label: "Digit Slots",type: "range", min: 0, max: 10, step: 1, default: 0 },
        { key: "reverse",    label: "Reverse",    type: "select", options: ["no","yes"], default: "no" },
        { key: "easing",     label: "Easing",     type: "select", options: ["linear","easeOut","easeInOut","expoOut"], default: "easeOut" },
        { key: "prefix",     label: "Prefix",     type: "text", default: "" },
        { key: "suffix",     label: "Suffix",     type: "text", default: "" },
      ] },
    { key: "charStagger",    label: "Character Stagger", defDur: 1.00, group: "text",
      category: "text", supportedLayerTypes: ["TEXT"], placement: "layerStart", persistEnd: true,
      paramDefs: [
        { key: "target",     label: "Unit",       type: "select", options: ["char","word","line"], default: "char" },
        { key: "stagger",    label: "Per-Unit Delay (ms)", type: "range", min: 0, max: 400, step: 5, default: 60 },
        { key: "duration",   label: "Per-Unit Dur (ms)",   type: "range", min: 50, max: 1000, step: 10, default: 350 },
        { key: "distance",   label: "Distance",   type: "range", min: 0, max: 200, step: 1, default: 40 },
        { key: "direction",  label: "Direction",  type: "select", options: ["up","down","left","right","fade","scale"], default: "up" },
        { key: "order",      label: "Order",      type: "select", options: ["forward","reverse","center","edges","random"], default: "forward" },
      ] },
    { key: "sineWaveText",   label: "Sine Wave Text",  defDur: "layer", group: "text",
      category: "text", supportedLayerTypes: ["TEXT"], placement: "layerStart", sustained: true,
      paramDefs: [
        { key: "amplitude",  label: "Amplitude",  type: "range", min: 0, max: 100, step: 1, default: 20 },
        { key: "wavelength", label: "Wavelength", type: "range", min: 20, max: 800, step: 5, default: 200 },
        { key: "speed",      label: "Speed",      type: "range", min: 0, max: 8, step: 0.1, default: 1.0 },
        { key: "axis",       label: "Axis",       type: "select", options: ["y","x","both"], default: "y" },
        { key: "target",     label: "Unit",       type: "select", options: ["char","word"], default: "char" },
      ] },
    { key: "rgbSplitPro",    label: "RGB Split (Pro)", defDur: "layer", group: "signal",
      category: "universal", supportedLayerTypes: ["TEXT","IMG","SVG","VIDEO","SHAPE"], sustained: true,
      paramDefs: [
        { key: "distance",   label: "Distance",   type: "range", min: 0, max: 40, step: 0.5, default: 6 },
        { key: "angle",      label: "Angle",      type: "range", min: 0, max: 360, step: 1, default: 0 },
        { key: "jitter",     label: "Jitter",     type: "range", min: 0, max: 100, step: 1, default: 0 },
        { key: "intensity",  label: "Intensity",  type: "range", min: 0, max: 100, step: 1, default: 100 },
        { key: "blend",      label: "Blend",      type: "select", options: ["screen","add","lighten","normal"], default: "screen" },
      ] },
    { key: "weirdGlitch",    label: "Weird",           defDur: "layer", group: "signal",
      category: "universal", supportedLayerTypes: ["TEXT","IMG","SVG","VIDEO","SHAPE"], sustained: true,
      paramDefs: [
        { key: "glitchChance", label: "Glitch Chance", type: "range", min: 0, max: 100, step: 1, default: 40 },
        { key: "glitchSpeed",  label: "Glitch Speed",  type: "range", min: 1, max: 30,  step: 1, default: 10 },
        { key: "sliceDensity", label: "Slice Density", type: "range", min: 0, max: 100, step: 1, default: 45 },
        { key: "sliceStrength",label: "Slice Strength",type: "range", min: 0, max: 100, step: 1, default: 40 },
        { key: "shake",        label: "Shake",         type: "range", min: 0, max: 100, step: 1, default: 20 },
        { key: "chroma",       label: "Chroma Split",  type: "range", min: 0, max: 100, step: 1, default: 30 },
        { key: "noise",        label: "Noise",         type: "range", min: 0, max: 100, step: 1, default: 15 },
        { key: "colorFlash",   label: "Color Flash",   type: "range", min: 0, max: 100, step: 1, default: 10 },
        { key: "scanlineDrop", label: "Scanline Drop", type: "range", min: 0, max: 100, step: 1, default: 20 },
        { key: "seed",         label: "Seed",          type: "range", min: 0, max: 1000, step: 1, default: 137 },
      ] },
    { key: "svgTextOnPath",  label: "SVG Text on Path",defDur: "layer", group: "text",
      category: "text", supportedLayerTypes: ["TEXT","SVG"], placement: "layerStart", sustained: true, persistEnd: true,
      paramDefs: [
        { key: "pathD",      label: "Path (d attr)", type: "text", default: "M 20 100 Q 200 20 380 100 T 740 100" },
        { key: "startOffset",label: "Start Offset (%)", type: "range", min: 0, max: 100, step: 1, default: 0 },
        { key: "reverse",    label: "Reverse",    type: "select", options: ["no","yes"], default: "no" },
        { key: "align",      label: "Align",      type: "select", options: ["start","middle","end"], default: "start" },
        { key: "fitToPath",  label: "Fit To Path",type: "select", options: ["no","yes"], default: "no" },
        { key: "animateOffset",label: "Animate Speed", type: "range", min: 0, max: 200, step: 1, default: 0 },
      ] },
  ];
  const FX_EVENT_KEYS = new Set(FX_EVENTS.map((f) => f.key));
  // Lookup: key → definition (for placement / defDur / sustained flag)
  const FX_EVENT_DEF = new Map(FX_EVENTS.map((f) => [f.key, f]));

  /* v19.41 Effect Capability System.
   *
   * Every FX_EVENTS entry declares:
   *   category            — "universal" | "text" | "image" | "video" | "svg"
   *   supportedLayerTypes — subset of ["TEXT","IMG","SVG","VIDEO","SHAPE"]
   *
   * Entries pre-dating v19.41 get defaults filled in below so nothing
   * breaks.  The Effects panel filters buttons via
   * `fx.supportedLayerTypes.includes(layer.kind)` — the UI is
   * generated purely from this metadata, so adding a new effect
   * requires only adding an FX_EVENTS entry.
   *
   * Layer kinds: TEXT, IMG, SVG, VIDEO, SHAPE, GROUP.
   */
  const FX_CAPABILITY = {
    // Effects predating v19.41 that historically ran on SVG geometry
    // target SHAPE + SVG.  Everything else defaults to universal.
    vectorOnly: new Set([
      "lineDraw", "trimPaths", "symbolTrans", "fillReveal", "segmentReveal",
      "expansionBuild", "shapeMorph", "strokeWidthPulse", "fillColorFlash", "pathEnergize",
    ]),
    textOnly: new Set([
      "textFlicker", "textReplace",
    ]),
  };
  (function _hydrateFxCapability() {
    for (const fx of FX_EVENTS) {
      if (!fx.category) {
        if (FX_CAPABILITY.textOnly.has(fx.key))       fx.category = "text";
        else if (FX_CAPABILITY.vectorOnly.has(fx.key)) fx.category = "svg";
        else                                            fx.category = "universal";
      }
      if (!fx.supportedLayerTypes) {
        if (fx.category === "text")           fx.supportedLayerTypes = ["TEXT"];
        else if (fx.category === "svg")       fx.supportedLayerTypes = ["SHAPE", "SVG"];
        else if (fx.category === "video")     fx.supportedLayerTypes = ["VIDEO"];
        else if (fx.category === "image")     fx.supportedLayerTypes = ["IMG"];
        else                                  fx.supportedLayerTypes = ["TEXT","IMG","SVG","VIDEO","SHAPE"];
      }
    }
  })();
  function fxSupportsLayer(fx, layer) {
    if (!layer) return false;
    if (!fx.supportedLayerTypes) return true;
    return fx.supportedLayerTypes.includes(layer.kind);
  }
  const FX_EVENT_GROUPS = [
    { id: "text",      label: "Text FX" },
    { id: "reveal",    label: "Reveal" },
    { id: "sustained", label: "Sustained" },
    { id: "core",      label: "Core" },
    { id: "motion",    label: "Motion" },
    { id: "signal",    label: "Signal / Glitch" },
    { id: "overlay",   label: "Overlay / HUD" },
    // v19.8: vector-animation effects grouped separately so users can
    // find them when working with shape/SVG layers.
    { id: "vector",    label: "Vector" },
  ];

  // Per-event default parameters. Kept minimal: intensity is the universal
  // strength dial (0-100), other params are per-event where meaningful.
  // The event handler in EVENT_EFFECTS reads these off the second arg.
  function defaultParamsFor(key) {
    const base = { intensity: 50, opacityMix: 100 };
    switch (key) {
      case "microJitter":   return { ...base, intensity: 40 };
      case "hudPulse":      return { ...base, intensity: 60 };
      case "digitalTear":   return { ...base, intensity: 55, direction: 0 };
      case "targetPing":    return { ...base, intensity: 60 };
      case "microZoomPop":  return { ...base, intensity: 40 };
      case "magneticSnap":  return { ...base, intensity: 60, direction: 0 };
      case "coordShift":    return { ...base, intensity: 45, direction: 0 };
      case "phaseShift":    return { ...base, intensity: 50 };
      case "waveformBurst": return { ...base, intensity: 55 };
      case "lineTrace":     return { ...base, intensity: 70 };
      case "signalDrop":    return { ...base, intensity: 65 };
      case "dataScramble":  return { ...base, intensity: 55 };
      case "noiseGate":     return { ...base, intensity: 50 };
      case "ghostFrame":    return { ...base, intensity: 50 };
      case "syncFlash":     return { ...base, intensity: 70 };
      case "scanlineSurge": return { ...base, intensity: 55 };
      case "gridFlash":     return { ...base, intensity: 60 };
      case "terminalBlink": return { ...base, intensity: 55 };
      case "frequencyJump": return { ...base, intensity: 65 };
      case "vectorLock":    return { ...base, intensity: 50 };
      // High-end effects have rich per-event parameter sets. Every field
      // listed here becomes an editable slider (or seg control) in the
      // Selected clip inspector — see EVENT_PARAM_SCHEMA below.
      // Lost Signal — corruption anchored to the layer; NO global
      // transform jitter (see anchorStability default 100).
      case "lostSignal":    return { ...base, intensity: 70, opacityMix: 100,
        rgbSeparation: 55, sliceCount: 14, sliceDisplacement: 24,
        corruptionAmount: 65, corruptionDirection: "right", rightBias: 85,
        dataLeakage: 55, leakageLength: 38, leakageDensity: 35,
        randomness: 55, anchorStability: 100 };
      case "vectorBeam":    return { ...base, intensity: 75, opacityMix: 100,
        direction: "right", beamLength: 100, beamWidth: 8,
        trailCount: 4, trailOpacity: 55, trailSpread: 10,
        glowStrength: 20, flickerAmount: 25, freezeDuration: 0.08,
        sourceFlash: 45, growthEasing: "hard" };
      // Pixel Sweep — Phase 1 defaults.  Progress is driven by the
      // clip's own time normalization (0 at clip.start → 1 at
      // clip.end).  Direction/sampleWidth/trailLength/sampleMode/
      // preserveAlpha are user-tunable.
      case "pixelSweep":    return { ...base, intensity: 100,
        direction: "right", sampleWidth: 2, trailLength: 40,
        sampleMode: "center", preserveAlpha: true };
      // v19.8 vector-animation effects.
      //  - strokeWidthPulse: intensity controls how much the stroke
      //    swells at peak (multiplier applied to the shape's base
      //    stroke width).  No color param.
      //  - fillColorFlash: color is user-editable per clip; the
      //    inspector renders a color-picker row (see renderClipInspector).
      case "strokeWidthPulse": return { ...base, intensity: 60 };
      case "fillColorFlash":   return { ...base, intensity: 70, color: "#FF3366" };
      // v19.12 Fill Reveal.  `direction` picks the reveal mode.
      // Values: "left" (→ right), "right", "top", "bottom",
      // "center-out" (rectangular growth), "radial" (circular growth).
      // Angle-based directional reveal is planned separately.
      case "fillReveal":       return { ...base, intensity: 100, direction: "left" };
      // v19.14 Segment Reveal defaults.
      //  - mode: sequential | sequential-reverse | random | center-out | edges-in
      //  - spread: 0-100 = how tight the stagger is.  0 = all-at-once
      //    (degenerates to Fill Reveal), 100 = last piece starts as
      //    the first piece ends.  Default 60 = pleasant overlap.
      //  - seed: only used for random mode; kept stable across
      //    replays so the animation is deterministic.
      case "segmentReveal":    return { ...base, intensity: 100, mode: "sequential", spread: 60, seed: 1 };
      // v19.14 Expansion Build defaults (v19.15 redesigned for cinematic drama).
      //  - mode: expand | expand-fade | expand-rotate | expand-blur |
      //          explosive | fit-canvas
      //    Default `expand`: pure scale to the user's targetScale.
      //    `explosive`: preset combining fade + blur + rotate + easeInQuint.
      //    `fit-canvas`: auto-computes targetScale from canvas/layer ratio.
      //  - targetScale: 1..100x multiplier.  Default 20x for immediate
      //    drama (was 0=auto-fit in v19.14, which felt too tame).
      //    Ignored when mode = fit-canvas.
      //  - origin: "object-center" (default, expands from layer's own
      //    center — cinematic zoom-into feel) or "canvas-center"
      //    (layer's on-canvas position pulled toward center as scale
      //    grows).  Custom focal point is a planned future addition.
      //  - ease: easeIn | easeInQuint | linear | easeOut | easeInOut
      //    easeInQuint (t^5) gives the "held still then explodes" feel.
      //  - rotateAmount: degrees during expansion (rotate/explosive modes).
      //  - blurAmount: max blur px (blur/explosive modes).
      case "expansionBuild":   return { ...base, intensity: 100,
        mode: "expand", targetScale: 20, origin: "object-center",
        ease: "easeIn", rotateAmount: 180, blurAmount: 12 };
      // v19.9 Shape Morph.  morphTargetLayerId is 0 by default (=
      // "no target"), and the effect no-ops until the user picks one.
      case "shapeMorph":       return { ...base, intensity: 100, morphTargetLayerId: 0, morphTargetIndex: 0 };
      default: {
        // v19.41: seed defaults from paramDefs when present.  New
        // effects only need paramDefs — no defaultParamsFor case.
        const def = FX_EVENT_DEF && FX_EVENT_DEF.get(key);
        if (def && def.paramDefs) {
          const out = { ...base };
          for (const pd of def.paramDefs) out[pd.key] = pd.default;
          return out;
        }
        return { ...base };
      }
    }
  }

  /* Per-event slider schema — the inspector shows intensity + opacityMix
     for every event; if a schema entry exists for the event key, its
     extra params render as sliders below.  Format: [key, label, min, max,
     step?].  Segmented controls (direction / growthEasing) are handled
     separately in renderClipInspector. */
  const EVENT_PARAM_SCHEMA = {
    lostSignal: [
      // corruptionDirection handled as 3-way seg control below
      ["rgbSeparation",     "RGB separation",   0, 100],
      ["sliceCount",        "Slice count",      2,  32, 1],
      ["sliceDisplacement", "Displacement",     0, 100],
      ["corruptionAmount",  "Corruption",       0, 100],
      ["rightBias",         "Right bias",       0, 100],
      ["dataLeakage",       "Data leakage",     0, 100],
      ["leakageLength",     "Leakage length",   0, 100],
      ["leakageDensity",    "Leakage density",  0, 100],
      ["randomness",        "Randomness",       0, 100],
      ["anchorStability",   "Anchor stability", 0, 100],
    ],
    vectorBeam: [
      // direction handled as 4-way seg control (right/left/up/down)
      ["beamLength",     "Beam length",   0, 200],
      ["beamWidth",      "Beam width",    1,  40, 1],
      ["trailCount",     "Trails",        0,   8, 1],
      ["trailOpacity",   "Trail opacity", 0, 100],
      ["trailSpread",    "Trail spread",  0,  40],
      ["glowStrength",   "Glow",          0,  60],
      ["flickerAmount",  "Flicker",       0, 100],
      ["freezeDuration", "Freeze (s)",    0,   1, 0.01],
      ["sourceFlash",    "Source flash",  0, 100],
      // growthEasing handled as hard/ease seg control
    ],
    // Pixel Sweep — Phase 1 params.  Direction handled as 4-way seg
    // control (shared code path with vectorBeam).
    pixelSweep: [
      ["sampleWidth",  "Sample width (px)",  1,  32, 1],
      ["trailLength",  "Trail length (%)",   0, 100, 1],
      // sampleMode handled as 2-way seg control (see below)
    ],
  };

  /* ---------------- PRESETS (public names, no private refs) ----------------
     fx: effect keys. patch: scene params. transform stays off unless the
     preset explicitly needs it (none of the defaults rotate/zoom). */
  const PRESETS = {
    "Signal System":       { fx: ["scanRevealEvent","rgbOffset","hudOverlay","flickerBlocks","dataBreakEvent"], patch: { flicker: 38, rgbSplit: 32, scanline: 55, noise: 26 } },
    "Hardware Motion":     { fx: ["scanRevealEvent","blurIn","hudOverlay","pulseGlow"], patch: { flicker: 26, scanline: 60, glow: 55, blur: 14 } },
    "Vector Scan":         { fx: ["scanRevealEvent","radarSweep","hudOverlay","lineDraw"], patch: { flicker: 30, scanline: 75, glow: 45, noise: 16 } },
    "Signal Loss":         { fx: ["hardCutEvent","dataBreakEvent","rgbOffset","flickerBlocks","scanRevealEvent"], patch: { glitch: 60, flicker: 78, rgbSplit: 55, scanline: 62, noise: 55 } },
    "Data Pulse":          { fx: ["pulseGlow","rgbOffset","dataStream","hardCutEvent"], patch: { glow: 70, rgbSplit: 40, scanline: 55, flicker: 30 } },
    "Clean Motion Poster": { fx: ["blurIn","pulseGlow"], patch: { flicker: 10, blur: 16, scanline: 14, noise: 6, glow: 45 } },
    "CRT Monitor":         { fx: ["scanRevealEvent","dataBreakEvent","oscilloscope","pulseGlow"], patch: { flicker: 28, blur: 10, scanline: 95, noise: 34, glow: 40 } },
    "Interface Intro":     { fx: ["blurIn","lineDraw","hudOverlay","rgbOffset"], patch: { flicker: 26, scanline: 50, rgbSplit: 30, glow: 45 }, stagger: true },
    "Hardware Motion Intro":{ fx: ["blurIn","scanRevealEvent","hudOverlay","coordBlinkEvt","trimPaths"], patch: { flicker: 24, scanline: 55, glow: 50, blur: 12 }, stagger: true },
    "Terrain Scanner":     { fx: ["lineDraw","radarSweep","coordBlinkEvt","scanRevealEvent","dataStream","rgbOffset"], patch: { flicker: 22, scanline: 60, rgbSplit: 22, glow: 50, noise: 14 } },
    "Detroit Techno":      { fx: ["hardCutEvent","rgbOffset","scanRevealEvent","flickerBlocks","pulseGlow"], patch: { flicker: 42, rgbSplit: 46, scanline: 42, glow: 55, bassReaction: 90, motionIntensity: 85 } },
    "Data Terminal":       { fx: ["textFlicker","hudOverlay","coordBlinkEvt","dataStream","oscilloscope","scanRevealEvent"], patch: { flicker: 34, scanline: 60, noise: 20, glow: 40 } },
  };

  /* ---------------- DOM ---------------- */
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const el = {
    dropzone: $("#dropzone"), fileInput: $("#fileInput"), exposeSubToggle: $("#exposeSubToggle"),
    assetList: $("#assetList"), assetCount: $("#assetCount"),
    presetGrid: $("#presetGrid"), applyAll: $("#applyAll"), clearPresetBtn: $("#clearPresetBtn"),
    layerStack: $("#layerStack"), layerCount: $("#layerCount"),
    stage: $("#stage"), stageWorkspace: $("#stageWorkspace"), artboardScaler: $("#artboardScaler"), artboard: $("#artboard"), artboardBg: $("#artboardBg"),
    layerHost: $("#layerHost"), artboardFrame: $("#artboardFrame"), selectionBox: $("#selectionBox"),
    stageHint: $("#stageHint"),
    readoutCanvas: $("#readoutCanvas"), readoutFormat: $("#readoutFormat"), readoutZoom: $("#readoutZoom"), readoutSel: $("#readoutSel"),
    zoomIn: $("#zoomIn"), zoomOut: $("#zoomOut"), zoomFit: $("#zoomFit"), zoomVal: $("#zoomVal"),
    playBtn: $("#playBtn"), playIcon: $("#playIcon"), pauseIcon: $("#pauseIcon"),
    topPlayBtn: $("#topPlayBtn"), topPlayIcon: $("#topPlayIcon"), topPauseIcon: $("#topPauseIcon"),
    loopBtn: $("#loopBtn"), timecode: $("#timecode"),
    aiPrompt: $("#aiPrompt"), aiRun: $("#aiRun"), aiEcho: $("#aiEcho"),
    // transform
    transformEmpty: $("#transformEmpty"), transformBody: $("#transformBody"),
    lockAspect: $("#lockAspect"),
    tfCenter: $("#tfCenter"), tfFit: $("#tfFit"), tfFill: $("#tfFill"), tfOriginal: $("#tfOriginal"), tfReset: $("#tfReset"),
    layerDup: $("#layerDup"), layerHide: $("#layerHide"), layerLock: $("#layerLock"), layerDel: $("#layerDel"),
    layerClearFx: $("#layerClearFx"),
    svgDiagGroup: $("#svgDiagGroup"), svgDiagStatus: $("#svgDiagStatus"), svgDiagBody: $("#svgDiagBody"),
    // video (Phase 2)
    videoGroup: $("#videoGroup"), videoDurLabel: $("#videoDurLabel"),
    vFitTrim: $("#vFitTrim"), vResetTrim: $("#vResetTrim"),
    // v19.22: unified Fill & Stroke — new opacity + utility refs.
    // The legacy `colorGroup` / fillColor / strokeColor / colApply*
    // controls have been removed in favor of the unified panel.
    shapeFillOpacity: $("#shapeFillOpacity"), shapeFillOpacityRange: $("#shapeFillOpacityRange"),
    shapeStrokeOpacity: $("#shapeStrokeOpacity"), shapeStrokeOpacityRange: $("#shapeStrokeOpacityRange"),
    shapeSvgUtilsRow: $("#shapeSvgUtilsRow"),
    shapeSvgUtilsHead: $("#shapeSvgUtilsHead"),
    shapeMonoBtn: $("#shapeMonoBtn"), shapeInvertBtn: $("#shapeInvertBtn"),
    // fx
    fxEmpty: $("#fxEmpty"), fxBody: $("#fxBody"), fxToggleGrid: $("#fxToggleGrid"), fxEventGrid: $("#fxEventGrid"), allowTransform: $("#allowTransform"),
    attachSfx: $("#attachSfx"), attachSfxSel: $("#attachSfxSel"),
    // selected clip
    clipEmpty: $("#clipEmpty"), clipBody: $("#clipBody"), clipType: $("#clipType"), clipTrack: $("#clipTrack"),
    clipMute: $("#clipMute"), clipDup: $("#clipDup"), clipDel: $("#clipDel"), clipPreview: $("#clipPreview"), clipVolRow: $("#clipVolRow"),
    // audio
    audioBtn: $("#audioBtn"), audioInput: $("#audioInput"), levelFill: $("#levelFill"), audioName: $("#audioName"),
    audioReactiveToggle: $("#audioReactiveToggle"), beatMeter: $("#beatMeter"),
    bpmVal: $("#bpmVal"), snapBeat: $("#snapBeat"), autoKeyframes: $("#autoKeyframes"),
    // sfx library
    sfxDropzone: $("#sfxDropzone"), sfxInput: $("#sfxInput"), sfxList: $("#sfxList"), sfxCount: $("#sfxCount"),
    // mixer
    mixerGroup: $("#mixerGroup"),
    // bg
    bgColor: $("#bgColor"), bgHex: $("#bgHex"),
    // timeline
    tlBody: $("#tlBody"), tlRuler: $("#tlRuler"), tlTracks: $("#tlTracks"), tlEmpty: $("#tlEmpty"), tlPlayhead: $("#tlPlayhead"),
    tlAudioTracks: $("#tlAudioTracks"), tlTracksWrap: $("#tlTracksWrap"), durSegTl: $("#durSegTl"),
    tlZoom: $("#tlZoom"), markerBtn: $("#markerBtn"), snapFrameBtn: $("#snapFrameBtn"),
    // v18.8 timeline precision — snap toggles + zoom helpers + timecode goto
    snapPlayheadBtn: $("#snapPlayheadBtn"), snapClipsBtn: $("#snapClipsBtn"),
    zoomFitAllBtn: $("#zoomFitAllBtn"), zoomToSelBtn: $("#zoomToSelBtn"),
    tcGoto: $("#tcGoto"),
    // v19.0 Text Tool + text inspector + playhead frame + status bar
    toolStrip: $("#toolStrip"), toolSelect: $("#toolSelect"), toolText: $("#toolText"),
    // v19.2 Shape Tools — 5 tool buttons + shape inspector
    toolRect: $("#toolRect"), toolCircle: $("#toolCircle"), toolEllipse: $("#toolEllipse"),
    toolLine: $("#toolLine"), toolPolygon: $("#toolPolygon"),
    shapeGroup: $("#shapeGroup"), shapeTypeBadge: $("#shapeTypeBadge"),
    shapeFill: $("#shapeFill"), shapeFillHex: $("#shapeFillHex"), shapeFillOn: $("#shapeFillOn"),
    shapeStroke: $("#shapeStroke"), shapeStrokeHex: $("#shapeStrokeHex"), shapeStrokeOn: $("#shapeStrokeOn"),
    shapeStrokeW: $("#shapeStrokeW"), shapeStrokeWRange: $("#shapeStrokeWRange"),
    shapeCornerR: $("#shapeCornerR"), shapeCornerRRange: $("#shapeCornerRRange"),
    shapeCornerRow: $("#shapeCornerRow"),
    shapeSides: $("#shapeSides"), shapeSidesRange: $("#shapeSidesRange"),
    shapeSidesRow: $("#shapeSidesRow"),
    textGroup: $("#textGroup"),
    textContent: $("#textContent"), textFontFamily: $("#textFontFamily"),
    textSize: $("#textSize"), textSizeRange: $("#textSizeRange"),
    textWeight: $("#textWeight"),
    textColor: $("#textColor"), textColorHex: $("#textColorHex"),
    textAlignSeg: $("#textAlignSeg"),
    textLetterSpacing: $("#textLetterSpacing"), textLineHeight: $("#textLineHeight"),
    timecodeFrame: $("#timecodeFrame"),
    readoutFilename: $("#readoutFilename"),
    // export
    exportBtn: $("#exportBtn"), exportSheet: $("#exportSheet"), exportClose: $("#exportClose"),
    exportPng: $("#exportPng"), exportPngT: $("#exportPngT"), exportSeq: $("#exportSeq"), exportSeqT: $("#exportSeqT"),
    exportWebm: $("#exportWebm"), exportWebmA: $("#exportWebmA"), exportMp4: $("#exportMp4"),
    exportStatus: $("#exportStatus"), optTransparent: $("#optTransparent"), optAudio: $("#optAudio"),
    layerModeRow: $("#layerModeRow"),
    toast: $("#toast"),
  };

  /* ---------------- AUDIO / SFX STATE ---------------- */
  // Audio graph:
  //   [each clip source] -> [clip GainNode] -> [trackBus GainNode] -> [masterBus] -> destination
  // Music (main track) uses a separate MediaElementSource -> analyser + musicBus.
  // Peaks/BPM come from the analyser reading of the music.
  const sounds = [];         // library: { id, name, url, buffer, duration }
  const audioClips = [];     // placed on timeline: { id, soundId, track: 'sfx1'|'sfx2'|'sfx3'|'voice', start, duration, volume, muted, selected, gain, source }
  const markers = [];        // { type: 'beat'|'peak'|'manual', time }
  let selectedAudioClip = null;
  const AUDIO_TRACKS = [
    { id: "music",  label: "Music",  color: "music",  fixed: true },
    { id: "sfx1",   label: "SFX 1",  color: "sfx",    fixed: false },
    { id: "sfx2",   label: "SFX 2",  color: "sfx",    fixed: false },
    { id: "sfx3",   label: "SFX 3",  color: "sfx",    fixed: false },
    { id: "voice",  label: "Voice",  color: "voice",  fixed: false },
  ];

  /* ---------------- ASSETS + LAYERS ---------------- */
  const assets = [];
  /* v19.18: Cross-layer ID resolution that also searches group
     members.  When layers are grouped, they're removed from the
     top-level `layers[]` array and stored in `group._members[]`.
     Cross-layer references (morph targetLayerId, and any future
     effects that reference other layers by ID) must still resolve
     when the target is inside a group — otherwise grouping silently
     invalidates existing animation relationships. */
  function findLayerAnywhere(id) {
    if (id == null) return null;
    const top = layers.find((L) => L.id === id);
    if (top) return top;
    for (const L of layers) {
      if (L.kind === "GROUP" && L._members) {
        const found = L._members.find((m) => m.id === id);
        if (found) return found;
      }
    }
    return null;
  }

  const layers = [];   // index 0 = back
  // v19.17: forward references to group helpers (defined inside setup()).
  // Allows module-scope functions like duplicateLayer to invoke them.
  let _groupSelectedLayers = null;
  let _ungroupSelectedLayer = null;
  let selectedLayer = null, idSeq = 0;
  /* v19.4 multi-selection.  selectedLayer stays as "primary" (drives
     inspector, transform display, primary highlight); selectedLayers
     mirrors selectedLayer for compatibility PLUS holds any additional
     Shift/Cmd-clicked layers.  Multi-affecting operations (Delete,
     Duplicate) iterate selectedLayers. */
  let selectedLayers = [];   // includes primary; empty when nothing selected

  function toast(msg, ms) {
    if (!el.toast) return;
    el.toast.textContent = msg; el.toast.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(() => el.toast.classList.remove("show"), ms || 2400);
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  function handleFiles(fileList) {
    const files = Array.from(fileList || []); if (!files.length) return;
    let ok = 0;
    files.forEach((file) => {
      const reader = new FileReader();
      if (file.type.includes("svg") || file.name.toLowerCase().endsWith(".svg")) { reader.onload = (e) => addSvgAsset(file.name, e.target.result); reader.readAsText(file); ok++; }
      else if (file.type.startsWith("image/")) { reader.onload = (e) => addImageAsset(file.name, e.target.result); reader.readAsDataURL(file); ok++; }
      else if (file.type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(file.name)) { addVideoAsset(file); ok++; }
    });
    if (!ok) toast("No supported files (SVG, PNG, JPG, WebP, MP4, WebM)");
  }

  function addSvgAsset(name, svgText) {
    try {
      const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
      const svg = doc.querySelector("svg");
      if (!svg || doc.querySelector("parsererror")) { toast(`Couldn't read ${name}`); return; }
      // preserve viewBox / aspect ratio
      let vb = svg.getAttribute("viewBox");
      let w = parseFloat(svg.getAttribute("width")) || 0, h = parseFloat(svg.getAttribute("height")) || 0;
      if (!vb) { if (!w) w = 300; if (!h) h = 300; svg.setAttribute("viewBox", `0 0 ${w} ${h}`); vb = `0 0 ${w} ${h}`; }
      const parts = vb.split(/[\s,]+/).map(Number);
      const natW = w || parts[2] || 300, natH = h || parts[3] || 300;
      svg.removeAttribute("width"); svg.removeAttribute("height");
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      // detect complex styling (style blocks / CSS classes) for color note
      const complex = !!svg.querySelector("style") || /class=/.test(svgText);
      registerAsset(name, "SVG", document.importNode(svg, true), null, { natW, natH, complex });
    } catch (e) { toast(`Couldn't read ${name}`); }
  }
  function addImageAsset(name, dataUrl) {
    const img = new Image();
    img.onload = () => registerAsset(name, "IMG", img, dataUrl, { natW: img.naturalWidth || 512, natH: img.naturalHeight || 512, complex: false });
    img.onerror = () => toast(`Couldn't load ${name}`);
    img.src = dataUrl; img.alt = name;
  }

  /* v19.31 Replace Asset — swap a layer's underlying image / SVG / video
   * source while preserving position, size, rotation, timeline timing,
   * clips, effects, and animations.  Only the source content changes.
   *
   * Scope for v1:
   *   IMG ↔ IMG, IMG ↔ SVG, SVG ↔ IMG, SVG ↔ SVG all supported.
   *   VIDEO source replacement not yet — WebCodecs re-init is a
   *   bigger surgery.  Attempted replace of VIDEO source shows a
   *   "not yet" toast so the user knows why.
   *
   * The layer's transform (cx, cy, wPct, hPct, rot, opacity) is
   * preserved verbatim — so the new asset shows up at the same
   * canvas position and size as the original.  If the new asset
   * has a different aspect ratio, that's user's call to fix. */
  function replaceLayerAsset(layer, file) {
    if (!layer || !file) return;
    if (layer.kind === "TEXT" || layer.kind === "GROUP") {
      toast(`Cannot replace asset on ${layer.kind} layers`);
      return;
    }
    const name = file.name;
    const isSvg   = file.type.includes("svg") || name.toLowerCase().endsWith(".svg");
    const isImg   = file.type.startsWith("image/") && !isSvg;
    const isVideo = file.type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(name);
    if (!isSvg && !isImg && !isVideo) {
      toast("Replace: unsupported file type");
      return;
    }
    // v19.33: video replacement.  Uses the same WebCodecs VideoSource
    // as the initial import — we build a fresh VideoSource from the
    // new file, close the old one, and swap references.  The layer's
    // canvas node is resized if the new video has different natural
    // dimensions; layer.transform (cx/cy/wPct/hPct/rot) is untouched
    // so the visual size on stage is preserved.
    if (isVideo) {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const buf = e.target.result;
        try {
          const newSource = await VideoSource.create(buf);
          if (layer.videoSource) { try { layer.videoSource.close(); } catch (_) {} }
          // v19.37 → v19.38: reset all coalesce + dedup state so the
          // new source doesn't reuse stale targets from the old one.
          if (layer._vidCoalesce) {
            layer._vidCoalesce.pending = null;
            layer._vidCoalesce.seeking = false;
            layer._vidCoalesce.lastAppliedT = -1;
            if (layer._vidCoalesce.requestedIdx) layer._vidCoalesce.requestedIdx.clear();
          }
          layer.videoSource = newSource;
          layer.natW = newSource.width;
          layer.natH = newSource.height;
          layer.name = name;
          // v19.39: swap the native preview element to the new source.
          // Reuse the same offscreen slot; revoke the old URL after
          // the new one loads to prevent double-URL retention.
          if (layer._previewVideoEl) {
            const oldUrl = layer._previewVideoUrl;
            try { layer._previewVideoEl.pause(); } catch (_) {}
            const newBlob = new Blob([buf], { type: "video/mp4" });
            const newUrl = URL.createObjectURL(newBlob);
            try { layer._previewVideoEl.src = newUrl; layer._previewVideoEl.load(); } catch (_) {}
            layer._previewVideoUrl = newUrl;
            if (oldUrl) { try { URL.revokeObjectURL(oldUrl); } catch (_) {} }
          }
          // Resize the canvas preview to the new natural size (subject
          // to the current preview-quality cap).
          if (layer.node && layer.node.tagName === "CANVAS") {
            const cap = previewCanvasSizeFor(layer.natW, layer.natH);
            layer.node.width  = cap.w;
            layer.node.height = cap.h;
            // Prime with frame 0 of the new video.
            newSource.getFrameAtSourceTime(0).then((frame) => {
              try {
                layer.node.getContext("2d").drawImage(frame, 0, 0, layer.node.width, layer.node.height);
              } catch (_) {}
              paintIfPaused();
            }).catch(() => {});
          }
          renderLayers(); renderInspector(); paintIfPaused();
          toast(`Replaced with ${name}`);
        } catch (err) {
          console.warn("Video replace failed", err);
          toast(`Couldn't load ${name} — ${err.message || "video decode failed"}`);
        }
      };
      reader.readAsArrayBuffer(file);
      return;
    }
    // Image / SVG replacement — same pipeline as v19.31, kind can
    // still change (IMG↔SVG).  Cross-type into video is not
    // supported (would require rebuilding the whole layer stack).
    if (layer.kind === "VIDEO" && !isVideo) {
      toast("Cannot replace video layer with a non-video asset — remove and re-import");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      if (isSvg) {
        try {
          const doc = new DOMParser().parseFromString(e.target.result, "image/svg+xml");
          const svg = doc.querySelector("svg");
          if (!svg || doc.querySelector("parsererror")) { toast(`Couldn't read ${name}`); return; }
          let vb = svg.getAttribute("viewBox");
          let w = parseFloat(svg.getAttribute("width")) || 0, h = parseFloat(svg.getAttribute("height")) || 0;
          if (!vb) { if (!w) w = 300; if (!h) h = 300; svg.setAttribute("viewBox", `0 0 ${w} ${h}`); vb = `0 0 ${w} ${h}`; }
          const parts = vb.split(/[\s,]+/).map(Number);
          const natW = w || parts[2] || 300, natH = h || parts[3] || 300;
          svg.removeAttribute("width"); svg.removeAttribute("height");
          svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
          swapLayerNode(layer, "SVG", document.importNode(svg, true), natW, natH, name);
        } catch (err) { toast(`Couldn't read ${name}`); }
      } else {
        const img = new Image();
        img.onload = () => {
          swapLayerNode(layer, "IMG", img, img.naturalWidth || 512, img.naturalHeight || 512, name);
        };
        img.onerror = () => toast(`Couldn't load ${name}`);
        img.src = e.target.result; img.alt = name;
      }
    };
    if (isSvg) reader.readAsText(file); else reader.readAsDataURL(file);
  }

  /* Perform the actual DOM swap.  layer.wrap is preserved (it holds
     the transform / rotation / clip-path etc); only the inner .node
     is replaced.  natW/natH update so aspect-aware effects behave
     correctly against the new content.  layer.transform is untouched
     — the visual size on canvas stays the same, so a landscape photo
     replaced with a portrait one will letterbox unless the user
     resizes deliberately. */
  function swapLayerNode(layer, newKind, newNode, natW, natH, newName) {
    if (!layer.wrap) return;
    // Remove old node from the wrap.  layer.node may have sibling
    // decorations (selection helpers, morph path) — remove only the
    // node itself.
    if (layer.node && layer.node.parentNode === layer.wrap) {
      layer.wrap.removeChild(layer.node);
    }
    layer.node = newNode;
    layer.kind = newKind;
    layer.natW = natW;
    layer.natH = natH;
    layer.name = newName || layer.name;
    // Clear kind-specific caches that referenced the OLD node's DOM.
    layer._primitives = null; layer._strokes = null;
    layer._segmentPrims = null; layer._segmentOrder = null;
    layer._morphPath = null; layer._morphApplied = false;
    layer.originalColors = null; layer._svgOriginalSnapshot = null;
    // v19.35: also clear SHAPE-only state when converting a shape layer
    // to an image / svg.  Prevents shape stroke/fill mutations from
    // trying to apply to the new asset.
    layer.shapeType = null;
    layer.shapeStyle = null;
    // Give the new SVG node the same wrapping behavior as an imported one.
    if (newKind === "SVG") {
      newNode.setAttribute("width",  "100%");
      newNode.setAttribute("height", "100%");
      splitTextNodes(newNode);
    } else if (newKind === "IMG") {
      newNode.style.width = "100%"; newNode.style.height = "100%";
      newNode.style.objectFit = "fill";   // matches how IMG layers render inside the wrap
    }
    layer.wrap.appendChild(newNode);
    renderLayers(); renderInspector(); paintIfPaused();
    toast(`Replaced with ${newName}`);
  }

  /* Public entry: prompt the user for a file and replace `layer`. */
  function promptReplaceAsset(layer) {
    if (!layer) return;
    const input = document.createElement("input");
    input.type = "file";
    // v19.33: also accept video files now that replaceLayerAsset
    // handles them via VideoSource.create.
    input.accept = "image/*,.svg,video/*,.mp4,.webm,.mov,.m4v";
    input.style.display = "none";
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (file) replaceLayerAsset(layer, file);
      document.body.removeChild(input);
    });
    document.body.appendChild(input);
    input.click();
  }

  /* =============== PATH B — WebCodecs VideoSource =====================
     Deterministic, timeline-driven video decoding.  Replaces the
     HTMLVideoElement + native-playback-clock architecture with a
     seek-any-frame frame cache addressed by source PTS.  Preview and
     export both call getFrameAtSourceTime(t) → VideoFrame; the timeline
     clock is the only clock.

     Scope for this deliverable (B1+B2+B3): MP4/H.264 input, preview
     only.  WebM continues to use the legacy HTMLVideoElement path
     until B6.  If WebCodecs or mp4box is unavailable, ANY video falls
     back to legacy — no regression versus previous release.  Export
     path is NOT touched in this deliverable (B4 — separate).
  */

  // ---- mp4box.js lazy loader ----------------------------------------
  // Loads mp4box on demand (first video import) from a CDN.  Cached
  // promise so we only load once.  If the load fails (offline, CDN
  // blocked, CSP), we return null and the caller falls back to legacy.
  let _mp4boxLoadPromise = null;
  function loadMP4Box() {
    if (typeof window.MP4Box !== "undefined") return Promise.resolve(window.MP4Box);
    if (_mp4boxLoadPromise) return _mp4boxLoadPromise;
    console.log("[Phaser video] injecting mp4box.js from CDN");
    _mp4boxLoadPromise = new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/mp4box@0.5.3/dist/mp4box.all.min.js";
      s.async = true;
      s.onload = () => {
        const ok = typeof window.MP4Box !== "undefined";
        console.log("[Phaser video] mp4box.js script.onload — MP4Box global present:", ok);
        resolve(window.MP4Box || null);
      };
      s.onerror = (e) => {
        console.warn("[Phaser video] mp4box.js script.onerror — CDN load failed (network/CSP/ad-blocker?)", e);
        _mp4boxLoadPromise = null;
        resolve(null);
      };
      document.head.appendChild(s);
    });
    return _mp4boxLoadPromise;
  }

  // ---- LRU cache (frame-index → VideoFrame) -------------------------
  // Doubly-linked list + Map.  O(1) get / set / evict.  Every eviction
  // calls frame.close() — critical to avoid GPU memory leaks.
  class FrameLRU {
    constructor(maxFrames, maxBytes) {
      this.maxFrames = maxFrames;
      this.maxBytes = maxBytes;
      this._map = new Map();      // idx → node
      this._head = null;           // MRU
      this._tail = null;           // LRU
      this._bytes = 0;
    }
    get(idx) {
      const node = this._map.get(idx);
      if (!node) return null;
      this._moveToHead(node);
      return node.frame;
    }
    set(idx, frame, byteSize) {
      if (this._map.has(idx)) { try { frame.close(); } catch(e){} return; }
      const node = { idx, frame, byteSize, prev: null, next: this._head };
      if (this._head) this._head.prev = node;
      this._head = node;
      if (!this._tail) this._tail = node;
      this._map.set(idx, node);
      this._bytes += byteSize;
      this._evict();
    }
    _moveToHead(node) {
      if (node === this._head) return;
      if (node.prev) node.prev.next = node.next;
      if (node.next) node.next.prev = node.prev;
      if (node === this._tail) this._tail = node.prev;
      node.prev = null; node.next = this._head;
      if (this._head) this._head.prev = node;
      this._head = node;
      if (!this._tail) this._tail = node;
    }
    _evict() {
      while ((this._map.size > this.maxFrames || this._bytes > this.maxBytes) && this._tail) {
        const dead = this._tail;
        this._tail = dead.prev;
        if (this._tail) this._tail.next = null; else this._head = null;
        this._map.delete(dead.idx);
        this._bytes -= dead.byteSize;
        try { dead.frame.close(); } catch(e){}
      }
    }
    clear() {
      for (const node of this._map.values()) { try { node.frame.close(); } catch(e){} }
      this._map.clear();
      this._head = null; this._tail = null;
      this._bytes = 0;
    }
    get size() { return this._map.size; }
    get bytes() { return this._bytes; }
  }

  /* ---- VideoSource -------------------------------------------------
     Wraps an MP4/H.264 file into a frame-accurate, timeline-driven
     decode source.  Public API:

       VideoSource.create(arrayBuffer) → Promise<VideoSource>
       source.getFrameSyncIfCached(tSourceSeconds) → VideoFrame | null
       source.getFrameAtSourceTime(tSourceSeconds) → Promise<VideoFrame>
       source.close()

     Each layer owns its own VideoSource so independent playhead
     positions don't fight for a shared decoder.  Duplicated layers get
     independent sources built from the same shared ArrayBuffer. */
  class VideoSource {
    constructor(arrayBuffer) {
      this._buffer = arrayBuffer;
      this._decoder = null;
      this._samples = [];              // [{pts_us, isKeyframe, data}]
      this._sampleByPts = new Map();   // pts_us → sample index
      this._width = 0;
      this._height = 0;
      this._duration = 0;
      this._frameRate = 30;
      this._codec = null;
      this._codecDescription = null;
      this._cache = new FrameLRU(60, 256 * 1024 * 1024);
      this._pendingResolvers = new Map();  // idx → [{resolve, reject}]
      this._submittedUpTo = -1;
      this._closed = false;
      this._lastError = null;
      // v19.38 instrumentation for playback perf diagnosis.
      this.metrics = { decodedFrames: 0, enqueuedChunks: 0, cacheHits: 0, cacheMisses: 0,
                       frameRequests: 0, decoderResets: 0, timeoutDrops: 0 };
    }

    static async create(arrayBuffer, step) {
      const log = step || (() => {});
      if (typeof VideoDecoder === "undefined") throw new Error("VideoDecoder unavailable");
      if (typeof EncodedVideoChunk === "undefined") throw new Error("EncodedVideoChunk unavailable");
      log("loading mp4box.js...");
      const MP4Box = await loadMP4Box();
      if (!MP4Box) throw new Error("mp4box.js failed to load (CDN blocked or unreachable)");
      log("mp4box.js loaded", { hasCreateFile: typeof MP4Box.createFile === "function" });
      const source = new VideoSource(arrayBuffer);
      await source._init(MP4Box, log);
      return source;
    }

    get width()       { return this._width; }
    get height()      { return this._height; }
    get duration()    { return this._duration; }
    get frameRate()   { return this._frameRate; }
    get sampleCount() { return this._samples.length; }
    get cacheStats()  { return { frames: this._cache.size, bytes: this._cache.bytes, maxFrames: this._cache.maxFrames, maxBytes: this._cache.maxBytes }; }
    // v19.38: live decoder queue depth (Chromium 94+).  Falls back to
    // 0 when not exposed.
    get decodeQueueSize() { return (this._decoder && this._decoder.decodeQueueSize) || 0; }
    // v19.40: exact range of decodable presentation times.  Callers
    // clamp their requested tSource to [firstSourceTime, lastValidSourceTime]
    // so we never ask for a frame that isn't in the sample table.
    // Requesting past the last pts is a known cause of export freezes:
    // getFrameAtSourceTime would hit the sample-not-found path, no
    // frame ever arrives, promise times out, canvas stays stale.
    get firstSourceTime() {
      return this._samples.length ? (this._samples[0].pts_us / 1e6) : 0;
    }
    get lastValidSourceTime() {
      const N = this._samples.length;
      if (!N) return 0;
      // Scan the last few samples for the maximum pts (mp4box gives
      // samples in decode order, so the *last* array entry is NOT
      // necessarily the largest pts — B-frame streams have out-of-order
      // decode).  Take max across the tail.
      let maxPts = 0;
      for (let i = Math.max(0, N - 8); i < N; i++) {
        if (this._samples[i].pts_us > maxPts) maxPts = this._samples[i].pts_us;
      }
      return maxPts / 1e6;
    }

    async _init(MP4Box, step) {
      const log = step || (() => {});
      log("starting demux");
      const { track, samples, description } = await this._demux(MP4Box);
      log("demux complete", { codec: track.codec, nbSamples: track.nb_samples, descBytes: description && description.byteLength });
      this._width  = track.video ? track.video.width  : (track.track_width  || 0);
      this._height = track.video ? track.video.height : (track.track_height || 0);
      this._duration = (track.duration || 0) / (track.timescale || 1);
      this._frameRate = this._duration > 0 ? (track.nb_samples / this._duration) : 30;
      this._codec = track.codec;
      this._codecDescription = description;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const pts_us = Math.round((s.cts / track.timescale) * 1e6);
        this._samples.push({ pts_us, isKeyframe: !!s.is_sync, data: s.data });
        this._sampleByPts.set(pts_us, i);
      }
      log("checking codec support", { codec: this._codec });
      const support = await VideoDecoder.isConfigSupported({
        codec: this._codec, codedWidth: this._width, codedHeight: this._height,
        description: this._codecDescription,
      }).catch((e) => { log("isConfigSupported threw", { error: String(e) }); return { supported: false }; });
      log("codec support result", { supported: support.supported });
      if (!support.supported) throw new Error("Codec not supported by browser: " + this._codec);
      this._decoder = new VideoDecoder({
        output: (frame) => this._onFrame(frame),
        error:  (e) => { this._lastError = e; log("decoder error", { error: String(e) }); },
      });
      this._decoder.configure({
        codec: this._codec, codedWidth: this._width, codedHeight: this._height,
        description: this._codecDescription,
      });
      log("decoder configured");
    }

    _demux(MP4Box) {
      return new Promise((resolve, reject) => {
        const file = MP4Box.createFile();
        let track = null;
        let expected = 0;
        let description = null;
        const samples = [];
        file.onReady = (info) => {
          track = (info.videoTracks && info.videoTracks[0]) || null;
          if (!track) { reject(new Error("No video track")); return; }
          // Extract codec configuration box (avcC / hvcC / vpcC / av1C).
          try {
            const trak = file.moov.traks.find(t => t.tkhd.track_id === track.id);
            if (!trak) { reject(new Error("No track box")); return; }
            const entry = trak.mdia.minf.stbl.stsd.entries[0];
            const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
            if (!box) { reject(new Error("No codec description box")); return; }
            // DataStream is a TOP-LEVEL GLOBAL in mp4box.all.min.js's UMD
            // bundle — NOT a property of MP4Box.  My earlier code
            // assumed the wrong location.  Check window.DataStream +
            // implicit global + MP4Box.DataStream defensively so a
            // future mp4box version can add it as a property without
            // breaking us either way.
            const DS = (typeof window !== "undefined" && window.DataStream)
                    || (typeof DataStream !== "undefined" ? DataStream : null)
                    || (MP4Box && MP4Box.DataStream)
                    || null;
            if (!DS || typeof DS.BIG_ENDIAN === "undefined") {
              reject(new Error("DataStream global not exposed by mp4box.js — library incomplete or version mismatch"));
              return;
            }
            const stream = new DS(undefined, 0, DS.BIG_ENDIAN);
            box.write(stream);
            // DataStream grows its internal buffer in 8 KB chunks, so
            // `stream.buffer.byteLength` is usually larger than the
            // bytes actually written.  Use `stream.position` for the
            // exact written length (falls back to byteLength if
            // position isn't defined by this DataStream version).
            // First 8 bytes are the box header (size + type); trim.
            const written = (typeof stream.position === "number" && stream.position > 0)
                          ? stream.position
                          : stream.byteLength;
            description = new Uint8Array(stream.buffer, 8, Math.max(0, written - 8));
          } catch (e) { reject(new Error("Codec description extraction failed: " + e.message)); return; }
          expected = track.nb_samples;
          if (expected === 0) { reject(new Error("Track has no samples")); return; }
          file.setExtractionOptions(track.id, null, { nbSamples: expected });
          file.start();
        };
        file.onSamples = (trackId, user, extracted) => {
          for (const s of extracted) samples.push(s);
          if (samples.length >= expected) resolve({ track, samples, description });
        };
        file.onError = (e) => reject(new Error("mp4box: " + e));
        // mp4box mutates the buffer; clone so we don't damage the caller's copy.
        const buf = this._buffer.slice(0);
        buf.fileStart = 0;
        try { file.appendBuffer(buf); file.flush(); }
        catch (e) { reject(new Error("mp4box appendBuffer failed: " + e.message)); }
      });
    }

    _onFrame(frame) {
      if (this._closed) { try { frame.close(); } catch(e){} return; }
      this.metrics.decodedFrames++;
      let idx = this._sampleByPts.get(frame.timestamp);
      // v19.40: If the decoded frame's timestamp doesn't match any known
      // sample pts exactly (rounding drift, timescale conversion), fall
      // back to nearest-pts within a ±1ms window.  Prevents silent
      // frame drops when pts arithmetic loses a microsecond.
      if (idx === undefined) {
        const NEAR = 1000;   // 1ms window
        let bestIdx = -1, bestDelta = Infinity;
        for (let i = 0; i < this._samples.length; i++) {
          const d = Math.abs(this._samples[i].pts_us - frame.timestamp);
          if (d < bestDelta) { bestDelta = d; bestIdx = i; if (d === 0) break; }
        }
        if (bestIdx >= 0 && bestDelta <= NEAR) idx = bestIdx;
      }
      if (idx === undefined || idx < 0) { try { frame.close(); } catch(e){} return; }
      const byteSize = (frame.allocationSize && frame.allocationSize()) || (this._width * this._height * 4);
      const resolvers = this._pendingResolvers.get(idx);
      this._cache.set(idx, frame, byteSize);
      if (resolvers) {
        this._pendingResolvers.delete(idx);
        for (const r of resolvers) r.resolve(frame);
      }
    }

    _sampleIndexForTime(tSource) {
      if (this._samples.length === 0) return -1;
      const idx = Math.round(tSource * this._frameRate);
      return Math.max(0, Math.min(idx, this._samples.length - 1));
    }

    _findKeyframeAtOrBefore(idx) {
      for (let i = idx; i >= 0; i--) if (this._samples[i].isKeyframe) return i;
      return 0;
    }

    _enqueue(idx) {
      const s = this._samples[idx];
      try {
        this._decoder.decode(new EncodedVideoChunk({
          type: s.isKeyframe ? "key" : "delta",
          timestamp: s.pts_us,
          data: s.data,
        }));
        this._submittedUpTo = idx;
        this.metrics.enqueuedChunks++;
      } catch (e) { this._lastError = e; }
    }

    _resetDecoderForRewind() {
      this.metrics.decoderResets++;
      // Fired when a request lands behind _submittedUpTo AND isn't in cache.
      try { this._decoder.reset(); } catch(e){}
      try {
        this._decoder.configure({
          codec: this._codec, codedWidth: this._width, codedHeight: this._height,
          description: this._codecDescription,
        });
      } catch(e){ this._lastError = e; }
      this._submittedUpTo = -1;
      // Keep pendingResolvers — they'll resolve when we resubmit those chunks.
    }

    getFrameSyncIfCached(tSource) {
      const idx = this._sampleIndexForTime(tSource);
      if (idx < 0) return null;
      const f = this._cache.get(idx);
      if (f) this.metrics.cacheHits++; else this.metrics.cacheMisses++;
      return f;
    }

    getFrameAtSourceTime(tSource, opts) {
      if (this._closed) return Promise.reject(new Error("VideoSource closed"));
      this.metrics.frameRequests++;
      // v19.40: caller-supplied timeout — export uses a long window
      // (10s) to allow deep decode pipelines to catch up on long
      // videos; preview keeps the fast 2s default so a decode wedge
      // doesn't hang the UI.
      const timeoutMs = (opts && opts.timeoutMs) || 2000;
      const idx = this._sampleIndexForTime(tSource);
      if (idx < 0) return Promise.reject(new Error("No samples"));
      const cached = this._cache.get(idx);
      if (cached) return Promise.resolve(cached);
      const existing = this._pendingResolvers.get(idx);
      const promise = new Promise((resolve, reject) => {
        const entry = { resolve, reject };
        if (existing) existing.push(entry);
        else { this._pendingResolvers.set(idx, [entry]); }
      });
      if (!existing) {
        this._triggerDecodeTo(idx);
        setTimeout(() => {
          const rs = this._pendingResolvers.get(idx);
          if (rs) { this._pendingResolvers.delete(idx); this.metrics.timeoutDrops++;
            for (const r of rs) r.reject(new Error("decode timeout")); }
        }, timeoutMs);
      }
      return promise;
    }

    _triggerDecodeTo(targetIdx) {
      if (targetIdx <= this._submittedUpTo) {
        // Already in-flight: either the frame is coming or was evicted.
        // If evicted, we need to resubmit.  Since we don't track that
        // separately, resubmit from the keyframe before targetIdx.
        const cached = this._cache.get(targetIdx);
        if (cached) return;   // shouldn't happen (caller already checked)
        this._resetDecoderForRewind();
        const kf = this._findKeyframeAtOrBefore(targetIdx);
        for (let i = kf; i <= targetIdx; i++) this._enqueue(i);
        return;
      }
      // Forward from _submittedUpTo (contiguous decode).
      let startIdx = this._submittedUpTo + 1;
      // Cold start: begin at the keyframe at or before targetIdx.
      if (this._submittedUpTo < 0) startIdx = this._findKeyframeAtOrBefore(targetIdx);
      for (let i = startIdx; i <= targetIdx; i++) this._enqueue(i);
    }

    close() {
      if (this._closed) return;
      this._closed = true;
      try { this._decoder && this._decoder.close(); } catch(e){}
      this._cache.clear();
      for (const [, resolvers] of this._pendingResolvers) {
        for (const r of resolvers) r.reject(new Error("closed"));
      }
      this._pendingResolvers.clear();
      // Release the backing buffer so GC can reclaim.
      this._buffer = null;
    }
  }

  /* ---- VIDEO import ------------------------------------------------
     Path B: for MP4 files, try to build a WebCodecs VideoSource
     (deterministic, timeline-driven).  If that fails (WebCodecs
     unavailable, mp4box fails to load, unsupported codec, corrupt file)
     OR the file isn't MP4, fall back to the legacy HTMLVideoElement
     path.  In both cases we snapshot the first frame for the asset
     library thumbnail.  The user can tell which mode a layer is in
     from the "Frame-accurate" / "Legacy" badge in the inspector. */
  /* ---- VIDEO import ------------------------------------------------
     Path B: for MP4 files, try to build a WebCodecs VideoSource
     (deterministic, timeline-driven).  If that fails (WebCodecs
     unavailable, mp4box fails to load, unsupported codec, corrupt file)
     OR the file isn't MP4, fall back to the legacy HTMLVideoElement
     path.  In both cases we snapshot the first frame for the asset
     library thumbnail.  The user can tell which mode a layer is in
     from the "Frame-accurate" / "Legacy" badge in the inspector. */
  function addVideoAsset(file) {
    // Diagnostic record — every step logs into this object.  Retrievable
    // from DevTools console as window.__phaserVideoDiag so we can trace
    // exactly which step of the fallback ladder fired.
    const diag = {
      file: file.name,
      fileType: file.type,
      fileSize: file.size,
      steps: [],
      finalPath: null,
      error: null,
    };
    const step = (label, extra) => {
      const entry = { t: Date.now(), label, ...(extra || {}) };
      diag.steps.push(entry);
      console.log("[Phaser video]", label, extra || "");
    };
    window.__phaserVideoDiag = diag;

    /* --- Debug switch: force WebCodecs path, no fallback ---------------
       Enable from the DevTools console with:
           window.__phaserForceWebCodecs = true
       When set, ANY failure in the WebCodecs path throws to the console
       with a full stack trace instead of silently falling back to the
       legacy HTMLVideoElement path.  Use only for diagnosis. */
    const strictMode = !!window.__phaserForceWebCodecs;
    if (strictMode) step("STRICT MODE — fallback disabled");

    const failToLegacy = (reason, err) => {
      diag.finalPath = reason;
      if (err) diag.error = String(err && err.message || err);
      if (strictMode) {
        step("STRICT MODE — refusing to fall back", { reason, error: diag.error });
        console.error("[Phaser video] STRICT MODE — WebCodecs failed at", reason, err);
        toast(`WebCodecs failed at "${reason}" — see console. Legacy fallback disabled.`);
        return;
      }
      addVideoAsset_Legacy(file);
    };

    // Step 1: file-type detection.
    const isMP4Like = /\.(mp4|m4v|mov)$/i.test(file.name) || file.type === "video/mp4" || file.type === "video/quicktime";
    step("file-type check", { isMP4Like, name: file.name, mime: file.type });
    if (!isMP4Like) {
      step("→ LEGACY (not MP4-like)", null);
      failToLegacy("legacy:not-mp4");
      return;
    }

    // Step 2: WebCodecs API presence.
    const hasVD = typeof VideoDecoder !== "undefined";
    const hasEC = typeof EncodedVideoChunk !== "undefined";
    step("WebCodecs API check", { hasVideoDecoder: hasVD, hasEncodedVideoChunk: hasEC });
    if (!hasVD || !hasEC) {
      step("→ LEGACY (WebCodecs API missing)", null);
      failToLegacy("legacy:no-webcodecs-api");
      return;
    }

    // Step 3+: FileReader → VideoSource.create → snapshot.
    const reader = new FileReader();
    reader.onerror = () => {
      step("FileReader error", { name: reader.error && reader.error.name });
      failToLegacy("legacy:file-read-error", reader.error);
      toast(`Couldn't read ${file.name}`);
    };
    reader.onload = async (ev) => {
      const arrayBuffer = ev.target.result;
      step("FileReader loaded", { bytes: arrayBuffer.byteLength });
      let source;
      try {
        source = await VideoSource.create(arrayBuffer, step);
        step("VideoSource.create succeeded", { width: source.width, height: source.height, duration: source.duration, codec: source._codec, sampleCount: source.sampleCount });
      } catch (e) {
        step("VideoSource.create FAILED", { error: String(e && e.message || e), stack: e && e.stack });
        console.warn("[Phaser video] falling back to legacy for", file.name, e);
        failToLegacy("legacy:VideoSource.create-threw", e);
        return;
      }
      // Snapshot first frame to exercise the full decode pipeline.
      let dataUrl;
      try {
        const frame = await source.getFrameAtSourceTime(0);
        step("first-frame decode succeeded", { hasFrame: !!frame });
        const c = document.createElement("canvas");
        c.width = source.width; c.height = source.height;
        c.getContext("2d").drawImage(frame, 0, 0, source.width, source.height);
        dataUrl = c.toDataURL("image/png");
      } catch (e) {
        step("first-frame decode FAILED", { error: String(e && e.message || e), stack: e && e.stack });
        console.warn("[Phaser video] snapshot failed, falling back", e);
        source.close();
        failToLegacy("legacy:snapshot-failed", e);
        return;
      }
      const img = new Image();
      img.onload = () => {
        // Store the raw ArrayBuffer on the asset so future layers built
        // from this asset get their own independent VideoSource.  The
        // asset's own source is discarded after the snapshot; not
        // shared with layers (each layer needs its own decoder state).
        source.close();
        diag.finalPath = "webcodecs";
        step("→ WEBCODECS active (registering asset)", null);
        registerAsset(file.name, "VIDEO", img, dataUrl, {
          natW: source.width, natH: source.height, complex: false,
          arrayBuffer,                         // shared source of truth
          duration: source.duration,
          frameRate: source.frameRate,
          codec: source._codec,
          isVideoSource: true,
          useWebCodecs: true,                  // marks Frame-accurate layers
          videoDiag: JSON.parse(JSON.stringify(diag)),  // snapshot for the inspector
        });
      };
      img.onerror = () => {
        step("snapshot Image failed to load", null);
        source.close();
        failToLegacy("legacy:snapshot-img-load-failed");
      };
      img.src = dataUrl;
    };
    reader.readAsArrayBuffer(file);
  }

  /* Legacy HTMLVideoElement path — Phase 2 behaviour, kept as fallback.
     Used for WebM, for anything WebCodecs can't decode, and when
     mp4box/WebCodecs are unavailable.  Layers built from these assets
     get the "Legacy" badge in the inspector. */
  function addVideoAsset_Legacy(file) {
    let url;
    try { url = URL.createObjectURL(file); } catch (e) { toast(`Couldn't read ${file.name}`); return; }
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    // Offscreen: kept alive in memory but not attached to the DOM so
    // it never renders itself into the layout.
    video.src = url;

    let handled = false;
    const fail = (why) => {
      if (handled) return; handled = true;
      URL.revokeObjectURL(url);
      toast(`Couldn't load ${file.name} — ${why}`);
    };
    video.addEventListener("error", () => fail("decoder error"));
    // Timeout guard for browsers that stall on metadata for a bad file.
    const t0 = performance.now();
    const timeoutId = setTimeout(() => { if (!handled && !video.videoWidth) fail("timed out reading video"); }, 10000);

    video.addEventListener("loadedmetadata", () => {
      const natW = video.videoWidth || 640, natH = video.videoHeight || 480;
      const duration = isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
      // Seek to a tiny offset instead of exactly 0 — some browsers
      // hand back a blank frame at t=0 before the first keyframe has
      // been decoded.  Clamp to a value inside the media.
      const seekTo = Math.min(0.05, duration * 0.02);
      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);
        clearTimeout(timeoutId);
        if (handled) return;
        // Snapshot the current frame to a canvas → dataURL → Image
        try {
          const c = document.createElement("canvas");
          c.width = natW; c.height = natH;
          const ctx = c.getContext("2d");
          ctx.drawImage(video, 0, 0, natW, natH);
          const dataUrl = c.toDataURL("image/png");
          const img = new Image();
          img.onload = () => {
            handled = true;
            // Register with kind VIDEO; asset.node is the snapshot Image
            // (so it slots straight into the existing rendering path);
            // asset.videoEl keeps the offscreen video alive for later
            // phases; asset.videoUrl / duration are stored for save/UX.
            registerAsset(file.name, "VIDEO", img, dataUrl, {
              natW, natH, complex: false,
              videoEl: video, videoUrl: url, duration,
              // Phase 1 marker: this asset comes from a video source.
              isVideoSource: true,
              useWebCodecs: false,     // Legacy layers get the "Legacy" badge.
              // Snapshot the WebCodecs-attempt diag so the inspector can
              // surface WHY we ended up here.  When the file was e.g. a
              // WebM (not MP4-like), diag exists but its steps only
              // include the "not-mp4" trip.  When mp4box.js CDN failed,
              // the full ladder is captured.
              videoDiag: window.__phaserVideoDiag
                ? JSON.parse(JSON.stringify(window.__phaserVideoDiag))
                : { finalPath: "legacy:direct", steps: [], error: null },
            });
          };
          img.onerror = () => fail("snapshot decode failed");
          img.src = dataUrl;
        } catch (e) { fail("frame snapshot blocked"); }
      };
      video.addEventListener("seeked", onSeeked);
      // Some browsers only fire seeked if currentTime actually changes;
      // if we're already at seekTo (rare) trigger the load manually.
      try { video.currentTime = seekTo; } catch (e) { onSeeked(); }
    });
  }
  function registerAsset(name, kind, node, dataUrl, meta) {
    const asset = { id: ++idSeq, name, kind, node, dataUrl, meta: meta || { natW: 512, natH: 512, complex: false } };
    assets.push(asset); renderAssetList(); addLayerFromAsset(asset); toast(`Added ${name}`);
  }
  function renderAssetList() {
    el.assetCount.textContent = assets.length;
    if (!assets.length) { el.assetList.innerHTML = '<div class="empty-note">Nothing here yet. Add files to start.</div>'; return; }
    el.assetList.innerHTML = "";
    assets.forEach((a) => {
      const card = document.createElement("div"); card.className = "asset-card"; card.title = `${a.name} — click to add as a layer`;
      // VIDEO assets use the first-frame snapshot dataURL, same as IMG.
      // Only SVG is rendered from a live <svg> node.
      const thumb = (a.kind === "IMG" || a.kind === "VIDEO")
        ? `<img class="asset-thumb" src="${a.dataUrl}" alt="">`
        : `<div class="asset-thumb">${svgThumb(a.node)}</div>`;
      card.innerHTML = `<span class="asset-kind">${a.kind}</span><button class="asset-del" title="Remove from library">\u00d7</button>` + thumb;
      card.addEventListener("click", (e) => { if (e.target.classList.contains("asset-del")) { removeAsset(a); e.stopPropagation(); } else { addLayerFromAsset(a); toast(`Layer added: ${a.name}`); } });
      el.assetList.appendChild(card);
    });
  }
  function svgThumb(node) { const c = node.cloneNode(true); c.setAttribute("width", "100%"); c.setAttribute("height", "100%"); return c.outerHTML; }
  function removeAsset(a) { const i = assets.indexOf(a); if (i >= 0) assets.splice(i, 1); renderAssetList(); }

  /* ================ v19.0 TEXT TOOL ================
     Native text layer support.  Text layers are stored as
     `layer.kind === "TEXT"` with `layer.textStyle` holding the params.
     The layer's DOM node is an SVG containing a <text> element, so all
     existing text-based effects (Text Replace, Text Flicker, Symbol
     Transition) work automatically via the same splitTextNodes path.

     Workflow:
       1. Click the "T" tool button → STATE.tool = "text", cursor changes.
       2. Click on the artboard → createTextLayerAt(pageX, pageY) creates
          a text layer at that position with default style.
       3. Tool auto-reverts to "select" after creation.
       4. Double-click a text layer → inline text edit overlay opens.
       5. Text style controls in the inspector edit the layer's textStyle
          and rebuild the SVG live.
  */
  const TEXT_FONT_STACK = "sans-serif";   // fallback if a Google font hasn't loaded yet
  function defaultTextStyle() {
    return {
      text: "Text",
      fontFamily: "Inter",
      fontSize: 96,
      fontWeight: 500,
      color: "#FFFFFF",
      align: "middle",         // start | middle | end (SVG text-anchor values)
      letterSpacing: 0,        // em units (1 em = fontSize px approx)
      lineHeight: 1.2,         // multiplier
    };
  }

  // Measure a single line of text using canvas 2d measureText, which is
  // the most reliable way to get text metrics without laying out DOM.
  const _textMeasureCanvas = document.createElement("canvas");
  const _textMeasureCtx = _textMeasureCanvas.getContext("2d");
  function measureTextLines(lines, style) {
    _textMeasureCtx.font = `${style.fontWeight} ${style.fontSize}px "${style.fontFamily}", ${TEXT_FONT_STACK}`;
    // canvas measureText doesn't natively support letter-spacing; approximate
    // by adding (letterSpacing * fontSize) to each line's width per character.
    const spacingPx = (style.letterSpacing || 0) * style.fontSize;
    let maxW = 0;
    lines.forEach((ln) => {
      const m = _textMeasureCtx.measureText(ln || " ");
      const w = m.width + Math.max(0, ln.length - 1) * spacingPx;
      if (w > maxW) maxW = w;
    });
    const lineH = style.fontSize * (style.lineHeight || 1.2);
    return { w: Math.ceil(maxW), h: Math.ceil(lineH * lines.length) };
  }

  // Rebuild the SVG contents for a text layer from its current textStyle.
  // Called when style changes, text content changes, or on creation.
  function buildTextLayerSVG(layer) {
    const s = layer.textStyle;
    const lines = String(s.text || "").split("\n");
    const meas = measureTextLines(lines, s);
    // Padding around measured text so descenders + letter-spacing don't clip.
    const padX = Math.max(8, s.fontSize * 0.25);
    const padY = Math.max(8, s.fontSize * 0.25);
    const W = meas.w + padX * 2;
    const H = meas.h + padY * 2;
    const svgNS = "http://www.w3.org/2000/svg";
    // Empty existing content
    while (layer.node.firstChild) layer.node.removeChild(layer.node.firstChild);
    // v19.7: invalidate cached stroke references (in case a future
    // text-based path effect ever gets attached; harmless otherwise).
    layer._strokes = null;
    layer._dashApplied = false;
    layer.node.setAttribute("xmlns", svgNS);
    layer.node.setAttribute("viewBox", `0 0 ${W} ${H}`);
    layer.node.setAttribute("width", "100%");
    layer.node.setAttribute("height", "100%");
    layer.node.setAttribute("preserveAspectRatio", "xMidYMid meet");
    // Anchor X position within the viewBox
    const anchorX = s.align === "start" ? padX : s.align === "end" ? (W - padX) : W / 2;
    const lineH = s.fontSize * (s.lineHeight || 1.2);
    const firstBaselineY = padY + s.fontSize * 0.82;  // ~ascender height
    const textEl = document.createElementNS(svgNS, "text");
    textEl.setAttribute("x", String(anchorX));
    textEl.setAttribute("y", String(firstBaselineY));
    textEl.setAttribute("text-anchor", s.align);
    textEl.setAttribute("font-family", `"${s.fontFamily}", ${TEXT_FONT_STACK}`);
    textEl.setAttribute("font-size", String(s.fontSize));
    textEl.setAttribute("font-weight", String(s.fontWeight));
    textEl.setAttribute("fill", s.color);
    if (s.letterSpacing) textEl.setAttribute("letter-spacing", (s.letterSpacing * s.fontSize).toFixed(2));
    lines.forEach((line, i) => {
      const tspan = document.createElementNS(svgNS, "tspan");
      tspan.setAttribute("x", String(anchorX));
      if (i > 0) tspan.setAttribute("dy", String(lineH));
      tspan.textContent = line || " ";  // preserve blank lines
      textEl.appendChild(tspan);
    });
    layer.node.appendChild(textEl);
    // Split characters into tspans for text-based effects (Text Flicker etc.)
    // Note: we only split single-line text; multi-line already has one tspan per line.
    if (lines.length === 1) {
      textEl.textContent = "";
      [...lines[0]].forEach((ch) => {
        const g = document.createElementNS(svgNS, "tspan");
        g.setAttribute("data-glyph", "1");
        g.textContent = ch;
        textEl.appendChild(g);
      });
      textEl.dataset.split = "1";
    }
    layer.natW = W;
    layer.natH = H;
    // Update layer's DOM size percentage to match the new intrinsic size,
    // preserving the previous visual size.  We keep transform.wPct/hPct.
    // The <svg> auto-scales via viewBox to the outer size set by the CSS.
    return { W, H };
  }

  /* ================================================================
   * v19.41 TEXT FX ENGINE
   *
   * All text-affecting effects run through this module. The layer's
   * ORIGINAL text (layer.textStyle.text) is never mutated — it stays
   * fully editable.  Effects mutate the RENDERED SVG only.
   *
   * Two mutation categories:
   *   1. STRING mutators (Scramble, BulkTyping, Counter, Odometer)
   *      — return a new display string.  Chained: earlier effects'
   *        outputs feed the next.
   *   2. DOM mutators (CharStagger, SineWaveText, SvgTextOnPath)
   *      — operate on the resulting SVG (tspan positions, opacity,
   *        textPath wrap).
   *
   * The engine is invoked from composeLayer's TEXT branch.  It only
   * rebuilds SVG when the composed display string changes (rebuilds
   * are expensive) — most frames are attribute-only updates on
   * existing tspans (fast).
   *
   * Deterministic randomness via mulberry32(clip.id + seedParam +
   * frameIdx) so preview and export match exactly.
   * ================================================================ */

  // Charsets for scramble.
  const SCRAMBLE_CHARSETS = {
    alnum:   "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    binary:  "01",
    matrix:  "ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜ0123456789",
    symbols: "!@#$%^&*()_+-=[]{}|;:,.<>?/\\~`",
    hex:     "0123456789ABCDEF",
  };

  // Easing functions used by counter/odometer + stagger.
  const TEXT_EASE = {
    linear:    (t) => t,
    easeOut:   (t) => 1 - Math.pow(1 - t, 3),
    easeInOut: (t) => (t < 0.5) ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
    expoOut:   (t) => (t >= 1) ? 1 : 1 - Math.pow(2, -10 * t),
  };

  function _rng(seed) {
    // Local closure for a deterministic per-frame RNG.  mulberry32 is
    // already defined further down; inline a tiny copy here for early
    // availability during Text FX evaluation.
    let a = seed | 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- STRING MUTATORS ----
  const TEXT_FX_STRING = {
    textScramble(layer, clip, p, sig, sceneTime, inputText) {
      const P = clip.params || {};
      const src = String(inputText);
      // v19.41: at p >= ~1 (including past-end persistEnd fires at p=1),
      // return the source unmodified so the "resolved" state is exact.
      // Also protects the divide-by-zero at the last order slot.
      if (p >= 0.999) return src;
      const charset = SCRAMBLE_CHARSETS[P.charset || "matrix"] || SCRAMBLE_CHARSETS.matrix;
      const intensity = (P.intensity ?? 60) / 100;
      const speed = P.speed || 24;
      const seed = (P.seed || 0) + (clip.id || 0) * 17;
      const target = P.target || "char";
      const units = _splitUnits(src, target);
      const N = units.length;
      const order = _shuffleOrder(N, seed);
      const frameIdx = Math.floor(sceneTime * speed);
      const rng = _rng(seed + frameIdx);
      const out = units.slice();
      for (let i = 0; i < N; i++) {
        const orderPos = order.indexOf(i) / Math.max(1, N - 1);
        const unitP = (p - orderPos) / Math.max(0.001, 1 - orderPos);
        if (unitP >= 1) continue;
        const scrambleAmt = Math.max(0, 1 - unitP) * intensity;
        if (target === "char") {
          if (rng() < scrambleAmt) {
            out[i] = charset[Math.floor(rng() * charset.length)];
          }
        } else {
          const orig = units[i];
          if (rng() < scrambleAmt) {
            let s = "";
            for (let k = 0; k < orig.length; k++) {
              s += (/\s/.test(orig[k])) ? orig[k] : charset[Math.floor(rng() * charset.length)];
            }
            out[i] = s;
          }
        }
      }
      return _joinUnits(out, target);
    },

    bulkTyping(layer, clip, p, sig, sceneTime, inputText) {
      const P = clip.params || {};
      const src = String(inputText);
      // Position by cps within the clip's local time, or by p (fallback).
      const localT = Math.max(0, sceneTime - (layer.start + clip.start));
      const cps = P.cps || 20;
      let visibleChars = Math.floor(localT * cps);
      // Backspace behavior: after `backspace` percent of duration, delete
      // `backspaceAmt` chars then continue typing.  Simple deterministic model.
      const backspaceAt = (P.backspace || 0) / 100;
      const backspaceAmt = P.backspaceAmt || 0;
      if (backspaceAt > 0 && backspaceAmt > 0 && p > backspaceAt) {
        const backP = (p - backspaceAt) / (1 - backspaceAt);
        // Delete over 15% of the remaining window, then keep typing.
        if (backP < 0.15) {
          const backProg = backP / 0.15;
          const backedChars = Math.floor(backspaceAmt * backProg);
          visibleChars = Math.max(0, visibleChars - backedChars);
        } else {
          // Compensate visibleChars so typing resumes from the backspaced point
          // (no jump forward).
          visibleChars = Math.max(0, visibleChars - backspaceAmt);
        }
      }
      // Pause on punctuation: for every . , ; : encountered, add pauseMs delay.
      const pausePunct = (P.pausePunct || 0) / 1000;
      if (pausePunct > 0) {
        let elapsed = 0, shown = 0;
        for (let i = 0; i < src.length; i++) {
          const dt = 1 / cps + (/[.,;:!?]/.test(src[i]) ? pausePunct : 0);
          if (elapsed + dt > localT) break;
          elapsed += dt; shown++;
        }
        visibleChars = Math.min(visibleChars, shown);
      }
      let display = src.slice(0, Math.min(visibleChars, src.length));
      // Cursor.
      const cursor = P.cursor || "underscore";
      const blinkHz = P.cursorBlink ?? 2;
      const on = blinkHz > 0 ? (Math.floor(sceneTime * blinkHz * 2) & 1) === 0 : true;
      if (cursor !== "none" && on && p < 1.02) {
        display += cursor === "underscore" ? "_" : cursor === "block" ? "\u2588" : "|";
      }
      return display;
    },

    animatedCounter(layer, clip, p, sig, sceneTime, _inputText) {
      const P = clip.params || {};
      const from = +P.from || 0, to = +P.to || 0;
      const ease = TEXT_EASE[P.easing || "easeOut"] || TEXT_EASE.easeOut;
      const val = from + (to - from) * ease(clamp01(p));
      const decimals = Math.max(0, Math.min(6, P.decimals ?? 0));
      const sepChar = (P.separator === "none") ? "" : (P.separator || ",");
      let s = val.toFixed(decimals);
      if (sepChar) {
        const [intPart, fracPart] = s.split(".");
        const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sepChar);
        s = fracPart ? withSep + "." + fracPart : withSep;
      }
      return (P.prefix || "") + s + (P.suffix || "");
    },

    odometer(layer, clip, p, sig, sceneTime, _inputText) {
      const P = clip.params || {};
      const from = Math.round(+P.from || 0);
      const to   = Math.round(+P.to   || 0);
      const ease = TEXT_EASE[P.easing || "easeOut"] || TEXT_EASE.easeOut;
      const eased = ease(clamp01(p));
      const val = Math.round(from + (to - from) * eased);
      let s = String(P.reverse === "yes" ? (to - (val - from)) : val);
      const slots = P.digits || 0;
      if (slots > 0 && s.length < slots) s = "0".repeat(slots - s.length) + s;
      return (P.prefix || "") + s + (P.suffix || "");
    },
  };

  // ---- DOM MUTATORS (operate on the rebuilt SVG's tspans) ----
  const TEXT_FX_DOM = {
    charStagger(layer, clip, p, sig, sceneTime) {
      const P = clip.params || {};
      const tspans = _getGlyphTspans(layer);
      if (!tspans.length) return;
      const unit = P.target || "char";
      const staggerMs = P.stagger || 60;
      const dur       = P.duration || 350;
      const dist      = P.distance || 40;
      const dir       = P.direction || "up";
      const order     = P.order || "forward";
      // Group tspans by unit.
      const groups = _groupTspansByUnit(tspans, unit, layer);
      const N = groups.length;
      const orderIdx = _computeOrderIndices(N, order, (clip.id || 0) * 13);
      const localMs = Math.max(0, sceneTime - (layer.start + clip.start)) * 1000;
      for (let i = 0; i < N; i++) {
        const delay = orderIdx[i] * staggerMs;
        const t = clamp01((localMs - delay) / dur);
        const eased = TEXT_EASE.easeOut(t);
        const groupTspans = groups[i];
        let dx = 0, dy = 0, op = 1, scaleAttr = null;
        switch (dir) {
          case "up":    dy = -dist * (1 - eased); op = eased; break;
          case "down":  dy =  dist * (1 - eased); op = eased; break;
          case "left":  dx = -dist * (1 - eased); op = eased; break;
          case "right": dx =  dist * (1 - eased); op = eased; break;
          case "fade":  op = eased; break;
          case "scale": op = eased; scaleAttr = 0.2 + 0.8 * eased; break;
        }
        for (const ts of groupTspans) {
          if (dx || ts._fxDx !== undefined) { ts.setAttribute("dx", String((ts._baseDx || 0) + dx)); ts._fxDx = dx; }
          if (dy || ts._fxDy !== undefined) { ts.setAttribute("dy", String((ts._baseDy || 0) + dy)); ts._fxDy = dy; }
          ts.setAttribute("opacity", String(op));
          if (scaleAttr != null) {
            // font-size scale via style; leaves layout somewhat intact for the demo.
            ts.style.opacity = String(op);
          }
        }
      }
    },

    sineWaveText(layer, clip, p, sig, sceneTime) {
      const P = clip.params || {};
      const tspans = _getGlyphTspans(layer);
      if (!tspans.length) return;
      const amp = P.amplitude || 20;
      const wavelen = P.wavelength || 200;
      const speed = P.speed ?? 1;
      const axis = P.axis || "y";
      // Wave phase advances with scene time — deterministic.
      const phase = sceneTime * speed * 2 * Math.PI;
      const groups = (P.target === "word") ? _groupTspansByUnit(tspans, "word", layer) : tspans.map(t => [t]);
      let x = 0;
      for (let i = 0; i < groups.length; i++) {
        const angle = (x / wavelen) * 2 * Math.PI + phase;
        const wave = Math.sin(angle) * amp;
        for (const ts of groups[i]) {
          const w = _tspanApproxWidth(ts, layer);
          if (axis === "y" || axis === "both") ts.setAttribute("dy", String((ts._baseDy || 0) + wave));
          if (axis === "x" || axis === "both") ts.setAttribute("dx", String((ts._baseDx || 0) + wave * 0.3));
          x += w;
        }
      }
    },

    svgTextOnPath(layer, clip, p, sig, sceneTime) {
      const P = clip.params || {};
      const svg = layer.node;
      if (!svg) return;
      const NS = "http://www.w3.org/2000/svg";
      // Ensure a <defs> with our path exists (id = "tp-<clip.id>").
      let defs = svg.querySelector("defs");
      if (!defs) { defs = document.createElementNS(NS, "defs"); svg.insertBefore(defs, svg.firstChild); }
      const pathId = "tp-" + (clip.id || "x");
      let pathEl = defs.querySelector("#" + pathId);
      if (!pathEl) {
        pathEl = document.createElementNS(NS, "path");
        pathEl.setAttribute("id", pathId);
        pathEl.setAttribute("fill", "none");
        defs.appendChild(pathEl);
      }
      const d = P.pathD || "M 20 100 Q 200 20 380 100 T 740 100";
      pathEl.setAttribute("d", d);
      // Wrap all text elements to use textPath.  We modify the existing <text>.
      const textEl = svg.querySelector("text");
      if (!textEl) return;
      // Extract current text content (concatenation of tspans).
      const currentText = textEl.textContent;
      // Rebuild: <text><textPath href="#pathId" startOffset="X%">...</textPath></text>
      while (textEl.firstChild) textEl.removeChild(textEl.firstChild);
      const tp = document.createElementNS(NS, "textPath");
      tp.setAttribute("href", "#" + pathId);
      const animSpeed = P.animateOffset || 0;
      const baseOffset = P.startOffset || 0;
      const dynOffset  = (baseOffset + (animSpeed * sceneTime)) % 100;
      tp.setAttribute("startOffset", dynOffset + "%");
      tp.setAttribute("side", (P.reverse === "yes") ? "right" : "left");
      const alignMap = { start: "start", middle: "middle", end: "end" };
      tp.setAttribute("text-anchor", alignMap[P.align] || "start");
      tp.textContent = currentText;
      textEl.appendChild(tp);
      textEl.setAttribute("text-anchor", alignMap[P.align] || "start");
      layer._textPathApplied = clip.id;
    },
  };

  // ---- Universal (non-text-specific) — pipeline attaches these via the DELTA path.
  // Weird and RGB Split (Pro) are implemented in EVENT_EFFECTS below.

  // Helpers
  function _splitUnits(src, target) {
    if (target === "line") return src.split("\n");
    if (target === "word") return src.split(/(\s+)/);
    return [...src];
  }
  function _joinUnits(units, target) {
    return units.join(target === "line" ? "\n" : "");
  }
  function _shuffleOrder(N, seed) {
    const r = _rng(seed);
    const arr = Array.from({ length: N }, (_, i) => i);
    for (let i = N - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function _computeOrderIndices(N, order, seed) {
    const idx = new Array(N);
    if (order === "forward") for (let i = 0; i < N; i++) idx[i] = i;
    else if (order === "reverse") for (let i = 0; i < N; i++) idx[i] = N - 1 - i;
    else if (order === "center") {
      const c = (N - 1) / 2;
      for (let i = 0; i < N; i++) idx[i] = Math.abs(i - c);
    } else if (order === "edges") {
      const c = (N - 1) / 2;
      for (let i = 0; i < N; i++) idx[i] = c - Math.abs(i - c);
    } else {
      const arr = _shuffleOrder(N, seed);
      for (let i = 0; i < N; i++) idx[i] = arr[i];
    }
    return idx;
  }
  function _getGlyphTspans(layer) {
    if (!layer.node) return [];
    return Array.from(layer.node.querySelectorAll('tspan[data-glyph="1"]'));
  }
  function _groupTspansByUnit(tspans, unit, layer) {
    if (unit === "char" || tspans.length === 0) return tspans.map(t => [t]);
    if (unit === "line") {
      // Multi-line text was rebuilt into single tspans per line —
      // treat each tspan as a line-group.
      return [tspans];
    }
    // word: split at whitespace tspans
    const groups = []; let cur = [];
    for (const ts of tspans) {
      if (/^\s+$/.test(ts.textContent)) {
        if (cur.length) groups.push(cur);
        groups.push([ts]);   // whitespace as its own group
        cur = [];
      } else { cur.push(ts); }
    }
    if (cur.length) groups.push(cur);
    return groups;
  }
  function _tspanApproxWidth(ts, layer) {
    const fs = layer.textStyle && layer.textStyle.fontSize || 96;
    return fs * 0.55 * (ts.textContent || " ").length;
  }
  function _clearTextPathIfApplied(layer) {
    if (!layer._textPathApplied) return;
    // Rebuild base SVG to remove the textPath wrapper.
    buildTextLayerSVG(layer);
    layer._textPathApplied = null;
  }

  /* ================================================================
   * v19.42 WEIRD SLICE COMPOSITOR (text layers)
   *
   * Replaces the v19.41 whole-layer DOM approximation with true
   * horizontal slice rendering.  Pipeline per frame:
   *
   *   1. Rasterize the current text into an offscreen source canvas
   *      (cached — only re-drawn when the displayed text or style
   *      changes).
   *   2. Divide into `sliceDensity` horizontal bands.
   *   3. Composite each band into layer._weirdCanvas with an
   *      independent X displacement (deterministic per band via
   *      mulberry32(seed + frame*991 + band*13)), plus optional
   *      Y jitter and per-band RGB channel separation.
   *   4. Overlay noise, color-flash difference blend, and
   *      scanline-drop bands based on the remaining params.
   *   5. Hide the SVG (layer.node.visibility = "hidden") and show
   *      the canvas so the visible representation is the sliced
   *      composite.
   *
   * Deterministic: same seed + frame_idx → identical output every
   * time.  Same compositor used in preview, scrub, and export
   * (export loop calls _renderWeirdCanvasIfActive per frame).
   * Original layer.textStyle.text NEVER mutated.
   * ================================================================ */

  const _weirdScratchCanvas = document.createElement("canvas");
  const _weirdNoiseTiles = new Map();

  function _getWeirdNoiseTile(seedKey) {
    let tile = _weirdNoiseTiles.get(seedKey);
    if (tile) return tile;
    tile = document.createElement("canvas");
    tile.width = tile.height = 64;
    const tctx = tile.getContext("2d");
    const img = tctx.createImageData(64, 64);
    const rng = _rng(seedKey);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.floor(rng() * 255);
      img.data[i] = v; img.data[i+1] = v; img.data[i+2] = v; img.data[i+3] = 255;
    }
    tctx.putImageData(img, 0, 0);
    _weirdNoiseTiles.set(seedKey, tile);
    // Bound the cache
    if (_weirdNoiseTiles.size > 16) {
      const firstKey = _weirdNoiseTiles.keys().next().value;
      _weirdNoiseTiles.delete(firstKey);
    }
    return tile;
  }

  function _ensureWeirdCanvases(layer) {
    const W = Math.max(1, layer.natW | 0);
    const H = Math.max(1, layer.natH | 0);
    if (!layer._weirdCanvas) {
      layer._weirdCanvas = document.createElement("canvas");
      // Fills the wrap so the CSS transforms (position, scale, rotation)
      // applied to layer.wrap carry through to the visible canvas.
      layer._weirdCanvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;display:none";
      layer.wrap.appendChild(layer._weirdCanvas);
    }
    if (!layer._weirdSourceCanvas) layer._weirdSourceCanvas = document.createElement("canvas");
    if (layer._weirdCanvas.width       !== W) layer._weirdCanvas.width       = W;
    if (layer._weirdCanvas.height      !== H) layer._weirdCanvas.height      = H;
    if (layer._weirdSourceCanvas.width !== W) layer._weirdSourceCanvas.width = W;
    if (layer._weirdSourceCanvas.height!== H) layer._weirdSourceCanvas.height= H;
  }

  function _rasterizeTextToSource(layer) {
    // The "displayed text" — either what applyTextFxAtTime last wrote
    // to the SVG, or the original textStyle.text if no string mutators
    // are active on this layer.
    const displayText = (layer._lastDisplayedText != null) ? layer._lastDisplayedText : (layer.textStyle ? layer.textStyle.text : "");
    const s = layer.textStyle || {};
    const key = displayText + "|" + s.fontFamily + "|" + s.fontSize + "|" + s.fontWeight + "|" + s.color + "|" + s.align + "|" + layer.natW + "|" + layer.natH;
    if (layer._weirdSourceKey === key) return;
    const src = layer._weirdSourceCanvas;
    const W = src.width, H = src.height;
    const sctx = src.getContext("2d");
    sctx.clearRect(0, 0, W, H);
    if (!displayText) { layer._weirdSourceKey = key; return; }
    sctx.font = `${s.fontWeight || 500} ${s.fontSize || 96}px "${s.fontFamily || "Inter"}", sans-serif`;
    sctx.fillStyle = s.color || "#FFFFFF";
    sctx.textAlign = s.align === "start" ? "left" : s.align === "end" ? "right" : "center";
    sctx.textBaseline = "alphabetic";
    const lines = String(displayText).split("\n");
    const padX = Math.max(8, (s.fontSize || 96) * 0.25);
    const anchorX = s.align === "start" ? padX : s.align === "end" ? (W - padX) : W / 2;
    const lineH = (s.fontSize || 96) * (s.lineHeight || 1.2);
    // Baseline ~82% of first-line font-size, matching buildTextLayerSVG's math.
    const firstBaselineY = Math.max(8, (s.fontSize || 96) * 0.25) + (s.fontSize || 96) * 0.82;
    lines.forEach((line, i) => {
      sctx.fillText(line, anchorX, firstBaselineY + i * lineH);
    });
    layer._weirdSourceKey = key;
  }

  /* Draw a rectangular BAND of the source canvas onto `dstCtx` with a
     channel tint applied.  Uses a scratch canvas: draw the band,
     re-fill with the tint color under source-in composite (so only
     opaque source pixels get tinted), then drawImage that onto dst
     with "lighter" so R/G/B channels add up into the destination. */
  function _drawTintedBand(dstCtx, src, sx, sy, sw, sh, dx, dy, tint) {
    if (_weirdScratchCanvas.width  < sw) _weirdScratchCanvas.width  = Math.max(sw, _weirdScratchCanvas.width);
    if (_weirdScratchCanvas.height < sh) _weirdScratchCanvas.height = Math.max(sh, _weirdScratchCanvas.height);
    const tctx = _weirdScratchCanvas.getContext("2d");
    tctx.globalCompositeOperation = "source-over";
    tctx.clearRect(0, 0, sw, sh);
    tctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
    tctx.globalCompositeOperation = "source-in";
    tctx.fillStyle = tint;
    tctx.fillRect(0, 0, sw, sh);
    tctx.globalCompositeOperation = "source-over";
    dstCtx.globalCompositeOperation = "lighter";
    dstCtx.drawImage(_weirdScratchCanvas, 0, 0, sw, sh, dx, dy, sw, sh);
  }

  function _compositeWeirdSlices(layer, P, sceneTime) {
    const dstCanvas = layer._weirdCanvas;
    const src = layer._weirdSourceCanvas;
    const W = dstCanvas.width, H = dstCanvas.height;
    const ctx = dstCanvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    const chance       = (P.glitchChance   ?? 40) / 100;
    const speed        = Math.max(1, P.glitchSpeed ?? 10);
    const density      = Math.max(1, Math.floor(P.sliceDensity  ?? 45));
    const strengthPct  = (P.sliceStrength  ?? 40) / 100;   // 0..1 fraction of W
    const shake        = (P.shake          ?? 0) / 100;    // 0..1 -> px
    const chroma       = (P.chroma         ?? 0) / 100;    // 0..1
    const noise        = (P.noise          ?? 0) / 100;
    const flash        = (P.colorFlash     ?? 0) / 100;
    const scanDrop     = (P.scanlineDrop   ?? 0) / 100;
    const seed         = (P.seed           ?? 137) | 0;

    const frame  = Math.floor(sceneTime * speed);
    const rngG   = _rng(seed + frame * 991);
    const isGlitching = rngG() < chance;

    const bandH = H / density;
    const maxDispX = strengthPct * W * 0.6;      // up to 60% of layer width
    const shakePx  = shake * 12;                 // up to ~12px whole-layer

    for (let i = 0; i < density; i++) {
      const rB = _rng(seed + frame * 991 + i * 13 + 1);
      const sy = i * bandH;
      const drawH = (i === density - 1) ? (H - sy) : bandH;   // last band fills remainder
      // Deterministic per-band displacement.  When not glitching this frame,
      // 30% of bands still get a tiny nudge so there's visible activity
      // (avoids "totally frozen" look at low Chance).
      let offX = 0, offY = 0;
      const active = isGlitching ? (rB() < 0.75) : (rB() < 0.15);
      if (active) {
        offX = (rB() * 2 - 1) * maxDispX;
        offY = (rB() * 2 - 1) * shakePx * 0.3;
      }

      // Scanline drop: some bands vanish (total drop) or dim.
      let bandAlpha = 1;
      if (scanDrop > 0 && (isGlitching || rB() < 0.3)) {
        const roll = rB();
        if (roll < scanDrop * 0.35)      continue;                 // TOTAL drop
        else if (roll < scanDrop)        bandAlpha = 0.35;         // dim
      }

      ctx.globalAlpha = bandAlpha;
      if (chroma > 0.03 && active) {
        // Per-slice RGB channel offsets — additive composite.
        const chOff = chroma * Math.max(6, maxDispX * 0.15);
        _drawTintedBand(ctx, src, 0, sy, W, drawH, offX - chOff, sy + offY, "#ff0000");
        _drawTintedBand(ctx, src, 0, sy, W, drawH, offX,          sy + offY, "#00ff00");
        _drawTintedBand(ctx, src, 0, sy, W, drawH, offX + chOff, sy + offY, "#0000ff");
      } else {
        ctx.globalCompositeOperation = "source-over";
        ctx.drawImage(src, 0, sy, W, drawH, offX, sy + offY, W, drawH);
      }
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.globalAlpha = 1;

    // Whole-layer shake — offset the entire composite via a translate
    // on the canvas element (not baked into pixels so it doesn't blur).
    const rngS = _rng(seed + frame * 7);
    const shakeX = shake > 0 ? (rngS() * 2 - 1) * shakePx : 0;
    const shakeY = shake > 0 ? (rngS() * 2 - 1) * shakePx * 0.6 : 0;
    dstCanvas.style.transform = shake > 0 ? `translate(${shakeX.toFixed(2)}px, ${shakeY.toFixed(2)}px)` : "";

    // Noise overlay — deterministic tile fill.
    if (noise > 0.02) {
      const tile = _getWeirdNoiseTile(seed + Math.floor(frame / 4));
      ctx.globalAlpha = Math.min(0.6, noise * 0.5);
      ctx.globalCompositeOperation = "overlay";
      for (let ty = 0; ty < H; ty += tile.height) {
        for (let tx = 0; tx < W; tx += tile.width) {
          ctx.drawImage(tile, tx, ty);
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    // Color flash — deterministic color, difference blend.
    if (flash > 0.05 && (isGlitching || rngG() < 0.3)) {
      const rngF = _rng(seed + frame * 3 + 77);
      const cols = ["#ff2a2a", "#2affff", "#ffff2a", "#ff2aff", "#2aff2a", "#ffffff"];
      const col = cols[Math.floor(rngF() * cols.length)];
      ctx.fillStyle = col;
      ctx.globalCompositeOperation = "difference";
      ctx.globalAlpha = Math.min(0.5, flash * 0.35);
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }
  }

  function _showWeirdCanvas(layer) {
    if (layer._weirdCanvas) layer._weirdCanvas.style.display = "";
    if (layer.node && layer.node.style) layer.node.style.visibility = "hidden";
    layer._weirdActive = true;
  }

  function _clearWeirdCanvas(layer) {
    if (layer._weirdCanvas) {
      layer._weirdCanvas.style.display = "none";
      layer._weirdCanvas.style.transform = "";
      const ctx = layer._weirdCanvas.getContext("2d");
      ctx.clearRect(0, 0, layer._weirdCanvas.width, layer._weirdCanvas.height);
    }
    if (layer.node && layer.node.style) layer.node.style.visibility = "";
    layer._weirdActive = false;
    layer._weirdSourceKey = null;
  }

  /* Called from applyTextFxAtTime for TEXT layers.  Also callable
     directly from the export loop so preview and export use the SAME
     compositor. */
  function applyWeirdSlicesOnText(layer, weirdClipEntries, sceneTime) {
    if (!layer || layer.kind !== "TEXT") return;
    if (!weirdClipEntries || !weirdClipEntries.length) {
      if (layer._weirdActive) _clearWeirdCanvas(layer);
      return;
    }
    // Stacking multiple Weird clips is a no-op — use the last active
    // one's params (matches "latest wins" convention used by morph /
    // fill reveal / segment reveal).
    const last = weirdClipEntries[weirdClipEntries.length - 1];
    const clip = last.c;
    const P = clip.params || {};
    _ensureWeirdCanvases(layer);
    _rasterizeTextToSource(layer);
    _compositeWeirdSlices(layer, P, sceneTime);
    _showWeirdCanvas(layer);
  }

  /* Entry point — called from composeLayer for TEXT layers.
     Runs all active text-affecting clips (including persist-past-end
     ones for reveal-style effects).  Rebuilds SVG only when the
     composed display string changes, then applies DOM mutators. */
  function applyTextFxAtTime(layer, sceneTime, sig) {
    if (!layer || layer.kind !== "TEXT") return;
    const activeAll = activeEventClipsAt(layer, sceneTime);
    // Partition by category.
    const strMutClips = [], domMutClips = [], textPathClips = [];
    for (const { c, p } of activeAll) {
      if (TEXT_FX_STRING[c.fxKey]) strMutClips.push({ c, p });
      if (TEXT_FX_DOM[c.fxKey])    domMutClips.push({ c, p });
      if (c.fxKey === "svgTextOnPath") textPathClips.push({ c, p });
    }
    // 1. Compose display string by chaining string mutators (sort by clip.start for stable order)
    const original = layer.textStyle ? String(layer.textStyle.text || "") : "";
    let display = original;
    strMutClips.sort((a, b) => a.c.start - b.c.start);
    for (const { c, p } of strMutClips) {
      const fn = TEXT_FX_STRING[c.fxKey];
      try { display = fn(layer, c, p, sig, sceneTime, display); } catch (e) {}
    }
    // 2. Rebuild SVG only if display string differs from what's currently rendered.
    if (display !== (layer._lastDisplayedText ?? original) || (!strMutClips.length && layer._lastDisplayedText != null && layer._lastDisplayedText !== original)) {
      const backup = layer.textStyle.text;
      // Temporarily swap in the display text so buildTextLayerSVG uses it.
      layer.textStyle.text = display;
      buildTextLayerSVG(layer);
      layer.textStyle.text = backup;
      layer._lastDisplayedText = display;
    }
    // 3. Apply DOM mutators (position/opacity/textPath).
    // Reset dx/dy attributes on all glyph tspans first so mutators
    // compose from a clean base each frame.
    if (domMutClips.length || textPathClips.length) {
      const tspans = _getGlyphTspans(layer);
      for (const ts of tspans) {
        if (ts.hasAttribute("dx")) ts.removeAttribute("dx");
        if (ts.hasAttribute("dy") && !ts.getAttribute("dy").match(/^\d/)) ts.removeAttribute("dy");
        if (ts.hasAttribute("opacity")) ts.removeAttribute("opacity");
      }
    }
    for (const { c, p } of domMutClips) {
      if (c.fxKey === "svgTextOnPath") continue;   // handled separately
      const fn = TEXT_FX_DOM[c.fxKey];
      try { fn(layer, c, p, sig, sceneTime); } catch (e) {}
    }
    if (textPathClips.length) {
      // Only the LAST textPath clip wins (stacking textPaths is nonsensical).
      const tp = textPathClips[textPathClips.length - 1];
      try { TEXT_FX_DOM.svgTextOnPath(layer, tp.c, tp.p, sig, sceneTime); } catch (e) {}
    } else if (layer._textPathApplied) {
      _clearTextPathIfApplied(layer);
    }
    // v19.42: WEIRD SLICE PASS.  If any weirdGlitch clip is active on
    // this TEXT layer, render true horizontal slices into an overlay
    // canvas and hide the underlying SVG.  Compositor owns the visual
    // representation while active — the DOM-level delta from
    // EFFECTS.weirdGlitch still runs on composeLayer but is invisible
    // (SVG hidden); harmless.  When no weird clip is active, the
    // canvas is hidden and the SVG shows again.
    const weirdClips = activeAll.filter(({ c }) => c.fxKey === "weirdGlitch");
    applyWeirdSlicesOnText(layer, weirdClips, sceneTime);
  }

  /* Create a new text layer at the given ARTBOARD pixel position (not
     stage coords).  If x/y omitted, places at artboard center. */
  function createTextLayerAt(artX, artY) {
    const A = STATE.format;
    const id = ++idSeq;
    const svgNS = "http://www.w3.org/2000/svg";
    const node = document.createElementNS(svgNS, "svg");
    const wrap = document.createElement("div");
    wrap.className = "layer-el"; wrap.appendChild(node);
    el.layerHost.appendChild(wrap);
    const style = defaultTextStyle();
    // Build a stub layer object; buildTextLayerSVG fills node contents + natW/H
    const layer = {
      id, name: "Text", kind: "TEXT", assetId: null, complex: false,
      node, wrap, subLayers: [], natW: 100, natH: 40,
      visible: true, locked: false,
      transform: { cx: 0, cy: 0, wPct: 0, hPct: 0, rot: 0, opacity: 100 },
      start: 0, duration: STATE.duration,
      allowTransform: false,
      clips: [],
      recipe: makeRecipe(id * 131),
      originalColors: null,
      textStyle: style,
    };
    // Fill in geometry + SVG
    buildTextLayerSVG(layer);
    // Convert center point (artX, artY) into cx/cy (% offset from center)
    // and compute a wPct/hPct that produces the intrinsic size at 1:1.
    const cx = artX == null ? 0 : ((artX - A.w / 2) / A.w) * 100;
    const cy = artY == null ? 0 : ((artY - A.h / 2) / A.h) * 100;
    layer.transform.cx = clamp(cx, -50, 50);
    layer.transform.cy = clamp(cy, -50, 50);
    layer.transform.wPct = (layer.natW / A.w) * 100;
    layer.transform.hPct = (layer.natH / A.h) * 100;
    layers.push(layer);
    renderLayers(); renderTimeline(); selectLayer(layer); updateHintVisibility();
    renderStaticFrame();
    return layer;
  }

  /* Set the active tool.  "text" activates modal text-creation mode:
     next click on the artboard creates a text layer at that position.
     Auto-reverts to "select" after one placement. */
  function setTool(name) {
    STATE.tool = name || "select";
    // v19.2: sync active state on every tool-strip button.
    const btns = { select: el.toolSelect, text: el.toolText,
      rect: el.toolRect, circle: el.toolCircle, ellipse: el.toolEllipse,
      line: el.toolLine, polygon: el.toolPolygon };
    Object.entries(btns).forEach(([n, btn]) => {
      if (btn) btn.classList.toggle("is-active", STATE.tool === n);
    });
    // Stage cursor state
    if (el.stage) {
      el.stage.classList.toggle("tool-text-active", STATE.tool === "text");
      el.stage.classList.toggle("tool-shape-active", SHAPE_TYPES.includes(STATE.tool));
    }
  }

  /* Convert a page-space (clientX/clientY) point into artboard-space
     pixel coordinates.  Reverse of what applyZoom does to position
     the artboard.  Returns null if the point isn't over the artboard. */
  function stagePointToArtboard(clientX, clientY) {
    if (!el.artboard) return null;
    const rect = el.artboard.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    const z = STATE.zoom || 1;
    return { x: (clientX - rect.left) / z, y: (clientY - rect.top) / z };
  }

  /* Update layer.textStyle with `patch` and rebuild the SVG + transform. */
  function updateTextLayer(layer, patch) {
    if (!layer || layer.kind !== "TEXT") return;
    Object.assign(layer.textStyle, patch);
    const A = STATE.format;
    // Preserve the visual size the user has set: capture current onscreen
    // width in artboard pixels, rebuild SVG to new intrinsic size, then
    // keep the wPct/hPct that produce the same visual bounds.
    const prevVisualW = (layer.transform.wPct / 100) * A.w;
    const prevVisualH = (layer.transform.hPct / 100) * A.h;
    // Was the text auto-sized (matching natW/H exactly)?  If so, resize
    // to the new natural dimensions so text stays crisp.  Otherwise
    // keep the user's manual size.
    const wasAutoSized =
      Math.abs(prevVisualW - (layer.natW / A.w) * A.w) < 1 &&
      Math.abs(prevVisualH - (layer.natH / A.h) * A.h) < 1;
    buildTextLayerSVG(layer);
    if (wasAutoSized) {
      layer.transform.wPct = (layer.natW / A.w) * 100;
      layer.transform.hPct = (layer.natH / A.h) * 100;
    }
    renderStaticFrame();
    renderTimeline();
  }

  /* v19.1 Inline text editing overlay.  Positioned in stage space so
     it renders on top of the layer's on-canvas text.  Font metrics are
     multiplied by STATE.zoom so the editor visually MATCHES the text
     it's editing rather than shrinking to a fixed cap. */
  let _activeTextEditor = null;
  function startTextEdit(layer) {
    if (!layer || layer.kind !== "TEXT" || _activeTextEditor) return;
    // Layer's on-screen bounds in viewport coords, then offset into stage
    // coordinate space (which is scrolled).
    const wrapRect = layer.wrap.getBoundingClientRect();
    const stageRect = el.stage.getBoundingClientRect();
    const ta = document.createElement("textarea");
    ta.className = "text-edit-overlay";
    ta.value = layer.textStyle.text;
    ta.setAttribute("spellcheck", "false");
    ta.style.left  = (wrapRect.left - stageRect.left + el.stage.scrollLeft) + "px";
    ta.style.top   = (wrapRect.top  - stageRect.top  + el.stage.scrollTop) + "px";
    ta.style.width = Math.max(80, wrapRect.width)  + "px";
    ta.style.height = Math.max(28, wrapRect.height) + "px";
    // Match visual font metrics 1:1 with what's on-canvas.
    ta.style.fontFamily = `"${layer.textStyle.fontFamily}", ${TEXT_FONT_STACK}`;
    // The layer wrap is already scaled by STATE.zoom for the on-canvas
    // preview.  Since our overlay lives in stage-space (not artboard-
    // space), we scale font-size by zoom to match visually.
    ta.style.fontSize   = (layer.textStyle.fontSize * (STATE.zoom || 1)) + "px";
    ta.style.fontWeight = layer.textStyle.fontWeight;
    ta.style.color      = layer.textStyle.color;
    ta.style.lineHeight = layer.textStyle.lineHeight || 1.2;
    ta.style.textAlign  = layer.textStyle.align === "start" ? "left" : layer.textStyle.align === "end" ? "right" : "center";
    if (layer.textStyle.letterSpacing) ta.style.letterSpacing = (layer.textStyle.letterSpacing * layer.textStyle.fontSize * (STATE.zoom || 1)).toFixed(2) + "px";
    el.stage.appendChild(ta);
    _activeTextEditor = { textarea: ta, layer };
    // Auto-select the placeholder so the user's first keypress replaces it.
    // Small timeout so focus() applies reliably.
    requestAnimationFrame(() => { ta.focus(); ta.select(); });
    const finalize = () => {
      if (!_activeTextEditor) return;
      const newText = ta.value;
      _activeTextEditor = null;
      ta.remove();
      updateTextLayer(layer, { text: newText || " " });
      renderInspector();
    };
    ta.addEventListener("blur", finalize, { once: true });
    ta.addEventListener("keydown", (ev) => {
      // Enter commits (Shift+Enter inserts newline).  Escape reverts.
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); ta.blur(); }
      else if (ev.key === "Escape") { ev.preventDefault(); ta.value = layer.textStyle.text; ta.blur(); }
    });
  }

  function splitTextNodes(root) {
    root.querySelectorAll("text").forEach((t) => {
      const raw = t.textContent;
      if (!raw || t.dataset.split || t.querySelector("tspan")) return;
      t.dataset.split = "1"; t.textContent = "";
      [...raw].forEach((ch) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "tspan"); s.textContent = ch; s.setAttribute("data-glyph", "1"); t.appendChild(s); });
    });
  }

  /* ================ v19.2 SHAPE TOOLS ================
     Native vector shape layers.  Each shape is stored as an SVG
     containing a single primitive (rect, circle, ellipse, line,
     polygon).  Same rendering path as text and imported SVG, so all
     effects work with zero integration.

     Data model:
       layer.kind       = "SHAPE"
       layer.shapeType  = "rect" | "circle" | "ellipse" | "line" | "polygon"
       layer.shapeStyle = { fill, fillOn, stroke, strokeOn, strokeWidth,
                            cornerRadius, sides }

     Extensibility: future path-based effects (morphing, path
     interpolation) can read layer.node.querySelector("path|rect|...")
     to identify the primitive.  For morphing, converting rect/ellipse
     to a normalized `<path>` at effect-application time is trivial —
     no data-model change needed. */

  const SHAPE_TYPES = ["rect", "circle", "ellipse", "line", "polygon"];
  const SHAPE_LABELS = { rect: "Rectangle", circle: "Circle", ellipse: "Ellipse", line: "Line", polygon: "Polygon" };
  const SHAPE_DEFAULT_SIZE = {
    // default sizes when the user CLICKS (no drag).  Drag overrides.
    rect:     { w: 240, h: 160 },
    circle:   { w: 200, h: 200 },
    ellipse:  { w: 260, h: 180 },
    line:     { w: 240, h: 0   },
    polygon:  { w: 200, h: 200 },
  };
  /* ============================================================
     v19.21 UNIFIED FILL & STROKE for imported SVG layers.

     Design: destructive DOM mutation matching Illustrator behavior.
     Every drawable primitive in the SVG has its fill/stroke/stroke-
     width attributes rewritten in place, and the change persists in
     the exported artwork.  Undo is supported via the same
     `_svgSnapshot` pattern used by v19.11 SVG Repair — before the
     first mutation on a given layer, the original SVG innerHTML is
     snapshotted so undo can restore.

     Read-side (for populating the inspector when an SVG is selected):
     `readSvgFillStroke` extracts the "representative" fill/stroke
     from the first drawable primitive.  If different primitives
     have different colors, this is a lossy readout — the picker
     shows the first primitive's value.  When the user then edits it
     and re-writes, the write applies uniformly to ALL primitives.
     ============================================================ */
  function ensureSvgSnapshot(layer) {
    if (!layer || layer.kind !== "SVG" || !layer.node) return;
    if (!layer._svgSnapshot) layer._svgSnapshot = layer.node.innerHTML;
  }
  function readSvgFillStroke(layer) {
    if (!layer || layer.kind !== "SVG" || !layer.node) return null;
    const prims = layer.node.querySelectorAll("path, rect, circle, ellipse, line, polygon, polyline");
    if (!prims.length) return null;
    // Sample the first primitive as the representative.
    const first = prims[0];
    const cs = window.getComputedStyle(first);
    const rawFill = first.getAttribute("fill");
    const rawStroke = first.getAttribute("stroke");
    const fillEff = rawFill !== null ? rawFill : cs.fill;
    const strokeEff = rawStroke !== null ? rawStroke : cs.stroke;
    const sw = parseFloat(first.getAttribute("stroke-width")) || parseFloat(cs.strokeWidth) || 0;
    const fo = parseFloat(first.getAttribute("fill-opacity"));
    const so = parseFloat(first.getAttribute("stroke-opacity"));
    return {
      fill: normalizeSvgColor(fillEff) || "#7A5CFF",
      fillOn: fillEff !== "none" && fillEff !== "transparent",
      stroke: normalizeSvgColor(strokeEff) || "#FFFFFF",
      strokeOn: strokeEff !== "none" && strokeEff !== "transparent" && sw > 0,
      strokeWidth: sw,
      fillOpacity: Number.isFinite(fo) ? fo : 1,
      strokeOpacity: Number.isFinite(so) ? so : 1,
    };
  }
  // v19.22: SVG-only utility — set fill and stroke to a single color
  // on every drawable primitive.  Used by the "Monochrome" button.
  // The button in the unified panel takes the current Fill color.
  // v19.24: detection uses computed style (catches CSS-classed fills)
  // and mutations write both attribute and inline style (inline beats
  // inlined <style> block per SVG specificity).
  function applySvgMonochrome(layer, color) {
    if (!layer || layer.kind !== "SVG" || !layer.node) return 0;
    ensureSvgSnapshot(layer);
    const prims = layer.node.querySelectorAll("path, rect, circle, ellipse, line, polygon, polyline");
    let count = 0;
    prims.forEach((n) => {
      const attrFill = n.getAttribute("fill");
      const attrStroke = n.getAttribute("stroke");
      const cs = window.getComputedStyle(n);
      // "Visible" if either attribute or computed style says so.
      const hasFill = (attrFill !== null && attrFill !== "none") ||
                      (attrFill === null && cs.fill && cs.fill !== "none" && cs.fill !== "rgba(0, 0, 0, 0)");
      const hasStroke = (attrStroke !== null && attrStroke !== "none") ||
                        (attrStroke === null && cs.stroke && cs.stroke !== "none" && cs.stroke !== "rgba(0, 0, 0, 0)");
      if (hasFill)   { n.setAttribute("fill", color);   n.style.fill = color; }
      if (hasStroke) { n.setAttribute("stroke", color); n.style.stroke = color; }
      n.removeAttribute("data-saved-fill"); n.removeAttribute("data-saved-stroke");
      count++;
    });
    layer._primitives = null; layer._strokes = null;
    layer._segmentPrims = null; layer._segmentOrder = null;
    return count;
  }
  // v19.22: SVG-only utility — invert every fill/stroke color.
  // v19.24: same treatment — use computed style for detection, write
  // both attribute and inline style so CSS class rules don't mask.
  function applySvgInvert(layer) {
    if (!layer || layer.kind !== "SVG" || !layer.node) return 0;
    ensureSvgSnapshot(layer);
    const prims = layer.node.querySelectorAll("path, rect, circle, ellipse, line, polygon, polyline");
    const inv = (v) => {
      if (!v || v === "none" || v.startsWith("url(") || v === "currentColor") return null;
      const norm = normalizeSvgColor(v);
      if (!norm) return null;
      const r = 255 - parseInt(norm.slice(1, 3), 16);
      const g = 255 - parseInt(norm.slice(3, 5), 16);
      const b = 255 - parseInt(norm.slice(5, 7), 16);
      return "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase();
    };
    let count = 0;
    prims.forEach((n) => {
      const cs = window.getComputedStyle(n);
      ["fill", "stroke"].forEach((attr) => {
        const v = n.getAttribute(attr);
        // Effective color: attribute wins if set, otherwise computed style.
        const effective = (v !== null && v !== "none") ? v :
                          (v === null ? cs[attr] : null);
        const iv = inv(effective);
        if (iv) {
          n.setAttribute(attr, iv);
          n.style[attr] = iv;
        }
      });
      count++;
    });
    layer._primitives = null; layer._strokes = null;
    return count;
  }
  // Convert an SVG color string (rgb(...), #hex, named) to a #RRGGBB
  // form the <input type="color"> can display.  Non-representable
  // colors (gradients, patterns, currentColor) return null so the
  // caller can fall back to a default.
  function normalizeSvgColor(v) {
    if (!v) return null;
    v = v.trim();
    if (v === "none" || v === "transparent" || v.startsWith("url(") || v === "currentColor") return null;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toUpperCase();
    if (/^#[0-9a-fA-F]{3}$/.test(v)) {
      return ("#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]).toUpperCase();
    }
    const rgbMatch = v.match(/^rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (rgbMatch) {
      const r = (+rgbMatch[1]).toString(16).padStart(2, "0");
      const g = (+rgbMatch[2]).toString(16).padStart(2, "0");
      const b = (+rgbMatch[3]).toString(16).padStart(2, "0");
      return ("#" + r + g + b).toUpperCase();
    }
    return null;
  }
  // Apply a partial patch to every drawable primitive in the SVG.
  // patch: { fill?, fillOn?, stroke?, strokeOn?, strokeWidth? }
  // Undefined fields are left untouched — a "Fill On" toggle
  // doesn't touch stroke and vice versa.
  //
  // Toggle-off preserves the previous color in a data-* attribute so
  // toggle-on restores it — a user who disables and re-enables Fill
  // shouldn't lose the artwork's original colors.
  function applySvgFillStroke(layer, patch) {
    if (!layer || layer.kind !== "SVG" || !layer.node) return 0;
    ensureSvgSnapshot(layer);
    const prims = layer.node.querySelectorAll("path, rect, circle, ellipse, line, polygon, polyline");
    let count = 0;
    prims.forEach((n) => {
      // v19.24: also write inline style alongside attribute.  CSS
      // rules from an inlined <style> block override presentation
      // attributes in SVG specificity — very common in Illustrator
      // "Save for Web" exports.  Inline style beats <style> block,
      // so setting style.fill/stroke ensures the change is visible.
      if (patch.fill !== undefined) {
        n.setAttribute("fill", patch.fill);
        n.style.fill = patch.fill;
        n.removeAttribute("data-saved-fill");
      }
      if (patch.fillOn !== undefined) {
        if (!patch.fillOn) {
          const cur = n.getAttribute("fill");
          if (cur && cur !== "none" && !n.hasAttribute("data-saved-fill")) {
            n.setAttribute("data-saved-fill", cur);
          }
          n.setAttribute("fill", "none");
          n.style.fill = "none";
        } else if (patch.fill === undefined) {
          const saved = n.getAttribute("data-saved-fill");
          const c = saved || "#7A5CFF";
          n.setAttribute("fill", c);
          n.style.fill = c;
          n.removeAttribute("data-saved-fill");
        }
      }
      if (patch.stroke !== undefined) {
        n.setAttribute("stroke", patch.stroke);
        n.style.stroke = patch.stroke;
        n.removeAttribute("data-saved-stroke");
      }
      if (patch.strokeOn !== undefined) {
        if (!patch.strokeOn) {
          const cur = n.getAttribute("stroke");
          if (cur && cur !== "none" && !n.hasAttribute("data-saved-stroke")) {
            n.setAttribute("data-saved-stroke", cur);
          }
          n.setAttribute("stroke", "none");
          n.style.stroke = "none";
        } else if (patch.stroke === undefined) {
          const saved = n.getAttribute("data-saved-stroke");
          const c = saved || "#FFFFFF";
          n.setAttribute("stroke", c);
          n.style.stroke = c;
          n.removeAttribute("data-saved-stroke");
        }
      }
      if (patch.strokeWidth !== undefined) {
        n.setAttribute("stroke-width", String(patch.strokeWidth));
        n.style.strokeWidth = String(patch.strokeWidth) + "px";
      }
      // v19.22: opacity attributes.  Setting to 1 removes the attribute
      // to keep the SVG string clean.
      if (patch.fillOpacity !== undefined) {
        if (patch.fillOpacity >= 1) { n.removeAttribute("fill-opacity"); n.style.fillOpacity = ""; }
        else { n.setAttribute("fill-opacity", String(patch.fillOpacity)); n.style.fillOpacity = String(patch.fillOpacity); }
      }
      if (patch.strokeOpacity !== undefined) {
        if (patch.strokeOpacity >= 1) { n.removeAttribute("stroke-opacity"); n.style.strokeOpacity = ""; }
        else { n.setAttribute("stroke-opacity", String(patch.strokeOpacity)); n.style.strokeOpacity = String(patch.strokeOpacity); }
      }
      count++;
    });
    // Invalidate primitive caches so effects re-read the new attributes.
    layer._primitives = null; layer._strokes = null;
    layer._segmentPrims = null; layer._segmentOrder = null;
    return count;
  }

  function defaultShapeStyle() {
    return {
      fill: "#7A5CFF",
      fillOn: true,
      stroke: "#FFFFFF",
      strokeOn: false,
      strokeWidth: 2,
      fillOpacity: 1,       // v19.22 unified fill/stroke opacity
      strokeOpacity: 1,
      cornerRadius: 0,   // rect only
      sides: 6,          // polygon only
    };
  }

  /* Compute polygon vertex points inside a box of (w, h). */
  function polygonPointsInBox(sides, w, h) {
    const cx = w / 2, cy = h / 2;
    const rx = w / 2, ry = h / 2;
    const n = Math.max(3, Math.min(24, sides | 0));
    const pts = [];
    // Start at the top so shapes read the way a designer expects.
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
    }
    return pts.map((p) => p[0].toFixed(2) + "," + p[1].toFixed(2)).join(" ");
  }

  /* Build the SVG for a shape layer.  Called on creation AND after
     any style/geometry change.  Sizes viewBox to the shape's intrinsic
     bounding box (including stroke overshoot) so the layer's outer
     dimensions can be transform-scaled predictably. */
  function buildShapeLayerSVG(layer) {
    const svgNS = "http://www.w3.org/2000/svg";
    const s = layer.shapeStyle;
    const t = layer.shapeType;
    const strokePad = Math.max(0, s.strokeWidth || 0);
    // Intrinsic box W×H = layer.natW × natH set at creation time.
    const W = layer.natW, H = layer.natH;
    // Padding accounts for stroke growth outside the primitive edge.
    const pad = strokePad + 2;
    const vbW = W + pad * 2, vbH = H + pad * 2;
    while (layer.node.firstChild) layer.node.removeChild(layer.node.firstChild);
    // v19.7: clear cached path-stroke references — the primitive is
    // about to be replaced, so any Line Draw / Trim Paths / Path
    // Energize effect currently applied would otherwise hold a
    // dangling reference to a detached DOM node.  The cache rebuilds
    // lazily on next pathStrokes() call.
    layer._strokes = null;
    layer._dashApplied = false;
    // v19.8: same invalidation for the shape-style delta baseline
    // cache.  The baseline was measured from the old primitive; the
    // new one may have different stroke/fill defaults.
    layer._primitives = null; layer._segmentPrims = null; layer._segmentOrder = null;
    layer._shapeStyleApplied = false;
    layer.node.setAttribute("xmlns", svgNS);
    layer.node.setAttribute("viewBox", `${-pad} ${-pad} ${vbW} ${vbH}`);
    layer.node.setAttribute("width", "100%");
    layer.node.setAttribute("height", "100%");
    layer.node.setAttribute("preserveAspectRatio", "none");
    const fillAttr   = s.fillOn ? s.fill : "none";
    const strokeAttr = s.strokeOn ? s.stroke : "none";
    let prim;
    if (t === "rect") {
      prim = document.createElementNS(svgNS, "rect");
      prim.setAttribute("x", "0"); prim.setAttribute("y", "0");
      prim.setAttribute("width", String(W));
      prim.setAttribute("height", String(H));
      const r = Math.max(0, Math.min(Math.min(W, H) / 2, s.cornerRadius || 0));
      if (r > 0) { prim.setAttribute("rx", String(r)); prim.setAttribute("ry", String(r)); }
    } else if (t === "circle") {
      prim = document.createElementNS(svgNS, "circle");
      prim.setAttribute("cx", String(W / 2));
      prim.setAttribute("cy", String(H / 2));
      prim.setAttribute("r",  String(Math.min(W, H) / 2));
    } else if (t === "ellipse") {
      prim = document.createElementNS(svgNS, "ellipse");
      prim.setAttribute("cx", String(W / 2));
      prim.setAttribute("cy", String(H / 2));
      prim.setAttribute("rx", String(W / 2));
      prim.setAttribute("ry", String(H / 2));
    } else if (t === "line") {
      // v19.3: lines are stored INTERNALLY as always horizontal
      // (left→right, centered vertically in the bounding box).
      // Direction is expressed via layer.transform.rot so that:
      //   - the 8-way Shift snap during drag maps cleanly onto exact
      //     rotation values (0/45/90/... degrees)
      //   - future stroke-animation effects can traverse a normalized
      //     path without caring about direction
      //   - the transform inspector's rotation control just works
      prim = document.createElementNS(svgNS, "line");
      prim.setAttribute("x1", "0");           prim.setAttribute("y1", String(H / 2));
      prim.setAttribute("x2", String(W));     prim.setAttribute("y2", String(H / 2));
      prim.setAttribute("stroke-linecap", "round");
    } else if (t === "polygon") {
      prim = document.createElementNS(svgNS, "polygon");
      prim.setAttribute("points", polygonPointsInBox(s.sides || 6, W, H));
    }
    if (prim) {
      // Lines don't have meaningful fill; force fill=none for them.
      prim.setAttribute("fill",   t === "line" ? "none" : fillAttr);
      // For lines, if user has BOTH fill+stroke off, still show stroke so
      // the line is visible.
      const effectiveStroke = (t === "line" && !s.strokeOn) ? s.stroke : strokeAttr;
      prim.setAttribute("stroke", effectiveStroke);
      prim.setAttribute("stroke-width", String(s.strokeWidth || 0));
      // v19.22: opacity attributes.  Omit when 1 to keep the SVG clean.
      if (s.fillOpacity !== undefined && s.fillOpacity < 1) {
        prim.setAttribute("fill-opacity", String(s.fillOpacity));
      }
      if (s.strokeOpacity !== undefined && s.strokeOpacity < 1) {
        prim.setAttribute("stroke-opacity", String(s.strokeOpacity));
      }
      layer.node.appendChild(prim);
    }
    return { W: vbW, H: vbH };
  }

  /* Create a shape layer.  `bounds` = { x, y, w, h } in artboard px.
     If w/h are absent or too small, uses defaults for that shape type.
     Returns the created layer. */
  function createShapeLayerAt(shapeType, bounds) {
    if (!SHAPE_TYPES.includes(shapeType)) return null;
    const A = STATE.format;
    const id = ++idSeq;
    const svgNS = "http://www.w3.org/2000/svg";
    const node = document.createElementNS(svgNS, "svg");
    const wrap = document.createElement("div"); wrap.className = "layer-el"; wrap.appendChild(node);
    el.layerHost.appendChild(wrap);
    const defSize = SHAPE_DEFAULT_SIZE[shapeType];

    /* v19.3 LINE handling: convert the drag vector (dx, dy) into a
       horizontal line + a rotation.  Length = drag magnitude, angle =
       atan2(dy, dx).  The bounding box has enough height for the
       stroke, and the layer's transform.rot controls direction.
       This makes 8-way Shift snap map to exact 0/45/90/135/... rotations,
       and keeps the internal SVG geometry consistent regardless of
       drag direction. */
    let layerRotation = 0;
    let x, y, w, h;
    if (shapeType === "line") {
      const dx = bounds && bounds.w != null ? bounds.w : 0;
      const dy = bounds && bounds.h != null ? bounds.h : 0;
      const length = Math.hypot(dx, dy);
      if (length < 4) {
        // Click alone → default horizontal line
        w = defSize.w; h = 12; layerRotation = 0;
        x = (bounds && bounds.x != null ? bounds.x : A.w / 2) - w / 2;
        y = (bounds && bounds.y != null ? bounds.y : A.h / 2) - h / 2;
      } else {
        w = length;
        h = 12;   // enough vertical room for the stroke + hit target
        layerRotation = Math.atan2(dy, dx) * 180 / Math.PI;
        // Position the layer's CENTER at the midpoint of the drag.
        const startX = bounds.x, startY = bounds.y;
        const midX = startX + dx / 2, midY = startY + dy / 2;
        x = midX - w / 2;
        y = midY - h / 2;
      }
    } else {
      // All non-line shapes: original bounding-box logic.
      x = bounds && bounds.x != null ? bounds.x : A.w / 2 - defSize.w / 2;
      y = bounds && bounds.y != null ? bounds.y : A.h / 2 - defSize.h / 2;
      w = bounds && bounds.w != null && Math.abs(bounds.w) >= 4 ? Math.abs(bounds.w) : defSize.w;
      h = bounds && bounds.h != null && Math.abs(bounds.h) >= 4 ? Math.abs(bounds.h) : defSize.h;
      // Circle constrains to square
      if (shapeType === "circle") { const s = Math.min(w, h) || defSize.w; w = s; h = s; }
      // Normalize negative drag directions
      if (bounds && bounds.w < 0) x = bounds.x + bounds.w;
      if (bounds && bounds.h < 0) y = bounds.y + bounds.h;
    }

    const style = defaultShapeStyle();
    // Lines: stroke is required for visibility, so turn it on by default
    if (shapeType === "line") { style.strokeOn = true; style.fillOn = false; style.strokeWidth = 3; }
    const layer = {
      id, name: SHAPE_LABELS[shapeType], kind: "SHAPE", assetId: null, complex: false,
      node, wrap, subLayers: [], natW: w, natH: h,
      visible: true, locked: false,
      transform: { cx: 0, cy: 0, wPct: 0, hPct: 0, rot: layerRotation, opacity: 100 },
      start: 0, duration: STATE.duration,
      allowTransform: false,
      clips: [],
      recipe: makeRecipe(id * 131),
      originalColors: null,
      shapeType, shapeStyle: style,
    };
    buildShapeLayerSVG(layer);
    // Position: layer center = (x + w/2, y + h/2)
    const centerX = x + w / 2, centerY = y + h / 2;
    layer.transform.cx = clamp(((centerX - A.w / 2) / A.w) * 100, -80, 80);
    layer.transform.cy = clamp(((centerY - A.h / 2) / A.h) * 100, -80, 80);
    layer.transform.wPct = (w / A.w) * 100;
    layer.transform.hPct = (Math.max(h, 8) / A.h) * 100;
    layers.push(layer);
    renderLayers(); renderTimeline(); selectLayer(layer); updateHintVisibility();
    renderStaticFrame();
    return layer;
  }

  /* Update layer.shapeStyle with `patch` and rebuild the SVG.  For
     geometry changes (cornerRadius, sides) natW/natH stay put — those
     are the shape's outer bounds — only the internal primitive changes. */
  function updateShapeLayer(layer, patch) {
    if (!layer || layer.kind !== "SHAPE") return;
    Object.assign(layer.shapeStyle, patch);
    buildShapeLayerSVG(layer);
    renderStaticFrame();
    renderTimeline();
  }

  /* ---------------- LAYER CREATION ----------------
     Layer transform is stored as: cx/cy (center, % of artboard, 0=center),
     wPct/hPct (size as % of artboard), rot, opacity. On import the layer
     is fit inside the canvas preserving aspect ratio, centered, NOT scaled
     up or rotated. */
  function addLayerFromAsset(asset) {
    const id = ++idSeq;
    let node;
    let webCodecsSource = null;   // if non-null, this layer uses the WebCodecs path
    if (asset.kind === "SVG") { node = asset.node.cloneNode(true); splitTextNodes(node); }
    else if (asset.kind === "VIDEO") {
      if (asset.meta.useWebCodecs && asset.meta.arrayBuffer) {
        // Path B: create a canvas node that we'll drawImage decoded
        // VideoFrames into on every RAF.  The canvas naturally slots
        // into the existing layer.wrap → composeLayer → CSS filter
        // pipeline, so all 34 event effects work on top of it
        // without special-casing.  A fresh VideoSource is built here
        // so each layer has its own decoder + cache (independent
        // playhead per layer).
        // S2 — canvas is sized to the current preview-quality cap.
        // CSS scales it to fit the artboard regardless of natural
        // resolution, so lower internal size ≠ visible size change.
        node = document.createElement("canvas");
        const cap = previewCanvasSizeFor(asset.meta.natW, asset.meta.natH);
        node.width  = cap.w;
        node.height = cap.h;
        node._is_webcodecs_video = true;   // marker used by the render loop
        // v19.39 hybrid preview: also create an offscreen native
        // <video> element that owns the same source bytes (via a Blob
        // URL).  During normal playback the RAF loop drawImages from
        // this element — smooth sequential decode handled by the
        // browser's native pipeline.  Paused/scrubbing still uses the
        // WebCodecs videoSource for frame-accurate access.
        try {
          const blob = new Blob([asset.meta.arrayBuffer], { type: "video/mp4" });
          const previewUrl = URL.createObjectURL(blob);
          const pvEl = document.createElement("video");
          pvEl.muted = true;          // never duplicate audio
          pvEl.playsInline = true;
          pvEl.preload = "auto";
          pvEl.crossOrigin = "anonymous";
          pvEl.src = previewUrl;
          // Attached to a hidden container so the browser prioritizes
          // decoding but nothing renders it in-layout.  layer.node
          // (the canvas) remains the visible element.
          pvEl.style.cssText = "position:absolute;left:-99999px;top:0;width:1px;height:1px;pointer-events:none;visibility:hidden";
          document.body.appendChild(pvEl);
          // Store on the node so we can find it after layer creation.
          node._previewVideoEl = pvEl;
          node._previewVideoUrl = previewUrl;
        } catch (e) {
          console.warn("[hybrid] preview <video> setup failed:", e);
        }
        // Kick off VideoSource creation asynchronously; until it's
        // ready, the canvas stays black.  The initial snapshot is
        // drawn as soon as the source is ready.
        VideoSource.create(asset.meta.arrayBuffer).then((source) => {
          if (!node.isConnected) { source.close(); return; }
          const found = layers.find((L) => L.node === node);
          if (!found) { source.close(); return; }
          found.videoSource = source;
          // Prime the cache with frame 0 and draw it immediately.
          source.getFrameAtSourceTime(0).then((frame) => {
            try {
              const ctx = node.getContext("2d");
              ctx.drawImage(frame, 0, 0, node.width, node.height);
            } catch (e) {}
            paintIfPaused();
          }).catch(() => {});
        }).catch((e) => {
          console.warn("[VideoSource] layer init failed, using snapshot fallback", e);
          // Draw the asset's first-frame snapshot as a static fallback.
          try { node.getContext("2d").drawImage(asset.node, 0, 0, node.width, node.height); } catch (e) {}
        });
      } else {
        // Legacy path: keep the Phase 2 <video> element behaviour.
        node = document.createElement("video");
        node.muted = true;
        node.playsInline = true;
        node.preload = "auto";
        node.crossOrigin = "anonymous";
        node.src = asset.meta.videoUrl;
        node.addEventListener("error", () => {
          toast(`Couldn't decode ${asset.name} — browser doesn't support this codec`);
        });
      }
    }
    else {
      node = new Image(); node.src = asset.dataUrl;
    }
    const wrap = document.createElement("div"); wrap.className = "layer-el"; wrap.appendChild(node);
    el.layerHost.appendChild(wrap);

    // Default import sizing = Fit to Canvas (contain the whole artwork,
    // preserving aspect ratio via viewBox), centered. No auto-scale-up
    // past the artboard, no rotation.
    const A = STATE.format, nat = asset.meta;
    const fit = Math.min(A.w / nat.natW, A.h / nat.natH); // contain, fills the smaller dimension
    const wPx = nat.natW * fit, hPx = nat.natH * fit;

    let subLayers = [];
    if (asset.kind === "SVG" && STATE.exposeSub) subLayers = extractSubLayers(node, id);

    const layer = {
      id, name: asset.name, kind: asset.kind, assetId: asset.id, complex: asset.meta.complex,
      node, wrap, subLayers, natW: nat.natW, natH: nat.natH,
      visible: true, locked: false,
      transform: { cx: 0, cy: 0, wPct: (wPx / A.w) * 100, hPct: (hPx / A.h) * 100, rot: 0, opacity: 100 },
      start: 0, duration: STATE.duration,
      allowTransform: false,
      clips: [],   // timeline event clips (unified system): { id, fxKey, start, duration }
      recipe: makeRecipe(id * 131),
      originalColors: null,
    };
    // VIDEO layers: schema fields, additive.  WebCodecs layers use
    // layer.videoSource (attached asynchronously above); legacy layers
    // use layer.videoEl (the <video> node itself).
    if (asset.kind === "VIDEO") {
      layer.useWebCodecs = !!asset.meta.useWebCodecs;
      layer.videoEl = layer.useWebCodecs ? null : node;
      layer.videoSource = null;         // filled in when VideoSource.create resolves
      layer.videoUrl = nat.videoUrl || null;
      layer.videoDuration = nat.duration || 0;
      layer.srcInPoint = 0;
      layer.srcOutPoint = nat.duration || 0;
      layer.speed = 1;                  // Phase 3 hook — not read yet
      // Diag from import — inspector reads this to show WHY the layer
      // ended up on WebCodecs or Legacy.
      layer.videoDiag = nat.videoDiag || null;
      // v19.39: hybrid preview — pull the native preview element off
      // the node onto the layer where the paint path expects it.
      if (node && node._previewVideoEl) {
        layer._previewVideoEl = node._previewVideoEl;
        layer._previewVideoUrl = node._previewVideoUrl;
        delete node._previewVideoEl; delete node._previewVideoUrl;
      }
    }
    captureOriginalColors(layer);
    layers.push(layer);
    renderLayers(); renderTimeline(); selectLayer(layer); updateHintVisibility();
    // IMPORTANT: do NOT auto-play. Imported layers stay static until the
    // user applies an effect/preset or presses Play. Render one static
    // frame so the layer is visible in its resting position.
    renderStaticFrame();
  }

  function extractSubLayers(node, id) {
    try {
      const subs = Array.from(node.querySelectorAll("g, path, rect, circle, ellipse, line, polyline, polygon, text, use, symbol"))
        .filter((n) => !(n.tagName.toLowerCase() === "g" && n.children.length === 0));
      if (subs.length > 300) { toast("SVG is very complex — keeping it grouped as one layer"); return []; }
      subs.forEach((s, i) => (s._recipe = makeRecipe(id * 97 + i)));
      return subs.slice(0, 60);
    } catch (e) { toast("SVG sublayer parsing was unstable — kept grouped"); return []; }
  }

  function makeRecipe(seed) {
    const rnd = mulberry32((seed + 1) >>> 0);
    const band = ["bass", "mid", "high"][Math.floor(rnd() * 3)];
    return { phase: rnd() * Math.PI * 2, ampX: 1 + rnd() * 4, ampY: 1 + rnd() * 3, freq: 0.5 + rnd() * 1.8, flickerBias: 0.3 + rnd() * 0.7, band, delay: rnd() * 0.7 };
  }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function updateHintVisibility() { el.stageHint.style.display = layers.length ? "none" : ""; }

  function duplicateLayer(layer) {
    /* v19.1: duplicate produces a copy AT THE EXACT SAME POSITION.
       Any offset is annoying when duplication is used to build
       variations from a fixed anchor.  Also handles text layers
       (no asset in the library) and preserves every editable field
       so the copy is truly identical. */
    let dup = null;
    if (layer.kind === "TEXT") {
      // Rebuild the text layer from its textStyle.
      const s = layer.textStyle;
      dup = createTextLayerAt();  // creates at center by default
      // Overwrite defaults with the source's style + transform
      dup.textStyle = JSON.parse(JSON.stringify(s));
      buildTextLayerSVG(dup);
    } else if (layer.kind === "SHAPE") {
      // Rebuild the shape layer at the same intrinsic size, then
      // copy the shapeStyle verbatim.  transform is copied below.
      dup = createShapeLayerAt(layer.shapeType, { x: 0, y: 0, w: layer.natW, h: layer.natH });
      dup.shapeStyle = JSON.parse(JSON.stringify(layer.shapeStyle));
      buildShapeLayerSVG(dup);
    } else if (layer.kind === "GROUP") {
      // v19.17: duplicating a group produces a NEW independent group
      // with fresh member copies.  Sequence:
      //   1. Temporarily restore each source member's suspended clips
      //      so the SHAPE/SVG/TEXT dup paths copy them into duplicates.
      //   2. Duplicate each member as an independent layer.
      //   3. Re-suspend the source members' clips (they stay grouped).
      //   4. Multi-select the new duplicates.
      //   5. Call _groupSelectedLayers() to form the new group — this
      //      also suspends the duplicated clips into _suspendedClips.
      //   6. Copy the source group's transform onto the new group so
      //      it lands at the same position/scale/rotation.
      //   7. Copy the source group's own clips.
      if (!_groupSelectedLayers) { toast("Group duplication not yet ready"); return; }
      // v19.20: temporarily restore source members' clips so dupes
      // carry them; re-suspend afterwards.  Without this, dup members
      // would have empty clips and empty _suspendedClips.
      const wasSuspended = [];
      layer._members.forEach((m) => {
        wasSuspended.push(m._suspendedClips || null);
        if (m._suspendedClips) { m.clips = m._suspendedClips; m._suspendedClips = undefined; }
      });
      const beforeIds = new Set(layers.map((L) => L.id));
      layer._members.forEach((m) => duplicateLayer(m));
      // Re-suspend the source members' clips.
      layer._members.forEach((m, i) => {
        if (wasSuspended[i]) { m._suspendedClips = m.clips; m.clips = []; }
      });
      const memberDups = layers.filter((L) => !beforeIds.has(L.id));
      selectedLayers = memberDups.slice();
      selectedLayer = memberDups[memberDups.length - 1] || null;
      _groupSelectedLayers();
      dup = selectedLayer;   // the newly-created group
      if (dup && dup.kind === "GROUP") {
        // Copy source group's transform + clips onto the duplicate so
        // it visually matches (position, scale, rotation, animation).
        Object.assign(dup.transform, layer.transform);
        dup._identityTransform = { ...layer._identityTransform };
        dup._groupNatWpct = layer._groupNatWpct;
        dup._groupNatHpct = layer._groupNatHpct;
        dup.name = layer.name + " copy";
        dup.clips = layer.clips.map((c) => ({
          ...c,
          id: ++idSeq,
          params: c.params ? JSON.parse(JSON.stringify(c.params)) : {},
        }));
      }
      return;
    } else {
      const asset = assets.find((a) => a.id === layer.assetId);
      if (!asset) { toast("Original asset not in library"); return; }
      addLayerFromAsset(asset);
      dup = layers[layers.length - 1];
    }
    // Copy the transform verbatim — SAME position, scale, rotation, opacity.
    dup.transform = { ...layer.transform };
    dup.allowTransform = layer.allowTransform;
    dup.clips = layer.clips.map((c) => ({
      ...c,
      id: ++idSeq,
      params: c.params ? JSON.parse(JSON.stringify(c.params)) : {},
    }));
    dup.start = layer.start;
    dup.duration = layer.duration;
    dup.visible = layer.visible;
    dup.locked = layer.locked;
    dup.name = layer.name + " copy";
    // Video-specific fields.
    if (layer.kind === "VIDEO") {
      dup.srcInPoint = layer.srcInPoint;
      dup.srcOutPoint = layer.srcOutPoint;
      dup.speed = layer.speed;
    }
    renderLayers(); renderTimeline(); renderInspector(); paintIfPaused();
  }
  function deleteLayer(layer) {
    const i = layers.indexOf(layer); if (i < 0) return;
    // v19.37: cancel any pending seeks / callbacks and free the
    // <video> element + object URL for legacy layers before we
    // disconnect the DOM.  Without this, seeking Promises resolve
    // against a stale layer reference and hold GPU memory.
    if (layer._vidCoalesce) {
      layer._vidCoalesce.pending = null;
      layer._vidCoalesce.seeking = false;
      if (layer._vidCoalesce.requestedIdx) layer._vidCoalesce.requestedIdx.clear();
    }
    if (layer.videoEl) {
      try { layer.videoEl.pause(); } catch (e) {}
      try { layer.videoEl.removeAttribute("src"); layer.videoEl.load(); } catch (e) {}
      if (layer.videoUrl) { try { URL.revokeObjectURL(layer.videoUrl); } catch (e) {} }
      layer.videoEl = null; layer.videoUrl = null;
    }
    // v19.39: also tear down the hybrid preview element (WebCodecs layers).
    if (layer._previewVideoEl) {
      try { layer._previewVideoEl.pause(); } catch (e) {}
      try { layer._previewVideoEl.removeAttribute("src"); layer._previewVideoEl.load(); } catch (e) {}
      try { if (layer._previewVideoEl.parentNode) layer._previewVideoEl.parentNode.removeChild(layer._previewVideoEl); } catch (e) {}
      if (layer._previewVideoUrl) { try { URL.revokeObjectURL(layer._previewVideoUrl); } catch (e) {} }
      layer._previewVideoEl = null; layer._previewVideoUrl = null;
    }
    // v19.40: also tear down the export-only paused HTMLVideoElement
    // if an export was mid-flight when the layer was deleted.
    if (layer._exportVideoEl) {
      try { layer._exportVideoEl.pause(); } catch (e) {}
      try { layer._exportVideoEl.removeAttribute("src"); layer._exportVideoEl.load(); } catch (e) {}
      try { if (layer._exportVideoEl.parentNode) layer._exportVideoEl.parentNode.removeChild(layer._exportVideoEl); } catch (e) {}
      layer._exportVideoEl = null;
    }
    // v19.42: weird slice compositor cleanup (text layers).
    if (layer._weirdCanvas) {
      try { if (layer._weirdCanvas.parentNode) layer._weirdCanvas.parentNode.removeChild(layer._weirdCanvas); } catch (e) {}
      layer._weirdCanvas = null;
    }
    layer._weirdSourceCanvas = null;
    layer._weirdSourceKey = null;
    layer._weirdActive = false;
    // Path B: release the decoder + close all cached VideoFrames.
    // Without this, GPU memory leaks with every deleted video layer.
    if (layer.videoSource) { try { layer.videoSource.close(); } catch (e) {} layer.videoSource = null; }
    // S2: drop the export-resolution canvas reference so GC can reclaim.
    if (layer._exportCanvas) layer._exportCanvas = null;
    // v19.16: deleting a GROUP also disposes its members — their DOM
    // is inside the group wrap and would leak otherwise.  User can
    // ungroup first if they want the members back.
    if (layer.kind === "GROUP" && layer._members) {
      layer._members.forEach((m) => { if (m.wrap && m.wrap.parentNode) m.wrap.parentNode.removeChild(m.wrap); });
      layer._members = null;
    }
    if (layer.wrap && layer.wrap.parentNode) layer.wrap.parentNode.removeChild(layer.wrap);
    layers.splice(i, 1);
    // v19.4: also remove from selectedLayers so multi-select stays coherent.
    const sIdx = selectedLayers.indexOf(layer);
    if (sIdx >= 0) selectedLayers.splice(sIdx, 1);
    if (selectedLayer === layer) selectedLayer = selectedLayers[selectedLayers.length - 1] || null;
    renderLayers(); renderTimeline(); renderInspector(); updateHintVisibility(); updateSelectionBox(); paintIfPaused();
  }
  function toggleLayerVisible(layer) { layer.visible = !layer.visible; layer.wrap.style.display = layer.visible ? "" : "none"; renderLayers(); paintIfPaused(); }
  function toggleLayerLock(layer) { layer.locked = !layer.locked; renderLayers(); renderInspector(); }

  /* ---------------- LAYER STACK ---------------- */
  function renderLayers() {
    el.layerCount.textContent = layers.length;
    applyZOrder();
    if (!layers.length) { el.layerStack.innerHTML = '<li class="empty-note">Add an asset to create a layer.</li>'; return; }
    el.layerStack.innerHTML = "";
    [...layers].reverse().forEach((layer) => {
      const li = document.createElement("li");
      // v19.4: distinct classes for primary vs secondary selection.
      //  - .selected      → primary (drives inspector; darker highlight)
      //  - .multi-selected → secondary (part of the multi-selection)
      const isPrimary = layer === selectedLayer;
      const isMulti = selectedLayers.length > 1 && selectedLayers.includes(layer);
      li.className = "layer-row"
        + (isPrimary ? " selected" : "")
        + (isMulti && !isPrimary ? " multi-selected" : "")
        + (layer.visible ? "" : " hidden-layer")
        + (layer.locked ? " locked-layer" : "");
      li.draggable = true; li.dataset.id = layer.id;
      li.title = "Right-click for options (Replace Asset…)";
      // v19.16: groups show a distinct thumb + subtitle indicating
      // member count, so users can visually distinguish them from
      // regular layers.  Clicking a group selects it as one entity;
      // there's no "click into" behavior in v1 (must ungroup to
      // access individual members).
      let thumb;
      if (layer.kind === "GROUP") {
        thumb = `<div class="group-thumb"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="10" y="10" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="10" y="2" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></div>`;
      } else {
        thumb = layer.kind === "IMG" ? `<img src="${layer.node.src}" alt="">` : svgThumb(layer.node);
      }
      const memberSuffix = layer.kind === "GROUP" && layer._members ? ` \u00b7 ${layer._members.length} items` : "";
      const partsSuffix  = layer.subLayers && layer.subLayers.length ? " \u00b7 " + layer.subLayers.length + " parts" : "";
      li.innerHTML =
        `<span class="layer-drag" title="Drag to reorder"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="4" cy="3" r="1" fill="currentColor"/><circle cx="8" cy="3" r="1" fill="currentColor"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="8" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="9" r="1" fill="currentColor"/><circle cx="8" cy="9" r="1" fill="currentColor"/></svg></span>` +
        `<span class="layer-thumb">${thumb}</span>` +
        `<span class="layer-meta"><span class="layer-title">${layer.name}</span><span class="layer-sub">${layer.kind}${memberSuffix}${partsSuffix}</span></span>` +
        `<button class="layer-eye" title="Hide / show">${layer.visible ? eyeOpen() : eyeClosed()}</button>`;
      li.addEventListener("click", (e) => {
        if (e.target.closest(".layer-eye")) { toggleLayerVisible(layer); e.stopPropagation(); return; }
        // v19.4: Shift/Cmd-click = additive; plain click = single-select.
        const additive = e.shiftKey || e.metaKey || e.ctrlKey;
        selectLayer(layer, { additive });
      });
      addLayerDrag(li, layer);
      el.layerStack.appendChild(li);
    });
  }
  function eyeOpen() { return '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" stroke="currentColor" stroke-width="1.2"/><circle cx="7" cy="7" r="1.6" fill="currentColor"/></svg>'; }
  function eyeClosed() { return '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 3l10 8M1 7s2.2-4 6-4c1 0 1.9.3 2.7.7M13 7s-2.2 4-6 4c-.5 0-1-.07-1.4-.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'; }

  let dragLayer = null;
  function addLayerDrag(li, layer) {
    li.addEventListener("dragstart", (e) => { dragLayer = layer; li.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
    li.addEventListener("dragend", () => { li.classList.remove("dragging"); $$(".layer-row").forEach((r) => r.classList.remove("drop-above", "drop-below")); dragLayer = null; });
    li.addEventListener("dragover", (e) => { e.preventDefault(); const rect = li.getBoundingClientRect(), below = e.clientY > rect.top + rect.height / 2; $$(".layer-row").forEach((r) => r.classList.remove("drop-above", "drop-below")); li.classList.add(below ? "drop-below" : "drop-above"); });
    li.addEventListener("drop", (e) => {
      e.preventDefault(); if (!dragLayer || dragLayer === layer) return;
      const rect = li.getBoundingClientRect(), below = e.clientY > rect.top + rect.height / 2;
      const from = layers.indexOf(dragLayer); layers.splice(from, 1);
      let to = layers.indexOf(layer); to = below ? to : to + 1;
      layers.splice(Math.max(0, to), 0, dragLayer);
      renderLayers(); renderTimeline();
    });
    // v19.31: right-click → Replace Asset context menu.
    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showLayerContextMenu(e.clientX, e.clientY, layer);
    });
  }

  /* v19.31 lightweight context menu.  Positioned at pointer, dismissed
     on any click outside or Escape.  Currently one action (Replace
     Asset) — the plumbing is generic so we can add more later
     (Duplicate, Isolate, Lock, etc.). */
  let _ctxMenuEl = null;
  function dismissContextMenu() {
    if (_ctxMenuEl && _ctxMenuEl.parentNode) _ctxMenuEl.parentNode.removeChild(_ctxMenuEl);
    _ctxMenuEl = null;
    document.removeEventListener("click", dismissContextMenu, true);
    document.removeEventListener("keydown", _ctxEscHandler, true);
  }
  function _ctxEscHandler(e) { if (e.key === "Escape") dismissContextMenu(); }
  function showLayerContextMenu(x, y, layer) {
    dismissContextMenu();
    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    menu.style.left = x + "px"; menu.style.top = y + "px";
    const canReplace = layer && (layer.kind === "IMG" || layer.kind === "SVG" || layer.kind === "VIDEO" || layer.kind === "SHAPE");
    const items = [
      { label: "Replace Asset…", disabled: !canReplace, action: () => promptReplaceAsset(layer),
        note: layer.kind === "TEXT" ? "(text not applicable)" : layer.kind === "GROUP" ? "(group)" : "" },
    ];
    items.forEach((it) => {
      const btn = document.createElement("button");
      btn.className = "ctx-menu-item" + (it.disabled ? " disabled" : "");
      btn.textContent = it.label + (it.note ? "  " + it.note : "");
      if (!it.disabled) btn.addEventListener("click", (ev) => { ev.stopPropagation(); it.action(); dismissContextMenu(); });
      menu.appendChild(btn);
    });
    document.body.appendChild(menu);
    _ctxMenuEl = menu;
    // Register dismissal handlers after the current event completes.
    setTimeout(() => {
      document.addEventListener("click", dismissContextMenu, true);
      document.addEventListener("keydown", _ctxEscHandler, true);
    }, 0);
  }
  function applyZOrder() { layers.forEach((layer, i) => { if (layer.wrap) layer.wrap.style.zIndex = String(i + 1); }); }

  /* v19.4 selectLayer with multi-select support.
     opts.additive  → toggle this layer's membership in selectedLayers
                      (Shift-click / Cmd-click behavior).
     opts.append    → add this layer without deselecting the others
                      (used programmatically; rarely needed by UI).
     Default (no opts) → single-select the layer (replaces selection).
     Passing `null` clears the selection entirely. */
  function selectLayer(layer, opts) {
    opts = opts || {};
    if (!layer) {
      selectedLayer = null;
      selectedLayers = [];
    } else if (opts.additive) {
      const idx = selectedLayers.indexOf(layer);
      if (idx >= 0) {
        // Toggle off — but keep at least one selected if possible.
        selectedLayers.splice(idx, 1);
        selectedLayer = selectedLayers.length ? selectedLayers[selectedLayers.length - 1] : null;
      } else {
        selectedLayers.push(layer);
        selectedLayer = layer;
      }
    } else if (opts.append) {
      if (!selectedLayers.includes(layer)) selectedLayers.push(layer);
      selectedLayer = layer;
    } else {
      // Default: single-select
      selectedLayer = layer;
      selectedLayers = [layer];
    }
    renderLayers(); renderInspector(); renderTimeline(); updateSelectionBox();
    // v19.33: also refresh the clip toolbar so D/S/E populate from
    // the selected layer's timing when no clip is selected.
    renderClipInspector();
    if (el.readoutSel) {
      if (!selectedLayer) el.readoutSel.textContent = "No layer selected";
      else if (selectedLayers.length > 1) el.readoutSel.textContent = `${selectedLayers.length} layers selected`;
      else el.readoutSel.textContent = selectedLayer.name;
    }
  }

  /* ---------------- INSPECTOR (transform + color + fx) ---------------- */
  /* v15.3 — Render the video diagnostic panel from layer.videoDiag.
     Extracts environmental status (WebCodecs API + mp4box) and the
     fallback reason from the raw diag step trail.  Adds a helpful
     hint below the status when the fallback reason is one we recognize
     (CDN block, HEVC, no WebCodecs, etc.).  Called from renderInspector
     whenever a video layer is selected. */
  function renderVideoDiagPanel(layer) {
    const $ = (id) => document.getElementById(id);
    const setVal = (id, text, cls) => {
      const e = $(id); if (!e) return;
      e.textContent = text;
      e.className = "video-diag-val" + (cls ? " " + cls : "");
    };
    const setHint = (text) => {
      const e = $("diag-hint"); if (!e) return;
      if (text) { e.textContent = text; e.classList.add("show"); }
      else { e.textContent = ""; e.classList.remove("show"); }
    };
    // If the layer has no diag object (very old asset, or edge case),
    // show a minimal panel with environmental info anyway.
    const diag = layer.videoDiag || { steps: [], finalPath: null, error: null };
    const stepByLabel = {};
    for (const s of (diag.steps || [])) {
      if (!stepByLabel[s.label]) stepByLabel[s.label] = s;
    }

    // --- WebCodecs API row (from step or current env) ---
    const wcStep = stepByLabel["WebCodecs API check"];
    const wcAvail = wcStep
      ? (!!wcStep.hasVideoDecoder && !!wcStep.hasEncodedVideoChunk)
      : (typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined");
    setVal("diag-webcodecs", wcAvail ? "available" : "unavailable", wcAvail ? "diag-ok" : "diag-err");

    // --- mp4box.js row ---
    // Loaded if either the "mp4box.js loaded" step exists, or the current
    // window has MP4Box defined.
    const mp4Step = stepByLabel["mp4box.js loaded"];
    const mp4Global = typeof window.MP4Box !== "undefined";
    let mp4Val, mp4Cls;
    if (mp4Step || mp4Global) { mp4Val = "loaded"; mp4Cls = "diag-ok"; }
    else if (diag.error && /mp4box/i.test(diag.error)) { mp4Val = "failed to load"; mp4Cls = "diag-err"; }
    else if (diag.finalPath === "legacy:not-mp4" || diag.finalPath === "legacy:no-webcodecs-api") { mp4Val = "not attempted"; mp4Cls = ""; }
    else { mp4Val = "not attempted"; mp4Cls = ""; }
    setVal("diag-mp4box", mp4Val, mp4Cls);

    // --- Codec row ---
    // Try to pull codec from the "codec selected" or "demux complete" step,
    // or from the asset meta if we got that far.
    const codecStep = stepByLabel["demux complete"] || stepByLabel["codec selected"] || stepByLabel["checking codec support"];
    const codec = (codecStep && codecStep.codec) || null;
    setVal("diag-codec", codec || "not detected", codec ? "" : "diag-warn");

    // --- Fallback row ---
    if (layer.useWebCodecs) {
      // Success — hide the fallback row (nothing to report).
      const row = $("diag-reason-row"); if (row) row.style.display = "none";
      setHint("");
    } else {
      const row = $("diag-reason-row"); if (row) row.style.display = "";
      const reason = diag.finalPath || "unknown";
      const msg    = diag.error     || (REASON_MESSAGES[reason] || "See DevTools console for details");
      setVal("diag-reason", msg, "diag-err");
      // Helpful hint below the status.
      setHint(REASON_HINTS[reason] || (
        diag.error && /codec not supported/i.test(diag.error)
          ? "This browser can't decode this codec via WebCodecs. Re-encode as H.264 (avc1) for frame-accurate playback."
        : diag.error && /mp4box/i.test(diag.error)
          ? "mp4box.js was blocked from loading (extension, corporate proxy, or CSP). Try a different network, disable ad-blockers for this site, or self-host mp4box."
        : ""
      ));
    }
  }

  // Human-readable messages + hints keyed by diag.finalPath.
  const REASON_MESSAGES = {
    "legacy:not-mp4":                    "file is not MP4",
    "legacy:no-webcodecs-api":           "WebCodecs API missing",
    "legacy:file-read-error":            "couldn't read file bytes",
    "legacy:VideoSource.create-threw":   "demux/decoder init failed",
    "legacy:snapshot-failed":            "first-frame decode failed",
    "legacy:snapshot-img-load-failed":   "snapshot image load failed",
    "legacy:direct":                     "WebM/other, always legacy",
  };
  const REASON_HINTS = {
    "legacy:not-mp4":                    "WebM sources always use the legacy path in this build. B6 will add WebM WebCodecs support.",
    "legacy:no-webcodecs-api":           "Browser doesn't expose VideoDecoder. Try Microsoft Edge, Chrome, or Safari 16.4+.",
    "legacy:file-read-error":            "The browser refused to read the file. Try re-importing.",
    "legacy:snapshot-img-load-failed":   "Decoded frame couldn't be turned into a preview image. Rare — try re-encoding the source.",
    "legacy:direct":                     "This file type uses the legacy decoder by design.",
  };

  function renderInspector() {
    const has = !!selectedLayer;
    el.transformEmpty.hidden = has; el.transformBody.hidden = !has;
    el.fxEmpty.hidden = has; el.fxBody.hidden = !has;
    // v19.31: Align panel visibility + reference label + distribute enablement.
    const alignEmpty = document.getElementById("alignEmpty");
    const alignBody  = document.getElementById("alignBody");
    const alignRef   = document.getElementById("alignRef");
    const distH      = document.getElementById("distH");
    const distV      = document.getElementById("distV");
    if (alignEmpty && alignBody) {
      alignEmpty.hidden = has; alignBody.hidden = !has;
      if (has) {
        const nSel = (selectedLayers && selectedLayers.length) || 1;
        if (alignRef) alignRef.textContent = nSel >= 2
          ? `Reference: selection (${nSel} layers)`
          : "Reference: canvas";
        if (distH) distH.disabled = nSel < 3;
        if (distV) distV.disabled = nSel < 3;
      }
    }
    const isSvg = has && selectedLayer.kind === "SVG";
    const isVideo = has && selectedLayer.kind === "VIDEO";
    const isText = has && selectedLayer.kind === "TEXT";
    const isShape = has && selectedLayer.kind === "SHAPE";
    // v19.22: legacy colorEmpty/colorBody removed with the panel.
    // v19.0: Text panel — visible only for TEXT layers.
    if (el.textGroup) {
      el.textGroup.hidden = !isText;
      // v19.1: toggle a class on the right panel-scroll so CSS `order`
      // promotes the text group to the top when a text layer is
      // selected, without any DOM mutation.
      const rightScroll = el.textGroup.closest(".panel-scroll");
      if (rightScroll) rightScroll.classList.toggle("text-layer-selected", isText);
      if (isText) {
        const s = selectedLayer.textStyle;
        // populate — guard against clobbering focused input
        const setIf = (elm, val) => { if (elm && document.activeElement !== elm) elm.value = val; };
        setIf(el.textContent, s.text || "");
        setIf(el.textFontFamily, s.fontFamily);
        setIf(el.textSize, s.fontSize);
        setIf(el.textSizeRange, Math.min(400, s.fontSize));
        setIf(el.textWeight, String(s.fontWeight));
        setIf(el.textColor, s.color);
        if (el.textColorHex) el.textColorHex.textContent = (s.color || "").toUpperCase();
        setIf(el.textLetterSpacing, s.letterSpacing || 0);
        setIf(el.textLineHeight, s.lineHeight || 1.2);
        if (el.textAlignSeg) {
          el.textAlignSeg.querySelectorAll("[data-align]").forEach((b) => {
            b.classList.toggle("active", b.dataset.align === s.align);
          });
        }
      }
    }
    // v19.2 Shape panel — visible only for SHAPE layers.
    if (el.shapeGroup) {
      // v19.21: Fill & Stroke panel is now shown for SVG imports too,
      // not just native SHAPE layers.  Both layer kinds route through
      // the same inspector controls; the write path branches based on
      // kind (SHAPE → updateShapeLayer; SVG → applySvgFillStroke).
      const isSvgKind = selectedLayer && selectedLayer.kind === "SVG";
      const showPanel = isShape || isSvgKind;
      el.shapeGroup.hidden = !showPanel;
      const rightScroll2 = el.shapeGroup.closest(".panel-scroll");
      if (rightScroll2) rightScroll2.classList.toggle("shape-layer-selected", showPanel);
      if (isShape) {
        const s = selectedLayer.shapeStyle;
        const type = selectedLayer.shapeType;
        const setIf = (elm, val) => { if (elm && document.activeElement !== elm) elm.value = val; };
        if (el.shapeTypeBadge) el.shapeTypeBadge.textContent = SHAPE_LABELS[type] || type;
        setIf(el.shapeFill,   s.fill);
        if (el.shapeFillHex)  el.shapeFillHex.textContent = (s.fill || "").toUpperCase();
        setIf(el.shapeStroke, s.stroke);
        if (el.shapeStrokeHex) el.shapeStrokeHex.textContent = (s.stroke || "").toUpperCase();
        if (el.shapeFillOn && document.activeElement !== el.shapeFillOn)     el.shapeFillOn.checked   = !!s.fillOn;
        if (el.shapeStrokeOn && document.activeElement !== el.shapeStrokeOn) el.shapeStrokeOn.checked = !!s.strokeOn;
        setIf(el.shapeStrokeW, s.strokeWidth);
        setIf(el.shapeStrokeWRange, Math.min(60, s.strokeWidth));
        // v19.22: opacity fields (0-100 in UI).
        const fo = Math.round((s.fillOpacity !== undefined ? s.fillOpacity : 1) * 100);
        const so = Math.round((s.strokeOpacity !== undefined ? s.strokeOpacity : 1) * 100);
        setIf(el.shapeFillOpacity, fo);      setIf(el.shapeFillOpacityRange, fo);
        setIf(el.shapeStrokeOpacity, so);    setIf(el.shapeStrokeOpacityRange, so);
        setIf(el.shapeCornerR, s.cornerRadius || 0);
        setIf(el.shapeCornerRRange, Math.min(200, s.cornerRadius || 0));
        setIf(el.shapeSides, s.sides || 6);
        setIf(el.shapeSidesRange, s.sides || 6);
        // Type-specific control visibility
        if (el.shapeCornerRow) el.shapeCornerRow.style.display = (type === "rect") ? "" : "none";
        if (el.shapeSidesRow)  el.shapeSidesRow.style.display  = (type === "polygon") ? "" : "none";
        // Hide SVG-only utility row for shapes.
        if (el.shapeSvgUtilsRow) el.shapeSvgUtilsRow.hidden = true;
        if (el.shapeSvgUtilsHead) el.shapeSvgUtilsHead.hidden = true;
      } else if (isSvgKind) {
        // v19.21: read fill/stroke from the SVG's first drawable
        // primitive.  When the user edits, the write applies to ALL
        // primitives in the SVG.  Shape-specific controls (corner
        // radius, sides) are hidden — they're meaningless for SVG.
        const s = readSvgFillStroke(selectedLayer) || {};
        const setIf = (elm, val) => { if (elm && document.activeElement !== elm && val !== undefined) elm.value = val; };
        if (el.shapeTypeBadge) el.shapeTypeBadge.textContent = "SVG";
        setIf(el.shapeFill, s.fill);
        if (el.shapeFillHex)  el.shapeFillHex.textContent = (s.fill || "").toUpperCase();
        setIf(el.shapeStroke, s.stroke);
        if (el.shapeStrokeHex) el.shapeStrokeHex.textContent = (s.stroke || "").toUpperCase();
        if (el.shapeFillOn && document.activeElement !== el.shapeFillOn)     el.shapeFillOn.checked   = !!s.fillOn;
        if (el.shapeStrokeOn && document.activeElement !== el.shapeStrokeOn) el.shapeStrokeOn.checked = !!s.strokeOn;
        setIf(el.shapeStrokeW, s.strokeWidth || 0);
        setIf(el.shapeStrokeWRange, Math.min(60, s.strokeWidth || 0));
        // v19.22: opacity fields for SVG (read from first primitive).
        const fo = Math.round((s.fillOpacity !== undefined ? s.fillOpacity : 1) * 100);
        const so = Math.round((s.strokeOpacity !== undefined ? s.strokeOpacity : 1) * 100);
        setIf(el.shapeFillOpacity, fo);      setIf(el.shapeFillOpacityRange, fo);
        setIf(el.shapeStrokeOpacity, so);    setIf(el.shapeStrokeOpacityRange, so);
        // Hide shape-only rows for SVG.
        if (el.shapeCornerRow) el.shapeCornerRow.style.display = "none";
        if (el.shapeSidesRow)  el.shapeSidesRow.style.display  = "none";
        // Show SVG utilities.
        if (el.shapeSvgUtilsRow) el.shapeSvgUtilsRow.hidden = false;
        if (el.shapeSvgUtilsHead) el.shapeSvgUtilsHead.hidden = false;
      }
    }
    // Video panel: only visible for VIDEO layers.
    if (el.videoGroup) {
      el.videoGroup.hidden = !isVideo;
      if (isVideo) {
        const L = selectedLayer;
        const dur = L.videoDuration || 0;
        if (el.videoDurLabel) el.videoDurLabel.textContent = dur.toFixed(2) + "s";
        const vin  = document.getElementById("ctl-vin");
        const vout = document.getElementById("ctl-vout");
        const vvin  = document.getElementById("val-vin");
        const vvout = document.getElementById("val-vout");
        if (vin)  { vin.max  = dur.toFixed(2); vin.value  = (L.srcInPoint  || 0).toFixed(2); }
        if (vout) { vout.max = dur.toFixed(2); vout.value = (L.srcOutPoint || dur).toFixed(2); }
        if (vvin)  vvin.textContent  = (L.srcInPoint  || 0).toFixed(2);
        if (vvout) vvout.textContent = (L.srcOutPoint || dur).toFixed(2);
        // Path B badge — tells the user which decoder is driving this layer.
        const badge = document.getElementById("videoDecoderBadge");
        if (badge) {
          if (L.useWebCodecs) {
            badge.textContent = "Frame-accurate (WebCodecs)";
            badge.className = "video-badge is-wc";
          } else {
            badge.textContent = "Legacy (HTMLVideoElement)";
            badge.className = "video-badge is-legacy";
          }
        }
        // v15.3 — In-UI diagnostic panel.  Read layer.videoDiag and show
        // the environmental status + the fallback reason (if any).
        renderVideoDiagPanel(L);
      }
    }
    // v19.9 SVG Diagnostics — only visible for SVG imports.
    // Bugfix (v19.10): previously nested inside `if (isVideo)`, which
    // meant this branch only ran for video layers — SVG imports never
    // triggered the panel to unhide.  Now a peer of the video block.
    if (el.svgDiagGroup) {
      const isSvg = has && selectedLayer.kind === "SVG";
      el.svgDiagGroup.hidden = !isSvg;
      if (isSvg) populateSvgDiagnostics(selectedLayer);
    }
    if (!has) return;
    const t = selectedLayer.transform;
    setSlider("x", t.cx); setSlider("y", t.cy); setSlider("scale", Math.round(t.wPct / initialWPct(selectedLayer) * 100));
    setSlider("w", Math.round(t.wPct)); setSlider("h", Math.round(t.hPct)); setSlider("rot", t.rot); setSlider("op", t.opacity);
    el.layerHide.textContent = selectedLayer.visible ? "Hide" : "Show";
    el.layerLock.textContent = selectedLayer.locked ? "Unlock" : "Lock";
    el.layerLock.classList.toggle("active", selectedLayer.locked);
    el.allowTransform.checked = selectedLayer.allowTransform;
    // v18.7: fx-toggle grid removed.  Every effect is now a timeline
    // clip created via the fx-event grid below.  The DOM node for the
    // legacy grid stays in the HTML (empty) so the layout doesn't
    // shift; we just leave its innerHTML blank.
    if (el.fxToggleGrid) el.fxToggleGrid.innerHTML = "";
    // ---- PRIMARY UI: Event Clip grid, grouped by category ----
    if (el.fxEventGrid) {
      el.fxEventGrid.innerHTML = "";
      // v19.41: Effect Capability filter — only show effects whose
      // supportedLayerTypes include the currently selected layer's kind.
      // Generated purely from FX_EVENTS metadata, no hardcoded lists.
      const compatible = FX_EVENTS.filter((fx) => fxSupportsLayer(fx, selectedLayer));
      FX_EVENT_GROUPS.forEach((grp) => {
        const events = compatible.filter((e) => e.group === grp.id);
        if (!events.length) return;
        const hd = document.createElement("div");
        hd.className = "fx-event-group-hd"; hd.textContent = grp.label;
        hd.dataset.groupId = grp.id;
        el.fxEventGrid.appendChild(hd);
        const wrap = document.createElement("div"); wrap.className = "fx-event-grid-inner";
        events.forEach((fx) => {
          const b = document.createElement("button");
          b.className = "fx-event";
          b.dataset.eventKey = fx.key;
          b.innerHTML = `<span class="fx-dot"></span>${fx.label}`;
          const catBadge = fx.category === "universal" ? "" : ` (${fx.category})`;
          b.title = `${fx.label}${catBadge}. Click to add a timeline clip on the selected layer at the playhead.`;
          b.addEventListener("click", () => toggleEventClipOnLayer(fx.key, fx.label));
          wrap.appendChild(b);
        });
        el.fxEventGrid.appendChild(wrap);
      });
    }
    // Update visual state to reflect existing clips on the selected layer
    renderEventButtons();
  }

  /* Reflects each Event Clip button's state against the selected layer:
     - .is-active   : an enabled clip of that type exists on the layer
     - .is-disabled : a clip of that type exists but is disabled
     - .is-selected : the currently selected clip is of that type
     Called after any change to layer.clips / selectedEventClip. */
  function renderEventButtons() {
    if (!el.fxEventGrid) return;
    const btns = el.fxEventGrid.querySelectorAll(".fx-event");
    btns.forEach((btn) => {
      const key = btn.dataset.eventKey;
      let hasEnabled = false, hasAny = false, isSel = false, count = 0;
      if (selectedLayer && selectedLayer.clips) {
        for (const c of selectedLayer.clips) {
          if (c.fxKey !== key) continue;
          hasAny = true; count++;
          if (c.enabled !== false) hasEnabled = true;
          if (selectedEventClip && selectedEventClip.layer === selectedLayer && selectedEventClip.ec === c) isSel = true;
        }
      }
      btn.classList.toggle("is-active",   hasEnabled);
      btn.classList.toggle("is-disabled", hasAny && !hasEnabled);
      btn.classList.toggle("is-selected", isSel);
      // v19.3: multi-instance count badge.  Shows ×N when the layer
      // has more than one instance of this effect (only meaningful
      // once we allow multiple instances).  We compute this even
      // when count===1 so the DOM slot exists; hide it visually
      // unless count > 1.
      let badge = btn.querySelector(".fx-count");
      if (count > 1) {
        if (!badge) { badge = document.createElement("span"); badge.className = "fx-count"; btn.appendChild(badge); }
        badge.textContent = "×" + count;
      } else if (badge) {
        badge.remove();
      }
    });
  }

  /* v19.6 Click behaviour for an Event Clip button:
     Every click ADDS a NEW instance of that effect clip to EVERY
     selected layer.  Multi-apply is the natural completion of the
     multi-selection workflow — users select 5 layers, click Pulse
     Glow once, and all 5 get an independent instance.

     Rationale:
       - The previous single-layer behavior (each click adds a clip
         to the primary layer only) required repetitive per-layer
         work when applying the same effect to multiple items.
       - Each target layer gets its OWN independent clip — same
         defaults, same placement, independent params afterwards.
       - When exactly one layer is selected, behaves identically to
         before.  Multi-apply only activates when >1 layers selected.

     Never blindly creates duplicates if no layer is selected. */
  function toggleEventClipOnLayer(fxKey, label) {
    if (!selectedLayers.length) { toast("Select a layer first"); return; }
    const targets = selectedLayers.slice();
    const created = [];
    targets.forEach((L) => {
      const c = createEventClip(fxKey, L);
      if (c) created.push({ layer: L, clip: c });
    });
    if (!created.length) return;
    // Auto-select the last new clip (matches previous single-layer UX).
    const last = created[created.length - 1];
    if (typeof selectEventClip === "function") {
      selectEventClip(last.layer, last.clip);
    }
    if (targets.length > 1) {
      toast(`${label} added to ${targets.length} layers`);
    } else {
      // Single-layer: report instance number for that layer.
      const total = last.layer.clips.filter((k) => k.fxKey === fxKey).length;
      if (total > 1) toast(`${label} — instance ${total}`);
      else toast(`${label} added`);
    }
    renderTimeline(); renderEventButtons(); renderClipInspector(); paintIfPaused();
  }
  function initialWPct(layer) {
    const A = STATE.format, fit = Math.min(A.w / layer.natW, A.h / layer.natH);
    return (layer.natW * fit / A.w) * 100 || 1;
  }
  function setSlider(key, val) {
    const input = document.getElementById(`ctl-${key}`), out = document.getElementById(`val-${key}`);
    if (input) { input.value = val; const min = +input.min, max = +input.max; input.style.setProperty("--pct", ((val - min) / (max - min) * 100) + "%"); }
    if (out) {
      // Time sliders (start / duration in seconds) need decimal precision;
      // integer sliders (px, %, etc.) don't.
      out.textContent = (key === "cs" || key === "cd") ? (+val).toFixed(3) : Math.round(val);
    }
    // v16 — paired numeric input for millisecond-precision typing.
    // Only cs / cd have these today; call is a no-op otherwise.
    const num = document.getElementById(`num-${key}`);
    if (num && document.activeElement !== num) num.value = (+val).toFixed(3);
  }

  // Transform slider bindings
  function bindTransform() {
    bindT("x", (v) => { selectedLayer.transform.cx = v; });
    bindT("y", (v) => { selectedLayer.transform.cy = v; });
    bindT("scale", (v) => { const base = initialWPct(selectedLayer); const ar = selectedLayer.transform.hPct / selectedLayer.transform.wPct || 1; selectedLayer.transform.wPct = base * v / 100; selectedLayer.transform.hPct = selectedLayer.transform.wPct * ar; setSlider("w", Math.round(selectedLayer.transform.wPct)); setSlider("h", Math.round(selectedLayer.transform.hPct)); });
    bindT("w", (v) => { const ar = selectedLayer.natH / selectedLayer.natW; const old = selectedLayer.transform.wPct; selectedLayer.transform.wPct = v; if (el.lockAspect.checked) { selectedLayer.transform.hPct = v * ar * (STATE.format.w / STATE.format.h); setSlider("h", Math.round(selectedLayer.transform.hPct)); } });
    bindT("h", (v) => { const ar = selectedLayer.natW / selectedLayer.natH; selectedLayer.transform.hPct = v; if (el.lockAspect.checked) { selectedLayer.transform.wPct = v * ar * (STATE.format.h / STATE.format.w); setSlider("w", Math.round(selectedLayer.transform.wPct)); } });
    bindT("rot", (v) => { selectedLayer.transform.rot = v; });
    bindT("op", (v) => { selectedLayer.transform.opacity = v; });
  }
  function bindT(key, fn) {
    const input = document.getElementById(`ctl-${key}`); if (!input) return;
    input.addEventListener("input", (e) => { if (!selectedLayer) return; fn(+e.target.value); setSlider(key, +e.target.value); updateSelectionBox(); paintIfPaused(); });
  }

  function tfCenter() { if (!selectedLayer) return; selectedLayer.transform.cx = 0; selectedLayer.transform.cy = 0; renderInspector(); updateSelectionBox(); paintIfPaused(); }
  function tfFit() { if (!selectedLayer) return; const A = STATE.format, L = selectedLayer; const fit = Math.min(A.w / L.natW, A.h / L.natH); L.transform.wPct = (L.natW * fit / A.w) * 100; L.transform.hPct = (L.natH * fit / A.h) * 100; L.transform.cx = 0; L.transform.cy = 0; L.transform.rot = 0; renderInspector(); updateSelectionBox(); paintIfPaused(); }
  function tfFill() { if (!selectedLayer) return; const A = STATE.format, L = selectedLayer; const fill = Math.max(A.w / L.natW, A.h / L.natH); L.transform.wPct = (L.natW * fill / A.w) * 100; L.transform.hPct = (L.natH * fill / A.h) * 100; L.transform.cx = 0; L.transform.cy = 0; renderInspector(); updateSelectionBox(); paintIfPaused(); }
  function tfOriginal() { if (!selectedLayer) return; const A = STATE.format, L = selectedLayer; L.transform.wPct = (L.natW / A.w) * 100; L.transform.hPct = (L.natH / A.h) * 100; L.transform.cx = 0; L.transform.cy = 0; renderInspector(); updateSelectionBox(); paintIfPaused(); }
  function tfReset() { if (!selectedLayer) return; const A = STATE.format, L = selectedLayer; const fit = Math.min(A.w / L.natW, A.h / L.natH); L.transform = { cx: 0, cy: 0, wPct: (L.natW * fit / A.w) * 100, hPct: (L.natH * fit / A.h) * 100, rot: 0, opacity: 100 }; renderInspector(); updateSelectionBox(); paintIfPaused(); }

  /* ---------------- ALIGNMENT ----------------
     cx / cy are stored as % offset from canvas center. wPct / hPct are
     % of canvas size. So layer left edge sits at cx - wPct/2 (relative to
     center, in %) and canvas left edge is at -50. Simple algebra.
     Multi-layer distribute is designed for a future multi-select mode;
     for now with a single selection it centers the layer on that axis. */
  function alignLeft()   { if (!selectedLayer) return notice(); selectedLayer.transform.cx = (selectedLayer.transform.wPct - 100) / 2; postAlign(); }
  function alignCenterH(){ if (!selectedLayer) return notice(); selectedLayer.transform.cx = 0; postAlign(); }
  function alignRight()  { if (!selectedLayer) return notice(); selectedLayer.transform.cx = (100 - selectedLayer.transform.wPct) / 2; postAlign(); }
  function alignTop()    { if (!selectedLayer) return notice(); selectedLayer.transform.cy = (selectedLayer.transform.hPct - 100) / 2; postAlign(); }
  function alignMiddle() { if (!selectedLayer) return notice(); selectedLayer.transform.cy = 0; postAlign(); }
  function alignBottom() { if (!selectedLayer) return notice(); selectedLayer.transform.cy = (100 - selectedLayer.transform.hPct) / 2; postAlign(); }
  function centerToCanvas() { if (!selectedLayer) return notice(); selectedLayer.transform.cx = 0; selectedLayer.transform.cy = 0; postAlign(); }
  function distributeH() { if (!selectedLayer) return notice(); selectedLayer.transform.cx = 0; postAlign(); }
  function distributeV() { if (!selectedLayer) return notice(); selectedLayer.transform.cy = 0; postAlign(); }
  function postAlign() { renderInspector(); updateSelectionBox(); paintIfPaused(); }
  function notice() { toast("Select a layer first"); }

  /* ---------------- COLOR EDITING ---------------- */
  const COLOR_TARGET = "path, rect, circle, ellipse, line, polyline, polygon, text, tspan";
  function captureOriginalColors(layer) {
    if (layer.kind !== "SVG") return;
    layer.originalColors = [];
    layer.node.querySelectorAll(COLOR_TARGET).forEach((n) => {
      layer.originalColors.push({ n, fill: n.getAttribute("fill"), stroke: n.getAttribute("stroke"), sw: n.getAttribute("stroke-width"), styleFill: n.style.fill, styleStroke: n.style.stroke });
    });
  }
  // v19.22: legacy applyFill / applyStroke / applyAllPaths /
  // applyStrokeWidth / restoreColors / monochrome / invertColors
  // removed with the old Color panel.  Their functionality is now
  // in the unified Fill & Stroke panel (via applySvgFillStroke) plus
  // dedicated applySvgMonochrome / applySvgInvert helpers.  The
  // `originalColors` snapshot above is kept for compatibility with
  // any older code paths and for potential future use.
  function selSvg() { return selectedLayer && selectedLayer.kind === "SVG"; }
  function setOrRemove(n, attr, val) { if (val == null) n.removeAttribute(attr); else n.setAttribute(attr, val); }

  /* ---------------- SELECTION BOX ---------------- */
  // Positions the dashed selection box over the selected layer's current
  // rect, in artboard px (the artboard is scaled by zoom, so we use % ).
  function updateSelectionBox() {
    if (!selectedLayer) { el.selectionBox.hidden = true; return; }
    const t = selectedLayer.transform;
    el.selectionBox.hidden = false;
    const w = t.wPct, h = t.hPct;
    const left = 50 + t.cx - w / 2, top = 50 + t.cy - h / 2;
    el.selectionBox.style.left = left + "%";
    el.selectionBox.style.top = top + "%";
    el.selectionBox.style.width = w + "%";
    el.selectionBox.style.height = h + "%";
    el.selectionBox.style.transform = `rotate(${t.rot}deg)`;
    el.selectionBox.style.transformOrigin = "center center";
  }

  /* ---------------- TIMELINE ---------------- */
  const TL = { pxPerSec: 0, dragClip: null, mode: null, startX: 0, orig: null, dragEvent: null, dragAudio: null };
  function computePxPerSec() {
    const bodyW = el.tlTracks.clientWidth || el.tlBody.clientWidth || 600;
    TL.pxPerSec = (bodyW / STATE.duration) * (STATE.tlZoom || 1);
  }
  function renderTimeline() {
    computePxPerSec();
    // ruler
    el.tlRuler.innerHTML = "";
    // v19.30 → v19.35: Adaptive tick spacing.  When zoomed out, labels
    // are every 1s (or every 5s for very long durations).  When zoomed
    // in, sub-second labels appear at 500ms, 250ms, 100ms, or 50ms
    // intervals so millisecond-precision editing has a visible ruler
    // to work against — matches the D/S/E control precision.
    // Interval is chosen so labels have at least ~55px of breathing
    // room (prevents overlap at any zoom).
    const pxPerSec = TL.pxPerSec;
    // v19.35: candidates from FINE to COARSE — we walk finest first
    // and stop at the first spacing that's readable (>=55px).  This
    // gives sub-second labels when zoomed in, whole-second (or
    // 5s/10s) labels when zoomed out.  Previous version iterated
    // coarse-first and picked overly coarse steps at any zoom.
    const candidates = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
    let step = 1;
    for (const c of candidates) {
      if (c * pxPerSec >= 55) { step = c; break; }
    }
    // Format label with precision matching the step.
    const fmt = (t) => {
      if (STATE.duration >= 60 && step >= 1) {
        const m = Math.floor(t / 60), sec = t - m * 60;
        // Whole-second minute:second when step is >= 1s.
        return `${m}:${String(Math.round(sec)).padStart(2, "0")}`;
      }
      // Number of decimals from the step size.
      if (step >= 1)      return t.toFixed(0) + "s";
      if (step >= 0.1)    return t.toFixed(1);
      if (step >= 0.01)   return t.toFixed(2);
      return t.toFixed(3);
    };
    // Every 5th major tick gets emphasis so scanning long timelines is easy.
    const emphasizeEvery = step >= 1 ? 5 : (step >= 0.1 ? 5 : 4);
    let idx = 0;
    for (let t = 0; t <= STATE.duration + 0.0001; t += step, idx++) {
      const tick = document.createElement("div");
      tick.className = "tl-tick" + (idx > 0 && idx % emphasizeEvery === 0 ? " major-5" : "");
      tick.style.left = (t * pxPerSec) + "px";
      tick.textContent = fmt(t);
      el.tlRuler.appendChild(tick);
    }
    // Minor ticks: half-second marks appear when a second is wide
    // enough to fit them; frame marks appear when frames are wide
    // enough to distinguish visually.  Prevents visual clutter at
    // low zoom while surfacing frame boundaries at high zoom.
    const fps = STATE.fps || 30;
    const pxPerFrame = TL.pxPerSec / fps;
    if (TL.pxPerSec >= 140 && step >= 1) {
      // Show half-second minor ticks only when major step is still 1s+
      for (let s = 0; s < STATE.duration; s++) {
        const tick = document.createElement("div"); tick.className = "tl-tick-minor";
        tick.style.left = ((s + 0.5) * TL.pxPerSec) + "px"; el.tlRuler.appendChild(tick);
      }
    }
    if (pxPerFrame >= 6) {
      // Show individual frame boundaries
      const totalFrames = Math.floor(STATE.duration * fps);
      for (let f = 0; f <= totalFrames; f++) {
        if (f % fps === 0) continue;   // skip whole seconds (drawn above)
        const tick = document.createElement("div"); tick.className = "tl-tick-frame";
        tick.style.left = ((f / fps) * TL.pxPerSec) + "px"; el.tlRuler.appendChild(tick);
      }
    }
    // markers overlay (draw in ruler and behind tracks)
    markers.forEach((m) => { const mk = document.createElement("div"); mk.className = "tl-marker " + m.type; mk.style.left = (m.time * TL.pxPerSec) + "px"; el.tlRuler.appendChild(mk); });

    // VISUAL tracks
    el.tlEmpty.style.display = layers.length ? "none" : "";
    el.tlTracks.querySelectorAll(".tl-track").forEach((n) => n.remove());
    [...layers].reverse().forEach((layer) => {
      const track = document.createElement("div"); track.className = "tl-track";
      // marker lines behind clip (subtle)
      markers.forEach((m) => { const mk = document.createElement("div"); mk.className = "tl-marker " + m.type; mk.style.left = (m.time * TL.pxPerSec) + "px"; track.appendChild(mk); });
      const label = document.createElement("span"); label.className = "tl-track-label"; label.textContent = layer.name; track.appendChild(label);
      // main sustained clip
      const clip = document.createElement("div"); clip.className = "tl-clip" + (layer.kind === "VIDEO" ? " video" : "") + (layer === selectedLayer && !selectedAudioClip ? " selected" : "");
      clip.style.left = (layer.start * TL.pxPerSec) + "px"; clip.style.width = Math.max(14, layer.duration * TL.pxPerSec) + "px";
      const summary = layer.clips.length ? layer.clips.length + " clip" + (layer.clips.length === 1 ? "" : "s") : "no clips";
      clip.innerHTML = `<span class="tl-handle left"></span><span class="tl-clip-label">${layer.name} \u00b7 ${summary}</span><span class="tl-handle right"></span>`;
      clip.addEventListener("mousedown", (e) => startClipDrag(e, layer, clip));
      clip.addEventListener("click", (e) => { e.stopPropagation(); selectLayer(layer); selectAudioClip(null); });
      track.appendChild(clip);
      // event clips
      layer.clips.forEach((c) => {
        const ec = document.createElement("div"); ec.className = "tl-clip event" + (c.enabled === false ? " disabled" : "") + (selectedEventClip && selectedEventClip.ec === c ? " selected" : ""); ec.dataset.eid = c.id;
        ec.style.left = ((layer.start + c.start) * TL.pxPerSec) + "px";
        ec.style.width = Math.max(6, c.duration * TL.pxPerSec) + "px";
        const def = FX_EVENTS.find((f) => f.key === c.fxKey);
        ec.innerHTML = `<span class="tl-handle left"></span><span class="tl-clip-label">${def ? def.label : c.fxKey}</span><span class="tl-handle right"></span>`;
        ec.addEventListener("mousedown", (e) => { e.stopPropagation(); startEventClipDrag(e, layer, c, ec); });
        ec.addEventListener("click", (e) => { e.stopPropagation(); selectEventClip(layer, c); });
        track.appendChild(ec);
      });
      el.tlTracks.appendChild(track);
    });

    // AUDIO tracks (music + sfx1/2/3 + voice)
    el.tlAudioTracks.innerHTML = "";
    AUDIO_TRACKS.forEach((tr) => {
      const track = document.createElement("div"); track.className = "tl-track";
      markers.forEach((m) => { const mk = document.createElement("div"); mk.className = "tl-marker " + m.type; mk.style.left = (m.time * TL.pxPerSec) + "px"; track.appendChild(mk); });
      const label = document.createElement("span"); label.className = "tl-track-label"; label.innerHTML = `<span class="mix-lbl mix-${tr.color}">${tr.label}</span>`; track.appendChild(label);
      // music clip (fake single-clip representation for the loaded music)
      if (tr.id === "music" && audio.ready && audio.el) {
        const musicDur = Math.min(STATE.duration, isFinite(audio.el.duration) ? audio.el.duration : STATE.duration);
        const mc = document.createElement("div"); mc.className = "tl-clip audio music" + (STATE.muteMusic ? " muted" : "");
        mc.style.left = "0px"; mc.style.width = Math.max(14, musicDur * TL.pxPerSec) + "px";
        mc.innerHTML = `<span class="tl-clip-label">${(el.audioName.textContent || "Music")}</span>`;
        mc.addEventListener("click", () => { STATE.muteMusic = !STATE.muteMusic; refreshMixer(); renderTimeline(); });
        track.appendChild(mc);
      }
      // audio clips on this track
      audioClips.filter((c) => c.track === tr.id).forEach((c) => {
        const s = sounds.find((x) => x.id === c.soundId);
        const cn = document.createElement("div");
        cn.className = "tl-clip audio " + tr.color + (c.muted ? " muted" : "") + (selectedAudioClip === c ? " selected" : "");
        cn.dataset.aid = c.id;
        cn.style.left = (c.start * TL.pxPerSec) + "px"; cn.style.width = Math.max(14, c.duration * TL.pxPerSec) + "px";
        cn.innerHTML = `<span class="tl-handle left"></span><span class="tl-clip-label">${s ? s.name : "sound"}</span><span class="tl-handle right"></span>`;
        cn.addEventListener("mousedown", (e) => { e.stopPropagation(); startAudioClipDrag(e, c, cn); });
        cn.addEventListener("click", (e) => { e.stopPropagation(); selectAudioClip(c); });
        track.appendChild(cn);
      });
      el.tlAudioTracks.appendChild(track);
    });
  }
  function startClipDrag(e, layer, clip) {
    e.preventDefault(); selectLayer(layer); selectAudioClip(null);
    const isLeft = e.target.classList.contains("left"), isRight = e.target.classList.contains("right");
    TL.dragClip = { layer, clip }; TL.mode = isLeft ? "trim-left" : isRight ? "trim-right" : "move";
    TL.startX = e.clientX; TL.orig = { start: layer.start, duration: layer.duration };
    clip.classList.add("dragging");
    document.addEventListener("mousemove", onClipDrag); document.addEventListener("mouseup", endClipDrag);
  }
  // Compute the effective time delta from a mousemove.  When Shift OR
  // Alt is held, the delta is scaled by 10 so users get precise
  // sub-frame nudging.  Both drag handlers use this so behavior is
  // consistent across layer clips, event clips, and audio clips.
  //   v19.29: Alt joined Shift as a precision modifier — Figma-style
  //   muscle memory (Alt) and After-Effects-style (Shift) both work.
  function isPrecisionKey(e) { return e.shiftKey || e.altKey; }
  function tlDeltaFromEvent(e, startX) {
    const rawDx = (e.clientX - startX) / TL.pxPerSec;
    return isPrecisionKey(e) ? rawDx / 10 : rawDx;
  }

  function onClipDrag(e) {
    if (!TL.dragClip) return;
    // Precision: require >2px of real movement before we start
    // committing changes.  Prevents accidental frame jumps from
    // sub-pixel mouse jitter when the user meant a click-select.
    const rawPx = Math.abs(e.clientX - TL.startX);
    if (!TL.dragClip._moved && rawPx < 2) return;
    TL.dragClip._moved = true;
    const dx = tlDeltaFromEvent(e, TL.startX), { layer } = TL.dragClip, o = TL.orig, D = STATE.duration;
    if (TL.mode === "move") layer.start = clamp(o.start + dx, 0, Math.max(0, D - layer.duration));
    else if (TL.mode === "trim-left") { const ns = clamp(o.start + dx, 0, o.start + o.duration - 0.2); layer.duration = o.duration - (ns - o.start); layer.start = ns; }
    else if (TL.mode === "trim-right") layer.duration = clamp(o.duration + dx, 0.2, D - layer.start);
    // Snap ALL editable edges on each mousemove.  Shift-drag suppresses
    // snap so users can nudge sub-frame during precise adjustments.
    if (!isPrecisionKey(e)) {
      // v18.8 magnetic snap.  Layer times are absolute; excludeClip
      // is the layer itself so we don't self-snap its opposite edge.
      // v19.30: pass the ORIGIN (pre-drag position) so snap can be
      // direction-aware and never pull the handle backward.
      if (TL.mode === "move" || TL.mode === "trim-left") {
        layer.start = applyMagneticSnap(layer.start, layer, o.start);
        if (TL.mode === "trim-left") {
          const endHeld = o.start + o.duration;
          layer.duration = Math.max(0.2, endHeld - layer.start);
        }
      }
      if (TL.mode === "trim-right") {
        const endSnapped = applyMagneticSnap(layer.start + layer.duration, layer, o.start + o.duration);
        layer.duration = Math.max(0.2, endSnapped - layer.start);
      }
    }
    const c = TL.dragClip.clip; c.style.left = (layer.start * TL.pxPerSec) + "px"; c.style.width = Math.max(14, layer.duration * TL.pxPerSec) + "px";
    // Live-refresh the inspector's numeric fields as the drag moves.
    if (typeof renderClipInspector === "function") renderClipInspector();
  }
  function endClipDrag() { if (TL.dragClip) TL.dragClip.clip.classList.remove("dragging"); TL.dragClip = null; document.removeEventListener("mousemove", onClipDrag); document.removeEventListener("mouseup", endClipDrag); }

  function startEventClipDrag(e, layer, ec, node) {
    e.preventDefault(); selectEventClip(layer, ec);
    const isLeft = e.target.classList.contains("left"), isRight = e.target.classList.contains("right");
    TL.dragEvent = { layer, ec, node, mode: isLeft ? "trim-left" : isRight ? "trim-right" : "move", startX: e.clientX, orig: { start: ec.start, duration: ec.duration } };
    node.classList.add("dragging");
    document.addEventListener("mousemove", onEventClipDrag); document.addEventListener("mouseup", endEventClipDrag);
  }
  function onEventClipDrag(e) {
    if (!TL.dragEvent) return;
    const rawPx = Math.abs(e.clientX - TL.dragEvent.startX);
    if (!TL.dragEvent._moved && rawPx < 2) return;
    TL.dragEvent._moved = true;
    const D = TL.dragEvent, dx = tlDeltaFromEvent(e, D.startX), layerDur = D.layer.duration;
    if (D.mode === "move") D.ec.start = clamp(D.orig.start + dx, 0, Math.max(0, layerDur - D.ec.duration));
    else if (D.mode === "trim-left") { const ns = clamp(D.orig.start + dx, 0, D.orig.start + D.orig.duration - 0.02); D.ec.duration = D.orig.duration - (ns - D.orig.start); D.ec.start = ns; }
    else if (D.mode === "trim-right") D.ec.duration = clamp(D.orig.duration + dx, 0.02, layerDur - D.ec.start);
    if (!isPrecisionKey(e)) {
      // v18.8: magnetic snap to playhead + other clip edges.  Runs in
      // absolute scene time; event clip times are stored layer-local.
      // v19.30: origin is pre-drag position in ABSOLUTE scene time.
      if (D.mode === "move" || D.mode === "trim-left") {
        const abs = D.layer.start + D.ec.start;
        const origin = D.layer.start + D.orig.start;
        const snapped = applyMagneticSnap(abs, D.ec, origin);
        D.ec.start = snapped - D.layer.start;
        if (D.mode === "trim-left") {
          const endHeld = D.orig.start + D.orig.duration;
          D.ec.duration = Math.max(0.02, endHeld - D.ec.start);
        }
      }
      if (D.mode === "trim-right") {
        const endAbs = D.layer.start + D.ec.start + D.ec.duration;
        const origin = D.layer.start + D.orig.start + D.orig.duration;
        const snapped = applyMagneticSnap(endAbs, D.ec, origin);
        D.ec.duration = Math.max(0.02, snapped - (D.layer.start + D.ec.start));
      }
    }
    D.node.style.left = ((D.layer.start + D.ec.start) * TL.pxPerSec) + "px";
    D.node.style.width = Math.max(6, D.ec.duration * TL.pxPerSec) + "px";
    renderClipInspector();
  }
  function endEventClipDrag() { if (TL.dragEvent) TL.dragEvent.node.classList.remove("dragging"); TL.dragEvent = null; document.removeEventListener("mousemove", onEventClipDrag); document.removeEventListener("mouseup", endEventClipDrag); }

  function startAudioClipDrag(e, ac, node) {
    e.preventDefault(); selectAudioClip(ac);
    const isLeft = e.target.classList.contains("left"), isRight = e.target.classList.contains("right");
    TL.dragAudio = { ac, node, mode: isLeft ? "trim-left" : isRight ? "trim-right" : "move", startX: e.clientX, orig: { start: ac.start, duration: ac.duration } };
    node.classList.add("dragging");
    document.addEventListener("mousemove", onAudioClipDrag); document.addEventListener("mouseup", endAudioClipDrag);
  }
  function onAudioClipDrag(e) {
    if (!TL.dragAudio) return;
    const rawPx = Math.abs(e.clientX - TL.dragAudio.startX);
    if (!TL.dragAudio._moved && rawPx < 2) return;
    TL.dragAudio._moved = true;
    const D = TL.dragAudio, dx = tlDeltaFromEvent(e, D.startX), dur = STATE.duration;
    if (D.mode === "move") D.ac.start = clamp(D.orig.start + dx, 0, Math.max(0, dur - D.ac.duration));
    else if (D.mode === "trim-left") { const ns = clamp(D.orig.start + dx, 0, D.orig.start + D.orig.duration - 0.05); D.ac.duration = D.orig.duration - (ns - D.orig.start); D.ac.start = ns; }
    else if (D.mode === "trim-right") D.ac.duration = clamp(D.orig.duration + dx, 0.05, dur - D.ac.start);
    if (!isPrecisionKey(e)) {
      // v18.8: magnetic snap.  Audio clip times are absolute.
      // v19.30: pass origin so snap is direction-aware.
      if (D.mode === "move" || D.mode === "trim-left") {
        const snapped = applyMagneticSnap(D.ac.start, D.ac, D.orig.start);
        D.ac.start = snapped;
        if (D.mode === "trim-left") {
          const endHeld = D.orig.start + D.orig.duration;
          D.ac.duration = Math.max(0.05, endHeld - D.ac.start);
        }
      }
      if (D.mode === "trim-right") {
        const endAbs = D.ac.start + D.ac.duration;
        const snapped = applyMagneticSnap(endAbs, D.ac, D.orig.start + D.orig.duration);
        D.ac.duration = Math.max(0.05, snapped - D.ac.start);
      }
    }
    D.node.style.left = (D.ac.start * TL.pxPerSec) + "px";
    D.node.style.width = Math.max(14, D.ac.duration * TL.pxPerSec) + "px";
    renderClipInspector();
  }
  function endAudioClipDrag() { if (TL.dragAudio) TL.dragAudio.node.classList.remove("dragging"); TL.dragAudio = null; document.removeEventListener("mousemove", onAudioClipDrag); document.removeEventListener("mouseup", endAudioClipDrag); }

  /* ---- Clip selection helpers ---- */
  let selectedEventClip = null;
  function selectEventClip(layer, ec) {
    selectedAudioClip = null;
    selectedEventClip = { layer, ec };
    // Auto-seek the playhead into the clip window so users can see the
    // event fire while editing intensity / duration / start.  Only seek
    // if we're currently OUTSIDE the clip; if we're already inside, keep
    // the user's position so scrubbing stays intuitive.
    const clipStart = layer.start + ec.start, clipEnd = clipStart + ec.duration;
    if (STATE.time < clipStart || STATE.time > clipEnd) {
      STATE.time = clipStart + ec.duration * 0.5;
      rafStart = performance.now() - STATE.time * 1000;
      updatePlayheads(STATE.time);
    }
    renderTimeline(); renderClipInspector(); renderEventButtons(); paintIfPaused();
  }
  function selectAudioClip(ac) {
    selectedEventClip = null;
    selectedAudioClip = ac;
    renderTimeline(); renderClipInspector(); renderEventButtons();
  }
  function renderClipInspector() {
    const hasEvt = !!selectedEventClip, hasAud = !!selectedAudioClip;
    const hasAny = hasEvt || hasAud;
    // v19.33: the CLIP toolbar fields (D/S/E) previously ONLY worked
    // when an event clip or audio clip was selected — layer selection
    // left them disabled with a "-" placeholder, which read as "the
    // feature is broken."  Extended so a selected LAYER (no clip)
    // also activates the fields — they then edit layer.start /
    // layer.duration.  The tlClipName label switches between "Clip",
    // "Audio", "Layer" so users see which entity they're editing.
    const hasLayerOnly = !hasAny && !!selectedLayer;
    const anyEditable = hasAny || hasLayerOnly;
    if (!el.clipEmpty || !el.clipBody) return;
    el.clipEmpty.hidden = hasAny; el.clipBody.hidden = !hasAny;
    // v19.29 → v19.30 → v19.33: toolbar controls — name label +
    // Duration + Start + End.  Now activate whenever an entity with
    // start/duration is selected: event clip, audio clip, OR layer.
    const tlS = document.getElementById("tlClipStart");
    const tlE = document.getElementById("tlClipEnd");
    const tlD = document.getElementById("tlClipDur");
    const tlN = document.getElementById("tlClipName");
    const setDisabled = (n, d) => { if (n) { n.disabled = d; if (d && document.activeElement !== n) n.value = ""; } };
    setDisabled(tlS, !anyEditable);
    setDisabled(tlE, !anyEditable);
    setDisabled(tlD, !anyEditable);
    if (tlN) {
      if (hasEvt)         tlN.textContent = "…";   // filled below with FX label
      else if (hasAud)    tlN.textContent = "Audio";
      else if (hasLayerOnly) tlN.textContent = selectedLayer.name || "Layer";
      else                tlN.textContent = "—";
    }
    // Params rows visibility
    const paramsHost = document.getElementById("clipParams");
    if (paramsHost) paramsHost.innerHTML = "";
    // Enable-toggle button label
    const enBtn = document.getElementById("clipEnable");
    // v19.33: for layer-only selection, populate D/S/E from layer
    // timing and short-circuit the rest of the clip-inspector body.
    if (!hasAny && hasLayerOnly) {
      const layer = selectedLayer;
      const startAbs = layer.start || 0;
      const dur      = layer.duration || 0;
      const setNumIf = (id, val) => {
        const n = document.getElementById(id);
        if (n && document.activeElement !== n) n.value = val;
      };
      setNumIf("tlClipStart", (+startAbs).toFixed(3));
      setNumIf("tlClipEnd",   (+(startAbs + dur)).toFixed(3));
      setNumIf("tlClipDur",   (+dur).toFixed(3));
      return;
    }
    if (!hasAny) return;
    let type = "—", track = "—", start = 0, dur = 0, vol = 100, muted = false;
    if (hasEvt) {
      const def = FX_EVENTS.find((f) => f.key === selectedEventClip.ec.fxKey);
      type = def ? def.label : selectedEventClip.ec.fxKey;
      track = "Visual · " + selectedEventClip.layer.name;
      start = selectedEventClip.ec.start; dur = selectedEventClip.ec.duration;
      el.clipVolRow.style.display = "none";
      // Ensure defaults exist for backward-compat clips
      if (selectedEventClip.ec.enabled === undefined) selectedEventClip.ec.enabled = true;
      // Merge missing defaults into `params` so old projects auto-gain
      // any newly-added param keys (user values are preserved because
      // Object.assign later sources win).
      const defs = defaultParamsFor(selectedEventClip.ec.fxKey);
      selectedEventClip.ec.params = Object.assign({}, defs, selectedEventClip.ec.params || {});
      // Enable/disable button
      if (enBtn) { enBtn.style.display = ""; enBtn.textContent = selectedEventClip.ec.enabled ? "Disable clip" : "Enable clip"; enBtn.classList.toggle("danger", !selectedEventClip.ec.enabled); }
      // Build params UI (intensity + opacityMix + optional direction)
      if (paramsHost) {
        const p = selectedEventClip.ec.params;
        paramsHost.appendChild(makeParamSlider("intensity", "Intensity", p.intensity, 0, 100, (v) => { p.intensity = v; renderTimeline(); renderEventButtons(); paintIfPaused(); }));
        paramsHost.appendChild(makeParamSlider("opacityMix", "Opacity mix", p.opacityMix ?? 100, 0, 100, (v) => { p.opacityMix = v; renderTimeline(); renderEventButtons(); paintIfPaused(); }));
        // Direction segmented control — 4-way for vectorBeam +
        // pixelSweep, 3-way (right/left/both) for lostSignal, 2-way
        // (0/1) for legacy events.
        if (p.direction !== undefined || p.corruptionDirection !== undefined) {
          const isVector = selectedEventClip.ec.fxKey === "vectorBeam";
          const isPixelSweep = selectedEventClip.ec.fxKey === "pixelSweep";
          const isLostSignal = selectedEventClip.ec.fxKey === "lostSignal";
          const paramKey = isLostSignal ? "corruptionDirection" : "direction";
          const options = (isVector || isPixelSweep)
            ? [["right","→"],["left","←"],["down","↓"],["up","↑"]]
            : isLostSignal
              ? [["right","→"],["left","←"],["both","↔"]]
              : [["0","→"],["1","←"]];
          const currentVal = p[paramKey];
          const row = document.createElement("div"); row.className = "prop-row";
          row.innerHTML = `<span class="prop-label">Direction</span>`;
          const btns = document.createElement("div"); btns.className = "seg-mini";
          options.forEach(([v, l]) => {
            const b = document.createElement("button");
            b.className = "mini-btn" + (String(currentVal) === v ? " active" : "");
            b.textContent = l;
            b.addEventListener("click", () => {
              p[paramKey] = (isVector || isPixelSweep || isLostSignal) ? v : +v;
              renderClipInspector(); renderTimeline(); renderEventButtons(); paintIfPaused();
            });
            btns.appendChild(b);
          });
          row.appendChild(btns); paramsHost.appendChild(row);
        }
        // v19.41: paramDefs-driven UI generation.  Any effect that
        // declares `paramDefs` on its FX_EVENTS entry gets its
        // inspector controls generated automatically here — new
        // effects don't need any inspector code changes.  Supported
        // types: range (slider), number (text input), select
        // (dropdown), text (text input).  Skips params already
        // rendered above (intensity, opacityMix, direction, color).
        const def = FX_EVENT_DEF.get(selectedEventClip.ec.fxKey);
        if (def && def.paramDefs) {
          const already = new Set(["intensity", "opacityMix", "direction", "corruptionDirection", "color"]);
          def.paramDefs.forEach((pd) => {
            if (already.has(pd.key)) return;
            const cur = (p[pd.key] !== undefined) ? p[pd.key] : pd.default;
            if (pd.type === "range") {
              paramsHost.appendChild(makeParamSlider(pd.key, pd.label, cur, pd.min, pd.max, (v) => {
                p[pd.key] = v; renderTimeline(); renderEventButtons(); paintIfPaused();
              }, pd.step));
            } else if (pd.type === "select") {
              const row = document.createElement("div"); row.className = "prop-row";
              row.innerHTML = `<span class="prop-label">${pd.label}</span>`;
              const sel = document.createElement("select");
              sel.className = "ctl-num"; sel.style.minWidth = "0"; sel.style.flex = "1"; sel.style.width = "auto"; sel.style.padding = "2px 6px";
              pd.options.forEach((opt) => {
                const o = document.createElement("option");
                o.value = String(opt); o.textContent = String(opt);
                sel.appendChild(o);
              });
              sel.value = String(cur);
              sel.addEventListener("change", () => {
                p[pd.key] = sel.value;
                renderTimeline(); renderEventButtons(); paintIfPaused();
              });
              row.appendChild(sel); paramsHost.appendChild(row);
            } else if (pd.type === "number") {
              const row = document.createElement("div"); row.className = "prop-row";
              row.innerHTML = `<span class="prop-label">${pd.label}</span>`;
              const inp = document.createElement("input");
              inp.type = "number"; inp.className = "ctl-num";
              inp.style.width = "88px"; inp.value = String(cur);
              inp.addEventListener("input", () => {
                const v = parseFloat(inp.value);
                p[pd.key] = isFinite(v) ? v : 0;
                renderTimeline(); renderEventButtons(); paintIfPaused();
              });
              row.appendChild(inp); paramsHost.appendChild(row);
            } else if (pd.type === "text") {
              const row = document.createElement("div"); row.className = "prop-row";
              row.innerHTML = `<span class="prop-label">${pd.label}</span>`;
              const inp = document.createElement("input");
              inp.type = "text"; inp.className = "ctl-num";
              inp.style.width = "160px"; inp.value = String(cur);
              inp.addEventListener("input", () => {
                p[pd.key] = inp.value;
                renderTimeline(); renderEventButtons(); paintIfPaused();
              });
              row.appendChild(inp); paramsHost.appendChild(row);
            }
          });
          // Special: svgTextOnPath — add a "Load path from SVG…" button
          // that parses an uploaded SVG file's first <path d=""> and
          // writes it into params.pathD.  Sanitized: only <path> d
          // attributes are read; no scripts / event handlers touched.
          if (selectedEventClip.ec.fxKey === "svgTextOnPath") {
            const row = document.createElement("div"); row.className = "prop-row";
            row.innerHTML = `<span class="prop-label">Load SVG</span>`;
            const btn = document.createElement("button");
            btn.className = "mini-btn"; btn.textContent = "Pick file…";
            btn.addEventListener("click", () => {
              const input = document.createElement("input");
              input.type = "file"; input.accept = "image/svg+xml,.svg";
              input.style.display = "none";
              input.addEventListener("change", () => {
                const file = input.files && input.files[0];
                if (!file) { document.body.removeChild(input); return; }
                const reader = new FileReader();
                reader.onload = (e) => {
                  try {
                    const doc = new DOMParser().parseFromString(String(e.target.result), "image/svg+xml");
                    if (doc.querySelector("parsererror")) { toast("Couldn't parse SVG"); return; }
                    const paths = Array.from(doc.querySelectorAll("path"));
                    if (!paths.length) { toast("SVG has no <path> elements"); return; }
                    // If multiple paths, ask which one (simple prompt fallback for MVP).
                    let idx = 0;
                    if (paths.length > 1) {
                      const pick = prompt(`SVG contains ${paths.length} paths (1..${paths.length}). Pick one:`, "1");
                      const n = parseInt(pick, 10);
                      if (isFinite(n) && n >= 1 && n <= paths.length) idx = n - 1;
                    }
                    const d = paths[idx].getAttribute("d") || "";
                    if (!d) { toast("Selected path has no `d` attribute"); return; }
                    p.pathD = d;
                    renderClipInspector(); renderTimeline(); paintIfPaused();
                    toast(`Loaded path #${idx + 1} of ${paths.length}`);
                  } catch (err) { toast("SVG load failed"); }
                };
                reader.readAsText(file);
                document.body.removeChild(input);
              });
              document.body.appendChild(input); input.click();
            });
            row.appendChild(btn); paramsHost.appendChild(row);
          }
        }
        // Event-specific extra params (Lost Signal / Vector Beam).
        const schema = EVENT_PARAM_SCHEMA[selectedEventClip.ec.fxKey];
        if (schema) {
          schema.forEach((spec) => {
            const [key, label, min, max, step] = spec;
            if (p[key] === undefined) return;
            paramsHost.appendChild(makeParamSlider(key, label, p[key], min, max, (v) => {
              p[key] = v; renderTimeline(); renderEventButtons(); paintIfPaused();
            }, step));
          });
        }
        // v19.8: color picker for clips whose params include a `color`
        // field (currently: Fill Color Flash; future vector effects
        // that flash / animate stroke color will plug in the same way).
        // Live-updates as the user drags the color, and paints while
        // paused so the flash is visible without playing.
        if (p.color !== undefined) {
          const row = document.createElement("div"); row.className = "prop-row";
          row.innerHTML = `<span class="prop-label">Color</span>`;
          const cell = document.createElement("div"); cell.className = "color-cell";
          const input = document.createElement("input");
          input.type = "color"; input.className = "color-input"; input.value = p.color;
          const hex = document.createElement("span");
          hex.className = "color-hex"; hex.textContent = (p.color || "").toUpperCase();
          const write = () => {
            p.color = input.value;
            hex.textContent = input.value.toUpperCase();
            renderTimeline(); renderEventButtons(); paintIfPaused();
          };
          input.addEventListener("input", write);
          input.addEventListener("change", write);
          cell.appendChild(input); cell.appendChild(hex);
          row.appendChild(cell);
          paramsHost.appendChild(row);
        }
        // v19.9: Morph target picker — appears for shapeMorph clips.
        //  - Dropdown lists other layers as morph targets.
        //  - Live compatibility badge below the picker updates as
        //    source/target changes.
        //  - Runs a fresh analyzeMorph each render so the report is
        //    always current with the DOM.
        if (selectedEventClip.ec.fxKey === "shapeMorph") {
          const layer = selectedEventClip.layer;
          // Target picker
          const row = document.createElement("div"); row.className = "prop-row";
          row.innerHTML = `<span class="prop-label">Target</span>`;
          const sel = document.createElement("select");
          sel.className = "ctl-num"; sel.style.minWidth = "0"; sel.style.flex = "1"; sel.style.width = "auto"; sel.style.padding = "2px 6px";
          const noneOpt = document.createElement("option");
          noneOpt.value = "0"; noneOpt.textContent = "— pick a layer —";
          sel.appendChild(noneOpt);
          // v19.18: also include group members as valid targets, since
          // pre-existing morph relationships must survive grouping.  A
          // member that hosts the source clip is filtered out below.
          const targets = [];
          layers.forEach((L) => {
            if (L.kind === "GROUP" && L._members) {
              L._members.forEach((m) => targets.push({ L: m, groupTag: ` (in ${L.name})` }));
            } else {
              targets.push({ L, groupTag: "" });
            }
          });
          targets.forEach(({ L, groupTag }) => {
            if (L === layer) return;    // can't morph to self
            const o = document.createElement("option");
            o.value = String(L.id); o.textContent = `${L.name} · ${L.kind}${L.kind === "SHAPE" ? " (" + L.shapeType + ")" : ""}${groupTag}`;
            sel.appendChild(o);
          });
          sel.value = String(p.morphTargetLayerId || 0);
          sel.addEventListener("change", () => {
            p.morphTargetLayerId = parseInt(sel.value, 10) || 0;
            renderClipInspector(); renderTimeline(); paintIfPaused();
          });
          row.appendChild(sel); paramsHost.appendChild(row);
          // Compatibility badge
          const target = findLayerAnywhere(p.morphTargetLayerId);
          const analysis = analyzeMorph(layer, target, p.morphTargetIndex);
          const status = document.createElement("div");
          status.className = "morph-diag " + (analysis.ok ? "morph-diag-ok" : "morph-diag-fail");
          if (analysis.ok) {
            status.innerHTML = `<b>✓ Compatible</b> · ${analysis.sourceCmds} commands · source ${layer.kind === "SHAPE" ? layer.shapeType : "SVG"} → target ${target.kind === "SHAPE" ? target.shapeType : "SVG"}`;
          } else {
            status.innerHTML = `<b>⚠ ${analysis.reason}</b>`;
            if (analysis.sourceCmds && analysis.targetCmds) {
              status.innerHTML += ` · source ${analysis.sourceCmds} cmds, target ${analysis.targetCmds} cmds`;
            }
          }
          paramsHost.appendChild(status);
        }
        // v19.12: Fill Reveal direction picker — appears for fillReveal clips.
        if (selectedEventClip.ec.fxKey === "fillReveal") {
          const row = document.createElement("div"); row.className = "prop-row";
          row.innerHTML = `<span class="prop-label">Direction</span>`;
          const sel = document.createElement("select");
          sel.className = "ctl-num"; sel.style.minWidth = "0"; sel.style.flex = "1"; sel.style.width = "auto"; sel.style.padding = "2px 6px";
          const opts = [
            ["left",       "Left → Right"],
            ["right",      "Right → Left"],
            ["top",        "Top → Bottom"],
            ["bottom",     "Bottom → Top"],
            ["center-out", "Center Out"],
            ["radial",     "Radial"],
          ];
          opts.forEach(([v, label]) => {
            const o = document.createElement("option"); o.value = v; o.textContent = label;
            sel.appendChild(o);
          });
          sel.value = p.direction || "left";
          sel.addEventListener("change", () => {
            p.direction = sel.value;
            renderTimeline(); paintIfPaused();
          });
          row.appendChild(sel); paramsHost.appendChild(row);
        }
        // v19.14: Segment Reveal — mode + spread pickers.
        if (selectedEventClip.ec.fxKey === "segmentReveal") {
          // Mode dropdown
          const row1 = document.createElement("div"); row1.className = "prop-row";
          row1.innerHTML = `<span class="prop-label">Mode</span>`;
          const sel = document.createElement("select");
          sel.className = "ctl-num"; sel.style.minWidth = "0"; sel.style.flex = "1"; sel.style.width = "auto"; sel.style.padding = "2px 6px";
          const opts = [
            ["sequential",         "Sequential"],
            ["sequential-reverse", "Reverse"],
            ["random",             "Random"],
            ["center-out",         "Center Out"],
            ["edges-in",           "Edges In"],
          ];
          opts.forEach(([v, label]) => {
            const o = document.createElement("option"); o.value = v; o.textContent = label;
            sel.appendChild(o);
          });
          sel.value = p.mode || "sequential";
          sel.addEventListener("change", () => {
            p.mode = sel.value;
            // Clear the segment-primitives cache — the sort signature changed.
            const L = selectedEventClip.layer;
            L._segmentPrims = null; L._segmentOrder = null; L._segmentSig = null;
            renderTimeline(); paintIfPaused();
          });
          row1.appendChild(sel); paramsHost.appendChild(row1);
          // Spread slider (stagger tightness)
          const row2 = document.createElement("div"); row2.className = "prop-row";
          row2.innerHTML = `<span class="prop-label">Spread</span>`;
          const cell = document.createElement("div"); cell.style.display = "flex"; cell.style.gap = "6px"; cell.style.alignItems = "center"; cell.style.flex = "1";
          const rng = document.createElement("input");
          rng.type = "range"; rng.min = 0; rng.max = 100; rng.step = 1; rng.value = p.spread ?? 60;
          rng.style.flex = "1";
          const val = document.createElement("span");
          val.className = "ctl-val"; val.textContent = String(p.spread ?? 60);
          const write = () => {
            p.spread = parseInt(rng.value, 10);
            val.textContent = String(p.spread);
            renderTimeline(); paintIfPaused();
          };
          rng.addEventListener("input", write);
          cell.appendChild(rng); cell.appendChild(val);
          row2.appendChild(cell); paramsHost.appendChild(row2);
        }
        // v19.14/19.15: Expansion Build — cinematic zoom controls.
        if (selectedEventClip.ec.fxKey === "expansionBuild") {
          // Mode dropdown — presets that enable different cross-effects.
          const row1 = document.createElement("div"); row1.className = "prop-row";
          row1.innerHTML = `<span class="prop-label">Mode</span>`;
          const sel = document.createElement("select");
          sel.className = "ctl-num"; sel.style.minWidth = "0"; sel.style.flex = "1"; sel.style.width = "auto"; sel.style.padding = "2px 6px";
          const opts = [
            ["expand",         "Expand"],
            ["expand-fade",    "Expand + Fade"],
            ["expand-rotate",  "Expand + Rotate"],
            ["expand-blur",    "Expand + Blur"],
            ["explosive",      "Explosive"],
            ["fit-canvas",     "Fit to canvas"],
          ];
          opts.forEach(([v, label]) => {
            const o = document.createElement("option"); o.value = v; o.textContent = label;
            sel.appendChild(o);
          });
          sel.value = p.mode || "expand";
          sel.addEventListener("change", () => {
            p.mode = sel.value;
            renderTimeline(); renderClipInspector(); paintIfPaused();
          });
          row1.appendChild(sel); paramsHost.appendChild(row1);
          // Target scale slider — 1x..100x direct multiplier.  Only
          // hidden when mode = fit-canvas (which auto-computes).
          if (p.mode !== "fit-canvas") {
            const rowS = document.createElement("div"); rowS.className = "prop-row";
            rowS.innerHTML = `<span class="prop-label">Scale</span>`;
            const cell = document.createElement("div"); cell.style.display = "flex"; cell.style.gap = "6px"; cell.style.alignItems = "center"; cell.style.flex = "1";
            const rng = document.createElement("input");
            rng.type = "range"; rng.min = 1; rng.max = 100; rng.step = 1; rng.value = p.targetScale ?? 20;
            rng.style.flex = "1";
            const val = document.createElement("span");
            val.className = "ctl-val"; val.textContent = `${p.targetScale ?? 20}×`;
            const write = () => {
              p.targetScale = parseInt(rng.value, 10);
              val.textContent = `${p.targetScale}×`;
              renderTimeline(); paintIfPaused();
            };
            rng.addEventListener("input", write);
            cell.appendChild(rng); cell.appendChild(val);
            rowS.appendChild(cell); paramsHost.appendChild(rowS);
          }
          // Origin dropdown — object-center vs canvas-center.
          const rowO = document.createElement("div"); rowO.className = "prop-row";
          rowO.innerHTML = `<span class="prop-label">Origin</span>`;
          const oSel = document.createElement("select");
          oSel.className = "ctl-num"; oSel.style.minWidth = "0"; oSel.style.flex = "1"; oSel.style.width = "auto"; oSel.style.padding = "2px 6px";
          [["object-center","Object center"],["canvas-center","Canvas center"]].forEach(([v, label]) => {
            const o = document.createElement("option"); o.value = v; o.textContent = label;
            oSel.appendChild(o);
          });
          oSel.value = p.origin || "object-center";
          oSel.addEventListener("change", () => {
            p.origin = oSel.value;
            renderTimeline(); paintIfPaused();
          });
          rowO.appendChild(oSel); paramsHost.appendChild(rowO);
          // Ease dropdown — includes "explosive" ease-in-quint.
          const row2 = document.createElement("div"); row2.className = "prop-row";
          row2.innerHTML = `<span class="prop-label">Ease</span>`;
          const eSel = document.createElement("select");
          eSel.className = "ctl-num"; eSel.style.minWidth = "0"; eSel.style.flex = "1"; eSel.style.width = "auto"; eSel.style.padding = "2px 6px";
          [
            ["easeIn",      "Ease In (cubic)"],
            ["easeInQuint", "Explosive (quintic)"],
            ["linear",      "Linear"],
            ["easeOut",     "Ease Out"],
            ["easeInOut",   "Ease In-Out"],
          ].forEach(([v, label]) => {
            const o = document.createElement("option"); o.value = v; o.textContent = label;
            eSel.appendChild(o);
          });
          eSel.value = p.ease || "easeIn";
          eSel.addEventListener("change", () => {
            p.ease = eSel.value;
            renderTimeline(); paintIfPaused();
          });
          row2.appendChild(eSel); paramsHost.appendChild(row2);
          // Rotate amount slider — only when rotate or explosive.
          if (p.mode === "expand-rotate" || p.mode === "explosive") {
            const row3 = document.createElement("div"); row3.className = "prop-row";
            row3.innerHTML = `<span class="prop-label">Rotation</span>`;
            const cell = document.createElement("div"); cell.style.display = "flex"; cell.style.gap = "6px"; cell.style.alignItems = "center"; cell.style.flex = "1";
            const rng = document.createElement("input");
            rng.type = "range"; rng.min = -720; rng.max = 720; rng.step = 15; rng.value = p.rotateAmount ?? 180;
            rng.style.flex = "1";
            const val = document.createElement("span");
            val.className = "ctl-val"; val.textContent = `${p.rotateAmount ?? 180}°`;
            const write = () => {
              p.rotateAmount = parseInt(rng.value, 10);
              val.textContent = `${p.rotateAmount}°`;
              renderTimeline(); paintIfPaused();
            };
            rng.addEventListener("input", write);
            cell.appendChild(rng); cell.appendChild(val);
            row3.appendChild(cell); paramsHost.appendChild(row3);
          }
          // Blur amount slider — only when blur or explosive.
          if (p.mode === "expand-blur" || p.mode === "explosive") {
            const row4 = document.createElement("div"); row4.className = "prop-row";
            row4.innerHTML = `<span class="prop-label">Blur</span>`;
            const cell = document.createElement("div"); cell.style.display = "flex"; cell.style.gap = "6px"; cell.style.alignItems = "center"; cell.style.flex = "1";
            const rng = document.createElement("input");
            rng.type = "range"; rng.min = 0; rng.max = 50; rng.step = 1; rng.value = p.blurAmount ?? 12;
            rng.style.flex = "1";
            const val = document.createElement("span");
            val.className = "ctl-val"; val.textContent = `${p.blurAmount ?? 12}px`;
            const write = () => {
              p.blurAmount = parseInt(rng.value, 10);
              val.textContent = `${p.blurAmount}px`;
              renderTimeline(); paintIfPaused();
            };
            rng.addEventListener("input", write);
            cell.appendChild(rng); cell.appendChild(val);
            row4.appendChild(cell); paramsHost.appendChild(row4);
          }
        }
        // Vector Beam growth easing seg (hard/ease) — separate from
        // direction because it uses different labels/values.
        if (selectedEventClip.ec.fxKey === "vectorBeam") {
          const row = document.createElement("div"); row.className = "prop-row";
          row.innerHTML = `<span class="prop-label">Growth</span>`;
          const btns = document.createElement("div"); btns.className = "seg-mini";
          [["hard","Hard"],["ease","Ease"]].forEach(([v, l]) => {
            const b = document.createElement("button");
            b.className = "mini-btn" + ((p.growthEasing ?? "hard") === v ? " active" : "");
            b.textContent = l;
            b.addEventListener("click", () => {
              p.growthEasing = v;
              renderClipInspector(); renderTimeline(); renderEventButtons(); paintIfPaused();
            });
            btns.appendChild(b);
          });
          row.appendChild(btns); paramsHost.appendChild(row);
        }
        // Pixel Sweep — sample mode seg (Center / Average).  Center is
        // sharpest; Average bilinearly averages the sample band which
        // reduces flicker on detailed sources at cost of some
        // softness.  Preserve Alpha shown as a toggle button.
        if (selectedEventClip.ec.fxKey === "pixelSweep") {
          const row = document.createElement("div"); row.className = "prop-row";
          row.innerHTML = `<span class="prop-label">Sample mode</span>`;
          const btns = document.createElement("div"); btns.className = "seg-mini";
          [["center","Center"],["average","Average"]].forEach(([v, l]) => {
            const b = document.createElement("button");
            b.className = "mini-btn" + ((p.sampleMode ?? "center") === v ? " active" : "");
            b.textContent = l;
            b.addEventListener("click", () => {
              p.sampleMode = v;
              renderClipInspector(); renderTimeline(); renderEventButtons(); paintIfPaused();
            });
            btns.appendChild(b);
          });
          row.appendChild(btns); paramsHost.appendChild(row);

          // Preserve Alpha toggle
          const paRow = document.createElement("div"); paRow.className = "prop-row";
          paRow.innerHTML = `<span class="prop-label">Preserve alpha</span>`;
          const paBtn = document.createElement("button");
          paBtn.className = "mini-btn" + ((p.preserveAlpha !== false) ? " active" : "");
          paBtn.textContent = (p.preserveAlpha !== false) ? "On" : "Off";
          paBtn.addEventListener("click", () => {
            p.preserveAlpha = !(p.preserveAlpha !== false);
            renderClipInspector(); paintIfPaused();
          });
          paRow.appendChild(paBtn); paramsHost.appendChild(paRow);
        }
      }
    } else if (hasAud) {
      const s = sounds.find((x) => x.id === selectedAudioClip.soundId);
      type = "Audio · " + (s ? s.name : "sound");
      track = AUDIO_TRACKS.find((tt) => tt.id === selectedAudioClip.track).label;
      start = selectedAudioClip.start; dur = selectedAudioClip.duration;
      vol = Math.round(selectedAudioClip.volume * 100); muted = selectedAudioClip.muted;
      el.clipVolRow.style.display = "";
      const csvi = document.getElementById("ctl-cv"); if (csvi) csvi.value = vol;
      const cvvi = document.getElementById("val-cv"); if (cvvi) cvvi.textContent = vol;
      el.clipMute.textContent = muted ? "Unmute" : "Mute";
      if (enBtn) enBtn.style.display = "none";
    }
    el.clipType.textContent = type; el.clipTrack.textContent = track;
    // v18.8: the Start slider represents ABSOLUTE scene time (0..STATE.duration)
    // to match both the numeric inspector display and the bindClipSlider("cs")
    // handler that reads scene time and stores layer-local.  For event clips
    // this means adding layer.start; audio clips are already absolute.
    const startAbsForSlider = hasEvt ? (selectedEventClip.layer.start + start) : start;
    setSlider("cs", startAbsForSlider); setSlider("cd", dur);
    // dynamic max on start/dur — both the range slider AND the numeric input
    const csEl = document.getElementById("ctl-cs"); if (csEl) csEl.max = STATE.duration;
    const cdEl = document.getElementById("ctl-cd"); if (cdEl) cdEl.max = STATE.duration;
    const csNum = document.getElementById("num-cs"); if (csNum) csNum.max = STATE.duration;
    const cdNum = document.getElementById("num-cd"); if (cdNum) cdNum.max = STATE.duration;
    // v18.8 timeline precision: populate End (seconds + frame) and frame
    // equivalents for Start/Duration.  Only update inputs that aren't
    // currently focused so live editing doesn't get clobbered.
    const fps = STATE.fps || 30;
    const setNumIf = (id, val) => {
      const n = document.getElementById(id);
      if (n && document.activeElement !== n) n.value = val;
    };
    const startAbs = hasEvt ? (selectedEventClip.layer.start + start) : start;
    setNumIf("num-cs", (+startAbs).toFixed(3));
    setNumIf("num-cs-f", Math.round(startAbs * fps));
    setNumIf("num-ce", (+(startAbs + dur)).toFixed(3));
    setNumIf("num-ce-f", Math.round((startAbs + dur) * fps));
    setNumIf("num-cd", (+dur).toFixed(3));
    setNumIf("num-cd-f", Math.round(dur * fps));
    // v19.29: also update toolbar Start/End inputs on selection change.
    setNumIf("tlClipStart", (+startAbs).toFixed(3));
    setNumIf("tlClipEnd",   (+(startAbs + dur)).toFixed(3));
    // v19.30: also update Duration input + name label.
    setNumIf("tlClipDur",   (+dur).toFixed(3));
    const tlNameEl = document.getElementById("tlClipName");
    if (tlNameEl) tlNameEl.textContent = type;
  }

  /* Param slider — `step` is optional; when < 1 the label formats with 2
     decimals so slow controls like Freeze (s) don't display as "0". */
  function makeParamSlider(key, label, value, min, max, onInput, step) {
    step = step || 1;
    const decimals = step < 1 ? 2 : 0;
    const wrap = document.createElement("div"); wrap.className = "control";
    const disp = decimals ? (+value).toFixed(decimals) : Math.round(value);
    wrap.innerHTML = `<span class="ctl-label">${label}</span><span class="ctl-val" id="pv-${key}">${disp}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-p="${key}">`;
    wrap.querySelector("input").addEventListener("input", (e) => {
      const v = +e.target.value;
      wrap.querySelector("#pv-" + key).textContent = decimals ? v.toFixed(decimals) : Math.round(v);
      onInput(v);
    });
    return wrap;
  }
  function setDuration(sec) { STATE.duration = sec; layers.forEach((l) => { l.start = clamp(l.start, 0, sec); l.duration = clamp(l.duration, 0.2, sec - l.start); }); EXPORTOPTS.duration = sec; syncDurationUI(); renderTimeline(); }
  function syncDurationUI() { [el.durSegTl, document.getElementById("durSeg")].forEach((seg) => { if (!seg) return; seg.querySelectorAll("[data-dur]").forEach((b) => b.classList.toggle("active", b.dataset.dur == STATE.duration || (b.dataset.dur === "custom" && ![4, 8, 15].includes(STATE.duration)))); }); }

  /* ============================================================ AUDIO ============================================================ */
  const audio = { ctx: null, el: null, source: null, analyser: null, freqData: null, timeData: null, ready: false, lastBeat: 0, prevBass: 0, prevFlux: 0, env: { bass: 0, mid: 0, high: 0, level: 0 }, energyAvg: 0, destGain: null, streamDest: null };
  function initAudio(file) {
    try {
      if (audio.el) audio.el.pause();
      audio.el = new Audio(URL.createObjectURL(file)); audio.el.loop = STATE.loop;
      ensureCtx();
      audio.source = audio.ctx.createMediaElementSource(audio.el);
      audio.analyser = audio.ctx.createAnalyser(); audio.analyser.fftSize = 2048; audio.analyser.smoothingTimeConstant = 0.75;
      audio.destGain = audio.ctx.createGain(); // legacy passthrough kept for MediaStream capture
      // analyser tees off; music routes through the mixer bus
      audio.source.connect(audio.analyser);
      audio.source.connect(audio.destGain);
      audio.destGain.connect(mixerBus.music);
      audio.freqData = new Uint8Array(audio.analyser.frequencyBinCount); audio.timeData = new Uint8Array(audio.analyser.frequencyBinCount);
      audio.ready = true; el.audioName.textContent = file.name;
      // v19.36: also decode to a raw AudioBuffer for offline analysis
      // (onset/beat marker generation).  Fire-and-forget — the buffer
      // becomes available when decoding finishes; the audio can still
      // play via <audio> while the decode happens in the background.
      file.arrayBuffer()
        .then((buf) => audio.ctx.decodeAudioData(buf.slice(0)))
        .then((decoded) => { audio.buffer = decoded; })
        .catch(() => { /* not fatal — analysis features will just be unavailable */ });
      // reset BPM state
      audio.beatTimes = []; STATE.bpm = 0; if (el.bpmVal) el.bpmVal.textContent = "—";
      toast("Music loaded");
    } catch (e) { toast("Could not initialize audio"); }
  }
  function bandAverage(lo, hi) { const nyq = (audio.ctx ? audio.ctx.sampleRate : 44100) / 2, bins = audio.analyser.frequencyBinCount; const a = Math.max(0, Math.floor((lo / nyq) * bins)), b = Math.min(bins - 1, Math.ceil((hi / nyq) * bins)); let s = 0, n = 0; for (let i = a; i <= b; i++) { s += audio.freqData[i]; n++; } return n ? s / (n * 255) : 0; }
  function analyzeAudio() {
    if (!audio.ready || audio.el.paused || !STATE.audioReactive) {
      const d = 0.9; STATE.audioLevel *= d; STATE.bassLevel *= d; STATE.midLevel *= d; STATE.highLevel *= d; STATE.beat *= 0.85; STATE.peak *= 0.8; STATE.buildup *= 0.98; audio.env.bass *= d; audio.env.mid *= d; audio.env.high *= d; audio.env.level *= d; updateDebugMeter(); return;
    }
    audio.analyser.getByteFrequencyData(audio.freqData); audio.analyser.getByteTimeDomainData(audio.timeData);
    let sum = 0; for (let i = 0; i < audio.timeData.length; i++) { const v = (audio.timeData[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / audio.timeData.length), bass = bandAverage(20, 160), mid = bandAverage(160, 2000), high = bandAverage(2000, 12000);
    const sm = 0.35 + (STATE.smoothing / 100) * 0.6, attack = 1 - sm, env = audio.env;
    env.bass = Math.max(bass, env.bass * sm + bass * attack); env.mid = Math.max(mid, env.mid * sm + mid * attack); env.high = Math.max(high, env.high * sm + high * attack); env.level = env.level * sm + rms * attack;
    STATE.bassLevel = env.bass; STATE.midLevel = env.mid; STATE.highLevel = env.high; STATE.audioLevel = env.level;
    const flux = Math.max(0, (bass + mid + high) - audio.prevFlux); audio.prevFlux = audio.prevFlux * 0.6 + (bass + mid + high) * 0.4;
    const peakGate = 0.04 + (STATE.peakThreshold / 100) * 0.25;
    if (flux > peakGate) STATE.peak = 1; else STATE.peak *= (0.65 + (STATE.syncTightness / 100) * 0.3);
    const now = performance.now(), sens = STATE.beatSensitivity / 100, beatGate = 0.30 + (1 - sens) * 0.35, refractory = 120 + (1 - sens) * 260;
    if (bass > beatGate && bass > audio.prevBass * (1.05 + (1 - sens) * 0.25) && now - audio.lastBeat > refractory) {
      STATE.beat = 1; audio.lastBeat = now;
      if (!audio.beatTimes) audio.beatTimes = [];
      audio.beatTimes.push(now);
      if (audio.beatTimes.length > 64) audio.beatTimes.shift();
      if (STATE.playing) { const bt = STATE.time; if (!markers.some((m) => m.type === "beat" && Math.abs(m.time - bt) < 0.05)) markers.push({ type: "beat", time: bt }); }
      updateBpm();
    } else STATE.beat *= (0.80 + (1 - STATE.syncTightness / 100) * 0.15);
    // record peak markers (music-driven)
    if (STATE.peak > 0.85 && STATE.playing) {
      const pt = STATE.time;
      if (!markers.some((m) => m.type === "peak" && Math.abs(m.time - pt) < 0.08)) {
        markers.push({ type: "peak", time: pt });
        if (STATE.autoKeyframes) autoEventFromPeak(pt);
      }
    }
    audio.prevBass = audio.prevBass * 0.7 + bass * 0.3;
    const energy = (bass + mid + high) / 3; audio.energyAvg = audio.energyAvg * 0.99 + energy * 0.01; STATE.buildup = clamp01(STATE.buildup + (energy > audio.energyAvg * 1.08 ? 0.01 : -0.006));
    updateDebugMeter();
  }
  function updateDebugMeter() {
    if (!el.beatMeter) return;
    const set = (sel, v) => { const bar = el.beatMeter.querySelector(sel); if (bar) bar.style.width = Math.min(100, v * 100) + "%"; };
    set(".m-bass > i", STATE.bassLevel); set(".m-mid > i", STATE.midLevel); set(".m-high > i", STATE.highLevel); set(".m-peak > i", STATE.peak);
    const dot = el.beatMeter.querySelector(".m-beat-dot"); if (dot) dot.classList.toggle("on", STATE.beat > 0.5);
    if (el.levelFill) el.levelFill.style.height = Math.min(100, STATE.audioLevel * 240) + "%";
  }
  function audioSignal() {
    const on = STATE.audioReactive && audio.ready ? 1 : 0, m = STATE.motionIntensity / 100;
    return { on, bass: on * STATE.bassLevel * (STATE.bassReaction / 100) * m, mid: on * STATE.midLevel * (STATE.midReaction / 100) * m, high: on * STATE.highLevel * (STATE.highReaction / 100) * m, level: on * STATE.audioLevel * m, beat: on * STATE.beat, peak: on * STATE.peak, buildup: on * STATE.buildup };
  }

  /* ============================================================ SFX / MIXER
     User-imported sound library + audio clips on timeline tracks.
     Audio graph:
       source -> clipGain -> trackBus(gain) -> masterBus(gain) -> destination
     Music has its own path: mediaElementSource -> analyser + musicBus.
     ============================================================ */
  const mixerBus = { master: null, music: null, sfx: null, voice: null };
  let previewSource = null, previewGain = null;

  function ensureCtx() {
    if (!audio.ctx) audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.ctx.state === "suspended") audio.ctx.resume().catch(() => {});
    if (!mixerBus.master) {
      mixerBus.master = audio.ctx.createGain(); mixerBus.master.gain.value = mixLevel("master");
      mixerBus.master.connect(audio.ctx.destination);
      mixerBus.music = audio.ctx.createGain(); mixerBus.music.gain.value = mixLevel("music"); mixerBus.music.connect(mixerBus.master);
      mixerBus.sfx = audio.ctx.createGain(); mixerBus.sfx.gain.value = mixLevel("sfx"); mixerBus.sfx.connect(mixerBus.master);
      mixerBus.voice = audio.ctx.createGain(); mixerBus.voice.gain.value = mixLevel("voice"); mixerBus.voice.connect(mixerBus.master);
    }
    return audio.ctx;
  }
  function mixLevel(bus) {
    if (bus === "master") return STATE.muteMaster ? 0 : STATE.mixMaster;
    if (bus === "music")  return STATE.muteMusic  ? 0 : STATE.mixMusic;
    if (bus === "sfx")    return STATE.muteSfx    ? 0 : STATE.mixSfx;
    if (bus === "voice")  return STATE.muteVoice  ? 0 : STATE.mixVoice;
    return 1;
  }
  function refreshMixer() {
    ensureCtx();
    mixerBus.master.gain.value = mixLevel("master");
    mixerBus.music.gain.value = mixLevel("music");
    mixerBus.sfx.gain.value = mixLevel("sfx");
    mixerBus.voice.gain.value = mixLevel("voice");
  }
  function trackBus(track) {
    if (track === "music") return mixerBus.music;
    if (track === "voice") return mixerBus.voice;
    return mixerBus.sfx;
  }

  async function handleSfxFiles(fileList) {
    const files = Array.from(fileList || []); if (!files.length) return;
    ensureCtx();
    for (const file of files) {
      if (!file.type.startsWith("audio/")) { toast(`Skipped: ${file.name} (not audio)`); continue; }
      try {
        const buf = await file.arrayBuffer();
        const decoded = await audio.ctx.decodeAudioData(buf.slice(0));
        const url = URL.createObjectURL(file);
        sounds.push({ id: ++idSeq, name: file.name, url, buffer: decoded, duration: decoded.duration });
        toast(`Loaded sound: ${file.name}`);
      } catch (e) { toast(`Could not decode ${file.name}`); }
    }
    renderSfxList();
    renderSfxSelect();
  }

  function renderSfxList() {
    el.sfxCount.textContent = sounds.length;
    if (!sounds.length) { el.sfxList.innerHTML = '<li class="empty-note">Nothing here yet. Import sound files to build your SFX library.</li>'; return; }
    el.sfxList.innerHTML = "";
    sounds.forEach((s) => {
      const li = document.createElement("li"); li.className = "sfx-item"; li.dataset.id = s.id;
      li.innerHTML = `<span class="sfx-waveform">\u266A</span>` +
        `<span class="sfx-meta"><span class="sfx-title">${s.name}</span><span class="sfx-sub">${s.duration.toFixed(2)}s</span></span>` +
        `<span class="sfx-actions"><button data-act="preview">Play</button><button data-act="add" title="Add to first SFX track at playhead">+ Track</button><button data-act="del" class="danger">\u2715</button></span>`;
      li.addEventListener("click", (e) => {
        const act = e.target.dataset && e.target.dataset.act;
        if (act === "preview") { previewSound(s); }
        else if (act === "add") { addSoundToTimeline(s, "sfx1"); }
        else if (act === "del") { removeSound(s); }
        else { $$(".sfx-item").forEach((n) => n.classList.remove("selected")); li.classList.add("selected"); }
      });
      el.sfxList.appendChild(li);
    });
  }

  function previewSound(s) {
    if (!s || !s.buffer) return;
    ensureCtx();
    stopPreview();
    previewGain = audio.ctx.createGain(); previewGain.gain.value = 1;
    previewSource = audio.ctx.createBufferSource(); previewSource.buffer = s.buffer;
    previewSource.connect(previewGain).connect(mixerBus.sfx);
    previewSource.start(0);
    toast(`Preview: ${s.name}`);
    previewSource.onended = () => { previewSource = null; };
  }
  function stopPreview() { if (previewSource) { try { previewSource.stop(); } catch (e) {} previewSource = null; } }

  function removeSound(s) {
    // remove clips using this sound too
    for (let i = audioClips.length - 1; i >= 0; i--) if (audioClips[i].soundId === s.id) audioClips.splice(i, 1);
    const idx = sounds.indexOf(s); if (idx >= 0) sounds.splice(idx, 1);
    if (s.url) URL.revokeObjectURL(s.url);
    renderSfxList(); renderSfxSelect(); renderTimeline();
  }

  function renderSfxSelect() {
    if (!el.attachSfxSel) return;
    const cur = el.attachSfxSel.value;
    el.attachSfxSel.innerHTML = '<option value="">Choose a sound…</option>' + sounds.map((s) => `<option value="${s.id}">${s.name}</option>`).join("");
    if (cur && sounds.some((s) => s.id == cur)) el.attachSfxSel.value = cur;
  }

  function addSoundToTimeline(sound, track) {
    const start = clamp(STATE.time, 0, STATE.duration - 0.05);
    const dur = Math.min(sound.duration, Math.max(0.1, STATE.duration - start));
    const clip = { id: ++idSeq, soundId: sound.id, track: track || "sfx1", start, duration: dur, volume: 1, muted: false, selected: false };
    audioClips.push(clip);
    renderTimeline();
    selectAudioClip(clip);
    toast(`Added ${sound.name} to ${track || "SFX 1"}`);
    return clip;
  }

  /* ---- Playback scheduling ----
     When playback starts, we schedule ALL currently-live audio clips
     (including music, if loaded) whose time overlaps the playhead. Each
     BufferSource is stopped on pause/seek/loop-restart. */
  const playingSources = [];  // { source, clipId }
  function stopAllAudioClipSources() {
    playingSources.forEach(({ source }) => { try { source.stop(); } catch (e) {} });
    playingSources.length = 0;
  }
  function schedulePlayback(fromTime) {
    ensureCtx();
    stopAllAudioClipSources();
    const now = audio.ctx.currentTime + 0.02;
    audioClips.forEach((clip) => {
      if (clip.muted) return;
      const sound = sounds.find((s) => s.id === clip.soundId); if (!sound) return;
      const clipEnd = clip.start + clip.duration;
      if (clipEnd <= fromTime) return;
      const startDelay = Math.max(0, clip.start - fromTime);
      const offset = Math.max(0, fromTime - clip.start);
      const playDuration = Math.min(clip.duration - offset, sound.duration - offset);
      if (playDuration <= 0.01) return;
      try {
        const src = audio.ctx.createBufferSource(); src.buffer = sound.buffer;
        const g = audio.ctx.createGain(); g.gain.value = clip.volume;
        src.connect(g).connect(trackBus(clip.track));
        src.start(now + startDelay, offset, playDuration);
        playingSources.push({ source: src, clipId: clip.id });
        src.onended = () => { const i = playingSources.findIndex((p) => p.source === src); if (i >= 0) playingSources.splice(i, 1); };
      } catch (e) {}
    });
  }

  /* ---- BPM detection (simple, from recent beat spacing) ---- */
  function updateBpm() {
    if (!audio.beatTimes) audio.beatTimes = [];
    if (audio.beatTimes.length < 4) { STATE.bpm = 0; return; }
    // take median of intervals from last N beats
    const recent = audio.beatTimes.slice(-16);
    const ints = []; for (let i = 1; i < recent.length; i++) ints.push(recent[i] - recent[i - 1]);
    ints.sort((a, b) => a - b);
    const median = ints[Math.floor(ints.length / 2)];
    if (median > 20 && median < 2000) STATE.bpm = Math.round(60000 / median);
    if (el.bpmVal) el.bpmVal.textContent = STATE.bpm ? STATE.bpm + " BPM" : "—";
  }

  /* ---- Event clip creation ---- */
  function createEventClip(fxKey, layer, startTime, duration) {
    if (!layer) { toast("Select a layer first"); return null; }
    const def = FX_EVENT_DEF.get(fxKey);
    // v18.7: honor placement + "layer" defDur so migrated sustained
    // effects fill the layer duration and reveal effects anchor at
    // layer start rather than playhead.
    let start;
    if (startTime != null) {
      // caller specified — trust them
      start = startTime;
    } else if (def && def.placement === "layerStart") {
      start = layer.start;
    } else {
      start = STATE.time;
    }
    // Compute duration.  "layer" sentinel = fill from start to end of layer.
    let dur;
    if (duration != null) {
      dur = duration;
    } else if (def && def.defDur === "layer") {
      const relStart = start - layer.start;
      dur = Math.max(0.05, layer.duration - relStart);
    } else {
      dur = (def && typeof def.defDur === "number") ? def.defDur : 0.2;
    }
    // clamp start within the layer window
    let localStart = clamp(start - layer.start, 0, Math.max(0, layer.duration - Math.min(dur, 0.05)));
    // apply timeline snap in absolute coords, then re-localize
    localStart = applySnap(localStart + layer.start) - layer.start;
    // clamp duration so the clip fits inside the layer
    dur = Math.min(dur, Math.max(0.05, layer.duration - localStart));
    const clip = { id: ++idSeq, fxKey, start: localStart, duration: dur, enabled: true, params: defaultParamsFor(fxKey) };
    layer.clips.push(clip);
    // optional SFX attachment
    if (STATE.attachSfx && STATE.attachSfxId) {
      const s = sounds.find((x) => x.id == STATE.attachSfxId);
      if (s) addSoundToTimeline(s, "sfx1");
    }
    renderTimeline();
    return clip;
  }
  function autoEventFromPeak(sceneTime) {
    if (!layers.length) return;
    const target = selectedLayer || layers[Math.floor(Math.random() * layers.length)];
    const keys = ["focusSnap", "signalInterrupt", "rgbSpike", "hardCutEvent"];
    const key = keys[Math.floor(Math.random() * keys.length)];
    // relative to layer start
    const relStart = clamp(sceneTime - target.start, 0, Math.max(0, target.duration - 0.05));
    const def = FX_EVENTS.find((f) => f.key === key);
    target.clips.push({ id: ++idSeq, fxKey: key, start: relStart, duration: def.defDur, enabled: true, params: defaultParamsFor(key) });
    renderTimeline();
  }
  function snapTimeToBeat(t) {
    if (!audio.beatTimes || audio.beatTimes.length < 2) return t;
    if (STATE.bpm) { const step = 60 / STATE.bpm; return Math.round(t / step) * step; }
    return t;
  }
  function snapTimeToFrame(t) { const fps = STATE.fps || 30; return Math.round(t * fps) / fps; }

  /* v18.8: fit-all and zoom-to-range helpers.
     - zoomFitAll() sets tlZoom so the full duration fills the visible
       timeline body width.
     - zoomToRange(startSec, endSec) sets tlZoom so the specified span
       fills ~60% of the visible width, then scrolls to center it. */
  function zoomFitAll() {
    STATE.tlZoom = 1;
    if (el.tlZoom) el.tlZoom.value = 1;
    if (el.tlBody) el.tlBody.scrollLeft = 0;
    renderTimeline();
  }
  function zoomToRange(startSec, endSec) {
    const dur = Math.max(0.05, endSec - startSec);
    const bodyW = (el.tlBody && el.tlBody.clientWidth) || 800;
    // At zoom=1, pxPerSec = bodyW / STATE.duration.  We want the
    // range's pixel width ≈ 0.6 * bodyW.
    const desiredPxPerSec = (0.6 * bodyW) / dur;
    const baseline = bodyW / STATE.duration;
    const desiredZoom = Math.max(0.25, Math.min(16, desiredPxPerSec / baseline));
    STATE.tlZoom = desiredZoom;
    if (el.tlZoom) el.tlZoom.value = desiredZoom;
    renderTimeline();
    // Center the range in the visible window after re-layout.
    requestAnimationFrame(() => {
      const centerSec = (startSec + endSec) / 2;
      const centerPx = centerSec * TL.pxPerSec;
      if (el.tlBody) el.tlBody.scrollLeft = centerPx - bodyW / 2;
    });
  }

  // Apply whichever snap modes are enabled. Called by clip drag handlers.
  function applySnap(t) {
    if (STATE.snapBeat) t = snapTimeToBeat(t);
    if (STATE.snapFrame) t = snapTimeToFrame(t);
    return t;
  }

  /* v18.8 magnetic snap.  Called during clip drag/trim to snap an
     edge to nearby "hot" targets: the playhead + other clip edges.
     Only fires within a small tolerance window measured in pixels,
     scaled to the current timeline zoom so behavior is consistent
     regardless of zoom level.  Returns the possibly-adjusted absolute
     time.  Also returns a flag so the drag code can flash a snap
     indicator.
     `t` = absolute scene time (not layer-local).
     `excludeClip` = the clip currently being dragged; its own edges
     are ignored to prevent self-snap.
  */
  const MAGNETIC_SNAP_PX = 6;
  function applyMagneticSnap(t, excludeClip, origin) {
    // Convert pixel tolerance to seconds at current zoom.
    const tol = MAGNETIC_SNAP_PX / (TL.pxPerSec || 1);
    // Frame snap first (integer pixel-grid).
    if (STATE.snapFrame) t = snapTimeToFrame(t);
    let bestTarget = null, bestDist = tol;
    // Collect all snap targets in scene time.
    const targets = [];
    if (STATE.snapPlayhead) targets.push(STATE.time);
    // v19.31 Snap to Marker.  When enabled, marker times participate
    // in the same magnetic-snap logic as playhead / clip edges.
    if (STATE.snapMarker) {
      for (const m of markers) targets.push(m.time);
    }
    if (STATE.snapClipEdges) {
      // Layer boundaries + event clip edges from every layer.
      layers.forEach((l) => {
        if (!l.clips) return;
        targets.push(l.start, l.start + l.duration);
        l.clips.forEach((c) => {
          if (c === excludeClip) return;
          targets.push(l.start + c.start, l.start + c.start + c.duration);
        });
      });
      // Audio clip edges too — they're on the timeline as well.
      audioClips.forEach((c) => {
        if (c === excludeClip) return;
        targets.push(c.start, c.start + c.duration);
      });
      // Duration bounds
      targets.push(0, STATE.duration);
    }
    for (const target of targets) {
      // v19.30 direction-aware snap: reject targets that lie on the
      // opposite side of `origin` from the current drag position.
      // Without this, snap can pull a handle BACKWARD relative to the
      // user's drag direction — the "I dragged right, edge moved
      // left" complaint.  When `origin` is undefined (playhead scrub,
      // legacy callers), fall back to old behavior.
      if (origin !== undefined && origin !== null) {
        const dragDelta   = t - origin;
        const targetDelta = target - origin;
        // Both non-zero and opposite signs → target is behind us.
        if (Math.abs(dragDelta) > 0.0001 && Math.abs(targetDelta) > 0.0001
            && Math.sign(dragDelta) !== Math.sign(targetDelta)) {
          continue;
        }
      }
      const d = Math.abs(t - target);
      if (d < bestDist) { bestDist = d; bestTarget = target; }
    }
    // v18.8 → v19.32 visual feedback: brief snap flash on the playhead
    // when a magnetic snap fired.  Extended in v19.32 to also flash
    // for marker and clip-edge snaps + a temporary vertical guide line
    // at the exact snap target position — addresses the "cannot tell
    // whether snap is happening" complaint.
    if (bestTarget !== null) {
      // Determine what KIND of target we snapped to for guide coloring.
      let targetKind = "edge";
      if (STATE.snapPlayhead && Math.abs(bestTarget - STATE.time) < 0.001) targetKind = "playhead";
      else if (STATE.snapMarker) {
        for (const m of markers) if (Math.abs(m.time - bestTarget) < 0.001) { targetKind = "marker"; break; }
      }
      // Playhead-badge flash for backward compatibility (playhead snap case).
      if (targetKind === "playhead" && el.tlPlayhead) {
        el.tlPlayhead.classList.add("snap-hit");
        clearTimeout(el.tlPlayhead._snapClear);
        el.tlPlayhead._snapClear = setTimeout(() => el.tlPlayhead.classList.remove("snap-hit"), 200);
      }
      // Guide line: a thin vertical line at the snap target's px
      // position, colored by kind (playhead=purple, marker=amber,
      // edge=white).  Fades out ~250ms.  One guide reused across
      // consecutive snap events.
      showSnapGuide(bestTarget, targetKind);
    }
    return bestTarget !== null ? bestTarget : t;
  }

  /* v19.32: transient snap guide line rendered inside the timeline
     tracks region.  Reused across snap events to avoid DOM churn. */
  function showSnapGuide(sceneTime, kind) {
    if (!el.tlTracks) return;
    let guide = document.getElementById("tlSnapGuide");
    if (!guide) {
      guide = document.createElement("div");
      guide.id = "tlSnapGuide";
      guide.className = "tl-snap-guide";
      el.tlTracks.appendChild(guide);
    }
    const px = Math.round(sceneTime * TL.pxPerSec);
    guide.style.left = px + "px";
    guide.dataset.kind = kind;
    // restart the CSS animation by removing + reflowing + re-adding
    guide.classList.remove("is-visible");
    // reflow so the animation restarts
    void guide.offsetWidth;
    guide.classList.add("is-visible");
    clearTimeout(guide._clearTimer);
    guide._clearTimer = setTimeout(() => guide.classList.remove("is-visible"), 180);
  }

  /* ============================================================ EFFECTS
     Appearance effects return opacity/blur/rgb/glow/flash and never move
     the layer. Transform effects (signalShake, hologramTilt) return
     tx/ty/scale/rot and are only applied when allowTransform is on.
     ============================================================ */
  const EFFECTS = {
    blurIn(sig, t) { const k = Math.min(1, (t % 6) / 1.2); return { blur: (1 - k) * 12, opacity: 0.15 + k * 0.85, scaleSafe: 0.96 + k * 0.04 }; },
    hardCut(sig, t) { const trig = sig.peak > 0.6 || sig.beat > 0.72; return { flash: trig ? (Math.random() < 0.5 ? "#fff" : "#000") : null, flashA: trig ? 0.45 : 0 }; },
    flickerBlocks(sig, t) { const amt = STATE.flicker / 100, kick = sig.beat * 0.8 + sig.peak * 0.6; const cut = Math.random() < (0.04 + kick * 0.22) * amt; return { opacity: cut ? 0.18 : 1 }; },
    rgbOffset(sig, t) { const base = (STATE.rgbSplit / 100) * 8, j = Math.sin(t * 40) * 0.5 + 0.5; return { rgb: base * (1 + sig.bass * 2 + sig.peak * 2.5) * (0.6 + j * 0.4) }; },
    scanReveal(sig, t) { return { scanBoost: 0.4 + sig.high, opacityWave: 0.92 + 0.08 * Math.sin(t * (3 + sig.mid * 6)) }; },
    dataBreakup(sig, t) { const on = sig.peak > 0.5; return { breakup: on ? (STATE.noise / 100) : 0, opacity: (on && Math.random() < 0.2) ? 0.6 : 1 }; },
    hudOverlay(sig, t) { return { hud: true, hudFlicker: 0.6 + sig.mid * 0.4 }; },
    pulseGlow(sig, t) { const b = Math.sin(t * (1.4 + sig.bass * 2)) * 0.5 + 0.5; return { glow: 6 + b * 12 + sig.bass * 30, opacity: 0.85 + 0.15 * b }; },
    symbolTrans(sig, t) { const k = Math.sin(t * 0.8) * 0.5 + 0.5; return { blur: k * 3, opacity: 0.6 + 0.4 * k, scaleSafe: 1 }; },
    textFlicker(sig, t) { const amt = STATE.flicker / 100; const cut = Math.random() < (0.05 + sig.mid * 0.2) * amt; return { textFlicker: amt, opacity: cut ? 0.4 : 1 }; },
    lineDraw(sig, t) { const k = clamp01((t % 5) / 2.2); return { pathDraw: k }; },
    trimPaths(sig, t) { const k = (Math.sin(t * 0.9) * 0.5 + 0.5); return { pathTrim: k }; },
    radarSweep(sig, t) { return { radar: (t * (60 + sig.mid * 120)) % 360, glow: 4 + sig.mid * 14 }; },
    coordBlink(sig, t) { return { hud: true, hudFlicker: 0.4 + 0.6 * (Math.random() < 0.1 ? 0 : 1) }; },
    dataStream(sig, t) { return { scanBoost: 0.3 + sig.high * 0.8, opacityWave: 0.9 + 0.1 * Math.sin(t * 12) }; },
    oscilloscope(sig, t) { return { oscilloscope: 0.5 + sig.level, scanBoost: 0.2 + sig.high * 0.5 }; },
    digitalWave(sig, t) { const w = Math.sin(t * (2 + sig.bass * 4)); return { skew: w * (1.2 + sig.bass * 2.5) }; },
    // transform effects (gated)
    signalShake(sig, t) { const s = (STATE.glitch / 100) * 1.5 + 0.6, impact = 1 + sig.bass * 3 + sig.beat * 2.5; return { tx: (Math.random() - 0.5) * s * impact, ty: (Math.random() - 0.5) * s * impact }; },
    hologramTilt(sig, t) { return { rotX: Math.sin(t * 0.7) * (7 + sig.mid * 8), rotY: Math.cos(t * 0.5) * (9 + sig.mid * 10) }; },
    // v19.41 sustained text-fx placeholders — their real work is done
    // by applyTextFxAtTime.  Returning empty delta so the pipeline
    // doesn't warn about a missing sustained handler.
    sineWaveText(sig, t)  { return {}; },
    svgTextOnPath(sig, t) { return {}; },
    // v19.41 universal RGB Split (Pro) — extended params over legacy rgbOffset.
    // distance/angle project into rgb offset magnitude with per-frame jitter.
    rgbSplitPro(sig, t, params) {
      const P = params || {};
      const dist = P.distance ?? 6;
      const jitter = (P.jitter || 0) / 100;
      const intensity = (P.intensity ?? 100) / 100;
      // Angle unused for the DOM channel-split preview (canvas export uses it).
      const jitterAmt = jitter * dist * 0.5 * (Math.sin(t * 27) * 0.5 + 0.5);
      return { rgb: (dist + jitterAmt) * intensity };
    },
    // v19.41 Weird — sustained "everything at once" glitch inspired by Efecto.
    // We synthesize deltas per RAF: shake, chroma split, slice offset, noise,
    // color flash, scanline drop.  Deterministic via seed × time-quantized frame.
    weirdGlitch(sig, t, params) {
      const P = params || {};
      const glitchChance = (P.glitchChance || 40) / 100;
      const glitchSpeed = P.glitchSpeed || 10;
      const shake = (P.shake || 0) / 100;
      const chroma = (P.chroma || 0) / 100;
      const noise = (P.noise || 0) / 100;
      const flash = (P.colorFlash || 0) / 100;
      const seed = (P.seed || 137);
      const frame = Math.floor(t * glitchSpeed);
      const r = _rng(seed + frame * 991);
      const isGlitching = r() < glitchChance;
      const delta = {
        rgb: chroma * (isGlitching ? 12 : 3),
        breakup: isGlitching ? noise * 0.9 : noise * 0.2,
        glow: isGlitching ? flash * 15 : 0,
        scanBoost: isGlitching ? (P.scanlineDrop || 0) / 100 * 0.8 : 0,
        tx: (r() - 0.5) * shake * (isGlitching ? 12 : 3),
        ty: (r() - 0.5) * shake * (isGlitching ? 8 : 2),
      };
      if (isGlitching && flash > 0.1 && r() < 0.4) {
        const cols = ["#ff2a2a","#2affff","#ffff2a","#ff2affaa","#2aff2a"];
        delta.flash = cols[Math.floor(r() * cols.length)];
        delta.flashA = flash * 0.25;
      }
      return delta;
    },
  };

  /* ============================================================ EVENT EFFECTS
     Short timeline events. Each takes `p` = progress (0..1) inside the
     clip. They return the same delta shape as EFFECTS. Applied only when
     the playhead is within the event clip.
     ============================================================ */
  const EVENT_EFFECTS = {
    // v19.41 event-style text-fx placeholders — actual mutation lives
    // in applyTextFxAtTime.  Returning empty delta is enough for the
    // clip to be "active" in the pipeline (activeEventClipsAt) so the
    // text engine picks them up.
    textScramble()    { return {}; },
    bulkTyping()      { return {}; },
    animatedCounter() { return {}; },
    odometer()        { return {}; },
    charStagger()     { return {}; },
    // Focus Snap: blur ramps up then snaps sharp on release.
    focusSnap(p, sig, params) { const k = (params?.intensity ?? 50) / 50; const b = p < 0.6 ? p / 0.6 : (1 - p) / 0.4; return { blur: 6 * b * k, glow: 10 * b * k, opacity: 0.85 + 0.15 * b }; },
    // Signal Interrupt: 1-3 frame opacity dropout with brief RGB kick.
    signalInterrupt(p, sig, params) { const on = p < 0.85; const k = (params?.intensity ?? 50) / 50; return { opacity: on ? 0.02 : 1, rgb: on ? 6 * k : 0, flash: on ? "#000" : null, flashA: on ? 0.15 * k : 0 }; },
    // Frame Hold: freeze (returns freeze:true; render loop keeps the previous frame).
    frameHold(p, sig) { return { freeze: true, blur: 0.4 }; },
    // RGB Spike: strong channel offset for a short window.
    rgbSpike(p, sig, params) { const k = (params?.intensity ?? 50) / 50; const t = 1 - Math.abs(p - 0.5) * 2; return { rgb: 14 * t * k }; },
    // Hard Cut event: single flash.
    hardCutEvent(p, sig, params) { const k = (params?.intensity ?? 50) / 50; return { flash: p < 0.5 ? "#fff" : "#000", flashA: 0.5 * (1 - p) * k }; },
    // Radar Sweep: horizontal scan bar (returns radarBar 0..1 as position).
    radarSweep(p, sig, params) { const k = (params?.intensity ?? 50) / 50; return { radarBar: p, scanBoost: (0.3 + sig.high * 0.4) * k }; },
    // Scan Reveal event: mask sweeps across the layer.
    scanRevealEvent(p, sig) { return { scanMask: p, opacityWave: 0.9 + 0.1 * Math.sin(p * 20) }; },
    // Coordinate Blink event: HUD flicker burst.
    coordBlinkEvt(p, sig) { return { hud: true, hudFlicker: 0.3 + 0.7 * (Math.random() < 0.4 ? 0 : 1) }; },
    // Data Break event: short breakup.
    dataBreakEvent(p, sig, params) { const k = (params?.intensity ?? 50) / 50; return { breakup: (0.7 + sig.peak * 0.3) * k, opacity: Math.random() < 0.25 ? 0.35 : 1, rgb: 4 * k }; },
    // Path Energize: stroke-dash flow across the layer's paths.
    pathEnergize(p, sig, params) { const k = (params?.intensity ?? 50) / 50; return { pathDraw: p, glow: (8 + 12 * (1 - Math.abs(p - 0.5) * 2)) * k }; },
    // Layer Swap: brief opacity drop plus color invert-like glow.
    layerSwap(p, sig) { return { opacity: p < 0.5 ? 0.2 : 1, glow: 20 * (1 - p) }; },
    // Text Replace: opacity blink (text swap handled at render if the
    // layer contains <text>). Kept safe if not.
    textReplace(p, sig) { return { textSwap: p, opacity: (p < 0.15 || p > 0.85) ? 1 : 0.65 }; },

    // ---- 20 new micrographic events ----
    // Micro Jitter: rapid tiny position jitter (px in artboard %-units, scaled small).
    microJitter(p, sig, params) { const k = (params?.intensity ?? 50) / 50; const a = 1.4 * k; return { tx: (Math.random() - 0.5) * a, ty: (Math.random() - 0.5) * a }; },
    // HUD Pulse: bright HUD frame that pulses with a triangle envelope.
    hudPulse(p, sig, params) { const k = (params?.intensity ?? 50) / 50; const env = 1 - Math.abs(p - 0.5) * 2; return { hud: true, hudFlicker: 0.6 + 0.4 * env, glow: 8 * env * k }; },
    // Grid Flash: brief scanline burst filling the canvas.
    gridFlash(p, sig, params) { const k = (params?.intensity ?? 50) / 50; return { scanBoost: 0.9 * k, flash: "#fff", flashA: 0.12 * k * (1 - p) }; },
    // Terminal Blink: on/off opacity toggle at 8Hz.
    terminalBlink(p, sig, params) { const k = (params?.intensity ?? 50) / 50; const on = Math.floor(p * 8) % 2 === 0; return { opacity: on ? 1 : (1 - 0.85 * k) }; },
    // Signal Drop: hard opacity cut like a bad feed, plus small RGB kick.
    signalDrop(p, sig, params) { const k = (params?.intensity ?? 50) / 50; const drop = p > 0.2 && p < 0.7; return { opacity: drop ? (1 - 0.9 * k) : 1, rgb: drop ? 4 * k : 0, flash: drop ? "#000" : null, flashA: drop ? 0.08 * k : 0 }; },
    // Magnetic Snap: quick offset then springs back to center.
    magneticSnap(p, sig, params) { const k = (params?.intensity ?? 50) / 50; const dir = (params?.direction ?? 0) === 0 ? 1 : -1; const amt = (1 - p) * 4 * k * dir; return { tx: amt }; },
    // Phase Shift: RGB channel wobble suggesting an out-of-phase signal.
    phaseShift(p, sig, params) { const k = (params?.intensity ?? 50) / 50; return { rgb: 6 * Math.abs(Math.sin(p * Math.PI * 3)) * k }; },
    // Data Scramble: heavy breakup + noise burst.
    dataScramble(p, sig, params) { const k = (params?.intensity ?? 50) / 50; return { breakup: 0.9 * k, rgb: 3 * k, opacity: Math.random() < 0.15 ? 0.6 : 1 }; },
    // Line Trace: draws SVG strokes progressively (path-draw event).
    lineTrace(p, sig, params) { const k = (params?.intensity ?? 50) / 50; return { pathDraw: p, glow: 6 * k }; },
    // Vector Lock: brief scale lock — small shrink then return, plus HUD flash.
    vectorLock(p, sig, params) { const k = (params?.intensity ?? 50) / 50; const shrink = 1 - 0.06 * k * (1 - Math.abs(p - 0.5) * 2); return { scaleSafe: shrink, hud: true, hudFlicker: 1 }; },
    // Target Ping: radial pulse from the layer center — rendered as glow ring.
    targetPing(p, sig, params) { const k = (params?.intensity ?? 50) / 50; return { targetPing: p, glow: 6 * k * (1 - p) }; },
    // Frequency Jump: fast opacity spike train (strobe-lite).
    frequencyJump(p, sig, params) { const k = (params?.intensity ?? 50) / 50; const on = Math.floor(p * 14) % 2 === 0; return { opacity: on ? 1 : (1 - 0.7 * k), rgb: on ? 0 : 2 * k }; },
    // Waveform Burst: audio-reactive glow tied to bass/high.
    waveformBurst(p, sig, params) { const k = (params?.intensity ?? 50) / 50; return { glow: (6 + sig.bass * 18 + sig.high * 8) * k * (1 - p) }; },
    // Micro Zoom Pop: subtle scale bump (2-3%).
    microZoomPop(p, sig, params) { const k = (params?.intensity ?? 50) / 50; const bump = 1 + 0.025 * k * (1 - Math.abs(p - 0.5) * 2); return { scaleSafe: bump }; },
    // Digital Tear: horizontal slice offset — signaled to renderer via `tear`.
    digitalTear(p, sig, params) { const k = (params?.intensity ?? 50) / 50; return { tear: k * (1 - Math.abs(p - 0.5) * 2), rgb: 2 * k }; },
    // Sync Flash: single frame full-canvas white flash.
    syncFlash(p, sig, params) { const k = (params?.intensity ?? 50) / 50; return { flash: "#fff", flashA: 0.6 * k * (1 - p) }; },
    // Scanline Surge: strong scanline overlay during clip.
    scanlineSurge(p, sig, params) { const k = (params?.intensity ?? 50) / 50; return { scanBoost: 0.7 * k * (0.6 + 0.4 * Math.sin(p * 8)) }; },
    // Noise Gate: opacity is gated (on/off) based on audio noise / random.
    noiseGate(p, sig, params) { const k = (params?.intensity ?? 50) / 50; const gate = Math.random() < 0.35; return { opacity: gate ? (1 - 0.6 * k) : 1 }; },
    // Ghost Frame: brief double exposure (rendered via layerSwap channel).
    ghostFrame(p, sig, params) { const k = (params?.intensity ?? 50) / 50; return { ghost: 0.5 * k * (1 - Math.abs(p - 0.5) * 2), opacity: 1 }; },
    // Coordinate Shift: small stepped position shift with HUD readout blink.
    coordShift(p, sig, params) { const k = (params?.intensity ?? 50) / 50; const dir = (params?.direction ?? 0) === 0 ? 1 : -1; return { tx: 2 * k * dir * Math.sign(Math.sin(p * Math.PI * 2)), hud: true, hudFlicker: 0.8 }; },

    /* ---- HIGH-END EVENTS ---------------------------------------------
       These return both a MARKER object (lostSignal / vectorBeam) that
       drawExportFrame reads to run its full pixel-accurate render, AND
       lightweight generic channels (tx/ty/opacity/rgb/flash/glow) that
       give the DOM preview a visible approximation while paused/playing
       — without a preview canvas overlay. */

    // LOST SIGNAL — local data corruption anchored to the layer.  The
    // entire layer must NOT move / rotate / scale by default: at
    // anchorStability=100 (the default) tx=ty=0 and there is zero
    // whole-layer wiggle.  All distortion is local, applied per-slice by
    // drawLostSignalLayer.  The DOM preview shows a chromatic-aberration
    // hint via the rgb channel; the export/canvas render is the ground
    // truth.
    lostSignal(p, sig, params) {
      const P = params || {};
      const intensity = (P.intensity ?? 70) / 100;
      // Envelope: fast attack, unstable middle, quick recovery.
      let envelope;
      if      (p < 0.12) envelope = p / 0.12;                  // attack
      else if (p < 0.78) envelope = 1;                          // sustain
      else               envelope = Math.max(0, 1 - (p - 0.78) / 0.22); // release
      const mag = intensity * envelope;

      // Anchor stability: 100 = zero global movement (default).  Only
      // when the user explicitly lowers this do we allow *extremely
      // subtle* horizontal wiggle — never vertical.
      const anchor = clamp01((P.anchorStability ?? 100) / 100);
      const wiggle = (1 - anchor) * mag;                        // 0..1

      return {
        // Marker consumed by drawLostSignalLayer (canvas render):
        lostSignal: {
          p, intensity, envelope, mag,
          rgbSep:     clamp01((P.rgbSeparation ?? 55) / 100),
          sliceCount: Math.max(2, Math.round(P.sliceCount ?? 14)),
          sliceDisp:  clamp01((P.sliceDisplacement ?? 24) / 100),
          corruption: clamp01((P.corruptionAmount ?? 65) / 100),
          direction:  P.corruptionDirection ?? "right",
          rightBias:  clamp01((P.rightBias ?? 85) / 100),
          leakage:    clamp01((P.dataLeakage ?? 55) / 100),
          leakageLen: clamp01((P.leakageLength ?? 38) / 100),
          leakageDen: clamp01((P.leakageDensity ?? 35) / 100),
          randomness: clamp01((P.randomness ?? 55) / 100),
          anchor,
        },
        // DOM preview: chromatic-aberration hint via the shared `rgb`
        // channel (drop-shadow on layer.wrap — does NOT move the layer).
        // We deliberately return NO tx/ty/blur/opacity so the layer's
        // anchor stays visually locked while paused or playing.
        rgb: clamp01((P.rgbSeparation ?? 55) / 100) * mag * 3,
        // Optional horizontal wiggle only when anchorStability < 100.
        // Uses seededRand so preview and export match at the same time.
        tx: wiggle * (seededRand((p * 1000) | 0) - 0.5) * 0.6,
      };
    },

    // VECTOR BEAM — directional beam projected from the layer edge,
    // trails, glow, hard freeze.  Marker read by drawExportFrame.
    vectorBeam(p, sig, params) {
      const P = params || {};
      const intensity = (P.intensity ?? 75) / 100;
      // Growth/freeze split: last 15% of window holds a locked beam.
      const growthEnd = 0.85;
      let growth;
      if (p < growthEnd) {
        const t = p / growthEnd;
        growth = (P.growthEasing === "ease") ? (1 - Math.pow(1 - t, 3)) : t;
      } else { growth = 1; }
      // Ignition flash: brief full-canvas white burst at start (~0.15).
      const flashP = clamp01((0.15 - p) / 0.15);
      const flashAmt = (P.sourceFlash ?? 45) / 100;
      return {
        vectorBeam: {
          p, intensity, growth,
          direction:   P.direction   ?? "right",
          beamLength:  (P.beamLength ?? 100) / 100,
          beamWidth:   P.beamWidth   ?? 8,
          trailCount:  P.trailCount  ?? 4,
          trailOpacity:(P.trailOpacity ?? 55) / 100,
          trailSpread: P.trailSpread ?? 10,
          glowStrength:P.glowStrength?? 20,
          flickerAmt:  (P.flickerAmount ?? 25) / 100,
        },
        // DOM-preview approximation: ignition flash + short layer glow.
        flash: flashP > 0 ? "#fff" : null,
        flashA: flashP * flashAmt * 0.18,
        glow: intensity * (0.5 + flashP * 0.5) * 14,
      };
    },

    // v19.8 VECTOR EFFECTS — return a shapeStyle delta object that
    // composeLayer accumulates and applyShapeStyleDelta writes to the
    // primitive.  Works uniformly on native SHAPE layers and imported
    // SVG (any element supporting SVG stroke/fill).

    // Stroke Width Pulse: the stroke thickness swells during the clip.
    //  - Envelope: rise → peak → fall (triangular by default), so the
    //    animation reads clearly on lines and outlined shapes.
    //  - Multiplier applied to whatever the shape's base stroke width
    //    is — a 4px line at intensity=60 pulses to 4 + 4×0.6×envelope.
    //  - Reads (params?.intensity ?? 60) / 100.  No color.
    strokeWidthPulse(p, sig, params) {
      const k = ((params?.intensity ?? 60) / 100);
      // Triangular envelope: 0 at p=0/1, 1 at p=0.5.  Adds a beat-audio
      // boost so audio-driven scenes get an extra kick at peaks.
      const env = 1 - Math.abs(p - 0.5) * 2;
      const audioBoost = (sig && sig.peak) ? sig.peak * 0.4 : 0;
      const mul = 1 + (env * k * 4) + audioBoost * k;   // up to ~5× at max
      return { shapeStyle: { strokeWidthMul: mul } };
    },

    // Fill Color Flash: the shape's fill briefly changes to `params.color`
    // during the clip.  The alpha of the override ramps up to peak then
    // back down, so the flash is momentary rather than a hard swap.
    //  - Color param is user-editable per clip (renderClipInspector
    //    picks up p.color and shows a color picker).
    //  - opacity delta uses fillOpacity so it composites naturally with
    //    the layer's own opacity.
    fillColorFlash(p, sig, params) {
      const k = ((params?.intensity ?? 70) / 100);
      const env = 1 - Math.abs(p - 0.5) * 2;   // triangular
      const color = params && params.color ? params.color : "#FF3366";
      // fillOpacity ramps 0 → k → 0 across the clip.  When k=0.7 at
      // peak, the flash is ~70% coverage — visible but not fully
      // opaque, so the underlying artwork is still readable.
      return { shapeStyle: { fillColor: color, fillOpacity: env * k } };
    },

    // v19.9 Shape Morph.  Emits a morph marker that composeLayer picks
    // up; the actual path interpolation happens in applyMorph (which
    // has access to `layers` for the target lookup).  Intensity controls
    // how far along the morph goes at peak — 100 = full morph reached
    // at p=1, 50 = only half the transformation is visible.
    shapeMorph(p, sig, params) {
      const k = ((params?.intensity ?? 100) / 100);
      return {
        morph: {
          targetLayerId: params?.morphTargetLayerId ?? 0,
          targetIndex:   params?.morphTargetIndex   ?? 0,
          progress: p * k,
        },
      };
    },

    // v19.12 Fill Reveal.  Returns a fillReveal marker describing the
    // mode + progress; composeLayer collects it and applyFillReveal
    // sets the layer wrap's clip-path.  Uses clip-path (not opacity)
    // so fills / gradients / colors are preserved exactly — the
    // artwork looks like it's being uncovered, not fading in.
    fillReveal(p, sig, params) {
      const k = ((params?.intensity ?? 100) / 100);
      // Ease progress slightly so the reveal feels smoother than a
      // pure linear wipe.  Bias k so intensity=50 reveals halfway
      // and intensity=100 reaches the full artwork at p=1.
      const eased = 1 - Math.pow(1 - Math.max(0, Math.min(1, p)), 2);  // ease-out quad
      return {
        fillReveal: {
          direction: (params && params.direction) || "left",
          progress: eased * k,
        },
      };
    },

    // v19.14 SEGMENT REVEAL.  Emits a marker with the mode + progress
    // + spread; applySegmentReveal orders the layer's primitives per
    // mode and computes per-element opacity from a staggered progress
    // ramp.  Ease-out cubic per element makes the pop-in feel snappy.
    segmentReveal(p, sig, params) {
      const k = ((params?.intensity ?? 100) / 100);
      const mode = (params && params.mode) || "sequential";
      // Spread of 0 collapses to one simultaneous reveal.  100 spaces
      // reveals across the whole clip window with no overlap.
      const spread = ((params && params.spread) !== undefined ? params.spread : 60) / 100;
      const seed = (params && params.seed) || 1;
      return {
        segmentReveal: {
          mode,
          progress: Math.max(0, Math.min(1, p)) * k,
          spread,
          seed,
        },
      };
    },

    // v19.14 EXPANSION BUILD (v19.15 cinematic redesign).
    //  Grows the layer to a large user-defined multiplier (up to 100x)
    //  so the artwork transforms into a full-screen visual field
    //  rather than merely filling the frame.  Origin controls whether
    //  the growth focal point is the layer's own center (cinematic
    //  zoom-in) or the canvas center (position-anchored zoom).  Ease
    //  profiles include easeInQuint for "held still, then explodes"
    //  timing.  Optional cross-effects (fade / rotate / blur) compose
    //  with the base scale; `explosive` mode enables all three.
    expansionBuild(p, sig, params) {
      const k = ((params?.intensity ?? 100) / 100);
      const t = Math.max(0, Math.min(1, p));
      const mode = (params && params.mode) || "expand";
      const easeMode = (params && params.ease) || "easeIn";
      const easedT = (
        easeMode === "linear"       ? t :
        easeMode === "easeOut"      ? 1 - Math.pow(1 - t, 3) :
        easeMode === "easeInOut"    ? (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2) :
        easeMode === "easeInQuint"  ? t * t * t * t * t :        // "explosive" — held then rockets
        /* easeIn (default) */        t * t * t
      );
      return {
        expansion: {
          progress: easedT * k,
          mode,
          userTargetScale: (params && params.targetScale) || 20,
          origin: (params && params.origin) || "object-center",
          rotateAmount: (params && params.rotateAmount) || 0,
          blurAmount:   (params && params.blurAmount)   || 0,
        },
      };
    },
  };

  // For each event key, which live layer field it modifies (used to
  // reset state cleanly when the event ends).
  function activeEventClipsAt(layer, t) {
    if (!layer.clips || !layer.clips.length) return [];
    const layerStart = layer.start;
    const out = [];
    for (const c of layer.clips) {
      if (c.enabled === false) continue; // disabled clip: still visible on timeline, no effect
      const s = layerStart + c.start, e = s + c.duration;
      if (t >= s && t <= e) {
        // Active — normal progress computation.
        out.push({ c, p: clamp01((t - s) / Math.max(0.001, c.duration)) });
      } else if (t > e) {
        // v19.34: after a clip ends, if it's a persistEnd effect, keep
        // it in the pipeline at p=1.0 so its final state persists.
        // Only within the layer's own visible window — outside the
        // layer's start+duration the layer itself is hidden anyway.
        const def = FX_EVENT_DEF.get(c.fxKey);
        if (def && def.persistEnd && t <= layerStart + layer.duration + 0.001) {
          out.push({ c, p: 1 });
        }
      }
    }
    return out;
  }

  /* ============ VIDEO / TIMELINE SYNC (Phase 2) ================
     One pure function is the source of truth for "what source-media
     time does this layer show at timeline time t?".  Both preview and
     export call it, guaranteeing the two paths agree.

     Phase 2: layer.speed defaults to 1, so this is simple linear
     mapping with clamping to the trim range.  Phase 3 will let users
     move the multiplier.  Phase 4 will swap the linear factor for the
     integrated speed curve.  No other code needs to change for those
     phases — everything downstream calls this function. */
  function sourceTimeAt(layer, t) {
    const inPt  = layer.srcInPoint  || 0;
    const outPt = (layer.srcOutPoint != null) ? layer.srcOutPoint : (layer.videoDuration || 0);
    const speed = layer.speed || 1;
    const src   = inPt + Math.max(0, t - layer.start) * speed;
    // Freeze on the trimmed-out frame if the layer outlives the source.
    return Math.min(Math.max(src, inPt), Math.max(inPt, outPt - 0.001));
  }

  /* Preview sync — hybrid strategy per the design doc:
     - Timeline playing, within 100ms drift: let native <video> playback advance.
     - Drift > 100ms (scrub, jump, initial): hard-seek.
     - Timeline paused: hard-seek + pause the video.
     Fire-and-forget on preview to keep scrubbing snappy; the video
     element updates its displayed frame when the seek completes. */
  const VIDEO_DRIFT_TOL = 0.10;   // 100ms
  /* v19.37 seek coalescing state.  Per-layer bookkeeping to prevent
   * currentTime spam during rapid scrubbing.  Without this, every
   * mousemove writes a new currentTime and cancels the in-flight
   * decode, so the video appears frozen or shows stale frames. */
  function _videoState(layer) {
    if (!layer._vidCoalesce) layer._vidCoalesce = { pending: null, seeking: false, lastAppliedT: -1 };
    return layer._vidCoalesce;
  }
  /* Global scrubbing hint — set by the timeline scrub handlers.
   * When true, video sync uses coarse/fast seeking (fastSeek where
   * available, coalesced enqueue).  On release, one accurate seek
   * lands us on the exact target frame. */
  const SCRUB = { active: false };
  function syncVideoLayerToTimeline(layer, t, playing) {
    const v = layer.videoEl;
    if (!v || v.readyState < 2) return;   // metadata not decoded yet
    const active = layer.visible && t >= layer.start - 0.001 && t <= layer.start + layer.duration + 0.001;
    if (!active) { if (!v.paused) { try { v.pause(); } catch (e) {} } return; }
    const desired = sourceTimeAt(layer, t);
    const drift   = Math.abs(v.currentTime - desired);
    if (playing) {
      // Playback: only nudge when drift exceeds tolerance; otherwise
      // let the video play through naturally.
      if (drift > VIDEO_DRIFT_TOL) {
        try { v.currentTime = desired; } catch (e) {}
      }
      if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
      return;
    }
    // Paused/scrubbing.  Make sure we're paused.
    if (!v.paused) { try { v.pause(); } catch (e) {} }
    // v19.37: L-Low throttles legacy video sync during scrub too — cap
    // seek rate to ~15/s to avoid drowning the decoder.
    if (SCRUB.active && STATE.previewQuality === "low") {
      const now = performance.now();
      if (layer._lastLowSyncMs && now - layer._lastLowSyncMs < 66) return;
      layer._lastLowSyncMs = now;
    }
    if (drift < 0.02) return;   // already at target
    const state = _videoState(layer);
    if (SCRUB.active) {
      // Coalesce: remember the newest target, fire one seek at a time.
      state.pending = desired;
      if (!state.seeking) {
        state.seeking = true;
        const flush = () => {
          if (state.pending == null) { state.seeking = false; return; }
          const target = state.pending; state.pending = null;
          // fastSeek jumps to the nearest keyframe — faster and more
          // scrub-appropriate than currentTime = (which requests exact
          // frame decode).  Fall back to currentTime when unsupported.
          try {
            if (typeof v.fastSeek === "function") v.fastSeek(target);
            else v.currentTime = target;
          } catch (e) { state.seeking = false; return; }
          // Wait for seeked (or a timeout) then flush the newest target.
          const onSeeked = () => {
            v.removeEventListener("seeked", onSeeked);
            clearTimeout(guard);
            flush();
          };
          v.addEventListener("seeked", onSeeked);
          const guard = setTimeout(() => {
            v.removeEventListener("seeked", onSeeked);
            state.seeking = false;
          }, 250);
        };
        flush();
      }
      return;
    }
    // Not scrubbing — one accurate seek.
    state.pending = null;
    try { v.currentTime = desired; } catch (e) {}
  }

  /* Path B — per-frame video sync for WebCodecs-backed layers.
     Draws the frame at sourceTimeAt(layer, t) into the layer's canvas
     if it's cached; otherwise kicks off an async decode and leaves
     the canvas showing the previously-drawn frame (no flash).  A
     small speculative prefetch (~0.5s ahead) keeps the cache warm
     during playback so sync-cached hits dominate. */
  function paintVideoLayer_WebCodecs(layer, t) {
    if (!layer.videoSource || !layer.node) return;
    const active = layer.visible && t >= layer.start - 0.001 && t <= layer.start + layer.duration + 0.001;
    if (!active) {
      // v19.39: also pause the native preview when the layer is out of
      // its active timeline range or hidden, so a shifted layer doesn't
      // keep decoding in the background.
      const pv = layer._previewVideoEl;
      if (pv && !pv.paused) { try { pv.pause(); } catch (e) {} }
      return;
    }
    // v19.38 per-layer draw counter for playback perf diagnosis.
    if (!layer._drawStats) layer._drawStats = { draws: 0, skipped_dup: 0, requested: 0, waited: 0, prefetched: 0, native_draws: 0 };
    // v19.37 → v19.38: L-Low throttling now applies to BOTH scrub and
    // playback (playback: ~30fps cap instead of RAF's 60).
    if (STATE.previewQuality === "low") {
      const now = performance.now();
      const minGap = SCRUB.active ? 66 : 33;
      if (layer._lastLowPaintMs && now - layer._lastLowPaintMs < minGap) return;
      layer._lastLowPaintMs = now;
    }
    const tSource = sourceTimeAt(layer, t);
    const state = _videoState(layer);

    // v19.39 HYBRID PLAYBACK PATH.  During normal playback, use the
    // native <video> element for smooth sequential decode.  Retains
    // WebCodecs for the paused/scrub/export paths (below).  Rationale:
    // native HTMLVideoElement uses the browser's optimized media
    // pipeline (hardware decoding, frame-pacing, dropped-frame budget)
    // which reliably delivers source-rate playback for typical H.264
    // content on all platforms — WebCodecs random-access frame
    // fetching has too much per-frame latency for smooth 30-60fps
    // playback of 1080p+ sources.
    const pv = layer._previewVideoEl;
    if (STATE.playing && !SCRUB.active && pv && pv.readyState >= 2) {
      // Sync currentTime if we've drifted (initial play, seek, loop).
      const drift = Math.abs(pv.currentTime - tSource);
      if (drift > 0.20) {
        try { pv.currentTime = tSource; } catch (e) {}
      }
      // Play if paused (initial play / resume after pause).  Muted so
      // audio never duplicates through the video element — music
      // playback is owned by the AudioContext mixer.
      if (pv.paused) {
        try { pv.muted = true; const pr = pv.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) {}
      }
      // Draw the current frame the browser is displaying internally.
      // No decoded frame lookup, no async wait — the frame is already
      // rasterized and drawImage samples it immediately.
      try {
        const ctx = layer.node.getContext("2d");
        ctx.drawImage(pv, 0, 0, layer.node.width, layer.node.height);
        state.lastAppliedT = tSource;
        layer._drawStats.native_draws++;
        layer._drawStats.draws++;
      } catch (e) {}
      return;
    }

    // Not playing (paused) or scrubbing.  Pause the native preview so
    // it stops eating decode budget.
    if (pv && !pv.paused) { try { pv.pause(); } catch (e) {} }

    // v19.37: skip redraw if we've already drawn this exact frame time.
    if (Math.abs((state.lastAppliedT ?? -1) - tSource) < 1e-4) { layer._drawStats.skipped_dup++; return; }

    const src = layer.videoSource;
    const srcFR = src.frameRate || 30;
    const cached = src.getFrameSyncIfCached(tSource);

    if (cached) {
      try {
        const ctx = layer.node.getContext("2d");
        ctx.drawImage(cached, 0, 0, layer.node.width, layer.node.height);
        state.lastAppliedT = tSource;
        layer._drawStats.draws++;
      } catch (e) {}
      return;
    }

    // Cache miss.
    layer._drawStats.waited++;

    if (SCRUB.active) {
      // v19.37 scrub path — coalesce, keep only newest target.
      state.pending = tSource;
      if (!state.seeking) {
        state.seeking = true;
        const flush = () => {
          if (state.pending == null) { state.seeking = false; return; }
          const target = state.pending; state.pending = null;
          src.getFrameAtSourceTime(target).then((f) => {
            if (!layer.node || !layer.node.getContext) { state.seeking = false; return; }
            try {
              const ctx = layer.node.getContext("2d");
              ctx.drawImage(f, 0, 0, layer.node.width, layer.node.height);
              state.lastAppliedT = target;
              layer._drawStats.draws++;
            } catch (e) {}
            flush();
          }).catch(() => { state.seeking = false; });
        };
        flush();
      }
      return;
    }

    // Paused (not scrubbing, not cached).  Kick off a one-shot decode
    // for the current frame; dedup so we don't request the same idx
    // repeatedly across RAFs.  Result draws on the promise callback.
    if (!state.requestedIdx) state.requestedIdx = new Set();
    const targetIdx = Math.round(tSource * srcFR);
    if (!state.requestedIdx.has(targetIdx)) {
      state.requestedIdx.add(targetIdx);
      layer._drawStats.requested++;
      src.getFrameAtSourceTime(tSource).then((f) => {
        state.requestedIdx.delete(targetIdx);
        if (!layer.node || !layer.node.getContext) return;
        try {
          const ctx = layer.node.getContext("2d");
          ctx.drawImage(f, 0, 0, layer.node.width, layer.node.height);
          state.lastAppliedT = tSource;
          layer._drawStats.draws++;
        } catch (e) {}
      }).catch(() => { state.requestedIdx.delete(targetIdx); });
    }
  }

  // Dispatch to the right video-sync helper based on which decoder the layer uses.
  function syncOrPaintVideoLayer(layer, t, playing) {
    if (layer.videoSource)      paintVideoLayer_WebCodecs(layer, t);
    else if (layer.videoEl)     syncVideoLayerToTimeline(layer, t, playing);
  }

  /* Export sync — async, deterministic.  Waits for the frame to be
     displayable before returning, so the next drawExportFrame call
     actually samples the seeked frame.  Prefers
     requestVideoFrameCallback (Chromium/Edge/Safari 16.4+) — precise
     "next painted frame" signal.  Falls back to 'seeked' + one RAF
     yield for any browser without rVFC. */
  function seekVideoLayerFor(layer, t) {
    const v = layer.videoEl;
    if (!v || v.readyState < 2) return Promise.resolve();
    if (!layer.visible) return Promise.resolve();
    if (t < layer.start - 0.001 || t > layer.start + layer.duration + 0.001) return Promise.resolve();
    const desired = sourceTimeAt(layer, t);
    if (Math.abs(v.currentTime - desired) < 1/240) return Promise.resolve();   // already there
    // rVFC path (preferred)
    if (typeof v.requestVideoFrameCallback === "function") {
      return new Promise((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; resolve(); };
        try { v.requestVideoFrameCallback(finish); } catch (e) { finish(); return; }
        try { v.currentTime = desired; } catch (e) { finish(); return; }
        setTimeout(finish, 500);   // hard timeout guard
      });
    }
    // seeked + RAF fallback
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        v.removeEventListener("seeked", onSeeked);
        requestAnimationFrame(() => resolve());
      };
      const onSeeked = () => finish();
      v.addEventListener("seeked", onSeeked);
      try { v.currentTime = desired; } catch (e) { finish(); return; }
      setTimeout(finish, 500);
    });
  }
  async function seekAllVideoLayersTo(t) {
    const vids = layers.filter((L) => L.kind === "VIDEO" && L.videoEl);
    if (!vids.length) return;
    // Videos should be paused during export so playback can't advance
    // between seeks.  Safe to call pause() on already-paused videos.
    vids.forEach((L) => { try { L.videoEl.pause(); } catch (e) {} });
    await Promise.all(vids.map((L) => seekVideoLayerFor(L, t)));
  }

  /* ---- Playback-based export sync (Phase 2 fix) --------------------
     The per-frame `seekAllVideoLayersTo` approach above works for PNG
     sequences (which don't care how long each frame takes) but breaks
     WebM/MP4 exports.  MediaRecorder timestamps every captured frame
     at the wall-clock moment `requestFrame()` is called; per-frame
     seeks take 20-100ms each, so `requestFrame` fires at variable
     intervals, and the recorded video plays back at variable framerate
     (choppy / slow-motion / inconsistent).

     Fix: use native <video> playback during export.  Pre-seek to
     srcInPoint once, then let the browser's decoder advance the video
     naturally at real-time (matching the export loop's wall-clock
     pacing).  Per-frame overhead drops from 20-100ms to ~1ms — a
     drift check that almost always passes.  Same strategy the preview
     path already uses, so preview and export match. */

  /* Called ONCE before an export starts.  Sets each video's currentTime
     to its srcInPoint and pauses.  Awaits the frame-ready signal so
     the first drawn export frame is guaranteed correct. */
  async function initVideoLayersForExport() {
    const vids = layers.filter((L) => L.kind === "VIDEO" && L.videoEl);
    if (!vids.length) return;
    await Promise.all(vids.map((L) => new Promise((resolve) => {
      const v = L.videoEl;
      try { v.pause(); } catch (e) {}
      v.playbackRate = 1;   // Phase 2: always 1.  Phase 3 will vary this.
      const target = Math.max(0, L.srcInPoint || 0);
      if (v.readyState >= 2 && Math.abs(v.currentTime - target) < 1/240) { resolve(); return; }
      let done = false;
      const fin = () => { if (done) return; done = true; resolve(); };
      if (typeof v.requestVideoFrameCallback === "function") {
        try { v.requestVideoFrameCallback(fin); } catch (e) { fin(); return; }
      } else {
        v.addEventListener("seeked", fin, { once: true });
      }
      try { v.currentTime = target; } catch (e) { fin(); return; }
      setTimeout(fin, 800);
    })));
  }

  /* Called ONCE after the export loop ends.  Pauses every video and
     resets its position to the layer's srcInPoint so subsequent
     previews start fresh. */
  function finalizeVideoLayersAfterExport() {
    layers.forEach((L) => {
      if (L.kind !== "VIDEO") return;
      if (L.videoEl) {
        try { L.videoEl.pause(); } catch (e) {}
        try { L.videoEl.currentTime = L.srcInPoint || 0; } catch (e) {}
      }
      // v19.40: tear down the export-only paused HTMLVideoElement.
      // This is DISTINCT from _previewVideoEl (v19.39 preview path)
      // which must survive export and continue driving preview
      // playback.  We only remove the export-only fallback element.
      if (L._exportVideoEl) {
        try { L._exportVideoEl.pause(); } catch (e) {}
        try { L._exportVideoEl.removeAttribute("src"); L._exportVideoEl.load(); } catch (e) {}
        try { if (L._exportVideoEl.parentNode) L._exportVideoEl.parentNode.removeChild(L._exportVideoEl); } catch (e) {}
        L._exportVideoEl = null;
        // Do NOT revoke _previewVideoUrl here — the preview path still
        // needs it.  We only shared the URL with the export element.
      }
    });
  }

  /* Called on EVERY export loop iteration.  Cheap when the videos are
     already playing at the right rate (which is the common case,
     because the export loop is wall-clock-paced and video playback
     advances at wall-clock 1x).  Only performs an async seek when a
     layer's window is being entered/exited or when drift exceeds the
     tolerance.  Returns a Promise that resolves immediately when no
     seek is required. */
  // Larger tolerance during export than during preview.  Each corrective
  // seek costs 20-100 ms of wall-clock time, and MediaRecorder-based
  // export uses wall-clock as its frame-timestamp clock; excessive
  // corrective seeks inflate the recorded duration beyond the target.
  // 300 ms is one to three source frames at 30 fps — still tight enough
  // that any perceptible drift gets corrected, but loose enough that
  // routine playback jitter doesn't trigger a seek.
  const EXPORT_DRIFT_TOL = 0.30;   // 300ms
  function driveVideoLayersRealtime(t) {
    const vids = layers.filter((L) => L.kind === "VIDEO" && L.videoEl && L.visible);
    if (!vids.length) return Promise.resolve();
    const awaits = [];
    for (const L of vids) {
      const v = L.videoEl;
      const inWindow = t >= L.start - 0.001 && t <= L.start + L.duration + 0.001;
      if (!inWindow) {
        if (!v.paused) { try { v.pause(); } catch (e) {} }
        continue;
      }
      const desired = sourceTimeAt(L, t);
      if (v.paused) {
        // Entering the layer's window — align + play.  If we're already
        // very close (pre-seek did the work), start playing immediately;
        // otherwise seek first, then play in the seek callback.
        if (Math.abs(v.currentTime - desired) < 0.02) {
          const p = v.play(); if (p && p.catch) p.catch(() => {});
        } else {
          awaits.push(new Promise((resolve) => {
            let done = false;
            const fin = () => { if (done) return; done = true; const pp = v.play(); if (pp && pp.catch) pp.catch(() => {}); resolve(); };
            if (typeof v.requestVideoFrameCallback === "function") {
              try { v.requestVideoFrameCallback(fin); } catch (e) { fin(); return; }
            } else {
              v.addEventListener("seeked", fin, { once: true });
            }
            try { v.currentTime = desired; } catch (e) { fin(); return; }
            setTimeout(fin, 500);
          }));
        }
      } else {
        // Playing normally — only correct large drift.
        const drift = Math.abs(v.currentTime - desired);
        if (drift > EXPORT_DRIFT_TOL) {
          awaits.push(new Promise((resolve) => {
            let done = false;
            const fin = () => { if (done) return; done = true; resolve(); };
            if (typeof v.requestVideoFrameCallback === "function") {
              try { v.requestVideoFrameCallback(fin); } catch (e) { fin(); return; }
            } else {
              v.addEventListener("seeked", fin, { once: true });
            }
            try { v.currentTime = desired; } catch (e) { fin(); return; }
            setTimeout(fin, 500);
          }));
        }
      }
    }
    return awaits.length ? Promise.all(awaits) : Promise.resolve();
  }

  /* Path B — WebCodecs layer export sync.  Called on every export loop
     iteration alongside driveVideoLayersRealtime (which is a no-op for
     WebCodecs layers because layer.videoEl is null).  This is where
     the WebCodecs canvas actually gets its frame content for export.

     For each in-window WebCodecs video layer:
       - Compute tSource = sourceTimeAt(layer, t)
       - Cache hit → draw immediately (microseconds)
       - Cache miss → await one decode, draw when it arrives
     Speculative prefetch decodes ~0.5s ahead so subsequent frames hit
     the cache.  Skipped when the loop is behind wall-clock (see the
     export loop for details).  */
  /* v19.40 export-only paused HTMLVideoElement fallback.
   *
   * When WebCodecs fails to deliver a frame for a specific export
   * time (decode timeout, unrecoverable pts drift, codec quirk near
   * EOS), the exporter transparently falls through to a paused
   * HTMLVideoElement.  It seeks to the exact requested source time,
   * waits for the frame to be displayable, draws it into the layer's
   * export canvas, then keeps the element paused.
   *
   *   - Separate from layer._previewVideoEl.  Preview element stays
   *     untouched so v19.39 playback behavior is unaffected.
   *   - Reuses the preview blob URL when available so we don't
   *     double-buffer the underlying bytes.
   *   - Never played (playbackRate=0-safe, only currentTime writes).
   *   - Torn down in finalizeVideoLayersAfterExport.
   */
  async function _ensureExportFallbackVideo(layer) {
    if (layer._exportVideoEl) {
      // Wait for readyState if we're mid-load
      if (layer._exportVideoEl.readyState >= 1) return layer._exportVideoEl;
    } else {
      const url = layer._previewVideoUrl || layer.videoUrl;
      if (!url) return null;
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      v.crossOrigin = "anonymous";
      v.src = url;
      v.style.cssText = "position:absolute;left:-99999px;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none";
      document.body.appendChild(v);
      layer._exportVideoEl = v;
    }
    // Wait for loadedmetadata + first frame available.
    const v = layer._exportVideoEl;
    if (v.readyState < 2) {
      await new Promise((resolve) => {
        let done = false;
        const fin = () => { if (done) return; done = true; resolve(); };
        v.addEventListener("loadeddata", fin, { once: true });
        v.addEventListener("canplay", fin, { once: true });
        setTimeout(fin, 3000);
      });
    }
    return v;
  }

  /* Seek `_exportVideoEl` to tSource and await frame availability.
     Uses requestVideoFrameCallback when supported (fires when a NEW
     frame is on-screen, guaranteeing displayable content); falls back
     to `seeked` + one RAF otherwise.  Never plays. */
  async function _seekExportVideoTo(v, tSource) {
    if (!v || v.readyState < 1) return false;
    try { v.pause(); } catch (e) {}
    const target = Math.max(0, tSource);
    if (Math.abs(v.currentTime - target) < 1 / 240) return true;
    return await new Promise((resolve) => {
      let done = false;
      const fin = (ok) => { if (done) return; done = true; resolve(!!ok); };
      const useRVFC = typeof v.requestVideoFrameCallback === "function";
      if (useRVFC) {
        try { v.requestVideoFrameCallback(() => fin(true)); } catch (e) {}
      } else {
        v.addEventListener("seeked", () => fin(true), { once: true });
      }
      try { v.currentTime = target; } catch (e) { fin(false); return; }
      setTimeout(() => fin(v.readyState >= 2), 2000);
    });
  }

  async function paintWebCodecsLayersForExport(t) {
    const vids = layers.filter((L) => L.kind === "VIDEO" && L.videoSource && L.visible);
    if (!vids.length) return;
    await Promise.all(vids.map(async (L) => {
      const inWindow = t >= L.start - 0.001 && t <= L.start + L.duration + 0.001;
      if (!inWindow) return;
      // S2 — export uses a SEPARATE full-source-resolution canvas.
      if (!L._exportCanvas || L._exportCanvas.width !== L.natW || L._exportCanvas.height !== L.natH) {
        L._exportCanvas = document.createElement("canvas");
        L._exportCanvas.width  = L.natW;
        L._exportCanvas.height = L.natH;
      }
      // v19.40: clamp to the actual last decodable pts.  Requesting
      // exactly video.duration or beyond routinely hit the "no sample
      // matches" branch and hung the decode-wait — the exported clip
      // then froze on whatever the canvas last held for the remaining
      // frames.  Freezing to lastValidSourceTime holds the true final
      // frame instead.
      let tSource = sourceTimeAt(L, t);
      const lastValid = L.videoSource.lastValidSourceTime;
      if (lastValid > 0 && tSource > lastValid) tSource = lastValid;

      // Fast path: sync cache hit.
      let frame = L.videoSource.getFrameSyncIfCached(tSource);
      if (!frame) {
        try {
          // v19.40: 10s timeout for export path.  Long enough that even
          // deep decoder pipelines on long clips have room to catch up.
          frame = await L.videoSource.getFrameAtSourceTime(tSource, { timeoutMs: 10000 });
        }
        catch (e) {
          // v19.40: WebCodecs failed — fall through to the paused
          // HTMLVideoElement fallback.  This is the deterministic
          // fallback path required for codecs / edge cases where the
          // WebCodecs decoder can't deliver a specific frame.  We DO
          // NOT return here anymore — that was the v19.39 silent-skip
          // that caused missing tail frames.
          try {
            const fbV = await _ensureExportFallbackVideo(L);
            if (fbV) {
              const ok = await _seekExportVideoTo(fbV, tSource);
              if (ok && fbV.readyState >= 2) {
                try {
                  const ctx = L._exportCanvas.getContext("2d");
                  ctx.drawImage(fbV, 0, 0, L._exportCanvas.width, L._exportCanvas.height);
                } catch (e) {}
              }
            }
          } catch (e2) {}
          return;
        }
      }
      try {
        const ctx = L._exportCanvas.getContext("2d");
        ctx.drawImage(frame, 0, 0, L._exportCanvas.width, L._exportCanvas.height);
      } catch (e) {}
      // Prefetch a rolling window ahead of the current position.  Also
      // clamp so we don't chase a pts that doesn't exist.
      const srcOut = Math.min(L.srcOutPoint || L.videoDuration || 0, lastValid || Infinity);
      const ahead = tSource + 0.5;
      if (ahead < srcOut) L.videoSource.getFrameAtSourceTime(ahead).catch(() => {});
    }));
  }

  /* S2 — after rasterizeAll, redirect WebCodecs video layers'
     imgs[id] entries to point at their full-resolution export canvas
     rather than the preview-capped layer.node.  Called once at the
     top of each export loop, after `imgs = await rasterizeAll(...)`. */
  function redirectImgsToExportCanvases(imgs) {
    layers.forEach((L) => {
      if (L.kind !== "VIDEO" || !L.videoSource) return;
      if (!L._exportCanvas) {
        L._exportCanvas = document.createElement("canvas");
        L._exportCanvas.width  = L.natW;
        L._exportCanvas.height = L.natH;
      }
      imgs[L.id] = L._exportCanvas;
    });
  }

  /* v19.42: per-frame text FX + weird slice export hook.
   *
   * Runs on every export frame BEFORE drawExportFrame so the raster
   * source that drawExportFrame samples reflects the current frame's
   * text FX state (Scramble, Counter, Odometer, Bulk Typing) and any
   * active Weird slice compositing.  Without this, the export loop's
   * initial rasterizeAll would bake in the t=0 frame for the whole
   * export duration, freezing text FX.
   *
   * For text layers:
   *   1. Run applyTextFxAtTime(layer, t, sig) — updates SVG contents
   *      to reflect display-text at time t and applies DOM mutators.
   *   2. If any weirdGlitch clip is active on this text layer,
   *      applyWeirdSlicesOnText renders the current frame's slice
   *      composite into layer._weirdCanvas.  Point imgs[layer.id]
   *      at layer._weirdCanvas so the export samples the compositor.
   *   3. Otherwise, re-rasterize the text SVG so text FX state
   *      changes get picked up.  layerToImage returns a serialized
   *      SVG-based image; call it and cache in imgs.
   */
  async function updateTextLayersForExportFrame(imgs, t, W, H) {
    const sig = (typeof audioSignal === "function") ? audioSignal() : { bass:0, mid:0, high:0, level:0, beat:0, peak:0 };
    const textLayers = layers.filter((L) => L.kind === "TEXT" && L.visible);
    for (const L of textLayers) {
      const inWindow = t >= L.start - 0.001 && t <= L.start + L.duration + 0.001;
      if (!inWindow) continue;
      // 1. Run text FX (updates SVG + weird canvas).
      try { applyTextFxAtTime(L, t, sig); } catch (e) {}
      // 2. If weird is active on this layer, route imgs[L.id] at the
      // weird canvas so drawExportFrame samples the slice composite.
      if (L._weirdActive && L._weirdCanvas) {
        imgs[L.id] = L._weirdCanvas;
      } else if (imgs[L.id] && imgs[L.id] === L._weirdCanvas) {
        // Weird just ended — re-rasterize the SVG so imgs[L.id]
        // points back at a fresh raster.
        try { imgs[L.id] = await layerToImage(L, W, H); } catch (e) {}
      } else {
        // No weird active — re-rasterize the SVG so text FX state
        // changes get baked into the raster.  Otherwise the initial
        // rasterizeAll would freeze text FX at t=0.
        try { imgs[L.id] = await layerToImage(L, W, H); } catch (e) {}
      }
    }
  }

  /* ---------------- RENDER LOOP ---------------- */
  let rafStart = performance.now();
  let hudLayer = null, flashOverlay = null;
  function frame(now) {
    requestAnimationFrame(frame);
    analyzeAudio();
    if (!STATE.playing) { return; }
    const elapsed = (now - rafStart) / 1000;
    let wrapped = false;
    if (STATE.loop && STATE.duration > 0 && elapsed >= STATE.duration) {
      // wrap: reset rafStart so we don't run away, mark for audio re-sched
      rafStart = performance.now();
      wrapped = true;
    }
    STATE.time = STATE.loop ? (elapsed % STATE.duration) : Math.min(elapsed, STATE.duration);
    if (wrapped) {
      // restart music from start and re-schedule sfx from 0
      if (audio.ready) { try { audio.el.currentTime = 0; audio.el.play().catch(() => {}); } catch (e) {} }
      schedulePlayback(0);
    }
    const t = STATE.time, sig = audioSignal();
    let sceneScan = STATE.scanline / 100, sceneNoise = STATE.noise / 100, anyHud = false, hudFlicker = 1, anyFlash = null, flashA = 0;

    // Phase 2: keep every video layer's <video> element in sync with the
    // timeline BEFORE composeLayer runs (composeLayer applies CSS
    // transforms/filters but doesn't touch playback state).
    layers.forEach((layer) => { if (layer.kind === "VIDEO") syncOrPaintVideoLayer(layer, t, true); });

    layers.forEach((layer) => {
      if (!layer.wrap) return;
      const active = layer.visible && t >= layer.start - 0.001 && t <= layer.start + layer.duration + 0.001;
      if (!active) { layer.wrap.style.opacity = "0"; return; }
      const lt = t - layer.start + layer.recipe.delay;
      const r = composeLayer(layer, lt, sig, t);
      // v19.41: apply text-fx (Scramble, Bulk Typing, Counter,
      // Odometer, Stagger, SineWave, TextOnPath) AFTER composeLayer.
      // The engine rebuilds text SVG only when its display string
      // changes and mutates tspan attributes for DOM-level effects.
      // Original layer.textStyle.text is never mutated — always editable.
      if (layer.kind === "TEXT") applyTextFxAtTime(layer, t, sig);
      if (r.hud) { anyHud = true; hudFlicker = r.hudFlicker; }
      if (r.flash) { anyFlash = r.flash; flashA = r.flashA; }
      if (r.scanBoost) sceneScan = Math.min(1, sceneScan + r.scanBoost * 0.3);
      if (r.breakup) sceneNoise = Math.min(1, sceneNoise + r.breakup);
    });

    const scanFlicker = 0.8 + Math.sin(t * (6 + sig.high * 20)) * 0.2;
    el.artboard.style.setProperty("--scanline-op", sceneScan * scanFlicker * (1 + sig.high));
    el.artboard.style.setProperty("--noise-op", sceneNoise * (0.5 + Math.random() * 0.5) * (1 + sig.high * 1.5 + sig.peak));
    updateHud(anyHud, hudFlicker, t); updateFlash(anyFlash, flashA); updatePlayheads(t);
    if (selectedLayer) updateSelectionBox();
  }

  /* v18.7 unified clip effect evaluator.  Dispatches by the effect
     definition's `sustained` flag:
       - sustained clips use the legacy EFFECTS[key](sig, clipLocalTime)
         function (wall-clock-time style that evolves indefinitely).
       - event clips use EVENT_EFFECTS[key](p, sig, params) with p as
         normalized progress across the clip window.
     Returns the delta object `d` or null when the effect is gated off
     (transform-only effect on a non-allowTransform layer).
     `sceneTime` is the absolute timeline time; `p` is the normalized
     progress across this clip's window.
  */
  function evaluateClipDelta(clip, layer, sceneTime, p, sig, allowT) {
    const def = FX_EVENT_DEF.get(clip.fxKey);
    const isTransformOnly = FX_TRANSFORM.has(clip.fxKey);
    if (isTransformOnly && !allowT) return null;
    // v19.42: weirdGlitch on TEXT is fully handled by the canvas slice
    // compositor (applyWeirdSlicesOnText).  Return null here so the
    // DOM-level shake/rgb/flash deltas don't double up on the same
    // layer — the compositor renders shake, chroma, flash internally.
    // Non-text layers keep the delta path.
    if (clip.fxKey === "weirdGlitch" && layer && layer.kind === "TEXT") return null;
    if (def && def.sustained) {
      const mod = EFFECTS[clip.fxKey]; if (!mod) return null;
      const clipLocal = sceneTime - (layer.start + clip.start);
      // v19.42: pass clip.params to sustained handlers so effects like
      // weirdGlitch / rgbSplitPro receive their tuned params (previous
      // call was mod(sig, clipLocal) — params were undefined).
      return mod(sig, clipLocal, clip.params) || null;
    }
    const mod = EVENT_EFFECTS[clip.fxKey]; if (!mod) return null;
    return mod(p, sig, clip.params) || null;
  }

  function composeLayer(layer, t, sig, sceneTime) {
    const T = layer.transform;
    // static base transform (position/size/rotation set by user)
    let tx = 0, ty = 0, extraScale = 1, rot = 0, rotX = 0, rotY = 0, skew = 0;
    // v19.15: expansion origin translation — bypasses the
    // allowTransform gate that limits per-clip jitter.
    let expansionTx = 0, expansionTy = 0;
    let opacity = T.opacity / 100, blur = 0, rgb = 0, glow = 0;
    let hud = false, hudFlicker = 1, flash = null, flashA = 0, scanBoost = 0, breakup = 0;
    let pathDraw = null, pathTrim = null;
    let radarBar = null, scanMask = null, freeze = false;
    /* v19.8 shapeStyle delta channel.  Any event effect can contribute
       stroke/fill animations by returning `{ shapeStyle: { ... } }`.
       Merge semantics per axis:
         - strokeWidthDelta:  additive (Σ contributions)
         - strokeWidthMul:    multiplicative (Π contributions)
         - strokeColor:       latest wins (last active clip's color)
         - fillColor:         latest wins
         - strokeOpacity:     latest wins (0..1 override)
         - fillOpacity:       latest wins (0..1 override; used as alpha
                              for color-flash overlays, so multiplicative
                              would mask the flash — a single override
                              is the right semantic here)
       Kept null until at least one clip contributes, so `else if
       (_shapeStyleApplied) clearShapeStyleDelta(...)` fires when the
       last active clip ends and we can restore the base primitive. */
    let shapeStyleDelta = null;
    // v19.9: morph contribution (source→target path interp).  Only one
    // active morph clip is used per frame (latest wins in the loop).
    let morphContrib = null;
    // v19.12: fill-reveal contribution.  Latest-wins across clips —
    // stacking two reveal modes on the same layer isn't a useful
    // authoring pattern; the last-active clip's direction is used.
    let fillRevealContrib = null;
    // v19.14: segment-reveal + expansion contributions.  Both latest-wins.
    let segmentRevealContrib = null;
    let expansionContrib = null;
    const allowT = layer.allowTransform;

    // v18.7: layer.fx sustained-toggle system removed.  Every effect
    // is now a timeline clip.  The single loop below handles both
    // sustained-style clips (evaluated with wall-clock time via
    // EFFECTS[]) and event-style clips (evaluated with progress p via
    // EVENT_EFFECTS[]) through the unified evaluateClipDelta().

    // --- Event clips: apply modules that are currently within their window ---
    if (sceneTime !== undefined) {
      const active = activeEventClipsAt(layer, sceneTime);
      for (const { c, p } of active) {
        const d = evaluateClipDelta(c, layer, sceneTime, p, sig, allowT);
        if (!d) continue;
        // opacity mix: params.opacityMix (0-100) scales how much of the event's opacity effect is felt.
        const mix = c.params && c.params.opacityMix !== undefined ? c.params.opacityMix / 100 : 1;
        if (d.opacity !== undefined) { const eff = 1 - (1 - d.opacity) * mix; opacity *= eff; }
        if (d.opacityWave !== undefined) opacity *= d.opacityWave;
        if (d.blur) blur += d.blur;
        if (d.rgb) rgb = Math.max(rgb, d.rgb);
        if (d.glow) glow = Math.max(glow, d.glow);
        if (d.flash) { flash = d.flash; flashA = d.flashA; }
        if (d.scanBoost) scanBoost = Math.max(scanBoost, d.scanBoost);
        if (d.breakup) breakup = Math.max(breakup, d.breakup);
        if (d.hud) { hud = true; hudFlicker = d.hudFlicker; }
        if (d.pathDraw !== undefined) pathDraw = d.pathDraw;
        if (d.pathTrim !== undefined) pathTrim = d.pathTrim;
        if (d.radarBar !== undefined) radarBar = d.radarBar;
        if (d.scanMask !== undefined) scanMask = d.scanMask;
        if (d.freeze) freeze = true;
        // v19.8: shapeStyle delta accumulation.  Effects contribute a
        // partial delta object; we compose them per-axis so multiple
        // clips can animate the same shape simultaneously.
        if (d.shapeStyle) {
          if (!shapeStyleDelta) shapeStyleDelta = {};
          const ds = d.shapeStyle;
          if (ds.strokeWidthDelta !== undefined) shapeStyleDelta.strokeWidthDelta = (shapeStyleDelta.strokeWidthDelta || 0) + ds.strokeWidthDelta;
          if (ds.strokeWidthMul   !== undefined) shapeStyleDelta.strokeWidthMul   = (shapeStyleDelta.strokeWidthMul   || 1) * ds.strokeWidthMul;
          if (ds.strokeColor      !== undefined) shapeStyleDelta.strokeColor      = ds.strokeColor;
          if (ds.fillColor        !== undefined) shapeStyleDelta.fillColor        = ds.fillColor;
          if (ds.strokeOpacity    !== undefined) shapeStyleDelta.strokeOpacity    = ds.strokeOpacity;
          if (ds.fillOpacity      !== undefined) shapeStyleDelta.fillOpacity      = ds.fillOpacity;
        }
        // v19.9 Shape Morph — latest-wins across active clips.  Multiple
        // simultaneous morph clips on the same layer aren't a useful
        // authoring pattern; last one takes precedence.
        if (d.morph) morphContrib = d.morph;
        // v19.12 Fill Reveal — latest-wins across active clips.
        if (d.fillReveal) fillRevealContrib = d.fillReveal;
        // v19.14 Segment Reveal + Expansion — latest-wins.
        if (d.segmentReveal) segmentRevealContrib = d.segmentReveal;
        if (d.expansion)     expansionContrib     = d.expansion;
        // Event clips MAY move / scale / rotate the layer briefly even
        // when allowTransform is off (they're designed as short micro-
        // motions).
        if (d.tx) tx += d.tx;
        if (d.ty) ty += d.ty;
        if (d.rot) rot += d.rot;
        if (d.scaleSafe !== undefined) extraScale *= d.scaleSafe;
        // v18.7: migrated sustained effects (hologramTilt, digitalWave)
        // emit rotX/rotY/skew.  These are transform-gated at the
        // evaluator level (evaluateClipDelta returns null when a
        // transform-only effect fires on a non-allowTransform layer),
        // so it's safe to accumulate here without re-checking.
        if (d.rotX) rotX += d.rotX;
        if (d.rotY) rotY += d.rotY;
        if (d.skew) skew += d.skew;
        // New per-layer channels used by drawExportFrame:
        if (d.tear !== undefined) layer._tear = d.tear; else if (layer._tear !== undefined) layer._tear = 0;
        if (d.targetPing !== undefined) layer._targetPing = d.targetPing; else if (layer._targetPing !== undefined) layer._targetPing = null;
        if (d.ghost !== undefined) layer._ghost = d.ghost; else if (layer._ghost !== undefined) layer._ghost = 0;
        // High-end effect markers — the DOM preview can't render slices
        // or beams, so the base layer stays as-is here and the markers
        // are only consumed by the export/canvas renderer.
        if (d.lostSignal) layer._lostSignal = d.lostSignal;   else if (layer._lostSignal) layer._lostSignal = null;
        if (d.vectorBeam) layer._vectorBeam = d.vectorBeam;   else if (layer._vectorBeam) layer._vectorBeam = null;
      }
    }
    blur += (STATE.blur / 100) * 2;

    // v19.7: Path-based effects (Line Draw, Trim Paths, Path Energize)
    // now run on native SHAPE layers (rect/circle/ellipse/line/polygon)
    // as well as imported SVG.  The stroke-discovery selector already
    // includes all primitives; only the layer-kind gate needed
    // widening.  TEXT layers are excluded — <text> doesn't support
    // getTotalLength() and stroke-dash on text glyphs doesn't produce
    // the "hand-drawn" reveal effect users expect.
    const pathAnimatable = layer.kind === "SVG" || layer.kind === "SHAPE" || layer.kind === "GROUP";
    if (pathAnimatable && (pathDraw !== null || pathTrim !== null)) applyPathDash(layer, pathDraw, pathTrim);
    else if (pathAnimatable && layer._dashApplied) clearPathDash(layer);
    // v19.8 shapeStyle delta application.  Same layer-kind gate as
    // path-dash — SHAPE + SVG participate, TEXT does not.  Effects like
    // Stroke Width Pulse and Fill Color Flash reach the primitives via
    // applyShapeStyleDelta; clearShapeStyleDelta restores baseline when
    // no clip is currently contributing.
    if (pathAnimatable && shapeStyleDelta) applyShapeStyleDelta(layer, shapeStyleDelta);
    else if (pathAnimatable && layer._shapeStyleApplied) clearShapeStyleDelta(layer);
    // v19.9 Morph — same gate.  applyMorph handles source/target
    // compatibility internally and no-ops with a diagnostic on the
    // clip when incompatible.
    if (pathAnimatable && morphContrib) applyMorph(layer, morphContrib);
    else if (pathAnimatable && layer._morphApplied) clearMorph(layer);
    // v19.12 Fill Reveal — works on ANY layer with a wrap element,
    // including SVG imports, native shapes, text, and images.  Doesn't
    // require the pathAnimatable gate because it clips the wrap, not
    // primitives.  Restricting to the layer.wrap element preserves
    // fills / gradients / colors exactly.
    if (fillRevealContrib) applyFillReveal(layer, fillRevealContrib);
    else if (layer._fillRevealApplied) clearFillReveal(layer);
    // v19.14 Segment Reveal — per-primitive opacity animation.
    // Works on any layer whose SVG contains primitives (SHAPE + SVG + GROUP).
    if (segmentRevealContrib) applySegmentReveal(layer, segmentRevealContrib);
    else if (layer._segmentRevealApplied) clearSegmentReveal(layer);
    // v19.14 Expansion Build — fold scale/opacity/rot deltas into the
    // transform accumulators BEFORE the transform is written to the
    // DOM.  Works on every layer kind.
    if (expansionContrib) {
      const ed = computeExpansionDelta(layer, expansionContrib, STATE.format);
      extraScale *= ed.scaleSafe;
      opacity   *= ed.opacity;
      rot       += ed.rot;
      blur      += ed.blur;
      // Expansion's tx/ty must bypass the allowTransform gate — it's
      // an intentional camera/origin shift, not per-clip audio jitter.
      // Store separately from the general tx/ty accumulator.
      expansionTx = ed.tx;
      expansionTy = ed.ty;
    }

    // Scan mask (event-only): reveal from left as p goes 0->1
    if (scanMask !== null) { layer.wrap.style.clipPath = `inset(0 ${((1 - scanMask) * 100).toFixed(1)}% 0 0)`; layer._clipApplied = true; }
    else if (layer._clipApplied) { layer.wrap.style.clipPath = ""; layer._clipApplied = false; }

    // Frame Hold: skip transform update, keep whatever was on screen
    if (freeze) return { hud, hudFlicker, flash, flashA, scanBoost, breakup, radarBar };

    // artboard-space placement: size in %, center offset in %
    const A = STATE.format;
    // v19.17: GROUP transform uses natural-size wrap + CSS scale so
    // member wraps inside (which are absolutely positioned in group-
    // local canvas px) scale together as one visual unit.  Regular
    // layers keep the original width/height-based scaling.
    if (layer.kind === "GROUP") {
      // v19.20 (Option A′): member clips are SUSPENDED while grouped.
      // Members are removed from layers[] AND their clips array is
      // moved to _suspendedClips, so no per-member effect processing
      // is needed here.  Ungroup restores the suspended clips.
      // Rationale: attempting to run member clips while grouped led
      // to preview/export divergence (v19.18/19.19 tried the various
      // recursion approaches — each fixed one dimension while
      // breaking another).  Suspending is the honest v1 boundary.
      const natWpx = ((layer._groupNatWpct || T.wPct) / 100) * A.w;
      const natHpx = ((layer._groupNatHpct || T.hPct) / 100) * A.h;
      const scaleX = (T.wPct / (layer._groupNatWpct || T.wPct)) * extraScale;
      const scaleY = (T.hPct / (layer._groupNatHpct || T.hPct)) * extraScale;
      const gCxPx = (T.cx / 100) * A.w + (allowT ? (tx / 100) * A.w : 0) + (expansionTx / 100) * A.w;
      const gCyPx = (T.cy / 100) * A.h + (allowT ? (ty / 100) * A.h : 0) + (expansionTy / 100) * A.h;
      layer.wrap.style.width = natWpx + "px";
      layer.wrap.style.height = natHpx + "px";
      layer.wrap.style.left = (A.w / 2 + gCxPx - natWpx / 2) + "px";
      layer.wrap.style.top  = (A.h / 2 + gCyPx - natHpx / 2) + "px";
      layer.wrap.style.transformOrigin = "center center";
      layer.wrap.style.transform = `perspective(1000px) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)}) rotate(${(T.rot + rot).toFixed(2)}deg) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg) skewX(${skew.toFixed(2)}deg)`;
      layer.wrap.style.opacity = clamp01(opacity).toFixed(2);
      layer.wrap.style.filter = `blur(${blur.toFixed(2)}px) ` + (rgb ? `drop-shadow(${rgb.toFixed(1)}px 0 0 rgba(255,60,80,0.5)) drop-shadow(${(-rgb).toFixed(1)}px 0 0 rgba(60,180,255,0.5)) ` : "") + (glow ? `drop-shadow(0 0 ${glow.toFixed(1)}px rgba(122,92,255,0.6))` : "");
      updatePixelSweepPreview(layer, sceneTime);
      return { hud, hudFlicker, flash, flashA, scanBoost, breakup, radarBar };
    }
    const wPx = (T.wPct / 100) * A.w * extraScale, hPx = (T.hPct / 100) * A.h * extraScale;
    const cxPx = (T.cx / 100) * A.w + (allowT ? (tx / 100) * A.w : 0) + (expansionTx / 100) * A.w;
    const cyPx = (T.cy / 100) * A.h + (allowT ? (ty / 100) * A.h : 0) + (expansionTy / 100) * A.h;
    const leftPx = A.w / 2 + cxPx - wPx / 2, topPx = A.h / 2 + cyPx - hPx / 2;

    layer.wrap.style.width = wPx + "px"; layer.wrap.style.height = hPx + "px";
    layer.wrap.style.left = leftPx + "px"; layer.wrap.style.top = topPx + "px";
    layer.wrap.style.transformOrigin = "center center";
    layer.wrap.style.transform = `perspective(1000px) rotate(${(T.rot + rot).toFixed(2)}deg) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg) skewX(${skew.toFixed(2)}deg)`;
    layer.wrap.style.opacity = clamp01(opacity).toFixed(2);
    layer.wrap.style.filter = `blur(${blur.toFixed(2)}px) ` + (rgb ? `drop-shadow(${rgb.toFixed(1)}px 0 0 rgba(255,60,80,0.5)) drop-shadow(${(-rgb).toFixed(1)}px 0 0 rgba(60,180,255,0.5)) ` : "") + (glow ? `drop-shadow(0 0 ${glow.toFixed(1)}px rgba(122,92,255,0.6))` : "");

    if (layer.kind === "SVG" && layer.subLayers && layer.subLayers.length) animateSubLayers(layer, t, sig, allowT);
    // ---- PIXEL SWEEP preview overlay ----
    // If a pixelSweep clip is active at sceneTime, render an overlay
    // canvas on top of the layer's normal content.  Same processing
    // function that export uses, so preview == export.
    updatePixelSweepPreview(layer, sceneTime);
    return { hud, hudFlicker, flash, flashA, scanBoost, breakup, radarBar };
  }

  /* Manages the per-layer pixelSweep preview overlay canvas.
     - If there's an active pixelSweep clip at t: creates (once) an
       overlay canvas inside layer.wrap, populates it with the swept
       result, shows the overlay, hides the underlying layer node.
     - If no active clip: hides the overlay, restores the underlying
       layer node.
     Overlay uses `position:absolute; inset:0; width/height:100%` so
     it inherits layer.wrap's transform, opacity, and filter — the
     effect composites cleanly with all existing CSS effects. */
  function updatePixelSweepPreview(layer, t) {
    const clip = (t !== undefined) ? activePixelSweepAt(layer, t) : null;
    if (!clip) {
      // No active sweep: hide overlay if present, restore underlying node.
      if (layer._pixelSweepOverlay) {
        layer._pixelSweepOverlay.style.display = "none";
      }
      if (layer.node && layer._pixelSweepUnderlyingHidden) {
        layer.node.style.visibility = "";
        layer._pixelSweepUnderlyingHidden = false;
      }
      return;
    }
    // Active sweep: ensure overlay canvas exists.
    if (!layer._pixelSweepOverlay) {
      const c = document.createElement("canvas");
      c.className = "layer-pixel-sweep";
      c.style.position = "absolute";
      c.style.inset = "0";
      c.style.width = "100%";
      c.style.height = "100%";
      c.style.pointerEvents = "none";
      layer.wrap.appendChild(c);
      layer._pixelSweepOverlay = c;
    }
    const source = getLayerSourceCanvas(layer);
    if (!source) return;
    const sw = source.naturalWidth || source.videoWidth || source.width || layer.natW;
    const sh = source.naturalHeight || source.videoHeight || source.height || layer.natH;
    // Match overlay canvas resolution to the source so pixel sampling
    // is 1:1.  CSS then scales to layer.wrap.
    if (layer._pixelSweepOverlay.width !== sw) layer._pixelSweepOverlay.width = sw;
    if (layer._pixelSweepOverlay.height !== sh) layer._pixelSweepOverlay.height = sh;
    const progress = pixelSweepProgress(clip, layer, t);
    applyPixelSweep(source, { ...clip.params, progress }, layer._pixelSweepOverlay);
    layer._pixelSweepOverlay.style.display = "";
    // Hide the underlying layer node so we're only seeing the sweep.
    if (layer.node && !layer._pixelSweepUnderlyingHidden) {
      layer.node.style.visibility = "hidden";
      layer._pixelSweepUnderlyingHidden = true;
    }
  }

  // Position a layer using ONLY its base transform — no effects, no scene
  // blur, no motion. Used for the static resting state before playback.
  function placeLayerStatic(layer) {
    if (!layer.wrap) return;
    const T = layer.transform, A = STATE.format;
    // v19.17: GROUP layers use natural-size wrap + CSS scale so
    // member wraps inside scale together.  Mirrors composeLayer's
    // GROUP branch so preview stays consistent regardless of which
    // rendering path (animated vs static) runs.
    if (layer.kind === "GROUP") {
      const natWpx = ((layer._groupNatWpct || T.wPct) / 100) * A.w;
      const natHpx = ((layer._groupNatHpct || T.hPct) / 100) * A.h;
      const scaleX = T.wPct / (layer._groupNatWpct || T.wPct);
      const scaleY = T.hPct / (layer._groupNatHpct || T.hPct);
      const gCxPx = (T.cx / 100) * A.w;
      const gCyPx = (T.cy / 100) * A.h;
      layer.wrap.style.width = natWpx + "px";
      layer.wrap.style.height = natHpx + "px";
      layer.wrap.style.left = (A.w / 2 + gCxPx - natWpx / 2) + "px";
      layer.wrap.style.top  = (A.h / 2 + gCyPx - natHpx / 2) + "px";
      layer.wrap.style.transformOrigin = "center center";
      layer.wrap.style.transform = `perspective(1000px) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)}) rotate(${T.rot.toFixed(2)}deg)`;
      layer.wrap.style.opacity = clamp01(T.opacity / 100).toFixed(2);
      layer.wrap.style.filter = "none";
      layer.wrap.style.clipPath = ""; layer._clipApplied = false;
      // Clear any active vector-animation deltas that member primitives may hold.
      if (layer._dashApplied) clearPathDash(layer);
      if (layer._shapeStyleApplied) clearShapeStyleDelta(layer);
      if (layer._morphApplied) clearMorph(layer);
      if (layer._fillRevealApplied) clearFillReveal(layer);
      if (layer._segmentRevealApplied) clearSegmentReveal(layer);
      return;
    }
    const wPx = (T.wPct / 100) * A.w, hPx = (T.hPct / 100) * A.h;
    const cxPx = (T.cx / 100) * A.w, cyPx = (T.cy / 100) * A.h;
    layer.wrap.style.width = wPx + "px"; layer.wrap.style.height = hPx + "px";
    layer.wrap.style.left = (A.w / 2 + cxPx - wPx / 2) + "px";
    layer.wrap.style.top = (A.h / 2 + cyPx - hPx / 2) + "px";
    layer.wrap.style.transformOrigin = "center center";
    layer.wrap.style.transform = `rotate(${T.rot.toFixed(2)}deg)`;
    layer.wrap.style.opacity = clamp01(T.opacity / 100).toFixed(2);
    layer.wrap.style.filter = "none";
    layer.wrap.style.clipPath = ""; layer._clipApplied = false;
    // reset any sublayer transforms so grouped/exposed SVGs sit still
    if (layer.subLayers) layer.subLayers.forEach((n) => { n.style.transform = ""; n.style.opacity = ""; });
    // v19.8: clear any active vector-animation deltas so the shape
    // returns to its baseline appearance when no clip is contributing.
    // Extended to SHAPE (was SVG-only in v19.7).
    const _va = layer.kind === "SVG" || layer.kind === "SHAPE" || layer.kind === "GROUP";
    if (_va && layer._dashApplied) clearPathDash(layer);
    if (_va && layer._shapeStyleApplied) clearShapeStyleDelta(layer);
    if (_va && layer._morphApplied) clearMorph(layer);
    // v19.12: fillReveal works on any layer kind (not just vector).
    if (layer._fillRevealApplied) clearFillReveal(layer);
    // v19.14: segmentReveal is per-primitive opacity — clear on static.
    if (layer._segmentRevealApplied) clearSegmentReveal(layer);
  }

  // Render one static frame (no animation) — every visible layer at rest,
  // overlays cleared. Called on import, transform edits, format/zoom
  // changes, etc. while paused.
  function renderStaticFrame() {
    if (STATE.playing) return;
    // Video layers still need to show the frame at the current
    // playhead when paused/scrubbing.  Fire-and-forget seek — the
    // <video> element updates its displayed frame when the seek
    // completes, which is fine for preview.
    layers.forEach((L) => { if (L.kind === "VIDEO") syncOrPaintVideoLayer(L, STATE.time, false); });
    layers.forEach((layer) => {
      if (!layer.wrap) return;
      if (!layer.visible) { layer.wrap.style.opacity = "0"; return; }
      placeLayerStatic(layer);
      // Ensure pixel-sweep overlay is cleared for static frames.
      updatePixelSweepPreview(layer, STATE.time);
    });
    el.artboard.style.setProperty("--scanline-op", 0);
    el.artboard.style.setProperty("--noise-op", 0);
    if (hudLayer) hudLayer.style.display = "none";
    if (flashOverlay) flashOverlay.style.opacity = 0;
    if (selectedLayer) updateSelectionBox();
  }
  /* Renders exactly ONE animated frame at the current STATE.time — used
     while the timeline is paused but the user is editing an event clip's
     parameters, so intensity / duration / start slider changes visibly
     update the preview when the playhead is inside an event window. */
  function renderOneAnimatedFrame() {
    const t = STATE.time, sig = audioSignal();
    let sceneScan = STATE.scanline / 100, sceneNoise = STATE.noise / 100;
    let anyHud = false, hudFlicker = 1, anyFlash = null, flashA = 0;
    // Sync video layers to the current timeline position before drawing.
    layers.forEach((L) => { if (L.kind === "VIDEO") syncOrPaintVideoLayer(L, t, false); });
    layers.forEach((layer) => {
      if (!layer.wrap) return;
      const active = layer.visible && t >= layer.start - 0.001 && t <= layer.start + layer.duration + 0.001;
      if (!active) { layer.wrap.style.opacity = "0"; return; }
      const lt = t - layer.start + layer.recipe.delay;
      const r = composeLayer(layer, lt, sig, t);
      if (layer.kind === "TEXT") applyTextFxAtTime(layer, t, sig);
      if (r.hud) { anyHud = true; hudFlicker = r.hudFlicker; }
      if (r.flash) { anyFlash = r.flash; flashA = r.flashA; }
      if (r.scanBoost) sceneScan = Math.min(1, sceneScan + r.scanBoost * 0.3);
      if (r.breakup) sceneNoise = Math.min(1, sceneNoise + r.breakup);
    });
    el.artboard.style.setProperty("--scanline-op", sceneScan);
    el.artboard.style.setProperty("--noise-op", sceneNoise);
    updateHud(anyHud, hudFlicker, t); updateFlash(anyFlash, flashA);
    if (selectedLayer) updateSelectionBox();
  }
  function paintIfPaused() {
    if (STATE.playing) return;
    // v19.34: always take the animated path when paused.  Previously
    // we only ran renderOneAnimatedFrame when a clip was currently
    // within its [start, end] window; renderStaticFrame skipped
    // composeLayer entirely, which meant:
    //   - Scrubbing between effect clips reset the layer to base state
    //     even for effects that should persist their end state (fill
    //     reveal, line draw, morph, segment reveal, expansion build).
    //   - Layer-level animation and any "just past end" persistence
    //     couldn't be shown while paused.
    // The animated path runs the full effect pipeline against t and
    // uses each effect's own logic to decide what state to render —
    // including the persist-past-end handling added below.
    renderOneAnimatedFrame();
  }

  // Line Draw / Trim Paths: animate stroke-dasharray/offset on SVG strokes.
  function pathStrokes(layer) {
    if (!layer._strokes) {
      layer._strokes = getLayerPrimitiveNodes(layer).map((n) => {
        let len = 0; try { len = typeof n.getTotalLength === "function" ? n.getTotalLength() : 0; } catch (e) { len = 0; }
        if (!len) { const bb = n.getBBox ? safeBBox(n) : null; len = bb ? (bb.width + bb.height) * 2 : 100; }
        return { n, len };
      });
    }
    return layer._strokes;
  }
  function safeBBox(n) { try { return n.getBBox(); } catch (e) { return null; } }
  function applyPathDash(layer, draw, trim) {
    pathStrokes(layer).forEach(({ n, len }) => {
      if (!len) return;
      n.style.strokeDasharray = len + "px";
      if (draw !== null && draw !== undefined) n.style.strokeDashoffset = (len * (1 - clamp01(draw))) + "px";
      else if (trim !== null && trim !== undefined) n.style.strokeDashoffset = (len * clamp01(trim)) + "px";
    });
    layer._dashApplied = true;
  }
  function clearPathDash(layer) { if (layer._strokes) layer._strokes.forEach(({ n }) => { n.style.strokeDasharray = ""; n.style.strokeDashoffset = ""; }); layer._dashApplied = false; }

  /* v19.16 GROUP-aware primitive discovery.
     Every path/shape effect that iterates SVG primitives (Segment
     Reveal, Line Draw, Trim Paths, Path Energize, Stroke Width Pulse,
     Fill Color Flash) uses this helper so the same code path works
     for SVG imports, native SHAPE layers, and wrapper-based GROUP
     layers.  For a GROUP, iterates member layers and concatenates
     their primitives — from the effect's perspective the group is
     "one layer with N primitives" spanning members' artwork. */
  const _PRIM_SELECTOR = "path, line, polyline, polygon, circle, ellipse, rect";
  function getLayerPrimitiveNodes(layer) {
    if (!layer) return [];
    if (layer.kind === "GROUP") {
      const out = [];
      const members = layer._members || [];
      for (const m of members) {
        if (m && m.node) {
          m.node.querySelectorAll(_PRIM_SELECTOR).forEach((p) => out.push(p));
        }
      }
      return out;
    }
    if (layer.node) return Array.from(layer.node.querySelectorAll(_PRIM_SELECTOR));
    return [];
  }

  /* ---------------- v19.8 UNIFIED shapeStyle DELTA CHANNEL ----------------
     Applies stroke / fill animation deltas to every drawable primitive
     inside a SHAPE or imported-SVG layer.  Uniform pipeline: an effect
     returns `{ shapeStyle: { ... } }`, composeLayer merges deltas
     across active clips (see the accumulator above), and this applier
     writes effective values via inline `style` (which has higher
     specificity than SVG attributes, so it composites on top of the
     layer's static appearance).

     Extension model: adding new axes (dashOffset, dashArray, strokeColor
     animation) is a one-line addition to composeLayer's accumulator
     plus one branch in the applier below.  Zero changes needed to
     effect handlers, buildShapeLayerSVG, or export pipeline.

     Baseline snapshot:  the FIRST call to shapePrimitives() reads the
     primitive's currently-computed stroke width / stroke color / fill
     color and stores them, so subsequent restores return to the exact
     visual state before any effect fired.  Cache invalidates when the
     shape SVG is rebuilt (buildShapeLayerSVG clears `_primitives`). */
  function shapePrimitives(layer) {
    if (!layer._primitives) {
      layer._primitives = getLayerPrimitiveNodes(layer).map((n) => {
        // Snapshot the baseline.  Prefer computed style so CSS-rules
        // (external stylesheets in imported SVGs) are captured.
        const cs = window.getComputedStyle(n);
        const attrSW = parseFloat(n.getAttribute("stroke-width"));
        const baseStrokeW = !isNaN(attrSW) ? attrSW : (parseFloat(cs.strokeWidth) || 0);
        const attrStroke = n.getAttribute("stroke");
        const attrFill   = n.getAttribute("fill");
        return {
          n,
          baseStrokeW,
          baseStroke:  attrStroke != null ? attrStroke : (cs.stroke || ""),
          baseFill:    attrFill   != null ? attrFill   : (cs.fill   || ""),
          hasStroke:   (attrStroke != null ? attrStroke : cs.stroke) !== "none",
          hasFill:     (attrFill   != null ? attrFill   : cs.fill)   !== "none",
        };
      });
    }
    return layer._primitives;
  }
  function applyShapeStyleDelta(layer, delta) {
    shapePrimitives(layer).forEach((prim) => {
      const { n, baseStrokeW, hasStroke, hasFill } = prim;
      // Stroke width: (base + delta) × mul, clamped to >= 0.
      if (delta.strokeWidthDelta !== undefined || delta.strokeWidthMul !== undefined) {
        let sw = baseStrokeW;
        if (delta.strokeWidthDelta !== undefined) sw += delta.strokeWidthDelta;
        if (delta.strokeWidthMul   !== undefined) sw *= delta.strokeWidthMul;
        n.style.strokeWidth = Math.max(0, sw) + "px";
      }
      // Stroke color override — only when the primitive HAD a visible
      // stroke.  Applying to a stroke:none primitive would silently
      // create a stroke the user didn't have.
      if (delta.strokeColor !== undefined && hasStroke) n.style.stroke = delta.strokeColor;
      // Fill color override — same rule: only for primitives with a
      // visible fill baseline.
      if (delta.fillColor !== undefined && hasFill) n.style.fill = delta.fillColor;
      if (delta.strokeOpacity !== undefined) n.style.strokeOpacity = delta.strokeOpacity;
      if (delta.fillOpacity   !== undefined) n.style.fillOpacity   = delta.fillOpacity;
    });
    layer._shapeStyleApplied = true;
  }
  function clearShapeStyleDelta(layer) {
    if (!layer._primitives) { layer._shapeStyleApplied = false; return; }
    layer._primitives.forEach(({ n }) => {
      n.style.strokeWidth = "";
      n.style.stroke = "";
      n.style.fill = "";
      n.style.strokeOpacity = "";
      n.style.fillOpacity = "";
    });
    layer._shapeStyleApplied = false;
  }

  /* ---------------- v19.9 MORPHING FOUNDATION ----------------
     Path-to-path interpolation for the Shape Morph event effect.

     Design:
       - Each drawable primitive is normalized to a `<path>` with a
         canonical `d` command sequence (only M / L / C / Z used, no
         Q or A).  This makes command-count matching predictable
         without a full path-parser + rebuilder.
       - Interpolation is per-command: matching command types are lerp'd
         numerically; mismatches abort with a diagnostic.
       - Result is a `d` string written to the source primitive.  If the
         source primitive isn't a `<path>` (e.g., a native <rect>), we
         REPLACE it with a `<path>` at first morph, then continue
         updating that path's `d`.  Original is restored in clearMorph
         via layer._morphOrigNode.

     Compatibility model:
       - Rect ↔ Rect      : normalized to M L L L Z (5 cmds)
       - Circle ↔ Circle  : normalized to M C C C C Z (6 cmds, 4 arc cubics)
       - Ellipse ↔ Ellipse: same as circle
       - Line ↔ Line      : M L (2 cmds)
       - Polygon ↔ Polygon: M L^n Z (n+2 cmds; MUST match side count)
       - Rect ↔ Circle    : both to M C C C C Z (6 cmds) via cubic-approx
                            straight-edge form for rect
       - Rect ↔ Ellipse   : same as above
       - Circle ↔ Ellipse : both are 4-cubic circles
       - Any → Any via SVG <path>: only if command sequences match
                                    exactly (both must produce same M/L/C/Z pattern)
       - Anything else    : incompatible, reported to clip inspector

     Diagnostics surfaced through layer._morphDiag which the clip
     inspector reads and displays. */

  // Circle-to-bezier control offset — makes a 4-cubic circle
  // approximation visually indistinguishable from a true arc.
  const CIRCLE_KAPPA = 0.5522847498307936;

  /* Convert an SVG primitive element to a canonical path `d` string.
     Returns { d, cmds } where `cmds` is a list of command letters
     (e.g., ["M","C","C","C","C","Z"]) used for compatibility matching.
     For unknown or unsupported elements returns null. */
  function primitiveToCanonicalPath(node, form) {
    // `form` steers the normalization for rectangles:
    //   "straight"  → M L L L Z (5 cmds) — matches other rects
    //   "cubic"     → M C C C C Z (6 cmds) — matches circles/ellipses
    // Circles/ellipses always use "cubic" (their only representation).
    if (!node) return null;
    const tag = node.tagName.toLowerCase();
    if (tag === "path") {
      const d = node.getAttribute("d") || "";
      const cmds = (d.match(/[a-zA-Z]/g) || []).map((c) => c.toUpperCase());
      return { d, cmds };
    }
    if (tag === "rect") {
      const x = parseFloat(node.getAttribute("x")) || 0;
      const y = parseFloat(node.getAttribute("y")) || 0;
      const w = parseFloat(node.getAttribute("width")) || 0;
      const h = parseFloat(node.getAttribute("height")) || 0;
      if (form === "cubic") {
        // Represent rectangle sides as degenerate cubics so segment
        // counts match circles/ellipses.  Control points sit ON the
        // straight edge, so shape stays a rectangle.
        const c = (x1, y1, x2, y2) => {
          const cx1 = x1 + (x2 - x1) / 3, cy1 = y1 + (y2 - y1) / 3;
          const cx2 = x1 + (x2 - x1) * 2 / 3, cy2 = y1 + (y2 - y1) * 2 / 3;
          return `C${cx1},${cy1} ${cx2},${cy2} ${x2},${y2}`;
        };
        const d = `M${x},${y} ${c(x,y,x+w,y)} ${c(x+w,y,x+w,y+h)} ${c(x+w,y+h,x,y+h)} ${c(x,y+h,x,y)} Z`;
        return { d, cmds: ["M","C","C","C","C","Z"] };
      }
      const d = `M${x},${y} L${x+w},${y} L${x+w},${y+h} L${x},${y+h} Z`;
      return { d, cmds: ["M","L","L","L","Z"] };
    }
    if (tag === "circle" || tag === "ellipse") {
      const cx = parseFloat(node.getAttribute("cx")) || 0;
      const cy = parseFloat(node.getAttribute("cy")) || 0;
      let rx, ry;
      if (tag === "circle") { rx = ry = parseFloat(node.getAttribute("r")) || 0; }
      else { rx = parseFloat(node.getAttribute("rx")) || 0; ry = parseFloat(node.getAttribute("ry")) || 0; }
      const K = CIRCLE_KAPPA;
      const okx = rx * K, oky = ry * K;
      // 4-arc cubic circle: start at top, go clockwise
      const d = [
        `M${cx},${cy - ry}`,
        `C${cx + okx},${cy - ry} ${cx + rx},${cy - oky} ${cx + rx},${cy}`,
        `C${cx + rx},${cy + oky} ${cx + okx},${cy + ry} ${cx},${cy + ry}`,
        `C${cx - okx},${cy + ry} ${cx - rx},${cy + oky} ${cx - rx},${cy}`,
        `C${cx - rx},${cy - oky} ${cx - okx},${cy - ry} ${cx},${cy - ry}`,
        `Z`,
      ].join(" ");
      return { d, cmds: ["M","C","C","C","C","Z"] };
    }
    if (tag === "line") {
      const x1 = parseFloat(node.getAttribute("x1")) || 0;
      const y1 = parseFloat(node.getAttribute("y1")) || 0;
      const x2 = parseFloat(node.getAttribute("x2")) || 0;
      const y2 = parseFloat(node.getAttribute("y2")) || 0;
      return { d: `M${x1},${y1} L${x2},${y2}`, cmds: ["M","L"] };
    }
    if (tag === "polygon" || tag === "polyline") {
      const pts = (node.getAttribute("points") || "").trim().split(/[\s,]+/).map(parseFloat);
      if (pts.length < 4 || pts.length % 2 !== 0) return null;
      const parts = [];
      const cmds = [];
      for (let i = 0; i < pts.length; i += 2) {
        if (i === 0) { parts.push(`M${pts[i]},${pts[i+1]}`); cmds.push("M"); }
        else         { parts.push(`L${pts[i]},${pts[i+1]}`); cmds.push("L"); }
      }
      if (tag === "polygon") { parts.push("Z"); cmds.push("Z"); }
      return { d: parts.join(" "), cmds };
    }
    return null;
  }

  /* Parse a canonical `d` string into an array of { cmd, coords[] }.
     Only handles the commands our normalizer emits (M/L/C/Z). */
  function parseCanonicalPath(d) {
    const out = [];
    // Match a command letter followed by a run of numeric values.
    const rx = /([MLCZ])((?:\s*-?\d*\.?\d+(?:[eE][+-]?\d+)?\s*,?\s*)*)/g;
    let m;
    while ((m = rx.exec(d)) !== null) {
      const cmd = m[1];
      const coords = (m[2] || "").trim().split(/[\s,]+/).filter(Boolean).map(parseFloat);
      out.push({ cmd, coords });
    }
    return out;
  }
  /* Serialize the parsed representation back to a `d` string. */
  function serializeCanonicalPath(parsed) {
    return parsed.map(({ cmd, coords }) => coords.length ? `${cmd}${coords.join(",")}` : cmd).join(" ");
  }
  /* Interpolate two parsed paths.  Returns null if incompatible. */
  function interpolateCanonicalPaths(A, B, t) {
    if (A.length !== B.length) return null;
    const out = [];
    for (let i = 0; i < A.length; i++) {
      if (A[i].cmd !== B[i].cmd) return null;
      if (A[i].coords.length !== B[i].coords.length) return null;
      const coords = A[i].coords.map((v, j) => v + (B[i].coords[j] - v) * t);
      out.push({ cmd: A[i].cmd, coords });
    }
    return serializeCanonicalPath(out);
  }

  /* Compatibility analysis for a morph.  Returns { ok, reason?, sourceCmds?, targetCmds? }.
     Called on every morph frame to keep the diagnostic live. */
  /* ============================================================
     v19.23 MORPHING 2.0 — resampling-based morph.

     The old morph required source and target primitives to have
     IDENTICAL command sequences (M L L L Z matches M L L L Z, but
     M Q L Z rejected against M C C Z).  Real-world imported SVGs
     rarely satisfy this.

     New approach: sample both primitives to N points along their
     arc length using SVGGeometryElement.getTotalLength() +
     getPointAtLength().  These work uniformly on path/rect/circle/
     ellipse/line/polygon/polyline regardless of internal command
     types (Q/A/S/T all handled natively by the browser).

     Interpolation is per-point linear.  The output is always a
     "M x0,y0 L x1,y1 L x2,y2 ... Z" polygon-style path with N
     segments.  At N=128 the approximation is visually smooth.

     Vertex alignment: for closed shapes, cyclic-shift target's
     sample sequence to minimize sum-of-squared distances from
     source.  Without this, rect→circle "twists" as the starting
     points of each path don't line up.

     Known limitations kept honest for v1:
       - Compound paths (multiple M commands): only the first
         subpath is resampled.  Complex multi-subpath geometry
         approximates the outer sub-shape.
       - Stroke-only shapes morph based on their center-line, not
         the stroked outline.  Full stroke-to-outline expansion
         needs a geometry library (deferred).
       - Non-uniform scale during morph animation preserved
         because interpolation is point-by-point.
     ============================================================ */
  const MORPH_SAMPLES = 128;   // per-path sample count; balance smoothness vs cost

  // Resample any SVGGeometryElement to N equally-spaced points along
  // arc length.  Returns null if the element doesn't support the
  // required API or has zero length.
  function resamplePrimitiveToPoints(node, N) {
    if (!node || typeof node.getTotalLength !== "function") return null;
    let totalLen;
    try { totalLen = node.getTotalLength(); } catch (e) { return null; }
    if (!(totalLen > 0)) return null;
    // Detect closed shape: rect/circle/ellipse/polygon/polyline are
    // implicitly closed except polyline (open); path detection via
    // last command being Z.
    const tag = node.tagName.toLowerCase();
    let closed;
    if (tag === "path") {
      const d = node.getAttribute("d") || "";
      closed = /[zZ]\s*$/.test(d.trim());
    } else {
      closed = tag !== "line" && tag !== "polyline";
    }
    const points = new Array(N);
    for (let i = 0; i < N; i++) {
      // Closed shape: sample [0, totalLen) so the last sample
      // doesn't duplicate the first.  Open: sample [0, totalLen].
      const distance = closed ? (i / N) * totalLen : (i / (N - 1)) * totalLen;
      const p = node.getPointAtLength(distance);
      points[i] = { x: p.x, y: p.y };
    }
    return { points, closed };
  }
  // Convert a series of points into an SVG path d string.  For closed
  // shapes appends 'Z'.
  function pointsToPathD(points, closed) {
    if (!points || !points.length) return "";
    const parts = [`M${points[0].x.toFixed(3)},${points[0].y.toFixed(3)}`];
    for (let i = 1; i < points.length; i++) {
      parts.push(`L${points[i].x.toFixed(3)},${points[i].y.toFixed(3)}`);
    }
    if (closed) parts.push("Z");
    return parts.join(" ");
  }
  // v19.26 Corner-Aware Smoothing.
  //
  // v19.27 update — CONTINUOUS corner strength.
  //
  // The v19.26 detector was binary: a vertex was either a "corner"
  // (emit L segments across it) or "smooth" (emit C segments).  As
  // interpolation progressed, vertices crossed the binary threshold at
  // slightly different t values, causing L/C topology snaps visible
  // as small geometric jumps.
  //
  // v19.27 computes a per-vertex corner STRENGTH (0-1) instead:
  //   - Angle change > sharpThreshold (default 40°)  → strength = 1
  //   - Angle change < smoothThreshold (default 15°) → strength = 0
  //   - Between → linear ramp
  //
  // Source and target strengths are computed independently in
  // analyzeMorph.  applyMorph blends by t to get per-vertex
  // strength at the current frame, then emits ALL cubic Bezier
  // segments (no L/C topology change).  The Bezier control handles
  // pull toward the endpoint proportionally to strength: full
  // strength → handles at endpoints → visually straight ("sharp"
  // corner in cubic syntax); zero strength → full Catmull-Rom
  // handles → smooth curve.  Continuous transition, no snap.
  const CORNER_SHARP_DEG  = 40;
  const CORNER_SMOOTH_DEG = 15;
  function computeCornerStrengths(pts, closed, sharpDeg, smoothDeg) {
    const n = pts.length;
    const strengths = new Array(n).fill(0);
    // Angle-to-dot: cos(θ) is monotonically decreasing in θ over [0, 180°].
    // Fully smooth (angle < smoothDeg): dot > cosSmooth → strength 0
    // Fully sharp (angle > sharpDeg):   dot < cosSharp  → strength 1
    // In between: linear ramp on dot values.
    const cosSharp  = Math.cos(sharpDeg  * Math.PI / 180);
    const cosSmooth = Math.cos(smoothDeg * Math.PI / 180);
    const get = (i) => pts[((i % n) + n) % n];
    for (let i = 0; i < n; i++) {
      if (!closed && (i === 0 || i === n - 1)) continue;
      const a = get(i - 1), b = get(i), c = get(i + 1);
      const v1x = b.x - a.x, v1y = b.y - a.y;
      const v2x = c.x - b.x, v2y = c.y - b.y;
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
      if (l1 < 0.001 || l2 < 0.001) continue;
      const dot = (v1x * v2x + v1y * v2y) / (l1 * l2);
      let s;
      if (dot <= cosSharp)      s = 1;
      else if (dot >= cosSmooth) s = 0;
      else s = (cosSmooth - dot) / (cosSmooth - cosSharp);
      strengths[i] = s;
    }
    return strengths;
  }
  // Emit d string as cubic Bezier segments where each segment's
  // control handles are interpolated between "sharp" (collapsed to
  // endpoints) and "smooth" (full Catmull-Rom).  Blend factor comes
  // from per-vertex strengths — sharp handles when the endpoint's
  // strength is high, smooth handles when low.  Always emits C
  // segments, never L — so segment count stays constant across the
  // entire morph, eliminating topology snaps.
  function pointsToBlendedBezierPathD(pts, closed, strengths) {
    if (!pts || pts.length < 2) return "";
    const n = pts.length;
    const get = (i) => {
      if (closed) return pts[((i % n) + n) % n];
      return pts[Math.max(0, Math.min(n - 1, i))];
    };
    const getS = (i) => {
      if (closed) return strengths[((i % n) + n) % n] || 0;
      return strengths[Math.max(0, Math.min(n - 1, i))] || 0;
    };
    const parts = [`M${pts[0].x.toFixed(3)},${pts[0].y.toFixed(3)}`];
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
      const s1 = getS(i);
      const s2 = getS((i + 1) % n);
      // Full-smooth Catmull-Rom handles (tension = 0.5)
      const smoothC1x = p1.x + (p2.x - p0.x) / 6;
      const smoothC1y = p1.y + (p2.y - p0.y) / 6;
      const smoothC2x = p2.x - (p3.x - p1.x) / 6;
      const smoothC2y = p2.y - (p3.y - p1.y) / 6;
      // Blend toward endpoint by strength.  s=1 → handle at endpoint
      // (visually linear segment).  s=0 → full Catmull-Rom (smooth).
      const c1x = smoothC1x + (p1.x - smoothC1x) * s1;
      const c1y = smoothC1y + (p1.y - smoothC1y) * s1;
      const c2x = smoothC2x + (p2.x - smoothC2x) * s2;
      const c2y = smoothC2y + (p2.y - smoothC2y) * s2;
      parts.push(`C${c1x.toFixed(3)},${c1y.toFixed(3)} ${c2x.toFixed(3)},${c2y.toFixed(3)} ${p2.x.toFixed(3)},${p2.y.toFixed(3)}`);
    }
    if (closed) parts.push("Z");
    return parts.join(" ");
  }
  // Find optimal cyclic shift of `target` points so that the
  // interpolation with `source` minimizes total squared distance.
  // O(N²) in point count — at N=128 this is 16k comparisons per
  // analyze() call, which happens once per clip creation, not
  // per-frame.  Only applied to closed shapes (cyclic sequences).
  function alignPointSequence(source, target) {
    if (!source || !target || source.length !== target.length) return target;
    const N = source.length;
    let bestShift = 0;
    let bestCost = Infinity;
    for (let s = 0; s < N; s++) {
      let cost = 0;
      for (let i = 0; i < N; i++) {
        const t = target[(i + s) % N];
        const dx = t.x - source[i].x, dy = t.y - source[i].y;
        cost += dx * dx + dy * dy;
        if (cost >= bestCost) break;   // early exit
      }
      if (cost < bestCost) { bestCost = cost; bestShift = s; }
    }
    if (bestShift === 0) return target;
    const shifted = new Array(N);
    for (let i = 0; i < N; i++) shifted[i] = target[(i + bestShift) % N];
    return shifted;
  }
  // Linear per-point interpolation between two aligned sequences.
  function interpolatePoints(source, target, t) {
    const N = source.length;
    const out = new Array(N);
    for (let i = 0; i < N; i++) {
      const a = source[i], b = target[i];
      out[i] = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    return out;
  }
  // v19.24: bbox center of a point sequence.  Used to normalize source
  // and target into a shared coordinate space before interpolation, so
  // shapes with different local origins morph while staying centered
  // instead of drifting toward one side.
  function bboxCenter(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }
  // v19.25: full bounding box for size normalization between source
  // and target.  Together with bboxCenter these let analyzeMorph
  // normalize both sample sets into the same frame BEFORE alignment
  // and interpolation.
  function bboxOfPoints(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY,
             width:  maxX - minX,
             height: maxY - minY,
             cx: (minX + maxX) / 2,
             cy: (minY + maxY) / 2 };
  }
  // v19.24: return a translated copy so the sequence's bbox center is
  // at the origin.  Original array untouched.
  function centerPoints(points, center) {
    const out = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
      out[i] = { x: points[i].x - center.x, y: points[i].y - center.y };
    }
    return out;
  }
  // v19.24: centered interpolation — the morph output stays anchored
  // at the SOURCE's original bbox center regardless of where the
  // target primitive lives in its own SVG coord space.  Behavior:
  //   - At t=0: exactly matches source's original geometry (identity)
  //   - At t=1: target's SHAPE, positioned at source's center
  //   - Between: continuous centered interpolation
  // Called from applyMorph.
  function interpolatePointsCentered(source, target, srcCenter, t) {
    const srcC = centerPoints(source, srcCenter);
    const tgtCenter = bboxCenter(target);
    const tgtC = centerPoints(target, tgtCenter);
    const interpC = interpolatePoints(srcC, tgtC, t);
    // Translate back to source's original center so the shape stays anchored.
    const N = interpC.length;
    const out = new Array(N);
    for (let i = 0; i < N; i++) {
      out[i] = { x: interpC[i].x + srcCenter.x, y: interpC[i].y + srcCenter.y };
    }
    return out;
  }

  function analyzeMorph(sourceLayer, targetLayer, targetIndex) {
    if (!sourceLayer) return { ok: false, reason: "No source layer" };
    if (!targetLayer) return { ok: false, reason: "No target layer selected" };
    if (sourceLayer === targetLayer) return { ok: false, reason: "Source and target must differ" };
    if (targetLayer.kind === "TEXT" || sourceLayer.kind === "TEXT") {
      return { ok: false, reason: "TEXT layers not supported — convert to outlines first (future)" };
    }
    if (targetLayer.kind === "GROUP" || sourceLayer.kind === "GROUP") {
      return { ok: false, reason: "GROUP layers not supported as morph source/target (deferred)" };
    }
    const srcNode = sourceLayer.node && sourceLayer.node.querySelector("path,rect,circle,ellipse,line,polygon,polyline");
    const tgtNodes = targetLayer.node ? targetLayer.node.querySelectorAll("path,rect,circle,ellipse,line,polygon,polyline") : [];
    if (!srcNode) return { ok: false, reason: "Source has no drawable primitive" };
    if (!tgtNodes.length) return { ok: false, reason: "Target has no drawable primitives" };
    const tgtNode = tgtNodes[Math.min(targetIndex || 0, tgtNodes.length - 1)];
    // v19.23: resample both primitives to N points along arc length.
    // v19.24: normalize both to their bbox center BEFORE alignment
    // and interpolation.  Vertex alignment cost is computed in
    // centered space so shapes with different local origins produce
    // the correct cyclic shift.  applyMorph then translates the
    // interpolated result back to the source's original center, so
    // the morph stays visually anchored where the source was.
    const srcSample = resamplePrimitiveToPoints(srcNode, MORPH_SAMPLES);
    const tgtSample = resamplePrimitiveToPoints(tgtNode, MORPH_SAMPLES);
    if (!srcSample) return { ok: false, reason: `Source <${srcNode.tagName.toLowerCase()}> has zero geometry (empty path?)` };
    if (!tgtSample) return { ok: false, reason: `Target <${tgtNode.tagName.toLowerCase()}> has zero geometry (empty path?)` };
    const srcCenter = bboxCenter(srcSample.points);
    const tgtCenter = bboxCenter(tgtSample.points);
    const srcCentered = centerPoints(srcSample.points, srcCenter);
    let tgtCentered  = centerPoints(tgtSample.points, tgtCenter);
    // v19.25: normalize target's size to source's bounding box so the
    // morph output stays within source's frame throughout the
    // animation.  Without this, source and target with different
    // sizes produce intermediate shapes whose visible bbox no longer
    // matches the layer's selection rectangle — the drift shown in
    // the user's screenshot even though centers stay aligned.
    // Non-uniform scale (each axis independently) matches Illustrator
    // Blend semantics: source's frame is preserved, target's shape
    // adapts to fill it.
    const srcBB = bboxOfPoints(srcCentered);
    const tgtBB = bboxOfPoints(tgtCentered);
    const scaleX = tgtBB.width  > 0.001 ? srcBB.width  / tgtBB.width  : 1;
    const scaleY = tgtBB.height > 0.001 ? srcBB.height / tgtBB.height : 1;
    if (scaleX !== 1 || scaleY !== 1) {
      tgtCentered = tgtCentered.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY }));
    }
    // Vertex alignment for closed shapes — done in centered+normalized
    // space so the alignment measures pure shape similarity, not
    // positional or scale offset.
    if (srcSample.closed && tgtSample.closed) {
      tgtCentered = alignPointSequence(srcCentered, tgtCentered);
    }
    // v19.27: compute per-vertex corner strengths for source and
    // target.  These get blended by t in applyMorph so the sharp/
    // smooth transition happens continuously (no L/C topology snap).
    const srcStrengths = computeCornerStrengths(srcCentered, srcSample.closed || tgtSample.closed, CORNER_SHARP_DEG, CORNER_SMOOTH_DEG);
    const tgtStrengths = computeCornerStrengths(tgtCentered, srcSample.closed || tgtSample.closed, CORNER_SHARP_DEG, CORNER_SMOOTH_DEG);
    return {
      ok: true,
      sourceCmds: MORPH_SAMPLES,
      targetCmds: MORPH_SAMPLES,
      sourcePointsCentered: srcCentered,
      targetPointsCentered: tgtCentered,
      sourceCenter: srcCenter,
      srcStrengths,
      tgtStrengths,
      closed: srcSample.closed || tgtSample.closed,
      srcNode, tgtNode,
      // Legacy compat fields for callers that read these:
      sourceForm: { d: pointsToPathD(srcSample.points, srcSample.closed) },
      targetForm: { d: pointsToPathD(tgtSample.points, tgtSample.closed) },
    };
  }

  /* Apply a morph contribution.  Writes an interpolated d attribute
     to the source primitive (swapping in a <path> when the source
     is a native shape primitive that gets restored on clear). */
  function applyMorph(layer, morph) {
    if (!morph || !morph.targetLayerId) {
      layer._morphDiag = { ok: false, reason: "No target selected" };
      return;
    }
    const target = findLayerAnywhere(morph.targetLayerId);
    const analysis = analyzeMorph(layer, target, morph.targetIndex);
    layer._morphDiag = { ok: analysis.ok, reason: analysis.reason,
      sourceCmds: analysis.sourceCmds, targetCmds: analysis.targetCmds };
    if (!analysis.ok) return;
    const t = Math.max(0, Math.min(1, morph.progress || 0));
    // v19.24: interpolate in centered space, then translate back to
    // the source's original bbox center so the morph output stays
    // visually anchored.  Prevents "drift toward upper-left" seen
    // when source and target live in different coord frames.
    const interpC = interpolatePoints(analysis.sourcePointsCentered, analysis.targetPointsCentered, t);
    const N = interpC.length;
    const interp = new Array(N);
    const sc = analysis.sourceCenter;
    for (let i = 0; i < N; i++) {
      interp[i] = { x: interpC[i].x + sc.x, y: interpC[i].y + sc.y };
    }
    // v19.27: blend per-vertex strengths by t, emit continuous cubic
    // Bezier segments with control handles interpolated between sharp
    // (collapsed to endpoints) and smooth (Catmull-Rom).  No L/C
    // topology change across the animation — eliminates the snap.
    const nS = analysis.srcStrengths.length;
    const strengths = new Array(nS);
    for (let i = 0; i < nS; i++) {
      strengths[i] = analysis.srcStrengths[i] * (1 - t) + analysis.tgtStrengths[i] * t;
    }
    let dInterp = pointsToBlendedBezierPathD(interp, analysis.closed, strengths);
    if (!dInterp) dInterp = pointsToPathD(interp, analysis.closed);
    if (!dInterp) { layer._morphDiag = { ok: false, reason: "Interpolation failed (unexpected)" }; return; }
    // Locate or create the morph <path> node.  If the source primitive
    // isn't a <path>, we swap in a <path> on first morph and restore
    // the original in clearMorph.
    let morphPath = layer._morphPath;
    if (!morphPath) {
      const srcNode = analysis.srcNode;
      if (srcNode.tagName.toLowerCase() === "path") {
        morphPath = srcNode;
        layer._morphOrigD = srcNode.getAttribute("d");
      } else {
        // Replace primitive with a <path> that inherits stroke/fill.
        const svgNS = "http://www.w3.org/2000/svg";
        morphPath = document.createElementNS(svgNS, "path");
        // Copy stroke/fill attributes so appearance is preserved.
        ["fill","stroke","stroke-width","stroke-linecap","stroke-linejoin","opacity","fill-opacity","stroke-opacity"].forEach((a) => {
          const v = srcNode.getAttribute(a);
          if (v != null) morphPath.setAttribute(a, v);
        });
        srcNode.parentNode.insertBefore(morphPath, srcNode);
        srcNode.style.display = "none";
        layer._morphOrigNode = srcNode;
      }
      layer._morphPath = morphPath;
      // Invalidate caches that reference the old primitive.
      layer._strokes = null;
      layer._primitives = null; layer._segmentPrims = null; layer._segmentOrder = null;
    }
    morphPath.setAttribute("d", dInterp);
    layer._morphApplied = true;
  }
  function clearMorph(layer) {
    if (layer._morphPath) {
      if (layer._morphOrigNode) {
        // We swapped in a <path>; restore the original primitive.
        layer._morphOrigNode.style.display = "";
        layer._morphPath.parentNode.removeChild(layer._morphPath);
      } else if (layer._morphOrigD != null) {
        // Restore the source path's original `d`.
        layer._morphPath.setAttribute("d", layer._morphOrigD);
      }
      layer._morphPath = null;
      layer._morphOrigNode = null;
      layer._morphOrigD = null;
      layer._strokes = null;
      layer._primitives = null; layer._segmentPrims = null; layer._segmentOrder = null;
    }
    layer._morphApplied = false;
    layer._morphDiag = null;
  }

  /* ---------------- v19.12 FILL REVEAL ----------------
     Progressively uncovers a layer's filled artwork over time by
     animating a CSS clip-path on the layer wrap.  Because it operates
     at the composite layer (not per-primitive), it:
       - Works on imports, native shapes, text, and images uniformly.
       - Preserves fills / gradients / colors / images exactly — the
         artwork is never mutated; only the visible clip window
         expands.
       - Composes cleanly with other effects (Line Draw on strokes,
         Fill Color Flash, etc.).
       - Is cheap: pure CSS on one element per layer.

     Modes (v1):
       left           → wipes from left to right
       right          → wipes from right to left
       top            → wipes from top to bottom
       bottom         → wipes from bottom to top
       center-out     → rectangular reveal from center outward
       radial         → circular reveal from center outward
     Angle-based directional reveal is a natural next step. */
  function applyFillReveal(layer, r) {
    if (!layer || !layer.wrap) return;
    const p = Math.max(0, Math.min(1, r.progress || 0));
    // At p=0 the layer should be fully clipped (invisible); at p=1 the
    // clip window equals the full layer bounds (fully visible).
    let clip = "";
    switch (r.direction) {
      case "right":
        // Reveal from right → left.  As p goes 0→1, the left edge of the
        // clip window moves rightward from x=100% to x=0%.
        clip = `inset(0 0 0 ${((1 - p) * 100).toFixed(2)}%)`;
        break;
      case "top":
        clip = `inset(0 0 ${((1 - p) * 100).toFixed(2)}% 0)`;
        break;
      case "bottom":
        clip = `inset(${((1 - p) * 100).toFixed(2)}% 0 0 0)`;
        break;
      case "center-out": {
        // Expand a centered rectangle from 0×0 to full layer bounds.
        const inset = ((1 - p) * 50).toFixed(2);   // 50% inset = zero rect
        clip = `inset(${inset}% ${inset}% ${inset}% ${inset}%)`;
        break;
      }
      case "radial": {
        // Circle radius grows from 0 → the ~diagonal length so the
        // whole layer is revealed at p=1.  71% covers the corners.
        const r = (p * 71).toFixed(2);
        clip = `circle(${r}% at 50% 50%)`;
        break;
      }
      case "left":
      default:
        // Reveal from left → right.  As p goes 0→1, the right edge of
        // the clip window moves rightward from x=0% to x=100%.
        clip = `inset(0 ${((1 - p) * 100).toFixed(2)}% 0 0)`;
        break;
    }
    layer.wrap.style.clipPath = clip;
    layer.wrap.style.webkitClipPath = clip;
    layer._fillRevealApplied = true;
  }
  function clearFillReveal(layer) {
    if (!layer || !layer.wrap) { if (layer) layer._fillRevealApplied = false; return; }
    layer.wrap.style.clipPath = "";
    layer.wrap.style.webkitClipPath = "";
    layer._fillRevealApplied = false;
  }

  /* ---------------- v19.14 SEGMENT REVEAL ----------------
     Reveals individual primitives inside an SVG or shape layer one at
     a time.  Unlike Fill Reveal (which wipes the composite), this
     mutates each primitive's opacity independently so the animation
     feels like the artwork is being assembled piece-by-piece.

     Ordering modes:
       sequential          - document order (natural reading)
       sequential-reverse  - reverse of document order
       random              - deterministic shuffle (seed param stable)
       center-out          - by distance from layer center, ascending
       edges-in            - by distance from layer center, descending

     Stagger math:
       shift       = spread / N              (per-primitive start offset)
       windowSize  = 1 - shift * (N - 1)     (each primitive's reveal window)
       start_i     = i * shift               (in the sort-order space)
       localP_i    = clamp((P - start_i) / windowSize, 0, 1)
     At spread=0 every primitive reveals in sync (degenerates to Fill
     Reveal); at spread=1 the last primitive starts exactly as the
     first finishes.  Ease-out cubic per primitive for a snappy pop. */
  function shufflePrimIndices(N, seed) {
    // Deterministic LCG so replays are identical.  Fisher-Yates.
    const arr = Array.from({ length: N }, (_, i) => i);
    let s = (seed | 0) || 1;
    for (let i = N - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const j = s % (i + 1);
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function orderPrimitivesForReveal(prims, mode, seed) {
    const N = prims.length;
    if (!N) return [];
    // Build sort-order indices — arr[sortIdx] = origIdx.
    if (mode === "sequential")          return prims.map((_, i) => i);
    if (mode === "sequential-reverse")  return prims.map((_, i) => N - 1 - i);
    if (mode === "random")              return shufflePrimIndices(N, seed);
    if (mode === "center-out" || mode === "edges-in") {
      // Compute each primitive's centroid, then sort by distance from
      // the layer's local center.  Use getBBox() (SVG-native) for the
      // primitive's local bounds.
      const dists = prims.map((n, i) => {
        let cx = 0, cy = 0;
        try {
          const bb = n.getBBox();
          cx = bb.x + bb.width / 2;
          cy = bb.y + bb.height / 2;
        } catch (e) {}
        return { i, d: cx * cx + cy * cy };   // squared dist from origin; SVG local coords
      });
      // For center-out, sort ascending; edges-in, descending.
      dists.sort((a, b) => (mode === "center-out" ? a.d - b.d : b.d - a.d));
      return dists.map((x) => x.i);
    }
    return prims.map((_, i) => i);
  }
  function applySegmentReveal(layer, r) {
    if (!layer) return;
    // v19.16: GROUP layers legitimately have layer.node === null;
    // primitives live inside member nodes.  We can proceed as long as
    // getLayerPrimitiveNodes can find something — which it does for
    // GROUP via member iteration, and requires layer.node otherwise.
    if (!layer.node && layer.kind !== "GROUP") return;
    // Cache the primitive list + sort order.  Invalidates on rebuild
    // (buildShapeLayerSVG / SVG import) and on mode change.
    const modeSig = `${r.mode}|${r.seed}`;
    if (!layer._segmentPrims || layer._segmentSig !== modeSig) {
      const prims = getLayerPrimitiveNodes(layer);
      const order = orderPrimitivesForReveal(prims, r.mode, r.seed);
      layer._segmentPrims = prims;
      layer._segmentOrder = order;
      layer._segmentSig = modeSig;
    }
    const N = layer._segmentPrims.length;
    if (!N) return;
    const spread = Math.max(0, Math.min(1, r.spread));
    const shift = N > 1 ? (spread / N) : 0;
    const windowSize = Math.max(0.0001, 1 - shift * (N - 1));
    const P = Math.max(0, Math.min(1, r.progress));
    // Map sort-order → primitive.  primAtSortIdx = _segmentPrims[_segmentOrder[k]]
    for (let k = 0; k < N; k++) {
      const origIdx = layer._segmentOrder[k];
      const prim = layer._segmentPrims[origIdx];
      const startK = k * shift;
      const localP = Math.max(0, Math.min(1, (P - startK) / windowSize));
      // Ease-out cubic per primitive for a snappy pop-in.
      const eased = 1 - Math.pow(1 - localP, 3);
      prim.style.opacity = eased.toFixed(3);
    }
    layer._segmentRevealApplied = true;
  }
  function clearSegmentReveal(layer) {
    if (layer && layer._segmentPrims) {
      layer._segmentPrims.forEach((n) => { n.style.opacity = ""; });
    }
    if (layer) layer._segmentRevealApplied = false;
  }

  /* ---------------- v19.14/19.15 EXPANSION BUILD ----------------
     Returns scale/opacity/rot/blur/tx/ty deltas that composeLayer
     folds into its transform accumulators.

     Target scale (`S`):
       - fit-canvas mode  : computed from canvas/layer ratio + margin
       - all other modes  : userTargetScale (1..100, direct multiplier)

     Origin math:
       - object-center    : no positional shift; layer grows in place,
                            giving a cinematic "zoom into the object"
                            feel (the layer's own center is the focus).
       - canvas-center    : layer's canvas offset (cx, cy) is scaled
                            by S, so the layer's on-canvas center
                            travels outward with the growth.  Effect:
                            growth appears to originate from the
                            canvas center rather than the layer.

     Cross-effects (mode-driven):
       - expand-fade / explosive  → opacity *= (1 - progress)
       - expand-rotate / explosive → rot     += rotateAmount * progress
       - expand-blur / explosive   → blur    += blurAmount * progress

     `explosive` combines all three so a single mode gives the
     "camera-slam" feel.  targetScale still applies; author picks
     20x, 50x, or 100x depending on desired intensity. */
  function computeExpansionDelta(layer, r, STATEFormat) {
    const T = layer.transform;
    // Resolve target scale.
    let target;
    if (r.mode === "fit-canvas") {
      // Backwards-compat with v19.14 auto-fit behavior for users who
      // want a subtle transition.  Computes exactly-fills-frame + 5%.
      const wPx = (T.wPct / 100) * STATEFormat.w;
      const hPx = (T.hPct / 100) * STATEFormat.h;
      const kw = STATEFormat.w / Math.max(1, wPx);
      const kh = STATEFormat.h / Math.max(1, hPx);
      target = Math.max(kw, kh) * 1.05;
    } else {
      // Direct multiplier.  Range 1..100 in the UI; clamp defensively.
      target = Math.max(1, Math.min(100, r.userTargetScale || 20));
    }
    const scaleFactor = 1 + (target - 1) * r.progress;
    // Modes that enable each cross-effect.
    const isFade    = r.mode === "expand-fade"   || r.mode === "explosive";
    const isRotate  = r.mode === "expand-rotate" || r.mode === "explosive";
    const isBlur    = r.mode === "expand-blur"   || r.mode === "explosive";
    const opacityMul = isFade   ? (1 - r.progress) : 1;
    const rotDelta   = isRotate ? (r.rotateAmount || 0) * r.progress : 0;
    const blurDelta  = isBlur   ? (r.blurAmount   || 0) * r.progress : 0;
    // Origin translation.  For object-center (default), no shift —
    // the layer grows in place around its own center.  For canvas-
    // center, translate the layer so growth appears to originate from
    // (A.w/2, A.h/2) regardless of where the layer sits on canvas.
    let tx = 0, ty = 0;
    if (r.origin === "canvas-center") {
      // Layer center is at (A.w/2 + cxPx, A.h/2 + cyPx) in canvas
      // coords.  To scale from canvas-center, layer center at scale S
      // should be at (A.w/2 + cxPx * S, A.h/2 + cyPx * S).  The
      // additional translation is (cxPx * (S-1), cyPx * (S-1)).
      // tx/ty are in canvas percent; T.cx/T.cy are already in %.
      tx = T.cx * (scaleFactor - 1);
      ty = T.cy * (scaleFactor - 1);
    }
    return {
      scaleSafe: scaleFactor,
      opacity:   opacityMul,
      rot:       rotDelta,
      blur:      blurDelta,
      tx, ty,
    };
  }

  /* ---------------- v19.10 EXPORT / PREVIEW DOM PARITY ----------------
     `applyVectorEffectsAtTime(layer, t)` walks the layer's active
     clips at scene time `t` and applies just the DOM-mutating effects
     (path-dash, shape-style delta, morph).  It's the shared code path
     that keeps preview and export in visual sync — call before
     rasterizing the layer, and the layer's SVG DOM reflects the exact
     state that preview would have shown at that time.

     Bug it fixes: `drawExportFrame` reused `imgs[layer.id]` pre-
     rasterized ONCE at export start, so morph / Line Draw / etc. only
     showed whatever state the DOM was in when rasterizeAll ran.  Now
     the export loop calls this then re-rasters the affected layer
     each frame — expensive but correct.

     Contained tightly: only mutates the three vector-effect states.
     Transform / opacity / blur are handled by the canvas renderer, so
     we don't apply them here (which would double-apply). */
  const VECTOR_FX_KEYS = new Set([
    "shapeMorph", "lineDraw", "trimPaths", "pathEnergize", "lineTrace",
    "strokeWidthPulse", "fillColorFlash",
    "fillReveal",       // v19.12
    "segmentReveal",    // v19.14  (per-primitive opacity - DOM mutation)
    // NOTE: expansionBuild is intentionally NOT here.  It's a
    // transform/opacity delta only — no DOM mutation — so it doesn't
    // need per-frame re-rasterization.  The export evaluator picks it
    // up via evaluateLayerAtTime → scaleSafe/opacity/rot accumulators.
  ]);
  function hasActiveVectorClip(layer, t) {
    // v19.20 (Option A′): member clips are suspended when grouped,
    // so only the layer's own clips need checking.
    if (!layer || !layer.clips || !layer.clips.length) return false;
    const active = activeEventClipsAt(layer, t);
    return active.some(({ c }) => {
      if (!VECTOR_FX_KEYS.has(c.fxKey)) return false;
      if (c.fxKey === "fillReveal" || c.fxKey === "segmentReveal") return true;
      return layer.kind === "SVG" || layer.kind === "SHAPE" || layer.kind === "GROUP";
    });
  }
  function applyVectorEffectsAtTime(layer, t) {
    const active = activeEventClipsAt(layer, t);
    const pathKind = layer.kind === "SVG" || layer.kind === "SHAPE" || layer.kind === "GROUP";
    if (!active.length) {
      if (pathKind && layer._dashApplied)       clearPathDash(layer);
      if (pathKind && layer._shapeStyleApplied) clearShapeStyleDelta(layer);
      if (pathKind && layer._morphApplied)      clearMorph(layer);
      if (layer._fillRevealApplied)             clearFillReveal(layer);
      if (layer._segmentRevealApplied)          clearSegmentReveal(layer);
      return;
    }
    let pathDraw = null, pathTrim = null;
    let shapeStyleDelta = null;
    let morphContrib = null;
    let fillRevealContrib = null;
    let segmentRevealContrib = null;
    const sig = (typeof audioSignal === "function") ? audioSignal() : { level: 0, bass: 0, mid: 0, high: 0, peak: 0, beat: 0 };
    for (const { c, p } of active) {
      const d = evaluateClipDelta(c, layer, t, p, sig, layer.allowTransform);
      if (!d) continue;
      if (d.pathDraw !== undefined) pathDraw = d.pathDraw;
      if (d.pathTrim !== undefined) pathTrim = d.pathTrim;
      if (d.shapeStyle) {
        if (!shapeStyleDelta) shapeStyleDelta = {};
        const ds = d.shapeStyle;
        if (ds.strokeWidthDelta !== undefined) shapeStyleDelta.strokeWidthDelta = (shapeStyleDelta.strokeWidthDelta || 0) + ds.strokeWidthDelta;
        if (ds.strokeWidthMul   !== undefined) shapeStyleDelta.strokeWidthMul   = (shapeStyleDelta.strokeWidthMul   || 1) * ds.strokeWidthMul;
        if (ds.strokeColor      !== undefined) shapeStyleDelta.strokeColor      = ds.strokeColor;
        if (ds.fillColor        !== undefined) shapeStyleDelta.fillColor        = ds.fillColor;
        if (ds.strokeOpacity    !== undefined) shapeStyleDelta.strokeOpacity    = ds.strokeOpacity;
        if (ds.fillOpacity      !== undefined) shapeStyleDelta.fillOpacity      = ds.fillOpacity;
      }
      if (d.morph)          morphContrib = d.morph;
      if (d.fillReveal)     fillRevealContrib = d.fillReveal;
      if (d.segmentReveal)  segmentRevealContrib = d.segmentReveal;
    }
    if (pathKind) {
      if (pathDraw !== null || pathTrim !== null) applyPathDash(layer, pathDraw, pathTrim);
      else if (layer._dashApplied) clearPathDash(layer);
      if (shapeStyleDelta) applyShapeStyleDelta(layer, shapeStyleDelta);
      else if (layer._shapeStyleApplied) clearShapeStyleDelta(layer);
      if (morphContrib) applyMorph(layer, morphContrib);
      else if (layer._morphApplied) clearMorph(layer);
    }
    if (fillRevealContrib) applyFillReveal(layer, fillRevealContrib);
    else if (layer._fillRevealApplied) clearFillReveal(layer);
    if (segmentRevealContrib) applySegmentReveal(layer, segmentRevealContrib);
    else if (layer._segmentRevealApplied) clearSegmentReveal(layer);
    // v19.20 (Option A′): no member recursion.  Member clips are
    // suspended into member._suspendedClips at group creation time
    // and restored on ungroup, so their clips array is empty while
    // grouped and there's nothing to process.
  }

  /* ---------------- v19.9 SVG COMPATIBILITY INSPECTOR ----------------
     Read-only analyzer for imported SVG layers.  Reports the counts,
     structural features, and effect-compatibility status that
     determine whether Line Draw / Trim Paths / Path Energize / Morph
     will do anything useful on the layer.

     No auto-repair yet.  Warnings identify what to fix externally
     (Illustrator / Figma) or via a future Conversion Assistance UI.

     Return shape:
       {
         primitiveCount, pathCount, primsByTag: {path,rect,...},
         visibleStrokes, visibleFills,
         hasClipPath, hasMask, hasFilter, hasLiveText, hasUse,
         pathAnimatable: bool,          // Line Draw / Trim Paths ready
         morphReady:    bool,           // >=1 drawable primitive present
         warnings: [{ level: "warn"|"info", text, fix?: string }]
       }
     Called from renderInspector when an SVG layer is selected; results
     rendered by populateSvgDiagnostics into #svgDiagBody. */
  function analyzeSvgLayer(layer) {
    const root = layer && layer.node;
    if (!root) return null;
    const primsByTag = {};
    ["path","rect","circle","ellipse","line","polygon","polyline"].forEach((t) => { primsByTag[t] = 0; });
    let primitiveCount = 0;
    let visibleStrokes = 0, visibleFills = 0;
    // v19.13: per-primitive reachability analysis.  For every drawable
    // element, we record whether it satisfies the requirements for
    // each effect family, so the diagnostic can report "X of Y paths
    // are reachable by Line Draw" instead of just "Y paths exist".
    const primEntries = [];   // { tag, hasStroke, hasFill, lineDrawReady, morphReady, reasons[] }
    let pathsMLCZOnly = 0;        // paths with only M/L/C/Z commands (morph-compatible)
    let pathsWithQ    = 0;        // quadratic bezier (Line Draw OK, morph NO)
    let pathsWithA    = 0;        // arc commands (Line Draw OK, morph NO)
    let pathsCompound = 0;        // multiple M commands = compound subpath
    let zeroLength    = 0;        // getTotalLength() === 0
    let lineDrawReady = 0;        // has stroke + non-zero length
    let morphReady    = 0;        // path/prim with M/L/C/Z-only geometry
    let fillRevealReady = 0;      // any drawable primitive is fill-reveal reachable
    root.querySelectorAll("path,rect,circle,ellipse,line,polygon,polyline").forEach((n) => {
      primitiveCount++;
      const tag = n.tagName.toLowerCase();
      if (primsByTag[tag] !== undefined) primsByTag[tag]++;
      const cs = window.getComputedStyle(n);
      const stroke = (n.getAttribute("stroke") != null ? n.getAttribute("stroke") : cs.stroke) || "none";
      const fill   = (n.getAttribute("fill")   != null ? n.getAttribute("fill")   : cs.fill)   || "none";
      const sw = parseFloat(n.getAttribute("stroke-width")) || parseFloat(cs.strokeWidth) || 0;
      const hasStroke = stroke !== "none" && sw > 0;
      const hasFill   = fill !== "none";
      if (hasStroke) visibleStrokes++;
      if (hasFill) visibleFills++;
      // Length check — 0 means the primitive is degenerate.
      let len = 0;
      try { if (typeof n.getTotalLength === "function") len = n.getTotalLength(); } catch (e) {}
      if (len === 0) zeroLength++;
      // Path command inventory (only meaningful for <path>).
      const reasons = [];
      let mlczOnly = true;
      let isCompound = false;
      if (tag === "path") {
        const d = n.getAttribute("d") || "";
        const cmds = d.match(/[a-zA-Z]/g) || [];
        const upper = cmds.map((c) => c.toUpperCase());
        const mCount = upper.filter((c) => c === "M").length;
        if (mCount > 1) { isCompound = true; pathsCompound++; }
        const hasQ = upper.some((c) => c === "Q" || c === "T");
        const hasA = upper.some((c) => c === "A");
        const hasS = upper.some((c) => c === "S");
        if (hasQ) { pathsWithQ++; mlczOnly = false; reasons.push("has quadratic (Q/T)"); }
        if (hasA) { pathsWithA++; mlczOnly = false; reasons.push("has arc (A)"); }
        if (hasS) { mlczOnly = false; reasons.push("has smooth cubic (S)"); }
        if (isCompound) reasons.push("compound (multi-M)");
        if (mlczOnly && !isCompound) pathsMLCZOnly++;
      } else {
        // Non-path primitives normalize cleanly to M/L/C/Z via primitiveToCanonicalPath.
        pathsMLCZOnly++;
      }
      const ldReady = hasStroke && len > 0;
      const morphOK = mlczOnly && !isCompound;
      if (ldReady) lineDrawReady++;
      if (morphOK) morphReady++;
      fillRevealReady++;   // Fill Reveal works on any drawable
      if (!hasStroke) reasons.unshift("no visible stroke");
      if (len === 0)  reasons.unshift("zero length");
      primEntries.push({
        tag, hasStroke, hasFill,
        lineDrawReady: ldReady,
        morphReady: morphOK,
        reasons,
      });
    });
    // Non-primitive elements that block animation coverage.
    const useCount    = root.querySelectorAll("use").length;
    const symbolCount = root.querySelectorAll("symbol").length;
    const groupWithTransform = Array.from(root.querySelectorAll("g")).filter((g) => g.getAttribute("transform")).length;
    const hasClipPath = !!root.querySelector("clipPath, [clip-path]");
    const hasMask     = !!root.querySelector("mask, [mask]");
    const hasFilter   = !!root.querySelector("filter, [filter]:not([filter='none'])");
    const hasLiveText = !!root.querySelector("text");
    const hasUse      = useCount > 0;
    const hasImage    = !!root.querySelector("image");
    const hasForeignObject = !!root.querySelector("foreignObject");
    const warnings = [];
    // Compatibility judgements
    const pathAnimatable = visibleStrokes > 0;
    const anyMorphReady = morphReady > 0;
    // v19.13: Coverage percentages — reported per effect family.  Base
    // is the primitive count; excludes <use> and <text> which never
    // reach effects even in principle.
    const coverage = {
      lineDraw:   primitiveCount > 0 ? Math.round((lineDrawReady   / primitiveCount) * 100) : 0,
      morph:      primitiveCount > 0 ? Math.round((morphReady      / primitiveCount) * 100) : 0,
      fillReveal: primitiveCount > 0 ? Math.round((fillRevealReady / primitiveCount) * 100) : 0,
    };
    if (visibleStrokes === 0 && visibleFills > 0) {
      warnings.push({ level: "warn", text: "Fill-only shapes: no visible strokes to animate.",
        fix: "In Illustrator/Figma: enable a stroke, or use Object > Path > Outline Stroke, then re-export.  Or use Fill Reveal instead, which works on filled artwork." });
    }
    if (primitiveCount === 0) {
      warnings.push({ level: "warn", text: "No drawable primitives found — this SVG has no paths, rects, circles, etc." });
    }
    // v19.13: report the invisible-to-effects categories.
    if (useCount > 0) warnings.push({ level: "warn",
      text: `${useCount} <use> reference${useCount===1?"":"s"} detected — effects apply to the referenced <symbol>, not per-instance.`,
      fix: `Illustrator: File > Export > Export As... > SVG > "Object IDs: Layer Names" and disable "Preserve Illustrator Editing Capabilities" to inline instances.  Or expand <use> to inline copies before export.` });
    if (pathsWithQ > 0 || pathsWithA > 0) {
      const parts = [];
      if (pathsWithQ) parts.push(`${pathsWithQ} with quadratic beziers (Q/T)`);
      if (pathsWithA) parts.push(`${pathsWithA} with arcs (A)`);
      warnings.push({ level: "info",
        text: `${parts.join(", ")} — Line Draw / Fill Reveal work, but Morph will report command-count mismatches on these.`,
        fix: `In Illustrator/Figma: Object > Path > Simplify, or export with "Cubic beziers only" if the option exists.` });
    }
    if (pathsCompound > 0) warnings.push({ level: "info",
      text: `${pathsCompound} compound path${pathsCompound===1?"":"s"} (multiple M commands) — Line Draw treats subpaths as one continuous run, which may look off.`,
      fix: `In Illustrator: Object > Compound Path > Release.` });
    if (zeroLength > 0) warnings.push({ level: "warn",
      text: `${zeroLength} degenerate primitive${zeroLength===1?"":"s"} with zero geometry — invisible to Line Draw.`,
      fix: `Usually caused by transform errors during export or empty paths.  Check the original file for stray empty shapes.` });
    if (groupWithTransform > 0) warnings.push({ level: "info",
      text: `${groupWithTransform} group${groupWithTransform===1?"":"s"} with transform attributes — path lengths are measured in local coords, so dash-based reveals may not match the visual scale.` });
    if (hasClipPath) warnings.push({ level: "warn", text: "Clip paths detected — may hide primitives from Line Draw.",
      fix: "Release clipping mask before export, or use the Repair button below." });
    if (hasMask)     warnings.push({ level: "warn", text: "Masks detected — masked regions may not animate.",
      fix: "Flatten mask into the source primitives, or use the Repair button below." });
    if (hasFilter)   warnings.push({ level: "info", text: "Filters detected — may not render identically in preview vs export." });
    if (hasLiveText) warnings.push({ level: "warn", text: "Live <text> detected — text glyphs are not path-animatable.",
      fix: "Convert to outlines (Illustrator: Type > Create Outlines) before export." });
    if (hasImage)    warnings.push({ level: "info", text: "Embedded <image> detected — raster content will not path-animate." });
    if (hasForeignObject) warnings.push({ level: "warn", text: "<foreignObject> detected — not compatible with vector effects." });
    return {
      primitiveCount, pathCount: primsByTag.path, primsByTag,
      visibleStrokes, visibleFills,
      hasClipPath, hasMask, hasFilter, hasLiveText, hasUse, hasImage, hasForeignObject,
      pathAnimatable, morphReady: anyMorphReady, warnings,
      // v19.13 additions
      useCount, symbolCount, groupWithTransform,
      pathsMLCZOnly, pathsWithQ, pathsWithA, pathsCompound, zeroLength,
      lineDrawReady, morphReadyCount: morphReady, fillRevealReady,
      coverage,
      primEntries,
    };
  }
  function populateSvgDiagnostics(layer) {
    if (!el.svgDiagBody) return;
    const rep = analyzeSvgLayer(layer);
    if (!rep) { el.svgDiagBody.innerHTML = ""; if (el.svgDiagStatus) el.svgDiagStatus.textContent = "—"; return; }
    // Status badge — quick visual summary.
    if (el.svgDiagStatus) {
      if (!rep.morphReady) { el.svgDiagStatus.textContent = "Empty"; el.svgDiagStatus.className = "badge status-warn"; }
      else if (!rep.pathAnimatable) { el.svgDiagStatus.textContent = "Fill-only"; el.svgDiagStatus.className = "badge status-warn"; }
      else if (rep.warnings.some((w) => w.level === "warn")) { el.svgDiagStatus.textContent = "Partial"; el.svgDiagStatus.className = "badge status-partial"; }
      else { el.svgDiagStatus.textContent = "Compatible"; el.svgDiagStatus.className = "badge status-ok"; }
    }
    const rows = [];
    const row = (label, value, cls) => rows.push(`<div class="diag-row ${cls || ""}"><span class="diag-label">${label}</span><span class="diag-value">${value}</span></div>`);
    row("Primitives", rep.primitiveCount);
    row("Paths",      rep.primsByTag.path);
    // Only show other primitive counts if non-zero
    ["rect","circle","ellipse","line","polygon","polyline"].forEach((t) => {
      if (rep.primsByTag[t]) row(t.charAt(0).toUpperCase() + t.slice(1), rep.primsByTag[t]);
    });
    // v19.13: structural counts users need to understand coverage gaps.
    if (rep.useCount) row("&lt;use&gt; refs",  rep.useCount);
    if (rep.symbolCount) row("&lt;symbol&gt; defs", rep.symbolCount);
    if (rep.groupWithTransform) row("Groups with transform", rep.groupWithTransform);
    row("Visible strokes", rep.visibleStrokes);
    row("Visible fills",   rep.visibleFills);
    // v19.13: path command inventory (only shown if paths exist).
    if (rep.primsByTag.path > 0) {
      if (rep.pathsMLCZOnly)  row("Paths — M/L/C/Z only", `<span class="diag-ok">${rep.pathsMLCZOnly}</span>`);
      if (rep.pathsWithQ)     row("Paths — with Q/T",     `<span class="diag-warn-inline">${rep.pathsWithQ}</span>`);
      if (rep.pathsWithA)     row("Paths — with arc (A)", `<span class="diag-warn-inline">${rep.pathsWithA}</span>`);
      if (rep.pathsCompound)  row("Compound paths",       `<span class="diag-warn-inline">${rep.pathsCompound}</span>`);
      if (rep.zeroLength)     row("Zero-length primitives", `<span class="diag-fail">${rep.zeroLength}</span>`);
    }
    let html = `<div class="diag-grid">${rows.join("")}</div>`;
    // v19.13: effect-by-effect coverage report — the "what will
    // actually animate on this SVG" report the user asked for.
    if (rep.primitiveCount > 0) {
      html += `<div class="coverage-block">`;
      html += `<div class="coverage-head">Effect coverage</div>`;
      const bar = (label, pct, count, total) => `
        <div class="coverage-row">
          <span class="coverage-label">${label}</span>
          <div class="coverage-bar"><div class="coverage-fill" style="width:${pct}%"></div></div>
          <span class="coverage-pct">${count}/${total} · ${pct}%</span>
        </div>`;
      html += bar("Line Draw / Path Energize", rep.coverage.lineDraw,   rep.lineDrawReady,   rep.primitiveCount);
      html += bar("Fill Reveal",               rep.coverage.fillReveal, rep.fillRevealReady, rep.primitiveCount);
      html += bar("Shape Morph",               rep.coverage.morph,      rep.morphReadyCount, rep.primitiveCount);
      html += `</div>`;
    }
    // Legacy summary lines kept for continuity.
    html = html.replace('<div class="coverage-block">', `<div class="coverage-block">`);
    if (rep.warnings.length) {
      html += `<ul class="diag-warnings">`;
      rep.warnings.forEach((w) => {
        html += `<li class="diag-${w.level}"><span class="diag-warn-mark">${w.level === "warn" ? "⚠" : "ℹ"}</span> ${w.text}`;
        if (w.fix) html += `<div class="diag-fix">${w.fix}</div>`;
        html += `</li>`;
      });
      html += `</ul>`;
    } else {
      html += `<div class="diag-clean">No compatibility warnings detected.</div>`;
    }
    // v19.11: SVG Repair — actionable buttons that mutate the imported
    // SVG in-place to remove blockers for path-based vector effects.
    // Shown only when there's something to repair.  All operations are
    // reversible via the Undo button, which restores the original
    // serialized SVG innerHTML captured at first repair.
    const repairOps = collectSvgRepairOps(layer);
    if (repairOps.available.length || layer._svgSnapshot) {
      html += `<div class="repair-section">`;
      html += `<div class="repair-head">Repairs</div>`;
      html += `<div class="repair-note">Repairs modify the imported SVG in-place. Clipped/masked regions become fully visible after release. Use Undo to revert.</div>`;
      html += `<div class="repair-btns">`;
      repairOps.available.forEach((op) => {
        html += `<button class="mini-btn repair-btn" data-repair="${op.key}" title="${op.tooltip}">${op.label} <span class="repair-count">${op.count}</span></button>`;
      });
      repairOps.unavailable.forEach((op) => {
        html += `<button class="mini-btn repair-btn repair-unavailable" disabled title="${op.tooltip}">${op.label} <span class="repair-count">—</span></button>`;
      });
      if (layer._svgSnapshot) {
        html += `<button class="mini-btn repair-undo" data-repair="undo" title="Restore the SVG to its state at import — reverts all in-place edits including Fill/Stroke and Repairs.">Restore original SVG</button>`;
      }
      html += `</div></div>`;
    }
    el.svgDiagBody.innerHTML = html;
    // Wire the repair buttons.  Each button dispatches to runSvgRepair
    // which mutates the DOM, invalidates caches, and re-renders the
    // diagnostics panel so users see the new compatibility state.
    el.svgDiagBody.querySelectorAll(".repair-btn, .repair-undo").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.repair;
        if (!key) return;
        runSvgRepair(layer, key);
      });
    });
  }

  /* Inventory of repairs available for a layer.  Each entry has:
     { key, label, tooltip, count } — count = number of elements the
     repair will affect.  Ops with count===0 are omitted.  */
  function collectSvgRepairOps(layer) {
    const root = layer && layer.node; if (!root) return { available: [], unavailable: [] };
    const clipRefs = root.querySelectorAll("[clip-path]").length;
    const maskRefs = root.querySelectorAll("[mask]").length;
    // Convertible primitives = anything that isn't already a <path>.
    const convertibles = root.querySelectorAll("rect, circle, ellipse, line, polygon, polyline").length;
    const available = [];
    if (clipRefs > 0) available.push({
      key: "release-clip-paths",
      label: "Release clip paths",
      tooltip: `Remove ${clipRefs} clip-path attribute${clipRefs===1?"":"s"} and their <clipPath> definitions. Clipped regions become fully visible.`,
      count: clipRefs,
    });
    if (maskRefs > 0) available.push({
      key: "remove-masks",
      label: "Remove masks",
      tooltip: `Remove ${maskRefs} mask attribute${maskRefs===1?"":"s"} and their <mask> definitions. Masked regions become fully visible.`,
      count: maskRefs,
    });
    if (convertibles > 0) available.push({
      key: "convert-shapes",
      label: "Convert shapes to paths",
      tooltip: `Convert ${convertibles} primitive shape${convertibles===1?"":"s"} (rect/circle/ellipse/line/polygon) into <path> elements. Improves compatibility with external tools and future features.`,
      count: convertibles,
    });
    // Unavailable ops — surfaced so users know they exist but aren't ready.
    const unavailable = [];
    // Expand Strokes needs a real stroke-offset library.  Flag it as
    // planned rather than pretending to implement it.
    const strokedPaths = Array.from(root.querySelectorAll("path, rect, circle, ellipse, line, polygon, polyline")).filter((n) => {
      const cs = window.getComputedStyle(n);
      const s = n.getAttribute("stroke") ?? cs.stroke;
      return s && s !== "none";
    }).length;
    if (strokedPaths > 0) unavailable.push({
      key: "expand-strokes",
      label: "Expand strokes",
      tooltip: `Not yet available — accurate stroke-to-fill conversion requires a geometry library. Planned for a future update. (${strokedPaths} stroked primitives would be affected.)`,
    });
    return { available, unavailable };
  }

  /* Run a repair operation.  Snapshots the SVG on first mutation so
     undo can restore the original.  Invalidates layer caches so path
     effects find the new elements. */
  function runSvgRepair(layer, op) {
    if (!layer || !layer.node) return;
    if (op === "undo") {
      if (!layer._svgSnapshot) { toast("Nothing to undo"); return; }
      layer.node.innerHTML = layer._svgSnapshot;
      layer._svgSnapshot = null;
      layer._svgRepairsApplied = [];
      // Invalidate every cached DOM reference — the primitives are new nodes.
      layer._primitives = null; layer._segmentPrims = null; layer._segmentOrder = null;
      layer._strokes = null;
      layer._morphPath = null;
      layer._morphOrigNode = null;
      layer._morphOrigD = null;
      layer._dashApplied = false;
      layer._shapeStyleApplied = false;
      layer._morphApplied = false;
      populateSvgDiagnostics(layer);
      renderLayers();       // refresh thumbnail
      paintIfPaused();
      toast("SVG repairs undone");
      return;
    }
    // Snapshot BEFORE first mutation.
    if (!layer._svgSnapshot) layer._svgSnapshot = layer.node.innerHTML;
    if (!layer._svgRepairsApplied) layer._svgRepairsApplied = [];
    let n = 0;
    if (op === "release-clip-paths") n = releaseClipPaths(layer.node);
    else if (op === "remove-masks") n = removeMasks(layer.node);
    else if (op === "convert-shapes") n = convertShapesToPaths(layer.node);
    else { toast("Unknown repair"); return; }
    if (!layer._svgRepairsApplied.includes(op)) layer._svgRepairsApplied.push(op);
    // Invalidate caches — DOM has been mutated.
    layer._primitives = null; layer._segmentPrims = null; layer._segmentOrder = null;
    layer._strokes = null;
    layer._dashApplied = false;
    layer._shapeStyleApplied = false;
    // Refresh diagnostics + thumbnail + paint.
    populateSvgDiagnostics(layer);
    renderLayers();
    paintIfPaused();
    toast(`Repaired: ${n} element${n===1?"":"s"} affected`);
  }

  /* --- Individual repair operations --- */

  /* Release all clip paths: remove <clipPath> definitions AND clip-path
     attributes.  Returns the number of ELEMENTS whose appearance
     changes (i.e., that had clip-path references).  Definitions are
     removed as cleanup — they don't render on their own. */
  function releaseClipPaths(root) {
    let refs = 0;
    root.querySelectorAll("[clip-path]").forEach((n) => { n.removeAttribute("clip-path"); refs++; });
    // Also strip `clip-path` from inline styles (some Illustrator exports use style="clip-path:...")
    root.querySelectorAll("*").forEach((n) => {
      if (n.style && n.style.clipPath) { n.style.clipPath = ""; refs++; }
    });
    root.querySelectorAll("clipPath").forEach((cp) => cp.parentNode.removeChild(cp));
    return refs;
  }
  /* Remove all masks: <mask> definitions + mask attributes. */
  function removeMasks(root) {
    let refs = 0;
    root.querySelectorAll("[mask]").forEach((n) => { n.removeAttribute("mask"); refs++; });
    root.querySelectorAll("*").forEach((n) => {
      if (n.style && n.style.mask) { n.style.mask = ""; refs++; }
    });
    root.querySelectorAll("mask").forEach((m) => m.parentNode.removeChild(m));
    return refs;
  }
  /* Convert primitive shapes into <path> elements.  Reuses the same
     canonicalization used by the morph subsystem so behavior is
     consistent.  Preserves stroke/fill/opacity/transform/id/class. */
  function convertShapesToPaths(root) {
    const svgNS = "http://www.w3.org/2000/svg";
    let converted = 0;
    // Snapshot the list — we're going to replace each node.
    const nodes = Array.from(root.querySelectorAll("rect, circle, ellipse, line, polygon, polyline"));
    nodes.forEach((node) => {
      const canonical = primitiveToCanonicalPath(node, "straight");
      if (!canonical) return;
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", canonical.d);
      // Copy every attribute except geometry-defining ones.  Preserves
      // fill/stroke/stroke-width/opacity/transform/class/id and any
      // custom data-* attributes the source SVG uses.
      const skip = new Set(["x","y","width","height","rx","ry","cx","cy","r","x1","y1","x2","y2","points"]);
      for (const attr of Array.from(node.attributes)) {
        if (skip.has(attr.name)) continue;
        path.setAttribute(attr.name, attr.value);
      }
      node.parentNode.replaceChild(path, node);
      converted++;
    });
    return converted;
  }

  function animateSubLayers(layer, t, sig, allowT) {
    const fl = STATE.flicker / 100;
    // v18.7: detect an active flickerBlocks clip at current time
    // (was `layer.fx.includes("flickerBlocks")` under the old system).
    const now = STATE.time;
    let flickerBlocksActive = false;
    if (layer.clips && layer.clips.length) {
      for (const c of layer.clips) {
        if (c.fxKey !== "flickerBlocks" || c.enabled === false) continue;
        const s = layer.start + c.start, e = s + c.duration;
        if (now >= s - 0.001 && now <= e + 0.001) { flickerBlocksActive = true; break; }
      }
    }
    layer.subLayers.forEach((node) => {
      const rc = node._recipe; if (!rc) return;
      const lt = t - rc.delay, band = rc.band === "bass" ? sig.bass : rc.band === "mid" ? sig.mid : sig.high;
      let op = 0.78 + 0.22 * Math.sin(lt * rc.freq * 1.3 + rc.phase);
      if (flickerBlocksActive && Math.random() < 0.03 * fl * rc.flickerBias) op *= 0.25;
      let transform = "";
      if (allowT) { const dx = Math.sin(lt * rc.freq + rc.phase) * rc.ampX * (1 + band * 2), dy = Math.cos(lt * rc.freq * 0.7 + rc.phase) * rc.ampY * (1 + band * 1.5); node.style.transformBox = "fill-box"; node.style.transformOrigin = "center"; transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`; }
      node.style.transform = transform; node.style.opacity = clamp01(op).toFixed(2);
    });
  }

  function updateHud(want, flicker, t) {
    if (!want) { if (hudLayer) hudLayer.style.display = "none"; return; }
    if (!hudLayer) { hudLayer = document.createElement("div"); hudLayer.className = "fx fx-hud"; hudLayer.innerHTML = '<span class="hud-c hud-tl">\u2310 PHASER.SYS</span><span class="hud-c hud-tr">REC \u25cf</span><span class="hud-c hud-bl">X:0420 Y:1080</span><span class="hud-c hud-br">SCAN // LIVE</span><span class="hud-corner hud-c-tl"></span><span class="hud-corner hud-c-tr"></span><span class="hud-corner hud-c-bl"></span><span class="hud-corner hud-c-br"></span>'; el.artboard.appendChild(hudLayer); }
    hudLayer.style.display = "block"; hudLayer.style.opacity = (0.5 + 0.5 * flicker * (0.6 + 0.4 * Math.sin(t * 8))).toFixed(2);
  }
  function updateFlash(color, alpha) { if (!flashOverlay) { flashOverlay = document.createElement("div"); flashOverlay.className = "fx fx-flash"; el.artboard.appendChild(flashOverlay); } if (color && alpha > 0) { flashOverlay.style.background = color; flashOverlay.style.opacity = alpha; } else flashOverlay.style.opacity = 0; }
  function updatePlayheads(t) {
    // Use integer px for the playhead's `left` so sub-pixel rounding
    // in the compositor doesn't produce visible drift while scrubbing.
    // Timecode uses 3 decimals for millisecond-level readout.
    const pct = STATE.duration ? (t / STATE.duration) : 0;
    if (el.tlPlayhead) {
      const px = Math.round(pct * (el.tlTracks.clientWidth || 0));
      el.tlPlayhead.style.left = px + "px";
      // v19.30: floating time badge on the playhead.
      const badge = document.getElementById("tlPlayheadTime");
      if (badge) badge.textContent = t.toFixed(3);
    }
    if (el.timecode && document.activeElement !== el.timecode) {
      // v19.0: timecode is now an editable input.  Only overwrite when
      // it isn't being typed into, so live-updates during playback
      // don't clobber the user's edit.
      el.timecode.value = t.toFixed(3);
    }
    if (el.timecodeFrame) {
      const fps = STATE.fps || 30;
      el.timecodeFrame.textContent = Math.round(t * fps) + "f";
    }
  }
  function togglePlay() {
    STATE.playing = !STATE.playing;
    const show = (i, p) => { if (i) i.style.display = STATE.playing ? "none" : "block"; if (p) p.style.display = STATE.playing ? "block" : "none"; };
    show(el.playIcon, el.pauseIcon); show(el.topPlayIcon, el.topPauseIcon);
    if (STATE.playing) {
      rafStart = performance.now() - STATE.time * 1000;
      ensureCtx();
      if (audio.ready) {
        if (audio.ctx.state === "suspended") audio.ctx.resume();
        try { audio.el.currentTime = STATE.time; } catch (e) {}
        audio.el.play().catch(() => {});
      }
      // Sync + start every video layer.  syncVideoLayerToTimeline
      // handles the hard-seek + play() call.
      layers.forEach((L) => { if (L.kind === "VIDEO") syncOrPaintVideoLayer(L, STATE.time, true); });
      // schedule all SFX/voice clips
      schedulePlayback(STATE.time);
    } else {
      if (audio.ready) audio.el.pause();
      stopAllAudioClipSources();
      // Pause every video layer.
      layers.forEach((L) => { if (L.kind === "VIDEO" && L.videoEl && !L.videoEl.paused) { try { L.videoEl.pause(); } catch (e) {} } });
      stopPreview();
      renderStaticFrame();
    }
  }
  // Start playback only if not already playing (used when an effect/preset
  // is applied). Never toggles off.
  function startPlayback() { if (!STATE.playing) togglePlay(); }

  /* ---------------- PRESETS ---------------- */
  function buildPresets() {
    Object.keys(PRESETS).forEach((name) => {
      const b = document.createElement("button"); b.className = "preset";
      b.innerHTML = `<span class="preset-dot"></span><span>${name}</span>`;
      b.addEventListener("click", () => applyPreset(name)); el.presetGrid.appendChild(b);
    });
  }
  function applyPreset(name, toAll) {
    const p = PRESETS[name]; if (!p) return;
    /* v19.10 PRESET TOGGLE + CLEAR + BASELINE RESTORE.
       Clicking the same preset twice now disables it — removes every
       clip that was created by that preset and restores the global
       STATE.patch values (flicker/rgbSplit/scanline/glow/etc.) to
       their pre-preset baseline.  Clicking a DIFFERENT preset also
       clears the previous one first, so presets don't accumulate. */
    // Case 1: user clicked the currently-active preset → toggle off.
    if (STATE._activePreset === name) {
      _removeActivePreset();
      toast(`${name} disabled`);
      return;
    }
    // Case 2: a different preset is active → remove it first.
    if (STATE._activePreset) _removeActivePreset({ quiet: true });
    // Case 3: fresh apply — snapshot baseline first so we can restore.
    STATE._prePresetPatch = {};
    Object.keys(p.patch || {}).forEach((k) => { if (k in STATE) STATE._prePresetPatch[k] = STATE[k]; });
    Object.entries(p.patch).forEach(([k, v]) => { if (k in STATE) STATE[k] = v; });
    syncControls();
    const targets = (toAll || !selectedLayer) ? layers : [selectedLayer];
    if (!targets.length) { toast("Add a layer first"); return; }
    // Track which clips this apply created so we can remove exactly those
    // on toggle-off, without touching user-added clips of the same fxKey.
    const createdClipIds = [];
    targets.forEach((layer, i) => {
      // v18.7: preset "fx" list becomes clips on the layer's timeline.
      // Each preset key gets a clip using its FX_EVENT_DEF metadata
      // (defDur, placement).  Any pre-existing clip of the same
      // fxKey is removed first so re-applying a preset doesn't
      // stack duplicates.
      const presetKeys = new Set(p.fx || []);
      layer.clips = (layer.clips || []).filter((c) => !presetKeys.has(c.fxKey));
      (p.fx || []).forEach((fxKey) => {
        if (!FX_EVENT_DEF.has(fxKey)) return;   // unknown key — skip
        const clip = createEventClip(fxKey, layer);
        if (clip) {
          // v19.10: tag every clip we just added so toggle-off can
          // remove exactly these ones without disturbing user clips.
          clip._presetTag = name;
          createdClipIds.push(clip.id);
        }
      });
      // presets never force transform motion on; keep it as the user set it
      if (p.stagger && targets.length > 1) { layer.recipe = makeRecipe((layer.id * 131 + i * 997) >>> 0); layer.start = Math.min(STATE.duration * 0.5, i * 0.25); }
      else if (targets.length > 1) { layer.recipe = makeRecipe((layer.id * 131 + i * 331) >>> 0); }
    });
    STATE._activePreset = name;
    STATE._activePresetClipIds = createdClipIds;
    $$(".preset").forEach((c) => c.classList.toggle("active", c.textContent.trim() === name));
    renderTimeline(); renderInspector();
    startPlayback();
    toast(targets.length > 1 ? `Applied ${name} to ${targets.length} layers` : `Applied ${name}`);
  }
  /* Remove the currently-active preset: uncreate its tagged clips and
     restore the pre-preset STATE.patch values.  Called from applyPreset
     when toggling and from #clearPresetBtn. */
  function _removeActivePreset(opts) {
    opts = opts || {};
    const name = STATE._activePreset;
    if (!name) return;
    const ids = new Set(STATE._activePresetClipIds || []);
    let removedCount = 0;
    layers.forEach((layer) => {
      if (!layer.clips) return;
      const before = layer.clips.length;
      layer.clips = layer.clips.filter((c) => !(c._presetTag === name || ids.has(c.id)));
      removedCount += before - layer.clips.length;
    });
    // Restore snapshotted STATE.patch values so global sliders return
    // to what the user had before the preset was applied.
    if (STATE._prePresetPatch) {
      Object.entries(STATE._prePresetPatch).forEach(([k, v]) => { if (k in STATE) STATE[k] = v; });
    }
    STATE._activePreset = null;
    STATE._activePresetClipIds = null;
    STATE._prePresetPatch = null;
    syncControls();
    $$(".preset").forEach((c) => c.classList.remove("active"));
    renderTimeline(); renderInspector();
    // Clear any lingering vector effect residue on affected layers.
    layers.forEach((L) => {
      if (typeof clearPathDash === "function")       clearPathDash(L);
      if (typeof clearShapeStyleDelta === "function") clearShapeStyleDelta(L);
      if (typeof clearMorph === "function")           clearMorph(L);
    });
    paintIfPaused();
    if (!opts.quiet) toast(`Preset cleared (${removedCount} clip${removedCount === 1 ? "" : "s"} removed)`);
  }
  function applyMotionAll() { if (!layers.length) { toast("Add layers first"); return; } applyPreset("Signal System", true); toast("Motion applied to all layers"); }

  /* ---------------- AI DIRECTOR ---------------- */
  /* ---------------- AI DIRECTOR ----------------
     Each rule pushes named changes into `changes[]` so we can display an
     explicit "Detected → Applied" list. Rules modify STATE, layer.fx,
     event clips, and (for reference-style prompts) create timeline events. */
  function _rule(kw, name, fn) { return { kw, name, fn }; }
  const AI_RULES = [
    _rule(["no rotation", "no scale", "no zoom", "static", "still"], "Static layers", (ch) => {
      layers.forEach((l) => { l.allowTransform = false; l.transform.rot = 0; });
      if (el.allowTransform) el.allowTransform.checked = false;
      renderInspector();
      ch.push("transform motion disabled", "rotation reset to 0", "scale pulse disabled");
    }),
    _rule(["scanlines and rgb only", "scanline and rgb only", "scanlines only", "rgb only", "only opacity", "only appearance"], "Appearance only", (ch) => {
      layerFxAll(["scanRevealEvent", "rgbOffset", "flickerBlocks"]);
      layers.forEach((l) => l.allowTransform = false);
      ch.push("sustained clips set to scanReveal + rgbOffset + flickerBlocks", "transform motion disabled");
    }),
    _rule(["cleaner", "clean", "minimal", "elegant"], "Cleaner", (ch) => { set("glitch", 10); set("noise", 8); set("flicker", 14); bump("blur", -4); layerFxAll(["blurIn", "pulseGlow"]); ch.push("glitch/noise/flicker lowered", "layer fx = Blur-in + Pulse Glow"); }),
    _rule(["more aggressive", "aggressive", "harder", "intense", "harsh"], "Aggressive", (ch) => { bump("glitch", 25); bump("rgbSplit", 20); bump("bassReaction", 20); bump("motionIntensity", 15); layerFxAll(["hardCutEvent", "rgbOffset", "flickerBlocks", "dataBreakEvent", "pulseGlow"]); ch.push("glitch/RGB/bass reaction increased", "clips added: hard cut + RGB + flicker + breakup + glow"); }),
    _rule(["synced to the beat", "more synced", "sync to the beat", "beat sync", "on beat", "on peaks"], "Beat sync", (ch) => {
      bump("beatSensitivity", 25); bump("bassReaction", 25); bump("peakThreshold", -10); bump("syncTightness", 20); bump("motionIntensity", 15);
      STATE.audioReactive = true; if (el.audioReactiveToggle) el.audioReactiveToggle.checked = true;
      STATE.autoKeyframes = true; if (el.autoKeyframes) el.autoKeyframes.checked = true;
      ch.push("beat sensitivity increased", "peak threshold lowered", "auto peak events enabled (Focus Snap / Signal Interrupt / RGB Spike)");
    }),
    _rule(["1:1 post", "square post", "1080 x 1080", " post"], "Post 1:1", (ch) => { setFormat(1080, 1080, "Post 1:1"); ch.push("format = 1080\u00d71080"); }),
    _rule(["ig reel", "instagram reel", "reel", "vertical", "9:16"], "Reel 9:16", (ch) => { setFormat(1080, 1920, "Reel 9:16"); setDuration(8); ch.push("format = 1080\u00d71920", "duration = 8s"); }),
    _rule(["portrait", "4:5"], "Portrait 4:5", (ch) => { setFormat(1080, 1350, "Portrait 4:5"); ch.push("format = 1080\u00d71350"); }),
    _rule(["landscape", "16:9"], "Landscape 16:9", (ch) => { setFormat(1920, 1080, "Landscape 16:9"); ch.push("format = 1920\u00d71080"); }),
    _rule(["transparent png", "transparent", "alpha", "no background"], "Transparent", (ch) => { setBackground("transparent"); EXPORTOPTS.transparent = true; if (el.optTransparent) el.optTransparent.checked = true; ch.push("background = transparent", "PNG stills armed with alpha"); }),
    _rule(["every layer different", "each layer different", "vary layers", "layers different"], "Vary layers", (ch) => {
      const evtKeys = ["focusSnap", "signalInterrupt", "rgbSpike", "hardCutEvent"];
      layers.forEach((l, i) => {
        l.recipe = makeRecipe((l.id * 131 + Math.floor(Math.random() * 99999)));
        l.start = Math.min(STATE.duration * 0.5, i * 0.3);
        // add a unique event per layer at a staggered offset
        const key = evtKeys[i % evtKeys.length], def = FX_EVENTS.find((f) => f.key === key);
        const start = clamp(0.5 + i * 0.6, 0, l.duration - def.defDur);
        l.clips.push({ id: ++idSeq, fxKey: key, start, duration: def.defDur, enabled: true, params: defaultParamsFor(key) });
      });
      renderTimeline();
      ch.push("unique recipes per layer", "staggered starts", `unique event per layer (${layers.length} events created)`);
    }),
    _rule(["terrain scanner", "terrain"], "Terrain Scanner", (ch) => { applyPreset("Terrain Scanner", !selectedLayer); ch.push("preset = Terrain Scanner (Line Draw + Radar + Coord Blink + Scan Reveal + Data Stream)"); }),
    _rule(["signal system"], "Signal System", (ch) => { applyPreset("Signal System", !selectedLayer); ch.push("preset = Signal System"); }),
    _rule(["hardware motion"], "Hardware Motion", (ch) => { applyPreset("Hardware Motion", !selectedLayer); ch.push("preset = Hardware Motion"); }),
    _rule(["interface motion", "interface intro"], "Interface Intro", (ch) => { applyPreset("Interface Intro", !selectedLayer); ch.push("preset = Interface Intro"); }),
    _rule(["vector scan", "radar"], "Vector Scan", (ch) => { applyPreset("Vector Scan", !selectedLayer); ch.push("preset = Vector Scan"); }),
    _rule(["signal loss"], "Signal Loss", (ch) => { applyPreset("Signal Loss", !selectedLayer); ch.push("preset = Signal Loss"); }),
    _rule(["data pulse"], "Data Pulse", (ch) => { applyPreset("Data Pulse", !selectedLayer); ch.push("preset = Data Pulse"); }),
    _rule(["crt", "scanline", "scanlines"], "CRT scan", (ch) => { bump("scanline", 30); applyPreset("CRT Monitor", !selectedLayer); ch.push("scanline level bumped", "preset = CRT Monitor"); }),
    _rule(["detroit", "techno"], "Detroit Techno", (ch) => { applyPreset("Detroit Techno", !selectedLayer); ch.push("preset = Detroit Techno"); }),
    _rule(["data terminal", "terminal"], "Data Terminal", (ch) => { applyPreset("Data Terminal", !selectedLayer); ch.push("preset = Data Terminal"); }),
    _rule(["focus snap"], "Focus Snap event", (ch) => { const c = createEventClip("focusSnap", selectedLayer); if (c) ch.push(`Focus Snap event @ ${c.start.toFixed(2)}s (${c.duration}s)`); }),
    _rule(["signal interrupt", "interrupt"], "Signal Interrupt event", (ch) => { const c = createEventClip("signalInterrupt", selectedLayer); if (c) ch.push(`Signal Interrupt @ ${c.start.toFixed(2)}s`); }),
    _rule(["rgb spike"], "RGB Spike event", (ch) => { const c = createEventClip("rgbSpike", selectedLayer); if (c) ch.push(`RGB Spike @ ${c.start.toFixed(2)}s`); }),
    _rule(["hud", "overlay", "coordinates", "labels"], "HUD overlay", (ch) => { layerFxAdd("hudOverlay"); ch.push("HUD Overlay added to layer fx"); }),
    _rule(["glow", "pulse glow"], "Pulse glow", (ch) => { layerFxAdd("pulseGlow"); ch.push("Pulse Glow added"); }),
    _rule(["hologram", "tilt", "3d card"], "Hologram tilt", (ch) => { if (selectedLayer) { selectedLayer.allowTransform = true; if (el.allowTransform) el.allowTransform.checked = true; } layerFxAdd("hologramTilt"); ch.push("transform motion enabled", "Hologram Tilt added"); }),
    _rule(["shake"], "Signal shake", (ch) => { if (selectedLayer) { selectedLayer.allowTransform = true; if (el.allowTransform) el.allowTransform.checked = true; } layerFxAdd("signalShake"); ch.push("transform motion enabled", "Signal Shake added"); }),
    _rule(["allow transform", "enable transform", "allow motion"], "Transform on", (ch) => { (selectedLayer ? [selectedLayer] : layers).forEach((l) => l.allowTransform = true); if (el.allowTransform) el.allowTransform.checked = true; renderInspector(); ch.push("Allow transform motion enabled on target layer(s)"); }),
    _rule(["dark", "darker", "moody"], "Darker", (ch) => { setBackground("custom", "#050506"); bump("scanline", 12); ch.push("background darkened", "scanline level bumped"); }),
    _rule(["slow", "slower", "calm"], "Slower", (ch) => { set("speed", 25); bump("flicker", -12); ch.push("speed lowered", "flicker lowered"); }),
    _rule(["fast", "faster", "rapid"], "Faster", (ch) => { set("speed", 82); bump("flicker", 12); ch.push("speed raised", "flicker raised"); }),
    _rule(["mp4", "h.264", "h264", "export"], "Export sheet", (ch) => { openSheet(); ch.push("opened export panel"); }),
  ];
  const bump = (k, d) => (STATE[k] = clampP(STATE[k] + d));
  const set = (k, v) => (STATE[k] = clampP(v));
  const clampP = (v) => Math.max(0, Math.min(100, v));
  // v18.7: these helpers now create timeline clips rather than
  // mutating a per-layer sustained-effect array.  The behavior stays
  // the same from an AI Director perspective — same effect keys get
  // applied to same layers — but users see them as visible timeline
  // clips they can edit or remove.
  function layerFxAll(arr) {
    (selectedLayer ? [selectedLayer] : layers).forEach((l) => {
      // Replace any existing preset-style sustained clips with the new set.
      const presetKeys = new Set(arr);
      l.clips = (l.clips || []).filter((c) => !presetKeys.has(c.fxKey));
      arr.forEach((fxKey) => { if (FX_EVENT_DEF.has(fxKey)) createEventClip(fxKey, l); });
    });
    renderInspector(); renderTimeline();
  }
  function layerFxAdd(fx) {
    (selectedLayer ? [selectedLayer] : layers).forEach((l) => {
      const already = (l.clips || []).some((c) => c.fxKey === fx);
      if (!already && FX_EVENT_DEF.has(fx)) createEventClip(fx, l);
    });
    renderInspector(); renderTimeline();
  }
  function runAI() {
    const text = el.aiPrompt.value.toLowerCase().trim();
    if (!text) { el.aiEcho.innerHTML = 'Type a direction first, like <em>"make it more synced to the beat"</em>.'; return; }
    const detected = [], changes = [];
    AI_RULES.forEach((r) => {
      if (r.kw.some((k) => text.includes(k))) { detected.push(r.name); r.fn(changes); }
    });
    syncControls();
    if (changes.length) startPlayback();
    if (!detected.length) {
      el.aiEcho.innerHTML = 'No keywords matched. Try: <em>"cleaner"</em>, <em>"more aggressive"</em>, <em>"synced to the beat"</em>, <em>"no rotation, no scale, scanlines and RGB only"</em>, <em>"terrain scanner"</em>, <em>"every layer different"</em>, <em>"focus snap"</em>.';
    } else {
      el.aiEcho.innerHTML = `<strong>Detected:</strong> ${detected.map(escHtml).join(" \u00b7 ")}<br><strong>Applied:</strong> ${changes.map((c) => "\u2022 " + escHtml(c)).join("<br>")}`;
    }
  }
  function escHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  /* ---------------- CONTROLS ---------------- */
  function buildControls() {
    Object.entries(CONTROL_GROUPS).forEach(([group, items]) => { const c = document.querySelector(`.controls[data-group="${group}"]`); if (!c) return; items.forEach(({ key, label }) => addSlider(c, key, label)); });
  }
  function addSlider(container, key, label) {
    const wrap = document.createElement("div"); wrap.className = "control";
    wrap.innerHTML = `<span class="ctl-label">${label}</span><span class="ctl-val" id="scv-${key}">${STATE[key]}</span><input type="range" min="0" max="100" value="${STATE[key]}" id="sc-${key}" style="--pct:${STATE[key]}%">`;
    container.appendChild(wrap);
    wrap.querySelector("input").addEventListener("input", (e) => { STATE[key] = +e.target.value; document.getElementById(`scv-${key}`).textContent = STATE[key]; e.target.style.setProperty("--pct", STATE[key] + "%"); paintIfPaused(); });
  }
  function syncControls() { [...CONTROL_GROUPS.beatsync, ...CONTROL_GROUPS.scene].forEach(({ key }) => { const i = document.getElementById(`sc-${key}`), v = document.getElementById(`scv-${key}`); if (i) { i.value = STATE[key]; i.style.setProperty("--pct", STATE[key] + "%"); } if (v) v.textContent = STATE[key]; }); }

  /* ---------------- BACKGROUND ---------------- */
  function setBackground(mode, color) {
    STATE.bgMode = mode; if (color) STATE.bgColor = color;
    let css;
    switch (mode) { case "black": STATE.bgColor = "#000000"; css = "#000000"; break; case "white": STATE.bgColor = "#FFFFFF"; css = "#FFFFFF"; break; case "gradient": css = `linear-gradient(150deg, ${STATE.bgColor}, ${STATE.bgColor2})`; break; case "transparent": css = "transparent"; break; default: css = STATE.bgColor; }
    el.artboard.classList.toggle("checkerboard", mode === "transparent");
    el.artboard.style.setProperty("--frame-bg", mode === "transparent" ? "transparent" : css);
    if (el.bgColor && /^#/.test(STATE.bgColor)) el.bgColor.value = STATE.bgColor;
    if (el.bgHex) el.bgHex.textContent = mode === "transparent" ? "TRANSPARENT" : (mode === "gradient" ? "GRADIENT" : STATE.bgColor.toUpperCase());
    $$(".bg-swatch").forEach((sw) => sw.classList.toggle("active", sw.dataset.bg === mode));
    paintIfPaused();
  }

  /* ---------------- FORMAT + ZOOM ---------------- */
  function setFormat(w, h, label) {
    STATE.format = { w, h, label };
    el.artboard.style.width = w + "px"; el.artboard.style.height = h + "px";
    el.readoutCanvas.textContent = `${w} \u00d7 ${h}`;
    el.readoutFormat.textContent = label;
    $$(".fmt").forEach((b) => b.classList.toggle("active", +b.dataset.w === w && +b.dataset.h === h));
    fitZoom(); setTimeout(renderTimeline, 30);
    paintIfPaused();
  }
  function fitZoom() {
    const pad = 88, sw = el.stage.clientWidth || 800, sh = el.stage.clientHeight || 600;
    const availW = Math.max(50, sw - pad), availH = Math.max(50, sh - pad);
    const z = Math.min(availW / STATE.format.w, availH / STATE.format.h);
    STATE.zoom = Math.max(0.02, z); STATE.zoomMode = "fit"; applyZoom();
  }
  function setZoom(z) { STATE.zoom = clamp(z, 0.05, 4); STATE.zoomMode = "manual"; applyZoom(); }
  function applyZoom() {
    const zoom = STATE.zoom, A = STATE.format;
    // v18.9 canvas navigation: the scaler must reserve LAYOUT space
    // equal to the scaled artboard so that .stage scrollbars know
    // when to appear.  transform-origin is now top-left so visible
    // bounds match layout bounds.
    el.artboardScaler.style.transform = `scale(${zoom})`;
    el.artboardScaler.style.width  = (A.w * zoom) + "px";
    el.artboardScaler.style.height = (A.h * zoom) + "px";
    // v18.9: keep artboard-scaler's INNER artboard at its native px
    // size — the transform on the scaler handles the visual scaling.
    // (Inner artboard was already sized in px in setFormat / init.)
    // Fit-mode auto-hides scrollbars.
    if (el.stage) el.stage.classList.toggle("fit-mode", STATE.zoomMode === "fit");
    const label = STATE.zoomMode === "fit" ? "Fit" : Math.round(STATE.zoom * 100) + "%";
    el.zoomVal.textContent = label; el.readoutZoom.textContent = label;
    $$("#zoomPresets [data-zoom]").forEach((b) => b.classList.toggle("active", STATE.zoomMode === "manual" && Math.abs(STATE.zoom - +b.dataset.zoom) < 0.001));
  }

  /* ============================================================ EXPORT ============================================================ */
  const EXPORTOPTS = { transparent: false, duration: 8, fps: 30, includeAudio: true, quality: "high", bg: "selected", target: "comp", lmode: "canvas" };

  function openSheet() { el.exportSheet.hidden = false; syncExportUI(); setExportStatus("Ready", "info"); }
  function closeSheet() { el.exportSheet.hidden = true; }
  function qualScale() { return EXPORTOPTS.quality === "2x" ? 2 : EXPORTOPTS.quality === "ultra" ? 1.5 : 1; }

  /* ============================================================
     BACKGROUND RESOLUTION — explicit modes, safe fallback for video.
     - forVideo=true: video codecs don't support alpha reliably, so if
       the resolved bg would be null (transparent), fall back to a solid
       colour ('black' by default) UNLESS the user explicitly requested
       Alpha WebM (`wantAlphaVideo=true` passed by exportWebM).
     - For stills: honour transparent all the way.
     Returns:
       null                 => truly transparent (still exports only)
       "#RRGGBB"            => solid colour
       { grad: [c1, c2] }   => gradient
     ============================================================ */
  function resolveExportBg(forVideo, wantAlphaVideo) {
    // 1) Explicit segmented control on the export sheet overrides
    if (EXPORTOPTS.bg === "black") return "#000000";
    if (EXPORTOPTS.bg === "white") return "#FFFFFF";
    if (EXPORTOPTS.bg === "transparent") {
      if (forVideo && !wantAlphaVideo) return "#000000"; // safe fallback for video
      return null;
    }
    // 2) "Selected" => follow the current artboard mode
    const paint = currentBgPaint();
    if (paint === null) {
      // artboard is transparent
      if (forVideo && !wantAlphaVideo) return "#000000"; // no alpha in video codec
      return null;
    }
    return paint;
  }
  function currentBgPaint() {
    if (STATE.bgMode === "transparent") return null;
    if (STATE.bgMode === "gradient") return { grad: [STATE.bgColor, STATE.bgColor2] };
    if (STATE.bgMode === "white") return "#FFFFFF";
    if (STATE.bgMode === "black") return "#000000";
    return STATE.bgColor;
  }

  /* ================ PIXEL SWEEP =====================================
     Rasterize-based effect: samples one column (horizontal sweep) or
     row (vertical sweep) of the source at the current scanline
     position, then stretches that column/row across a trail region.
     Uses Canvas 2D `drawImage` for the stretch — nearest-neighbor by
     default, so trails stay sharp and digital, not blurred.
     Shared code path for preview + export.  All four layer kinds
     (text, SVG, image, video) are handled uniformly because the
     source has already been rasterized to a canvas/image by the
     caller. */

  // Given a normalized progress [0..1], returns { headPx, tailPx }
  // positions in source coordinates.  Progress is remapped so both
  // ends are off-screen at 0 and 1 → clean start + clean end.
  function _pixelSweepPositions(progress, dim, trailLenPct, direction) {
    const trailPx = (trailLenPct / 100) * dim;
    // Off-screen span: head enters from -trailLength, exits at dim+trailLength
    const range = dim + trailPx * 2;
    // Head starts at -trailLength (LTR/TTB) or dim+trailLength (RTL/BTT)
    if (direction === "right" || direction === "down") {
      const head = -trailPx + progress * range;
      const tail = head - trailPx;
      return { head, tail, trailPx, forward: true };
    } else {
      const head = dim + trailPx - progress * range;
      const tail = head + trailPx;
      return { head, tail, trailPx, forward: false };
    }
  }

  /* applyPixelSweep(source, params, output)
     source: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement
             — anything drawImage accepts
     params: { direction, sampleWidth, trailLength, sampleMode,
               preserveAlpha, progress, intensity, opacityMix }
     output: HTMLCanvasElement (optional; created if not passed).
             If passed with pre-set width/height, those dimensions are
             RESPECTED.  Source is scaled into the output resolution
             during processing.  This is critical when the source is
             an SVG-derived HTMLImageElement whose naturalWidth may
             be the browser's default (300×150) rather than the
             layer's true dimensions.
     Returns: the output canvas containing the swept result.
  */
  function applyPixelSweep(source, params, output) {
    // Source dimensions — used only to compute source-coord sample
    // positions.  The OUTPUT canvas dimensions drive the sweep math.
    const srcW = source.naturalWidth || source.videoWidth || source.width;
    const srcH = source.naturalHeight || source.videoHeight || source.height;
    if (!srcW || !srcH) return output || source;

    const out = output || document.createElement("canvas");
    // Respect the output canvas's incoming dimensions if it was
    // pre-sized by the caller.  Only fall back to source dimensions
    // when the caller didn't specify.  This is the fix for the
    // export regression where an SVG-Image at 300×150 was
    // clobbering a properly-sized buf back down to 300×150.
    const outW = out.width  || srcW;
    const outH = out.height || srcH;
    if (out.width  !== outW) out.width  = outW;
    if (out.height !== outH) out.height = outH;
    const octx = out.getContext("2d");
    octx.clearRect(0, 0, outW, outH);

    const p = params || {};
    const direction   = p.direction   || "right";
    const sampleWidth = Math.max(1, Math.min(32, p.sampleWidth || 2));
    const trailLenPct = Math.max(0, Math.min(100, p.trailLength || 40));
    const sampleMode  = p.sampleMode  || "center";
    const preserveAlpha = p.preserveAlpha !== false;
    const progress    = Math.max(0, Math.min(1, p.progress ?? 0));
    const intensity   = Math.max(0, Math.min(1, (p.intensity ?? 100) / 100));

    const isHorizontal = direction === "right" || direction === "left";
    // Sweep math operates in OUTPUT coordinates so the trail band is
    // sized correctly regardless of the source-to-output ratio.
    const dim = isHorizontal ? outW : outH;
    const pos = _pixelSweepPositions(progress, dim, trailLenPct, direction);
    let head = pos.head, tail = pos.tail;

    let bandLo = Math.min(head, tail), bandHi = Math.max(head, tail);
    const bandWidth = bandHi - bandLo;

    // No effect region visible — draw source scaled to full output.
    if (bandHi <= 0 || bandLo >= dim || bandWidth <= 0 || intensity <= 0.001) {
      octx.drawImage(source, 0, 0, srcW, srcH, 0, 0, outW, outH);
      return out;
    }

    const clampedLo = Math.max(0, bandLo);
    const clampedHi = Math.min(dim, bandHi);

    // Sample position in OUTPUT coords, converted to source coords.
    const sampleAtOut = Math.max(0, Math.min(dim - 1, Math.round(head)));
    const srcScaleX = srcW / outW;
    const srcScaleY = srcH / outH;
    const sampleAtSrc = isHorizontal
      ? Math.max(0, Math.min(srcW - 1, Math.round(sampleAtOut * srcScaleX)))
      : Math.max(0, Math.min(srcH - 1, Math.round(sampleAtOut * srcScaleY)));

    // Step 1: draw source (scaled to output res) outside the band.
    if (isHorizontal) {
      if (clampedLo > 0 || clampedHi < outW) {
        octx.save();
        octx.beginPath();
        if (clampedLo > 0)   octx.rect(0, 0, clampedLo, outH);
        if (clampedHi < outW) octx.rect(clampedHi, 0, outW - clampedHi, outH);
        octx.clip();
        octx.drawImage(source, 0, 0, srcW, srcH, 0, 0, outW, outH);
        octx.restore();
      }
    } else {
      if (clampedLo > 0 || clampedHi < outH) {
        octx.save();
        octx.beginPath();
        if (clampedLo > 0)   octx.rect(0, 0, outW, clampedLo);
        if (clampedHi < outH) octx.rect(0, clampedHi, outW, outH - clampedHi);
        octx.clip();
        octx.drawImage(source, 0, 0, srcW, srcH, 0, 0, outW, outH);
        octx.restore();
      }
    }

    // Step 2: draw the stretched sample INSIDE the band.
    const useAverage = (sampleMode === "average" && sampleWidth > 1);
    const stretchDstLo = clampedLo, stretchDstW = clampedHi - clampedLo;
    const srcSampleW = Math.max(1, Math.round(sampleWidth * (isHorizontal ? srcScaleX : srcScaleY)));
    const halfSrcW = Math.floor(srcSampleW / 2);

    octx.imageSmoothingEnabled = false;

    if (isHorizontal) {
      if (useAverage) {
        const inter = document.createElement("canvas");
        inter.width = 1; inter.height = outH;
        const ictx = inter.getContext("2d");
        ictx.imageSmoothingEnabled = true;
        const srcX = Math.max(0, Math.min(srcW - srcSampleW, sampleAtSrc - halfSrcW));
        ictx.drawImage(source, srcX, 0, srcSampleW, srcH, 0, 0, 1, outH);
        octx.drawImage(inter, 0, 0, 1, outH, stretchDstLo, 0, stretchDstW, outH);
      } else {
        octx.drawImage(source, sampleAtSrc, 0, 1, srcH, stretchDstLo, 0, stretchDstW, outH);
      }
    } else {
      if (useAverage) {
        const inter = document.createElement("canvas");
        inter.width = outW; inter.height = 1;
        const ictx = inter.getContext("2d");
        ictx.imageSmoothingEnabled = true;
        const srcY = Math.max(0, Math.min(srcH - srcSampleW, sampleAtSrc - halfSrcW));
        ictx.drawImage(source, 0, srcY, srcW, srcSampleW, 0, 0, outW, 1);
        octx.drawImage(inter, 0, 0, outW, 1, 0, stretchDstLo, outW, stretchDstW);
      } else {
        octx.drawImage(source, 0, sampleAtSrc, srcW, 1, 0, stretchDstLo, outW, stretchDstW);
      }
    }

    if (intensity < 0.999) {
      octx.globalAlpha = 1 - intensity;
      octx.drawImage(source, 0, 0, srcW, srcH, 0, 0, outW, outH);
      octx.globalAlpha = 1;
    }

    void preserveAlpha;
    return out;
  }

  /* Rasterization cache for pixel-sweep source frames.
     Static layers (SVG, IMG, TEXT) are rasterized once per session and
     reused — the canvas content doesn't change between frames.  Video
     layers must be rasterized every frame because the source frame
     changes with time.  The cache key is the layer id + a version
     counter incremented whenever the layer's static content changes.
     Video layers always miss the cache and rasterize fresh. */
  const _pixelSweepRasterCache = new Map();   // layer.id → { canvas, version }
  function invalidatePixelSweepCache(layerId) {
    if (layerId == null) _pixelSweepRasterCache.clear();
    else _pixelSweepRasterCache.delete(layerId);
  }

  // Returns a canvas (or the underlying element for IMG/VIDEO) that
  // represents the layer's current visual state.  Synchronous — used
  // by preview + export.  For SVG layers we cache a rasterized canvas
  // because serializing + decoding the SVG on every frame would be
  // very expensive.
  function getLayerSourceCanvas(layer) {
    if (layer.kind === "IMG") return layer.node;
    if (layer.kind === "VIDEO") {
      // WebCodecs path: layer.node is a canvas that already holds the
      // current frame (populated by the RAF loop / export sync).
      if (layer.videoSource) return layer._exportCanvas || layer.node;
      // Legacy path: the <video> element itself is a valid
      // CanvasImageSource; drawImage samples the current frame.
      return layer.node;
    }
    // SVG / TEXT / SVG-with-sublayers / GROUP: rasterize + cache.
    // v19.19: GROUP uses layerToImage's synthetic-SVG builder to
    // capture the composite of all members with current effect
    // mutations.  Otherwise falls through to the standard
    // XMLSerializer path.
    const cached = _pixelSweepRasterCache.get(layer.id);
    // For GROUP layers we DON'T cache — the composite changes as
    // member effects mutate their DOM, so the source canvas must be
    // rebuilt each frame.  For static layer kinds the cache stays.
    if (layer.kind !== "GROUP" && cached && cached.canvas && cached.loaded) return cached.canvas;
    if (layer.kind !== "GROUP" && cached && cached.canvas) return cached.canvas;

    const w = layer.natW || 512, h = layer.natH || 512;
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    const entry = { canvas: c, version: 1, loaded: false };
    if (layer.kind !== "GROUP") _pixelSweepRasterCache.set(layer.id, entry);
    // Rasterize via serialize → Blob URL → Image → drawImage.  For
    // GROUP layers, build the synthetic SVG on the fly.
    try {
      let nodeToSerialize;
      if (layer.kind === "GROUP") {
        const groupW = parseFloat(layer.wrap.style.width) || w;
        const groupH = parseFloat(layer.wrap.style.height) || h;
        const svgNS = "http://www.w3.org/2000/svg";
        const outer = document.createElementNS(svgNS, "svg");
        outer.setAttribute("xmlns", svgNS);
        outer.setAttribute("viewBox", `0 0 ${groupW} ${groupH}`);
        outer.setAttribute("width", groupW);
        outer.setAttribute("height", groupH);
        (layer._members || []).forEach((m) => {
          if (!m || !m.node || !m.wrap) return;
          const mLeft = parseFloat(m.wrap.style.left) || 0;
          const mTop  = parseFloat(m.wrap.style.top)  || 0;
          const mW    = parseFloat(m.wrap.style.width)  || 0;
          const mH    = parseFloat(m.wrap.style.height) || 0;
          if (mW <= 0 || mH <= 0) return;
          const inner = m.node.cloneNode(true);
          inner.setAttribute("x", mLeft);
          inner.setAttribute("y", mTop);
          inner.setAttribute("width", mW);
          inner.setAttribute("height", mH);
          outer.appendChild(inner);
        });
        nodeToSerialize = outer;
      } else {
        nodeToSerialize = layer.node;
      }
      const svgStr = new XMLSerializer().serializeToString(nodeToSerialize);
      const url = URL.createObjectURL(new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" }));
      const img = new Image();
      img.onload = () => {
        try { ctx.clearRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h); } catch (e) {}
        URL.revokeObjectURL(url);
        entry.loaded = true;
        // Trigger a preview repaint so the pixel sweep re-runs with
        // the now-populated source.  Without this the first frame
        // after creating a clip would show a blank sweep.
        try { paintIfPaused(); } catch (e) {}
      };
      img.onerror = () => { URL.revokeObjectURL(url); };
      img.src = url;
    } catch (e) {}
    return c;
  }

  // Called when a layer's static content changes (added, edited,
  // etc.) so the next Pixel Sweep pass re-rasterizes.
  window.__phaser_invalidatePixelSweep = invalidatePixelSweepCache;

  // Returns the pixelSweep clip active at time `t` for a layer, or
  // null if none.  There's only ever one active pixelSweep at a time
  // per layer (event clips don't overlap by design), so this returns
  // a single clip.
  function activePixelSweepAt(layer, t) {
    if (!layer.clips || !layer.clips.length) return null;
    for (const c of layer.clips) {
      if (c.fxKey !== "pixelSweep") continue;
      if (c.enabled === false) continue;
      const start = layer.start + c.start;
      const end = start + c.duration;
      if (t >= start - 0.001 && t <= end + 0.001) return c;
    }
    return null;
  }

  // Compute clip-time-normalized progress [0..1].  Called by both
  // preview and export so the effect is frame-accurate against the
  // timeline clock, not against wall time.
  function pixelSweepProgress(clip, layer, t) {
    const start = layer.start + clip.start;
    const dur = Math.max(0.001, clip.duration);
    return Math.max(0, Math.min(1, (t - start) / dur));
  }

  // Buffer canvases reused across frames to avoid GC pressure.  One
  // per layer keyed by id.
  const _pixelSweepOutputBuffer = new Map();
  function getPixelSweepOutputCanvas(layerId, w, h) {
    let c = _pixelSweepOutputBuffer.get(layerId);
    if (!c) { c = document.createElement("canvas"); _pixelSweepOutputBuffer.set(layerId, c); }
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    return c;
  }

  // Per-layer reusable canvas for the export-path pre-rasterization
  // step.  Separate from the output buffer because both are needed
  // simultaneously (source and destination of applyPixelSweep).
  // Purpose: hold a bitmap of the layer rendered at layer.natW × natH
  // BEFORE the sweep runs.  Fixes the SVG-Image-at-browser-default-
  // dimensions bug that caused export distortion.
  const _pixelSweepPreSourceBuffer = new Map();
  function getPixelSweepPreSource(layerId, w, h) {
    let c = _pixelSweepPreSourceBuffer.get(layerId);
    if (!c) { c = document.createElement("canvas"); _pixelSweepPreSourceBuffer.set(layerId, c); }
    if (c.width  !== w) c.width  = w;
    if (c.height !== h) c.height = h;
    return c;
  }


  /* ================ EXPORT DIAGNOSTICS (Phase 1) =====================
     Three-way capture + bitstream inspection for the MP4 export path.
     Triggered by setting `window.__phaserExportDiag = { frameIndex }`
     before running an export.
     Captures:
       1. Pre-encode PNG — the export canvas at that frame index
       2. Decoded MP4 frame PNG — extracted from the final MP4 via
          <video> playback
       3. SPS VUI parse from the first video chunk metadata
       4. `colr` atom scan from the muxed MP4 bytes
       5. Numeric histograms for preencode vs decoded MP4 frame
     Delivers all artifacts as downloads + a diag-report.json.
     Also attaches everything to `window.__phaserMP4Diag.phase1`.
     ==================================================================== */

  const _exportDiag = {
    active: false,
    frameIndex: 0,
    frameTimestampSec: 0,
    captures: {},   // populated during export
    report: {},
  };

  // ---- SPS VUI parser ------------------------------------------------
  // Strips RBSP emulation-prevention bytes (00 00 03 → 00 00), then
  // walks the SPS syntax to extract VUI color-info fields.
  function _stripEmulationPrevention(bytes) {
    const out = [];
    let zeros = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (zeros === 2 && b === 0x03) { zeros = 0; continue; }
      if (b === 0x00) zeros++; else zeros = 0;
      out.push(b);
    }
    return new Uint8Array(out);
  }
  class _BitReader {
    constructor(bytes) { this.bytes = bytes; this.pos = 0; }
    u(n) {
      let v = 0;
      for (let i = 0; i < n; i++) {
        const byteIdx = this.pos >> 3;
        const bitIdx  = 7 - (this.pos & 7);
        v = (v << 1) | ((this.bytes[byteIdx] >> bitIdx) & 1);
        this.pos++;
      }
      return v;
    }
    // Unsigned Exp-Golomb
    ue() {
      let leadingZeros = 0;
      while (this.u(1) === 0 && leadingZeros < 32) leadingZeros++;
      if (leadingZeros === 0) return 0;
      return (1 << leadingZeros) - 1 + this.u(leadingZeros);
    }
    // Signed Exp-Golomb
    se() {
      const v = this.ue();
      return (v % 2 === 0) ? -(v >> 1) : ((v + 1) >> 1);
    }
  }
  function parseSpsVui(spsBytes) {
    try {
      // Detect and skip NAL unit header (first byte of an SPS NAL is
      // 0x67 = nal_ref_idc=3, nal_unit_type=7).
      let start = 0;
      if (spsBytes[0] === 0x67) start = 1;
      const rbsp = _stripEmulationPrevention(spsBytes.slice(start));
      const br = new _BitReader(rbsp);

      const profile_idc = br.u(8);
      br.u(8);   // constraint_set flags + reserved
      const level_idc = br.u(8);
      br.ue();   // seq_parameter_set_id

      const highProfiles = new Set([100,110,122,244,44,83,86,118,128,138,139,134,135]);
      let chroma_format_idc = 1;
      if (highProfiles.has(profile_idc)) {
        chroma_format_idc = br.ue();
        if (chroma_format_idc === 3) br.u(1);
        br.ue();  // bit_depth_luma_minus8
        br.ue();  // bit_depth_chroma_minus8
        br.u(1);  // qpprime_y_zero_transform_bypass_flag
        const seq_scaling_matrix_present_flag = br.u(1);
        if (seq_scaling_matrix_present_flag) {
          return { parseError: "custom scaling list — parser skipped further fields" };
        }
      }

      br.ue();  // log2_max_frame_num_minus4
      const pic_order_cnt_type = br.ue();
      if (pic_order_cnt_type === 0) {
        br.ue();
      } else if (pic_order_cnt_type === 1) {
        br.u(1); br.se(); br.se();
        const num = br.ue();
        for (let i = 0; i < num; i++) br.se();
      }
      br.ue();  // max_num_ref_frames
      br.u(1);  // gaps_in_frame_num_value_allowed_flag
      br.ue();  // pic_width_in_mbs_minus1
      br.ue();  // pic_height_in_map_units_minus1
      const frame_mbs_only_flag = br.u(1);
      if (!frame_mbs_only_flag) br.u(1);
      br.u(1);  // direct_8x8_inference_flag
      const frame_cropping_flag = br.u(1);
      if (frame_cropping_flag) { br.ue(); br.ue(); br.ue(); br.ue(); }

      const vui_parameters_present_flag = br.u(1);
      const result = {
        profile_idc, level_idc, chroma_format_idc,
        vui_parameters_present_flag,
        video_signal_type_present_flag: 0,
        video_full_range_flag: null,
        colour_description_present_flag: 0,
        colour_primaries: null,
        transfer_characteristics: null,
        matrix_coefficients: null,
      };
      if (vui_parameters_present_flag) {
        const aspect_ratio_info_present_flag = br.u(1);
        if (aspect_ratio_info_present_flag) {
          const aspect_ratio_idc = br.u(8);
          if (aspect_ratio_idc === 255) { br.u(16); br.u(16); }
        }
        const overscan_info_present_flag = br.u(1);
        if (overscan_info_present_flag) br.u(1);
        const video_signal_type_present_flag = br.u(1);
        result.video_signal_type_present_flag = video_signal_type_present_flag;
        if (video_signal_type_present_flag) {
          br.u(3);  // video_format
          result.video_full_range_flag = br.u(1);
          const colour_description_present_flag = br.u(1);
          result.colour_description_present_flag = colour_description_present_flag;
          if (colour_description_present_flag) {
            result.colour_primaries = br.u(8);
            result.transfer_characteristics = br.u(8);
            result.matrix_coefficients = br.u(8);
          }
        }
      }
      // Human interpretation
      const primaryNames  = {1:"BT.709", 5:"BT.601-PAL", 6:"BT.601-NTSC", 9:"BT.2020"};
      const transferNames = {1:"BT.709", 6:"BT.601", 13:"sRGB", 14:"BT.2020-10", 16:"PQ", 18:"HLG"};
      const matrixNames   = {0:"RGB (Identity)", 1:"BT.709", 5:"BT.601", 9:"BT.2020"};
      const parts = [];
      if (result.colour_primaries != null) parts.push("primaries=" + (primaryNames[result.colour_primaries] || result.colour_primaries));
      if (result.transfer_characteristics != null) parts.push("transfer=" + (transferNames[result.transfer_characteristics] || result.transfer_characteristics));
      if (result.matrix_coefficients != null) parts.push("matrix=" + (matrixNames[result.matrix_coefficients] || result.matrix_coefficients));
      if (result.video_full_range_flag != null) parts.push("range=" + (result.video_full_range_flag ? "FULL" : "LIMITED"));
      result.interpretation = parts.join(", ") || "SPS has no VUI color info — players will default to limited-range BT.601/709";
      return result;
    } catch (e) {
      return { parseError: String(e && e.message || e) };
    }
  }

  // ---- colr atom scanner ---------------------------------------------
  // MP4 boxes are nested but "colr" is a small leaf with a known
  // structure.  Byte-scan for the type code is reliable enough for
  // diagnostics — the string "colr" isn't likely to occur in the mdat
  // payload by chance.
  function findColrAtom(mp4Bytes) {
    try {
      const bytes = new Uint8Array(mp4Bytes);
      // Search for the 4-byte type code "colr" (0x63 0x6F 0x6C 0x72)
      for (let i = 4; i < bytes.length - 12; i++) {
        if (bytes[i] === 0x63 && bytes[i+1] === 0x6F && bytes[i+2] === 0x6C && bytes[i+3] === 0x72) {
          // The 4 bytes before this are the box size (uint32 BE)
          const boxSize = new DataView(bytes.buffer, bytes.byteOffset + i - 4, 4).getUint32(0, false);
          // 4 bytes after "colr" = colour_type
          const type = String.fromCharCode(bytes[i+4], bytes[i+5], bytes[i+6], bytes[i+7]);
          if (type === "nclx" || type === "nclc") {
            const primaries = (bytes[i+8] << 8) | bytes[i+9];
            const transfer  = (bytes[i+10] << 8) | bytes[i+11];
            const matrix    = (bytes[i+12] << 8) | bytes[i+13];
            const result = { found: true, offset: i - 4, boxSize, type, primaries, transfer, matrix };
            if (type === "nclx") {
              const flags = bytes[i+14];
              result.fullRange = (flags & 0x80) !== 0;
            } else {
              result.fullRange = null;   // legacy nclc has no range flag
            }
            return result;
          }
        }
      }
      return { found: false, note: "No colr atom in MP4 container. Players will read range/primaries from SPS VUI only. Missing colr can cause playback inconsistency across players." };
    } catch (e) {
      return { found: false, error: String(e && e.message || e) };
    }
  }

  // ---- Histogram / color measurement ---------------------------------
  async function computeImageStats(pngBlob) {
    if (!pngBlob) return null;
    return new Promise((resolve) => {
      const url = URL.createObjectURL(pngBlob);
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0);
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let pureBlack = 0, nearBlack = 0, lumaSum = 0, lumaSqSum = 0, maxCyanSat = 0;
          const pxCount = d.length / 4;
          for (let i = 0; i < d.length; i += 4) {
            const r = d[i], g = d[i+1], b = d[i+2];
            if (r <= 2 && g <= 2 && b <= 2) pureBlack++;
            if (r <= 5 && g <= 5 && b <= 5) nearBlack++;
            const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            lumaSum += luma;
            lumaSqSum += luma * luma;
            // Cyan detection: high G, high B, low R → measure saturation of these pixels
            if (r < g && r < b && g > 128 && b > 128) {
              const maxC = Math.max(g, b);
              const minC = Math.min(r, g, b);
              const sat = maxC > 0 ? (maxC - minC) / maxC : 0;
              if (sat > maxCyanSat) maxCyanSat = sat;
            }
          }
          const meanLuma = lumaSum / pxCount;
          const varLuma = (lumaSqSum / pxCount) - (meanLuma * meanLuma);
          const stdLuma = Math.sqrt(Math.max(0, varLuma));
          URL.revokeObjectURL(url);
          resolve({
            dimensions: { w: c.width, h: c.height },
            total_pixels: pxCount,
            pure_black_pixels: pureBlack,
            pure_black_pct: (pureBlack / pxCount * 100).toFixed(3) + "%",
            near_black_pixels: nearBlack,
            near_black_pct: (nearBlack / pxCount * 100).toFixed(3) + "%",
            mean_luma: meanLuma.toFixed(2),
            luma_stddev: stdLuma.toFixed(2),
            peak_cyan_saturation: maxCyanSat.toFixed(3),
          });
        } catch (e) { URL.revokeObjectURL(url); resolve({ error: String(e) }); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  // ---- Delivery: download each artifact + JSON report -----------------
  function _downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  async function deliverDiagArtifacts(diag) {
    const f = diag.frameIndex;
    if (diag.captures.preencodePng)     _downloadBlob(diag.captures.preencodePng,     `phaser-diag-${f}-1-preencode.png`);
    if (diag.captures.decodedFramePng)  _downloadBlob(diag.captures.decodedFramePng,  `phaser-diag-${f}-2-mp4decoded.png`);
    const jsonBlob = new Blob([JSON.stringify(diag.report, null, 2)], { type: "application/json" });
    _downloadBlob(jsonBlob, `phaser-diag-${f}-3-report.json`);
  }

  // ---- Extract a frame from the muxed MP4 via <video> playback --------
  // Uses Chrome's video element to decode + present.  This captures the
  // "as-played-by-Chrome" pixel data — which is what users actually see
  // when they play the MP4.  If Chrome misinterprets color metadata,
  // this reproduces that misinterpretation, making it visible in the
  // downloaded PNG for direct comparison.
  async function extractMp4FrameAsPng(mp4Buffer, targetSec, W, H) {
    return new Promise((resolve) => {
      let url = null;
      const v = document.createElement("video");
      v.muted = true;
      const cleanup = () => {
        if (url) { URL.revokeObjectURL(url); url = null; }
      };
      const timeout = setTimeout(() => { cleanup(); resolve({ error: "timeout waiting for video decode" }); }, 8000);
      v.addEventListener("error", () => { clearTimeout(timeout); cleanup(); resolve({ error: "video element error: " + (v.error && v.error.message) }); });
      v.addEventListener("loadedmetadata", () => {
        // Clamp target within video's range
        const t = Math.max(0, Math.min(v.duration - 0.01, targetSec));
        v.currentTime = t;
      });
      v.addEventListener("seeked", async () => {
        // Wait one more frame for actual paint
        await new Promise(r => setTimeout(r, 120));
        try {
          const c = document.createElement("canvas");
          c.width = v.videoWidth || W; c.height = v.videoHeight || H;
          c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
          const blob = await new Promise(r => c.toBlob(r, "image/png"));
          clearTimeout(timeout); cleanup();
          resolve({ blob, videoWidth: v.videoWidth, videoHeight: v.videoHeight });
        } catch (e) {
          clearTimeout(timeout); cleanup();
          resolve({ error: String(e) });
        }
      }, { once: true });
      url = URL.createObjectURL(new Blob([mp4Buffer], { type: "video/mp4" }));
      v.src = url;
    });
  }


  function layerToImage(layer, targetW, targetH) {
    return new Promise((resolve) => {
      // IMG layers already have an <img> in layer.node — draw directly.
      // VIDEO layers have a <video> in layer.node — <video> is a valid
      // CanvasImageSource, so drawImage(video, ...) samples whatever
      // frame the video is currently displaying.  Preview and export
      // both seek the video before drawing, so both sample the same
      // frame at the same timeline t.
      if (layer.kind === "IMG" || layer.kind === "VIDEO") { resolve(layer.node); return; }
      // v19.16 GROUP export: build a synthetic SVG on demand that
      // contains each member's node content wrapped in a nested <svg>
      // positioned at the member's local coordinates within the group
      // wrap.  Effect mutations on member primitives (opacity, stroke-
      // dasharray, fill overrides) are captured because deep-cloning
      // includes inline style attributes.  Nested SVGs preserve each
      // member's own viewBox scaling.  Not cached — rebuilt each call
      // so the raster reflects the current DOM state.
      if (layer.kind === "GROUP") {
        const groupW = parseFloat(layer.wrap.style.width) || 1;
        const groupH = parseFloat(layer.wrap.style.height) || 1;
        const svgNS = "http://www.w3.org/2000/svg";
        const outer = document.createElementNS(svgNS, "svg");
        outer.setAttribute("xmlns", svgNS);
        outer.setAttribute("viewBox", `0 0 ${groupW} ${groupH}`);
        outer.setAttribute("width", groupW);
        outer.setAttribute("height", groupH);
        (layer._members || []).forEach((m) => {
          if (!m || !m.node || !m.wrap) return;
          const mLeft = parseFloat(m.wrap.style.left) || 0;
          const mTop  = parseFloat(m.wrap.style.top)  || 0;
          const mW    = parseFloat(m.wrap.style.width)  || 0;
          const mH    = parseFloat(m.wrap.style.height) || 0;
          if (mW <= 0 || mH <= 0) return;
          // Nested SVG preserves member's own viewBox.  Copy the
          // deep-cloned node — inline style attributes come along, so
          // any active effect mutations render into the export.
          const inner = m.node.cloneNode(true);
          inner.setAttribute("x", mLeft);
          inner.setAttribute("y", mTop);
          inner.setAttribute("width", mW);
          inner.setAttribute("height", mH);
          outer.appendChild(inner);
        });
        // Use the built SVG as if it were layer.node for the rest of
        // the rasterization pipeline.  natW / natH for scaling come
        // from the group dimensions.
        layer._groupSyntheticNode = outer;
        layer._groupNatW = groupW;
        layer._groupNatH = groupH;
      }
      const nodeToSerialize = layer.kind === "GROUP" ? layer._groupSyntheticNode : layer.node;
      const natW = (layer.kind === "GROUP" ? layer._groupNatW : layer.natW) || 400;
      const natH = (layer.kind === "GROUP" ? layer._groupNatH : layer.natH) || 400;
      const cap = 4096;
      const aspect = natW / natH;
      // Target scale: rasterize at 2× the export destination so the
      // eventual downsample to the final canvas provides supersampling
      // antialiasing.  Without this, thin wireframe strokes (< 1px in
      // export destination coords) lose contrast during the 1:1 or
      // near-1:1 downsample.  Rasterizing at 2× target means every
      // destination pixel receives ~4 source samples, giving proper
      // AA even for sub-pixel strokes.  Capped at 4096 for VRAM.
      // If no target passed (preview path), default to 2× viewBox
      // so preview overlay also gets crisp AA.
      const desiredScale = Math.max(
        2,                                     // 2× viewBox minimum
        ((targetW || 0) * 2) / natW,           // 2× target width
        ((targetH || 0) * 2) / natH            // 2× target height
      );
      const scale = Math.min(cap / Math.max(natW, natH), desiredScale);
      const rasterW = Math.max(1, Math.round(natW * scale));
      const rasterH = Math.max(1, Math.round(natH * scale));

      const svgStr = new XMLSerializer().serializeToString(nodeToSerialize);
      const url = URL.createObjectURL(new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" }));
      const svgImg = new Image();
      svgImg.onload = () => {
        const c = document.createElement("canvas");
        c.width = rasterW; c.height = rasterH;
        const ctx = c.getContext("2d");
        // Enable high-quality smoothing for the vector→bitmap step —
        // this is the ONLY step where interpolation matters, since
        // it's SVG's antialiased rendering being written to pixels.
        // Downstream bitmap-to-bitmap operations should keep
        // imageSmoothing enabled by default too (default in canvas
        // 2D is true) — that gives smooth downscaling to final dst.
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(svgImg, 0, 0, rasterW, rasterH);
        URL.revokeObjectURL(url);
        // Instrumentation (v18.3): log dimensions so we can prove the
        // pipeline is now high-res.  Emitted once per layer per export
        // cycle since rasterizeAll runs at export start.
        try {
          console.log("[Phaser SVG raster]", {
            layer: layer.id, name: layer.name,
            svg_viewBox: layer.node.getAttribute("viewBox"),
            svg_width_attr: layer.node.getAttribute("width"),
            svg_height_attr: layer.node.getAttribute("height"),
            natW, natH,
            rasterCanvasSize: { w: rasterW, h: rasterH },
            targetSize: { w: targetW, h: targetH },
            devicePixelRatio: window.devicePixelRatio,
            scale: scale.toFixed(3),
          });
        } catch (e) {}
        resolve(c);
      };
      svgImg.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      svgImg.src = url;
    });
  }
  async function rasterizeAll(exportW, exportH) {
    const imgs = {};
    // Log the export target once so users can correlate with the
    // per-layer raster logs.
    try {
      console.log("[Phaser export raster] rasterizeAll target:", {
        exportW, exportH,
        artboard: STATE.format,
        devicePixelRatio: window.devicePixelRatio,
      });
    } catch (e) {}
    for (const l of layers) imgs[l.id] = await layerToImage(l, exportW, exportH);
    return imgs;
  }

  // Which layers to draw: whole comp or just the selected layer.
  function exportLayers() { return (EXPORTOPTS.target === "layer" && selectedLayer) ? [selectedLayer] : layers; }

  // Draw one frame. If cropRect given (px in artboard space), the canvas
  // represents that crop region only.
  /* ============================================================
     SHARED EFFECT EVALUATION — used by BOTH preview and export.
     Returns a plain state object with the composed visual deltas for a
     layer at a given scene time, including active event clips.
     Bug fix: previous export used a copy of the preview logic that did
     NOT walk `layer.clips`, so event effects were invisible in export.
     ============================================================ */
  function evaluateLayerAtTime(layer, sceneTime, sig, localTime) {
    const T = layer.transform, allowT = layer.allowTransform;
    // baseline
    const s = {
      tx: 0, ty: 0, extraScale: 1, rot: 0, rotX: 0, rotY: 0, skew: 0,
      opacity: T.opacity / 100, blur: 0, rgb: 0, glow: 0,
      hud: false, hudFlicker: 1, flash: null, flashA: 0,
      scanBoost: 0, breakup: 0,
      pathDraw: null, pathTrim: null,
      radarBar: null, scanMask: null, freeze: false,
      textSwap: null, layerSwap: 0,
    };
    // v18.7: unified clip evaluator handles both sustained and event clips
    const active = activeEventClipsAt(layer, sceneTime);
    for (const { c, p } of active) {
      const d = evaluateClipDelta(c, layer, sceneTime, p, sig, allowT);
      if (!d) continue;
      const mix = c.params && c.params.opacityMix !== undefined ? c.params.opacityMix / 100 : 1;
      if (d.opacity !== undefined) { const eff = 1 - (1 - d.opacity) * mix; s.opacity *= eff; }
      if (d.opacityWave !== undefined) s.opacity *= d.opacityWave;
      if (d.blur) s.blur += d.blur;
      if (d.rgb) s.rgb = Math.max(s.rgb, d.rgb);
      if (d.glow) s.glow = Math.max(s.glow, d.glow);
      if (d.flash) { s.flash = d.flash; s.flashA = Math.max(s.flashA || 0, d.flashA || 0); }
      if (d.scanBoost) s.scanBoost = Math.max(s.scanBoost, d.scanBoost);
      if (d.breakup) s.breakup = Math.max(s.breakup, d.breakup);
      if (d.hud) { s.hud = true; s.hudFlicker = d.hudFlicker; }
      if (d.pathDraw !== undefined) s.pathDraw = d.pathDraw;
      if (d.pathTrim !== undefined) s.pathTrim = d.pathTrim;
      if (d.radarBar !== undefined) s.radarBar = d.radarBar;
      if (d.scanMask !== undefined) s.scanMask = d.scanMask;
      if (d.freeze) s.freeze = true;
      if (d.textSwap !== undefined) s.textSwap = d.textSwap;
      // Events / migrated sustained effects may move / scale / rotate.
      if (d.tx) s.tx += d.tx;
      if (d.ty) s.ty += d.ty;
      if (d.rot) s.rot += d.rot;
      if (d.rotX) s.rotX += d.rotX;
      if (d.rotY) s.rotY += d.rotY;
      if (d.skew) s.skew += d.skew;
      if (d.scaleSafe !== undefined) s.extraScale *= d.scaleSafe;
      // v19.14 Expansion Build in export.  Same computation as preview
      // but folded into export's `s` accumulator so the resulting MP4
      // matches preview exactly.  Uses STATE.format (global) for the
      // canvas dimensions, matching the preview path.
      if (d.expansion) {
        const ed = computeExpansionDelta(layer, d.expansion, STATE.format);
        s.extraScale *= ed.scaleSafe;
        s.opacity   *= ed.opacity;
        s.rot       += ed.rot;
        s.blur      += ed.blur;
        // Bypasses allowTransform gate — see preview path.
        s.expansionTx = (s.expansionTx || 0) + ed.tx;
        s.expansionTy = (s.expansionTy || 0) + ed.ty;
      }
      // New channels for the canvas renderer (drawExportFrame reads these).
      if (d.tear !== undefined) s.tear = d.tear;
      if (d.targetPing !== undefined) s.targetPing = d.targetPing;
      if (d.ghost !== undefined) s.ghost = d.ghost;
      // High-end effect markers — read by drawExportFrame's dedicated
      // draw routines (drawLostSignalLayer / drawVectorBeam).
      if (d.lostSignal) s.lostSignal = d.lostSignal;
      if (d.vectorBeam) s.vectorBeam = d.vectorBeam;
      if (c.fxKey === "layerSwap") s.layerSwap = 1 - p;
    }
    s.blur += (STATE.blur / 100) * 2;
    return s;
  }

  /* ============================================================
     EXPORT RENDERER — Bug fixes:
       1. Event effects now render (uses evaluateLayerAtTime).
       2. Transparent mode never fills black anywhere:
          - no bg fill
          - no radial vignette
          - scanline overlay uses source-atop (only touches non-alpha)
          - noise loop skips alpha==0 pixels
          - hardCut/event flashes composite as source-atop under alpha
     ============================================================ */
  async function drawExportFrame(ctx, W, H, imgs, t, opts, cropRect) {
    const transparent = !opts.bg;
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    // v18.4: force high-quality downsample.  Default browser
    // `imageSmoothingQuality` is "low" (bilinear).  When we downsample
    // the oversampled raster (2× target) to the destination, bilinear
    // over-averages sub-pixel wireframe strokes and softens them.
    // "high" uses bicubic/lanczos which preserves stroke contrast
    // through 2× downsample.  Debug hook lets us bypass to compare.
    if (window.__phaserForceNoSmoothing) {
      ctx.imageSmoothingEnabled = false;
    } else {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
    }
    ctx.clearRect(0, 0, W, H);

    if (!transparent) {
      if (typeof opts.bg === "object" && opts.bg.grad) {
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, opts.bg.grad[0]); g.addColorStop(1, opts.bg.grad[1]);
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = opts.bg;
      }
      ctx.fillRect(0, 0, W, H);
    }

    const A = STATE.format;
    const sx = cropRect ? (W / cropRect.w) : (W / A.w);
    const sy = cropRect ? (H / cropRect.h) : (H / A.h);
    const offX = cropRect ? cropRect.x : 0, offY = cropRect ? cropRect.y : 0;
    const sig = audioSignal();
    const drawList = exportLayers();

    // v19.10: EXPORT / PREVIEW PARITY for vector effects.
    //  imgs[] was pre-rasterized ONCE at export start (rasterizeAll).
    //  For layers with morph / path-dash / shape-style clips active at
    //  time `t`, the rasterized snapshot is stale — the DOM must
    //  reflect the current frame's animated state and be re-rasterized
    //  before the canvas composite reads it.  Cost: one extra
    //  SVG→image rasterization per affected layer per frame.  Skipped
    //  entirely for frames with no active vector clip on the layer,
    //  so static layers pay nothing.
    for (const layer of drawList) {
      if (!hasActiveVectorClip(layer, t)) {
        // No animation this frame — but if a prior frame DID mutate
        // the DOM (e.g., morph applied at t=0.5, we're now at t=1.5),
        // clear that state and re-rasterize to the baseline once.
        const needsClear = (layer._morphApplied || layer._dashApplied || layer._shapeStyleApplied);
        if (needsClear) {
          applyVectorEffectsAtTime(layer, t);   // clears
          try { imgs[layer.id] = await layerToImage(layer, W, H); } catch (e) {}
        }
        continue;
      }
      applyVectorEffectsAtTime(layer, t);
      try { imgs[layer.id] = await layerToImage(layer, W, H); } catch (e) {}
    }

    // Per-frame flash / hud collectors
    let frameFlash = null, frameFlashA = 0, frameHudFlicker = 0;
    const frameOverlays = []; // { type, ... } for radar sweeps etc

    drawList.forEach((layer) => {
      if (!layer.visible) return;
      if (t < layer.start - 0.001 || t > layer.start + layer.duration + 0.001) return;
      const rawImg = imgs[layer.id]; if (!rawImg) return;
      // Pixel Sweep: check for an active pixelSweep clip and, if one
      // exists, run the layer's rasterized image through the sweep
      // processor.  Uses the same function as preview so behavior is
      // identical.  Frame-accurate: progress is derived from the
      // clip's window relative to the current time `t`.
      //
      // CRITICAL FIX (v18.1): for SVG-derived rawImg elements, the
      // browser's default SVG rasterization dimensions (typically
      // 300×150 for SVGs without explicit width/height attributes)
      // do NOT match layer.natW/natH.  Pre-rasterize into a canvas
      // sized to layer.natW × natH before running the sweep.  This
      // mirrors what getLayerSourceCanvas does in preview and
      // guarantees preview == export.  Without this pre-rasterize
      // step, applyPixelSweep would produce a low-res 300×150 output
      // that the final drawImage would then stretch to dw×dh,
      // producing distortion.
      let img = rawImg;
      const psClip = activePixelSweepAt(layer, t);
      if (psClip) {
        // v18.3: use the raster source's ACTUAL dimensions, which are
        // now export-resolution (per the layerToImage sharpness fix).
        // Previously we hard-coded layer.natW × natH here, which for
        // an SVG at natW=400 exported at 1080 would downsample the
        // high-res source back to 400 before sweeping.  Now we
        // sweep at full raster resolution.
        const srcW = rawImg.naturalWidth || rawImg.width || layer.natW || 512;
        const srcH = rawImg.naturalHeight || rawImg.height || layer.natH || 512;
        const preSrc = getPixelSweepPreSource(layer.id, srcW, srcH);
        const pctx = preSrc.getContext("2d");
        pctx.clearRect(0, 0, srcW, srcH);
        pctx.drawImage(rawImg, 0, 0, srcW, srcH);
        const progress = pixelSweepProgress(psClip, layer, t);
        const buf = getPixelSweepOutputCanvas(layer.id, srcW, srcH);
        applyPixelSweep(preSrc, { ...psClip.params, progress }, buf);
        img = buf;
      }

      const T = layer.transform;
      const lt = t - layer.start + layer.recipe.delay;
      // Use the SAME evaluator as preview so event clips affect export.
      const s = evaluateLayerAtTime(layer, t, sig, lt);
      const allowT = layer.allowTransform;

      // Layer placement in artboard coordinates
      const wPx = (T.wPct / 100) * A.w * s.extraScale;
      const hPx = (T.hPct / 100) * A.h * s.extraScale;
      const cxPx = (T.cx / 100) * A.w + (allowT ? (s.tx / 100) * A.w : 0) + ((s.expansionTx || 0) / 100) * A.w;
      const cyPx = (T.cy / 100) * A.h + (allowT ? (s.ty / 100) * A.h : 0) + ((s.expansionTy || 0) / 100) * A.h;
      const centerX = (A.w / 2 + cxPx - offX) * sx;
      const centerY = (A.h / 2 + cyPx - offY) * sy;
      const dw = wPx * sx, dh = hPx * sy;
      const rotDeg = T.rot + s.rot;

      // Optional scan-mask (from event Scan Reveal): mask reveal from left
      // by clipping to a shrinking right-side rectangle.
      const useScanMask = s.scanMask !== null && s.scanMask !== undefined;

      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = clamp01(s.opacity);
      ctx.translate(centerX, centerY);
      ctx.rotate(rotDeg * Math.PI / 180);

      // Approximate blur with shadow trick — since ctx.filter is not
      // supported in all browsers for MediaRecorder-captured streams,
      // we use ctx.filter when available, else fall back to soft glow.
      if (s.blur > 0.05) { ctx.filter = `blur(${s.blur.toFixed(2)}px)`; }
      if (s.glow > 0) { ctx.shadowColor = "rgba(122,92,255,0.6)"; ctx.shadowBlur = s.glow * sx; }

      // Scan-mask reveal (event effect) — clip to reveal area
      if (useScanMask) {
        const revealPct = clamp01(s.scanMask);
        ctx.beginPath();
        ctx.rect(-dw / 2, -dh / 2, dw * revealPct, dh);
        ctx.clip();
      }

      // RGB offset / spike
      if (s.rgb > 0.3) {
        const off = s.rgb * sx;
        const a = ctx.globalAlpha;
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = a * 0.5;
        ctx.drawImage(img, -dw / 2 + off, -dh / 2, dw, dh);
        ctx.drawImage(img, -dw / 2 - off, -dh / 2, dw, dh);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = a;
      }

      // Layer Swap: draw an inverted/offset ghost duplicate briefly
      if (s.layerSwap > 0.01) {
        const a = ctx.globalAlpha;
        ctx.globalAlpha = a * 0.6 * s.layerSwap;
        ctx.globalCompositeOperation = "difference";
        ctx.drawImage(img, -dw / 2 + 4 * sx, -dh / 2 - 4 * sy, dw, dh);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = a;
      }

      // Ghost Frame: soft double-exposure duplicate offset from center.
      if (s.ghost && s.ghost > 0.02) {
        const a = ctx.globalAlpha;
        ctx.globalAlpha = a * 0.55 * s.ghost;
        ctx.drawImage(img, -dw / 2 + 6 * sx, -dh / 2 + 4 * sy, dw, dh);
        ctx.globalAlpha = a;
      }

      // Digital Tear: split the layer horizontally into a few slabs
      // and offset alternate slabs horizontally.
      if (s.lostSignal) {
        // LOST SIGNAL — replaces the normal layer draw entirely with a
        // corrupted rendering: echoes behind, RGB desync ghosts, then
        // the layer as displaced horizontal slices with random tears.
        drawLostSignalLayer(ctx, img, dw, dh, sx, sy, s.lostSignal, layer.id, t);
      } else if (s.tear && s.tear > 0.02) {
        const slabs = 8;
        const slabH = dh / slabs;
        const srcSlabH = img.height / slabs;
        const maxOff = 30 * sx * s.tear;
        ctx.save();
        for (let sIdx = 0; sIdx < slabs; sIdx++) {
          const off = (sIdx % 2 === 0 ? 1 : -1) * maxOff * ((sIdx / slabs) * 2 - 0.5);
          ctx.drawImage(
            img,
            0, sIdx * srcSlabH, img.width, srcSlabH,
            -dw / 2 + off, -dh / 2 + sIdx * slabH, dw, slabH
          );
        }
        ctx.restore();
      } else {
        // Main layer draw (default path; tear / lostSignal replace it when active)
        ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
      }

      // Reset filter/shadow for post-passes
      ctx.filter = "none";
      ctx.shadowBlur = 0;
      ctx.restore();

      // VECTOR BEAM — projected beam extending from the layer edge in
      // the chosen direction, with trails and glow.  Drawn AFTER the
      // ctx.restore() above so it renders in artboard-space (not the
      // layer's rotated local space).
      if (s.vectorBeam) {
        drawVectorBeam(ctx, W, H, sx, sy, s.vectorBeam, centerX, centerY, dw, dh, transparent);
      }

      // Target Ping: expanding ring centered on the layer.
      if (s.targetPing !== undefined && s.targetPing !== null) {
        const pR = clamp01(s.targetPing);
        const maxR = Math.max(dw, dh) * 0.6;
        const r = maxR * pR;
        const alpha = 1 - pR;
        ctx.save();
        ctx.globalAlpha = alpha * 0.8;
        ctx.strokeStyle = "rgba(156,134,255,1)";
        ctx.lineWidth = Math.max(1.5, 3 * sx);
        ctx.beginPath();
        ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
        ctx.stroke();
        // inner faint ring
        if (r > 6) {
          ctx.globalAlpha = alpha * 0.35;
          ctx.beginPath();
          ctx.arc(centerX, centerY, r * 0.6, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }

      // Radar sweep beam (event effect): draw a vertical bar sweeping
      // across the layer's bounding rect in artboard coords.
      if (s.radarBar !== null && s.radarBar !== undefined) {
        const layerLeft = centerX - dw / 2, layerTop = centerY - dh / 2;
        const barX = layerLeft + clamp01(s.radarBar) * dw;
        const barW = Math.max(2, dw * 0.04);
        const grd = ctx.createLinearGradient(barX - barW, 0, barX + barW, 0);
        grd.addColorStop(0.0, "rgba(122,92,255,0)");
        grd.addColorStop(0.5, "rgba(156,134,255,0.55)");
        grd.addColorStop(1.0, "rgba(122,92,255,0)");
        ctx.save();
        ctx.globalCompositeOperation = transparent ? "source-over" : "screen";
        ctx.fillStyle = grd;
        ctx.fillRect(barX - barW, layerTop, barW * 2, dh);
        ctx.restore();
      }

      // Data Break blocks (event effect): draw a few small displaced
      // slabs of the layer, respecting alpha (no black fill).
      if (s.breakup > 0.05) {
        const layerLeft = centerX - dw / 2, layerTop = centerY - dh / 2;
        const blocks = Math.floor(3 + s.breakup * 6);
        ctx.save();
        for (let bi = 0; bi < blocks; bi++) {
          const bx = layerLeft + Math.random() * dw * 0.9;
          const by = layerTop + Math.random() * dh * 0.85;
          const bw = 10 + Math.random() * 40, bh = 3 + Math.random() * 8;
          const dxOff = (Math.random() - 0.5) * 24 * sx;
          ctx.globalAlpha = 0.6;
          // draw a strip of the layer offset horizontally
          const sxSrc = (bx - layerLeft) * (img.width / dw);
          const sySrc = (by - layerTop) * (img.height / dh);
          const swSrc = bw * (img.width / dw), shSrc = bh * (img.height / dh);
          try { ctx.drawImage(img, sxSrc, sySrc, swSrc, shSrc, bx + dxOff, by, bw, bh); } catch (e) {}
        }
        ctx.restore();
      }

      // HUD flicker collector
      if (s.hud) frameHudFlicker = Math.max(frameHudFlicker, s.hudFlicker || 0.6);
      // flash collector
      if (s.flash && s.flashA > 0) {
        if (!frameFlash || s.flashA > frameFlashA) { frameFlash = s.flash; frameFlashA = s.flashA; }
      }
    });

    // ---- Scene-level overlays (scanlines / noise / vignette / flash) ----

    // Scanlines: honor STATE.scanline + boost from events. In transparent
    // mode, use source-atop so they only darken existing artwork, never
    // add solid black to empty regions.
    const scanTotal = clamp01(STATE.scanline / 100 + (drawList.some((l) => (l.fx && l.fx.length) || (l.clips && l.clips.length)) ? 0 : 0));
    if (scanTotal > 0.01) {
      ctx.save();
      if (transparent) ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = `rgba(0,0,0,${scanTotal * 0.5 * (1 + sig.high)})`;
      const step = Math.max(2, 3 * sy);
      for (let y = 0; y < H; y += step) ctx.fillRect(0, y, W, Math.max(1, sy));
      ctx.restore();
    }

    // HUD overlay (event or sustained): draw thin corner brackets + tiny
    // technical labels. Uses semi-transparent white — safe over alpha.
    if (frameHudFlicker > 0.01) {
      drawHudOverlay(ctx, W, H, sy, frameHudFlicker);
    }

    // Hard-cut / event flash: solid color overlay. In transparent mode
    // we still let it flash BUT composite as source-atop so it doesn't
    // add color to empty alpha regions.
    if (frameFlash && frameFlashA > 0.01) {
      ctx.save();
      if (transparent) ctx.globalCompositeOperation = "source-atop";
      ctx.globalAlpha = clamp01(frameFlashA);
      ctx.fillStyle = frameFlash;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    // Noise: mutate RGB slightly, skip alpha==0 pixels so transparent
    // stays transparent.
    if (STATE.noise > 0) {
      try {
        const n = ctx.getImageData(0, 0, W, H);
        const amt = (STATE.noise / 100) * 40 * (1 + sig.high);
        const d = n.data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] === 0) continue; // preserve transparent pixels
          if (Math.random() < 0.3) {
            const v = (Math.random() - 0.5) * amt;
            d[i]   = clamp255(d[i]   + v);
            d[i+1] = clamp255(d[i+1] + v);
            d[i+2] = clamp255(d[i+2] + v);
          }
        }
        ctx.putImageData(n, 0, 0);
      } catch (e) { /* getImageData may fail if canvas is tainted */ }
    }

    // Vignette — ONLY when we have a solid background (never over alpha)
    if (!transparent) {
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, "rgba(0,0,0,0.4)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
  }
  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

  /* Deterministic pseudo-random: hashes an integer seed to a value in
     [0,1).  Used by drawLostSignalLayer so slice offsets stay stable
     across preview and export at the same time bucket. */
  function seededRand(n) {
    let x = ((n | 0) * 2654435761) | 0;
    x = (x ^ (x >>> 15)) * 2246822507 | 0;
    x = (x ^ (x >>> 13)) * 3266489909 | 0;
    x = (x ^ (x >>> 16)) >>> 0;
    return x / 4294967296;
  }

  /* --- Per-image tinted-copy cache -----------------------------------
     RGB separation needs red/cyan copies of the layer image.  We build
     them once per (image, tint-color) pair and reuse them across every
     slice AND every render frame.  Keyed on the source Image via
     WeakMap so GC cleans up when the image goes away. */
  const _tintCache = new WeakMap();
  function getTintedImage(img, tintCss, cacheKey) {
    let byImg = _tintCache.get(img);
    if (!byImg) { byImg = {}; _tintCache.set(img, byImg); }
    if (byImg[cacheKey]) return byImg[cacheKey];
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const cctx = c.getContext("2d");
    cctx.drawImage(img, 0, 0);
    // Tint opaque pixels only, preserve alpha shape:
    cctx.globalCompositeOperation = "source-atop";
    cctx.fillStyle = tintCss;
    cctx.fillRect(0, 0, img.width, img.height);
    byImg[cacheKey] = c;
    return c;
  }

  /* --- LOST SIGNAL layer render -------------------------------------
     Local corruption anchored to the layer.  Assumes ctx is already
     translated to the layer center and rotated (so all coordinates are
     layer-local, centered at 0,0).  The LAYER ANCHOR IS STABLE — this
     function never adds a whole-layer translate/rotate/scale.

     Algorithm:
       1. Walk the image top-to-bottom in `sliceCount` horizontal bands.
       2. For each band, roll a seeded random against `corruption` to
          decide if it's a corrupted slice.
       3. Corrupted slices get an X-displacement whose sign follows
          `direction` (right / left / both) weighted by `rightBias`.
       4. Draw the corrupted slice at its displaced X (never at 0 —
          so it does NOT double-up with a clean copy).
       5. Uncorrupted slices draw at their normal position.
       6. Around each corrupted slice, draw red-tinted + cyan-tinted
          offset copies (per-slice chromatic aberration).
       7. Sparse vertical colour columns start from corrupted-slice tops
          and extend down by `leakageLength`.
     Deterministic: same clipId + time-bucket + slice index → same
     pattern in both preview and export. */
  function drawLostSignalLayer(ctx, img, dw, dh, sx, sy, LS, clipId, t) {
    const mag = LS.mag;
    if (mag < 0.001) { ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh); return; }
    // Scene-level ctx.filter (e.g. the tiny STATE.blur applied by the
    // export renderer) and shadowBlur must be cleared for our slice
    // draws — otherwise the tiny blur can smear thin slices to nothing.
    // The caller's ctx.save()/restore() pair still isolates our changes
    // from the rest of the frame; we also restore the previous values
    // at the bottom of this function so anything drawn afterward
    // (in the same save block) picks up the same state.
    const prevFilter = ctx.filter;
    const prevShadowBlur = ctx.shadowBlur;
    ctx.filter = "none";
    ctx.shadowBlur = 0;

    // 1. Draw the CLEAN base layer.  The spec says "the original white
    //    artwork stays readable" and "layer's visual center should
    //    remain stable during the entire effect".  So the base is
    //    always drawn at its anchored position, and corruption is added
    //    on top.
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);

    // Randomness dial → bucket rate.  Higher randomness = pattern churns
    // faster (finer time buckets).  Lower randomness = slower churn.
    const bucketRate = 8 + LS.randomness * 48;
    const bucket = Math.floor(t * bucketRate);
    const baseSeed = (clipId | 0) * 9973 + bucket;

    // Max slice displacement in pixels, scaled by intensity envelope.
    const maxDisp = LS.sliceDisp * 100 * sx * mag;

    const slices = LS.sliceCount;
    const sliceH = dh / slices;
    const srcSliceH = img.height / slices;

    // Probability that a corrupted slice's offset goes RIGHT (positive
    // X) vs LEFT (negative X).  Encodes direction + rightBias together.
    let pRight;
    if      (LS.direction === "right") pRight = LS.rightBias;
    else if (LS.direction === "left")  pRight = 1 - LS.rightBias;
    else /* both */                    pRight = 0.5;

    // Pre-tinted images for per-slice RGB separation (built lazily
    // per source image and cached).
    const redImg  = getTintedImage(img, "#ff2244", "ls-red");
    const cyanImg = getTintedImage(img, "#22e0ff", "ls-cyan");

    const corruptedRows = [];

    // 2. For each CORRUPTED slice: draw an offset copy (creating the
    //    displaced-slice glitch look), plus red/cyan RGB fringes.
    //    Uncorrupted slices are already fully covered by the base draw,
    //    so we do nothing extra for them — matching "some strips should
    //    remain untouched".
    for (let i = 0; i < slices; i++) {
      const rSeed = baseSeed + i * 1301;
      const isCorrupt = seededRand(rSeed) < LS.corruption * mag;
      if (!isCorrupt) continue;

      const sign = seededRand(rSeed + 1) < pRight ? 1 : -1;
      // Power-curve magnitude: most slices shift a little, a few shift a lot.
      const mag01 = Math.pow(seededRand(rSeed + 2), 1.6);
      const disp = sign * mag01 * maxDisp;
      const yDst = -dh / 2 + i * sliceH;

      // Per-slice RGB separation.  Only runs when rgbSep is meaningful.
      const rgbOff = LS.rgbSep * 14 * sx * (0.5 + seededRand(rSeed + 3) * 0.5) * mag;
      if (rgbOff > 0.4) {
        const a = ctx.globalAlpha;
        const prevComp = ctx.globalCompositeOperation;
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = a * 0.75;
        ctx.drawImage(redImg,
          0, i * srcSliceH, img.width, srcSliceH,
          -dw / 2 + disp + rgbOff, yDst, dw, sliceH);
        ctx.drawImage(cyanImg,
          0, i * srcSliceH, img.width, srcSliceH,
          -dw / 2 + disp - rgbOff, yDst, dw, sliceH);
        ctx.globalCompositeOperation = prevComp;
        ctx.globalAlpha = a;
      }

      // Displaced copy of the slice — the glitch itself.  Drawn ON TOP
      // of the base, so the corrupted band appears as a duplicate at
      // the new position while the original band is still visible from
      // the base draw — "signal damage" look from the reference.
      ctx.drawImage(
        img,
        0, i * srcSliceH, img.width, srcSliceH,
        -dw / 2 + disp, yDst, dw, sliceH);

      corruptedRows.push({ i, disp, yTop: yDst });
    }

    // 3. Sparse vertical data leakage — colored columns starting at
    //    corrupted-slice tops and bleeding downward.  Only draws when
    //    dataLeakage > 0 and there ARE corrupted rows, so it's tied
    //    to the corruption instead of blanket over the layer.
    if (LS.leakage > 0 && corruptedRows.length > 0) {
      const LEAK_COLORS = ["#ff2244", "#22ff88", "#22ccff", "#ff22cc", "#ffff44", "#ffffff"];
      const totalCols = Math.floor(LS.leakageDen * 8 * corruptedRows.length * mag);
      const maxLeakPx = LS.leakageLen * dh;
      for (let k = 0; k < totalCols; k++) {
        const row = corruptedRows[Math.floor(seededRand(baseSeed + 500 + k) * corruptedRows.length)];
        const color = LEAK_COLORS[Math.floor(seededRand(baseSeed + 600 + k) * LEAK_COLORS.length)];
        const colX = -dw / 2 + seededRand(baseSeed + 700 + k) * dw + row.disp;
        const colW = Math.max(1, (0.8 + seededRand(baseSeed + 800 + k) * 1.6) * sx);
        const colH = maxLeakPx * (0.25 + seededRand(baseSeed + 900 + k) * 0.75);
        const maxY = dh / 2;
        const drawH = Math.min(colH, maxY - row.yTop);
        if (drawH <= 0) continue;
        const a = ctx.globalAlpha;
        const prevComp = ctx.globalCompositeOperation;
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = a * LS.leakage * 0.7 * mag;
        ctx.fillStyle = color;
        ctx.fillRect(colX, row.yTop, colW, drawH);
        ctx.globalCompositeOperation = prevComp;
        ctx.globalAlpha = a;
      }
    }
    // Restore whatever ctx.filter / shadowBlur the caller had set.
    ctx.filter = prevFilter;
    ctx.shadowBlur = prevShadowBlur;
  }

  /* --- VECTOR BEAM render -------------------------------------------
     Draws a directional beam extending from the layer's edge, with N
     trails and optional glow, in artboard-space (not layer-local).
     centerX/centerY/dw/dh describe the layer's on-canvas bounds. */
  function drawVectorBeam(ctx, W, H, sx, sy, VB, centerX, centerY, dw, dh, transparent) {
    const dir = VB.direction;
    // Origin at the edge of the layer bounding box in the beam direction.
    let originX, originY;
    if (dir === "right")     { originX = centerX + dw / 2; originY = centerY; }
    else if (dir === "left") { originX = centerX - dw / 2; originY = centerY; }
    else if (dir === "down") { originX = centerX;          originY = centerY + dh / 2; }
    else /* "up" */          { originX = centerX;          originY = centerY - dh / 2; }
    // Beam length = % of the AVAILABLE space between the layer edge and
    // the canvas edge in the beam direction.  This keeps the beam inside
    // the canvas regardless of layer size ("Beam must respect canvas
    // boundaries" in the spec).
    let availableLen;
    if (dir === "right")     availableLen = Math.max(0, W - originX);
    else if (dir === "left") availableLen = Math.max(0, originX);
    else if (dir === "down") availableLen = Math.max(0, H - originY);
    else /* up */            availableLen = Math.max(0, originY);
    const targetLen = availableLen * VB.beamLength * VB.intensity;
    const currentLen = targetLen * VB.growth;
    if (currentLen < 1) return;
    const beamWidthPx = Math.max(1, VB.beamWidth * sx);
    // Flicker envelope (multiplicative on alpha, hard-edged)
    const flick = 1 - VB.flickerAmt * Math.abs(Math.sin(VB.p * 40));

    // Rect helpers (position, size) for direction-independent drawing
    // of a beam of given length + width + lateral offset.
    function beamRect(len, width, offAxis) {
      if (dir === "right") return [originX,             originY - width / 2 + offAxis, len,   width];
      if (dir === "left")  return [originX - len,       originY - width / 2 + offAxis, len,   width];
      if (dir === "down")  return [originX - width / 2 + offAxis, originY,             width, len  ];
      /* up */              return [originX - width / 2 + offAxis, originY - len,       width, len  ];
    }

    // ---- Glow layer (wider, softer) ----
    if (VB.glowStrength > 0) {
      ctx.save();
      // Screen-composite when we have solid bg; safe alpha otherwise.
      ctx.globalCompositeOperation = transparent ? "source-over" : "screen";
      ctx.globalAlpha = 0.35 * VB.intensity * flick;
      ctx.shadowColor = "rgba(255,255,255,0.85)";
      ctx.shadowBlur = VB.glowStrength * sx;
      ctx.fillStyle = "#ffffff";
      const [x, y, w, h] = beamRect(currentLen, beamWidthPx + VB.glowStrength * sx * 0.4, 0);
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    }

    // ---- Trails (below main, staggered laterally + shorter) ----
    const trails = Math.max(0, Math.round(VB.trailCount));
    for (let ti = 1; ti <= trails; ti++) {
      ctx.save();
      ctx.globalAlpha = VB.trailOpacity * (1 - ti / (trails + 1)) * flick;
      ctx.fillStyle = "#ffffff";
      const trailLen = currentLen * (1 - ti * 0.08);
      const sign = (ti % 2 === 0) ? 1 : -1;
      const off = sign * ti * VB.trailSpread * sx;
      const [x, y, w, h] = beamRect(trailLen, beamWidthPx * 0.55, off);
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    }

    // ---- Main crisp beam ----
    ctx.save();
    ctx.globalAlpha = VB.intensity * flick;
    ctx.fillStyle = "#ffffff";
    const [x, y, w, h] = beamRect(currentLen, beamWidthPx, 0);
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }

  // Small technical corner brackets + labels for HUD overlays (event or
  // sustained). Alpha-safe.
  function drawHudOverlay(ctx, W, H, sy, flicker) {
    const op = clamp01(0.55 + 0.45 * flicker);
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${op * 0.55})`;
    ctx.lineWidth = Math.max(1, sy * 1.2);
    const cs = Math.max(14, Math.min(W, H) * 0.028); // corner size
    const m = Math.max(10, Math.min(W, H) * 0.02);   // margin
    // top-left
    ctx.beginPath(); ctx.moveTo(m, m + cs); ctx.lineTo(m, m); ctx.lineTo(m + cs, m); ctx.stroke();
    // top-right
    ctx.beginPath(); ctx.moveTo(W - m - cs, m); ctx.lineTo(W - m, m); ctx.lineTo(W - m, m + cs); ctx.stroke();
    // bottom-left
    ctx.beginPath(); ctx.moveTo(m, H - m - cs); ctx.lineTo(m, H - m); ctx.lineTo(m + cs, H - m); ctx.stroke();
    // bottom-right
    ctx.beginPath(); ctx.moveTo(W - m - cs, H - m); ctx.lineTo(W - m, H - m); ctx.lineTo(W - m, H - m - cs); ctx.stroke();
    // labels
    const fSize = Math.max(10, Math.min(W, H) * 0.014);
    ctx.fillStyle = `rgba(255,255,255,${op * 0.7})`;
    ctx.font = `600 ${fSize}px ui-monospace, "SF Mono", monospace`;
    ctx.textBaseline = "top";
    ctx.fillText("\u2310 PHASER.SYS", m + cs + 6, m - 1);
    ctx.textAlign = "right";
    ctx.fillText("REC \u25cf", W - m - cs - 6, m - 1);
    ctx.textAlign = "left"; ctx.textBaseline = "bottom";
    ctx.fillText(`X:${Math.floor(STATE.time * 100).toString().padStart(4, "0")} Y:${STATE.format.h}`, m + cs + 6, H - m + fSize + 2);
    ctx.textAlign = "right";
    ctx.fillText("SCAN // LIVE", W - m - cs - 6, H - m + fSize + 2);
    ctx.restore();
  }

  // Compute export canvas size + optional crop rect.
  function exportDims() {
    const q = qualScale();
    if (EXPORTOPTS.target === "layer" && EXPORTOPTS.lmode === "crop" && selectedLayer) {
      const T = selectedLayer.transform, A = STATE.format;
      const wPx = (T.wPct / 100) * A.w, hPx = (T.hPct / 100) * A.h;
      const x = A.w / 2 + (T.cx / 100) * A.w - wPx / 2, y = A.h / 2 + (T.cy / 100) * A.h - hPx / 2;
      const crop = { x, y, w: Math.max(1, wPx), h: Math.max(1, hPx) };
      return { W: Math.round(crop.w * q), H: Math.round(crop.h * q), crop };
    }
    return { W: Math.round(STATE.format.w * q), H: Math.round(STATE.format.h * q), crop: null };
  }
  function makeCanvas() { const { W, H } = exportDims(); const c = document.createElement("canvas"); c.width = W; c.height = H; return c; }
  function downloadBlob(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1500); }
  function setExportStatus(msg, kind) { if (el.exportStatus) { el.exportStatus.textContent = msg; el.exportStatus.dataset.kind = kind || "info"; } if (kind === "done" || kind === "error") toast(msg); }
  function baseName(ext) { const tgt = EXPORTOPTS.target === "layer" ? "layer" : "comp"; const fmt = STATE.format.label.includes("Reel") ? "reel" : STATE.format.label.includes("Post") ? "post" : STATE.format.label.includes("Portrait") ? "portrait" : "landscape"; return `phaser-${fmt}-${tgt}.${ext}`; }

  async function exportPNG(tOverride) {
    if (!layers.length) { toast("Add a layer first"); return; }
    if (EXPORTOPTS.target === "layer" && !selectedLayer) { setExportStatus("Select a layer first", "error"); return; }
    const transparent = tOverride !== undefined ? tOverride : (EXPORTOPTS.transparent || EXPORTOPTS.bg === "transparent");
    setExportStatus(transparent ? "Rendering transparent PNG…" : "Rendering PNG…", "work");
    const { W, H, crop } = exportDims(), c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d"), imgs = await rasterizeAll(W, H);
    redirectImgsToExportCanvases(imgs);
    await updateTextLayersForExportFrame(imgs, STATE.time, W, H);
    await drawExportFrame(ctx, W, H, imgs, STATE.time, { bg: transparent ? null : resolveExportBg(false) }, crop);
    c.toBlob((b) => { downloadBlob(b, transparent ? baseName("transparent.png") : baseName("png")); setExportStatus("Done — PNG saved", "done"); closeSheet(); }, "image/png");
  }
  async function exportSequence(tOverride) {
    if (!layers.length) { toast("Add a layer first"); return; }
    const transparent = tOverride !== undefined ? tOverride : (EXPORTOPTS.transparent || EXPORTOPTS.bg === "transparent");
    const fps = EXPORTOPTS.fps, dur = EXPORTOPTS.duration, total = Math.round(fps * dur);
    setExportStatus(`Rendering ${total} frames (${dur}s @ ${fps}fps)…`, "work");
    const { W, H, crop } = exportDims(), c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d"), imgs = await rasterizeAll(W, H), bg = transparent ? null : resolveExportBg(false);
    redirectImgsToExportCanvases(imgs);
    for (let f = 0; f < total; f++) { await seekAllVideoLayersTo(f / fps); await paintWebCodecsLayersForExport(f / fps); await updateTextLayersForExportFrame(imgs, f / fps, W, H); await drawExportFrame(ctx, W, H, imgs, f / fps, { bg }, crop); await new Promise((res) => c.toBlob((b) => { downloadBlob(b, `phaser-seq-${String(f).padStart(4, "0")}.png`); setTimeout(res, 55); }, "image/png")); if (f % 10 === 0) setExportStatus(`Rendering frame ${f + 1}/${total}…`, "work"); }
    setExportStatus("Done — sequence saved", "done"); closeSheet();
  }
  function pickWebmMime() { return ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm"; }
  async function exportWebM(alphaOverride) {
    if (!layers.length) { toast("Add a layer first"); return; }
    if (typeof MediaRecorder === "undefined") { setExportStatus("This browser can't record video — use PNG sequence", "error"); return; }
    const fps = EXPORTOPTS.fps;
    const totalDur = EXPORTOPTS.duration;
    const totalFrames = Math.max(1, Math.round(fps * totalDur));
    const frameInterval = 1000 / fps;
    // wantAlpha only when user explicitly requested alpha video
    const wantAlpha = alphaOverride !== undefined ? alphaOverride : (EXPORTOPTS.transparent && EXPORTOPTS.bg === "transparent");
    const artboardTransparent = STATE.bgMode === "transparent";
    if (!wantAlpha && (artboardTransparent || EXPORTOPTS.bg === "transparent")) {
      toast("WebM/MP4 don't preserve alpha — using a solid background. Use PNG sequence for real transparency.");
    }
    setExportStatus(`Recording WebM (${totalDur}s @ ${fps}fps)…`, "work");
    const { W, H, crop } = exportDims();
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    const imgs = await rasterizeAll(W, H);
    redirectImgsToExportCanvases(imgs);
    /* DETERMINISTIC CAPTURE PIPELINE
       Bug we're fixing: prior version used `canvas.captureStream(fps)` +
       requestAnimationFrame(). rAF is throttled in background tabs and
       under load, so short event effects (a 0.08s Hard Cut, a 0.2s Focus
       Snap) got missed by MediaRecorder — the layer rendered correctly
       to the canvas, but the video track never sampled that frame.
       Fix: captureStream(0) means "only capture on requestFrame()", so
       every drawExportFrame call becomes exactly one recorded frame. */
    const useManualCapture = typeof c.captureStream === "function";
    const vStream = useManualCapture ? c.captureStream(0) : c.captureStream(fps);
    const vTrack = vStream.getVideoTracks()[0];
    const canRequestFrame = vTrack && typeof vTrack.requestFrame === "function";
    let mixed = vStream;
    if (EXPORTOPTS.includeAudio && audio.ready && audio.ctx) {
      try {
        audio.streamDest = audio.streamDest || audio.ctx.createMediaStreamDestination();
        audio.destGain.connect(audio.streamDest);
        const at = audio.streamDest.stream.getAudioTracks()[0];
        if (at) mixed = new MediaStream([...vStream.getVideoTracks(), at]);
        if (audio.ctx.state === "suspended") await audio.ctx.resume();
        audio.el.currentTime = 0;
        audio.el.play().catch(() => {});
      } catch (e) {}
    }
    const bg = resolveExportBg(true, wantAlpha);
    let rec;
    try {
      rec = new MediaRecorder(mixed, { mimeType: pickWebmMime(), videoBitsPerSecond: bitrateFor(EXPORTOPTS.quality) });
    } catch (e) {
      setExportStatus("Recording not supported here — use PNG sequence", "error");
      return;
    }
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => { rec.onstop = () => r(); });
    // Playback-based export sync: pre-seek all legacy video layers to
    // their srcInPoint once, then let native playback advance them at
    // 1x during the loop.
    await initVideoLayersForExport();
    rec.start();
    /* ---- Strict real-time pacing to preserve target duration --------
       MediaRecorder timestamps every captured frame at wall-clock, so
       the recorded file's duration equals the wall-clock elapsed
       between the first and last requestFrame() calls.  If seek+draw
       is faster than the frame interval we wait to target; if slower,
       we SKIP the seek+draw on that iteration and fire requestFrame()
       on time anyway.  The canvas keeps its previous contents in that
       slot (one duplicate frame).  Result: exact target duration.  */
    const frameIntervalMs = 1000 / fps;
    const startWall = performance.now();
    let droppedFrames = 0;
    for (let f = 0; f < totalFrames; f++) {
      const t = f / fps;
      const targetWall = startWall + (f + 1) * frameIntervalMs;
      const nowBefore = performance.now();
      const behindMs = nowBefore - (startWall + f * frameIntervalMs);

      if (behindMs < frameIntervalMs * 1.5) {
        // On budget — do the full seek + WebCodecs paint + composite.
        await driveVideoLayersRealtime(t % STATE.duration);
        await paintWebCodecsLayersForExport(t % STATE.duration);
        await updateTextLayersForExportFrame(imgs, t % STATE.duration, W, H);
        await drawExportFrame(ctx, W, H, imgs, t % STATE.duration, { bg }, crop);
      } else {
        // Behind by more than 1.5 frame intervals — reuse the last
        // drawn frame.  Prevents the export from stretching beyond
        // the target duration when the decoder can't keep up.
        droppedFrames++;
      }
      // Gate requestFrame() on the target wall-clock so MediaRecorder
      // sees consistently-spaced samples regardless of iteration cost.
      const wait = targetWall - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (canRequestFrame) vTrack.requestFrame();
      if (f % Math.max(1, Math.round(fps / 3)) === 0) {
        setExportStatus(`Recording ${f + 1}/${totalFrames}…` + (droppedFrames ? ` (${droppedFrames} paced-out)` : ""), "work");
      }
    }
    // Give the recorder one more moment to flush the last frames
    await new Promise((r) => setTimeout(r, Math.max(80, frameIntervalMs * 2)));
    rec.stop();
    await stopped;
    finalizeVideoLayersAfterExport();
    if (droppedFrames) console.log("[Phaser export] paced-out frames:", droppedFrames, "/", totalFrames);
    const blob = new Blob(chunks, { type: "video/webm" });
    LAST_WEBM_BLOB = blob;
    downloadBlob(blob, wantAlpha ? baseName("alpha.webm") : baseName("webm"));
    if (audio.ready) audio.el.pause();
    setExportStatus("Done — WebM saved", "done"); closeSheet();
  }

  /* MP4 (H.264) via ffmpeg.wasm — FFMPEG.WASM INTEGRATION POINT
     Record WebM then transcode. ffmpeg tags are commented out in
     index.html by default (~30MB). Without them: export WebM + message.
     The MP4 button never crashes the app. */
  let LAST_WEBM_BLOB = null, ffmpegInstance = null;

  /* ================ Audio export ==================================
     Offline audio mixdown for the export pipeline.  Renders music +
     SFX/voice clips into a single AudioBuffer via OfflineAudioContext,
     then feeds it to `AudioEncoder` (AAC) which produces
     `EncodedAudioChunk`s that mp4-muxer interleaves alongside the
     video chunks.  Video-source audio (from imported MP4s) is not
     included in v1 — deferred to a future release. */

  // Returns true if there's anything audible to include in the export.
  function hasAudioToExport() {
    if (audio.el && audio.el.src) return true;
    if (audioClips.some((c) => !c.muted)) return true;
    return false;
  }

  // Decode the music track's blob-URL into an AudioBuffer.  Cached on
  // audio.musicBuffer so repeat exports don't re-fetch.
  async function decodeMusicBuffer() {
    if (!audio.el || !audio.el.src) return null;
    if (audio.musicBuffer) return audio.musicBuffer;
    try {
      const resp = await fetch(audio.el.src);
      const arr = await resp.arrayBuffer();
      // Decode via a temporary offline context (any sample rate — we
      // only care about the resulting AudioBuffer, which the export
      // OfflineAudioContext will happily accept).
      const tempCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, 128, 44100);
      audio.musicBuffer = await tempCtx.decodeAudioData(arr);
      return audio.musicBuffer;
    } catch (e) {
      console.warn("[Phaser audio] music decode failed:", e);
      return null;
    }
  }

  // Render the full audio scene (music + SFX/voice clips) into one
  // AudioBuffer of exactly `durationSec` seconds at `sampleRate` Hz.
  async function renderAudioMixdown(durationSec, sampleRate) {
    const numChannels = 2;
    const totalSamples = Math.max(1, Math.ceil(durationSec * sampleRate));
    const OCCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OCCtor) throw new Error("OfflineAudioContext unavailable");
    const oc = new OCCtor(numChannels, totalSamples, sampleRate);
    const masterGain = mixLevel("master");

    // ---- Music track ----
    if (audio.el && audio.el.src) {
      const buf = await decodeMusicBuffer();
      if (buf) {
        const src = oc.createBufferSource();
        src.buffer = buf;
        // Loop matches the timeline loop setting so extended timelines
        // hear repeated music instead of silence past the track's end.
        src.loop = !!STATE.loop;
        const g = oc.createGain();
        g.gain.value = mixLevel("music") * masterGain;
        src.connect(g).connect(oc.destination);
        src.start(0);
      }
    }

    // ---- SFX / voice clips ----
    for (const clip of audioClips) {
      if (clip.muted) continue;
      const sound = sounds.find((s) => s.id === clip.soundId);
      if (!sound || !sound.buffer) continue;
      if (clip.start >= durationSec) continue;

      const clipStart = Math.max(0, clip.start);
      const offset = Math.max(0, -clip.start);
      const playDur = Math.min(
        clip.duration - offset,
        sound.duration - offset,
        durationSec - clipStart
      );
      if (playDur <= 0.001) continue;

      const src = oc.createBufferSource();
      src.buffer = sound.buffer;
      const g = oc.createGain();
      const busGain = (clip.track === "voice") ? mixLevel("voice") : mixLevel("sfx");
      g.gain.value = (clip.volume || 1) * busGain * masterGain;
      src.connect(g).connect(oc.destination);
      try { src.start(clipStart, offset, playDur); } catch (e) {}
    }

    return await oc.startRendering();
  }

  // Chunk an AudioBuffer into AudioData objects and push them into a
  // configured AudioEncoder.  Uses `f32-planar` format — the standard
  // WebCodecs planar layout.  Yields to the browser periodically so
  // the UI stays responsive during long mixdowns.
  async function encodeAudioBufferToAAC(audioBuffer, encoder, chunkFrames) {
    chunkFrames = chunkFrames || 1024;
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const totalFrames = audioBuffer.length;
    const channels = [];
    for (let c = 0; c < numChannels; c++) channels.push(audioBuffer.getChannelData(c));

    for (let offset = 0; offset < totalFrames; offset += chunkFrames) {
      const framesInChunk = Math.min(chunkFrames, totalFrames - offset);
      // Planar layout: [ch0 samples..., ch1 samples...]
      const planar = new Float32Array(framesInChunk * numChannels);
      for (let c = 0; c < numChannels; c++) {
        planar.set(channels[c].subarray(offset, offset + framesInChunk), c * framesInChunk);
      }
      const tsUs = Math.round((offset / sampleRate) * 1_000_000);
      const ad = new AudioData({
        format: "f32-planar",
        sampleRate,
        numberOfChannels: numChannels,
        numberOfFrames: framesInChunk,
        timestamp: tsUs,
        data: planar,
      });
      try { encoder.encode(ad); } finally { ad.close(); }
      // Keep queue bounded + yield to the UI once every ~100 chunks.
      if (encoder.encodeQueueSize > 8) {
        while (encoder.encodeQueueSize > 4) {
          await new Promise((r) => setTimeout(r, 2));
        }
      } else if ((offset / chunkFrames) % 100 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }


  // ---- mp4-muxer lazy loader (same pattern as mp4box).
  let _mp4MuxerLoadPromise = null;
  function loadMP4Muxer() {
    // The UMD build exposes either window.Mp4Muxer (v5+) or window.mp4Muxer
    // (older). We check both.
    const existing = window.Mp4Muxer || window.mp4Muxer;
    if (existing) return Promise.resolve(existing);
    if (_mp4MuxerLoadPromise) return _mp4MuxerLoadPromise;
    console.log("[Phaser MP4 S3] injecting mp4-muxer from CDN");
    _mp4MuxerLoadPromise = new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.min.js";
      s.async = true;
      s.onload = () => {
        const mod = window.Mp4Muxer || window.mp4Muxer;
        console.log("[Phaser MP4 S3] mp4-muxer script.onload — Mp4Muxer global present:", !!mod);
        resolve(mod || null);
      };
      s.onerror = () => {
        console.warn("[Phaser MP4 S3] mp4-muxer script.onerror — CDN load failed");
        _mp4MuxerLoadPromise = null;
        resolve(null);
      };
      document.head.appendChild(s);
    });
    return _mp4MuxerLoadPromise;
  }

  /* Returns true on success (MP4 saved), false on any failure (caller
     falls back to WebM).  All failure modes are logged with a distinct
     prefix so users on Edge can grep DevTools console. */
  async function exportMP4_S3() {
    const diag = { steps: [], finalPath: null };
    const step = (label, extra) => {
      diag.steps.push({ label, ...(extra || {}) });
      console.log("[Phaser MP4 S3]", label, extra || "");
    };
    window.__phaserMP4Diag = diag;

    // Phase 1 diagnostics activation
    if (window.__phaserExportDiag && window.__phaserExportDiag.frameIndex != null) {
      _exportDiag.active = true;
      _exportDiag.frameIndex = Number(window.__phaserExportDiag.frameIndex);
      _exportDiag.captures = {};
      _exportDiag.report = {};
      step("Phase 1 diagnostics ACTIVE", { targetFrame: _exportDiag.frameIndex });
    } else {
      _exportDiag.active = false;
    }

    // 1) API detection.
    if (typeof VideoEncoder === "undefined")      { step("VideoEncoder unavailable");      diag.finalPath = "fallback:no-videoencoder"; return false; }
    if (typeof EncodedVideoChunk === "undefined") { step("EncodedVideoChunk unavailable"); diag.finalPath = "fallback:no-chunk";         return false; }
    if (typeof VideoFrame === "undefined")        { step("VideoFrame unavailable");        diag.finalPath = "fallback:no-videoframe";    return false; }
    step("WebCodecs encoder APIs present");

    // 2) mp4-muxer.
    const Muxer = await loadMP4Muxer();
    if (!Muxer) { step("mp4-muxer failed to load"); diag.finalPath = "fallback:no-muxer"; return false; }
    step("mp4-muxer loaded", { hasMuxer: typeof Muxer.Muxer === "function", hasABT: typeof Muxer.ArrayBufferTarget === "function" });

    // 3) Compute encode parameters.
    const fps = EXPORTOPTS.fps;
    const totalDur = EXPORTOPTS.duration;
    const totalFrames = Math.max(1, Math.round(fps * totalDur));
    const { W, H, crop } = exportDims();
    const bitrate = bitrateFor(EXPORTOPTS.quality);
    // Codec: H.264 High Profile, Level 4.0 — safe for Instagram/TikTok/YouTube.
    // Some encoders don't have High; if the check fails we try Main then Baseline.
    const codecCandidates = ["avc1.640028", "avc1.4d0028", "avc1.42E01E"];
    let codec = null, support = null;
    for (const c of codecCandidates) {
      try {
        const r = await VideoEncoder.isConfigSupported({ codec: c, width: W, height: H, bitrate, framerate: fps });
        if (r && r.supported) { codec = c; support = r; break; }
      } catch (e) {}
    }
    if (!codec) { step("no supported H.264 profile", { tried: codecCandidates, W, H }); diag.finalPath = "fallback:codec-unsupported"; return false; }
    step("codec selected", { codec, W, H, bitrate, fps });

    // 4) Build muxer + encoders.
    // Decide up front whether audio will be included.  Requires both an
    // audible scene and the AudioEncoder/AudioData APIs.  Anything else
    // → video-only export with a clear status message.
    const AUDIO_SR = 48000;
    const AUDIO_CHANNELS = 2;
    // v18.5: raised from 128k to 192k.  AAC-LC at 128kbps is
    // near-transparent for spoken voice but loses subtle spectral
    // detail on music (cymbal shimmer, string harmonics).  192k is
    // the broadcast quality tier — indistinguishable from source for
    // typical short-form content.  Trade-off: ~50% larger audio
    // track, still small relative to video track size.
    const AUDIO_BITRATE = 192000;
    const hasAudio = hasAudioToExport();
    // v18.5 audio diagnostics — record source vs export characteristics
    // so users can see any resample or sample-rate mismatch.
    const audioDiag = {
      source_hasMusicEl: !!(audio.el && audio.el.src),
      source_musicSampleRate: (audio.musicBuffer && audio.musicBuffer.sampleRate) || null,
      source_musicChannels: (audio.musicBuffer && audio.musicBuffer.numberOfChannels) || null,
      source_sfxClipCount: audioClips.length,
      export_sampleRate: AUDIO_SR,
      export_channels: AUDIO_CHANNELS,
      export_bitrate: AUDIO_BITRATE,
      export_codec: "mp4a.40.2",
    };
    step("audio diagnostics", audioDiag);
    const canEncodeAudio = hasAudio
      && typeof AudioEncoder !== "undefined"
      && typeof AudioData !== "undefined";
    let audioSupported = false;
    if (canEncodeAudio) {
      try {
        const r = await AudioEncoder.isConfigSupported({
          codec: "mp4a.40.2", sampleRate: AUDIO_SR, numberOfChannels: AUDIO_CHANNELS, bitrate: AUDIO_BITRATE,
        });
        audioSupported = !!(r && r.supported);
      } catch (e) { audioSupported = false; }
    }
    step("audio decision", { hasAudio, canEncodeAudio, audioSupported });

    let muxer;
    try {
      const muxerCfg = {
        target: new Muxer.ArrayBufferTarget(),
        video: { codec: "avc", width: W, height: H, frameRate: fps },
        fastStart: "in-memory",
      };
      if (audioSupported) {
        muxerCfg.audio = { codec: "aac", numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_SR };
      }
      muxer = new Muxer.Muxer(muxerCfg);
    } catch (e) { step("muxer construction failed", { error: String(e) }); diag.finalPath = "fallback:muxer-init"; return false; }
    step("muxer constructed", { withAudio: audioSupported });

    let encodeError = null;
    // v18.2 diagnostics — track how many chunks reach the muxer for
    // each track so we can prove whether the video track is actually
    // being written when audio is also present.  Also record the
    // timestamp range so we can see if either track stopped early.
    const muxStats = {
      video: { count: 0, firstTs: null, lastTs: null, keyframes: 0 },
      audio: { count: 0, firstTs: null, lastTs: null },
    };
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          muxer.addVideoChunk(chunk, meta);
          muxStats.video.count++;
          if (muxStats.video.firstTs === null) muxStats.video.firstTs = chunk.timestamp;
          muxStats.video.lastTs = chunk.timestamp;
          if (chunk.type === "key") muxStats.video.keyframes++;
          // Phase 1 diag: capture the SPS description from the very
          // first chunk's metadata.  Chrome emits `meta.decoderConfig
          // .description` with the AVCDecoderConfigurationRecord
          // (avcC contents) which contains the SPS bytes we need.
          if (_exportDiag.active && !_exportDiag.captures.avcCDescription
              && meta && meta.decoderConfig && meta.decoderConfig.description) {
            _exportDiag.captures.avcCDescription = new Uint8Array(meta.decoderConfig.description).slice();
          }
        } catch (e) { encodeError = e; step("addVideoChunk threw", { error: String(e), atTs: chunk && chunk.timestamp }); }
      },
      error: (e) => { encodeError = e; step("encoder error", { error: String(e) }); },
    });

    // v18.5 COLOR-SPACE INVESTIGATION
    // Symptom reported: lifted blacks + desaturated colors in exported
    // MP4 vs preview canvas.  Suspected cause: encoder produces
    // limited-range (16–235) YUV without writing the corresponding
    // range flag into the H.264 SPS VUI, so players default to
    // full-range interpretation → limited-range values render lifted.
    //
    // WebCodecs spec: colorSpace is a property of VideoFrame, NOT of
    // VideoEncoderConfig.  We set it at VideoFrame construction time
    // (see frame loop below).  This tells the encoder the source
    // colorimetry so it can write correct VUI flags.
    //
    // Chrome's actual behavior with this flag varies by version and
    // hardware.  Full instrumentation below lets users report what
    // their browser actually does.
    const videoConfig = {
      codec, width: W, height: H, bitrate, framerate: fps,
      latencyMode: "quality",
      avc: { format: "avc" },
    };
    step("VideoEncoder config", {
      codec: videoConfig.codec,
      width: videoConfig.width, height: videoConfig.height,
      bitrate: videoConfig.bitrate, framerate: videoConfig.framerate,
      avc: videoConfig.avc,
      note: "colorSpace applied at VideoFrame construction, not encoder config (per WebCodecs spec)",
    });
    try {
      encoder.configure(videoConfig);
    } catch (e) { step("encoder.configure threw", { error: String(e) }); try { encoder.close(); } catch(_){}; diag.finalPath = "fallback:encoder-configure"; return false; }
    step("encoder configured");

    // Configure the AudioEncoder if audio is going to be muxed.
    let audioEncoder = null;
    if (audioSupported) {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          try {
            muxer.addAudioChunk(chunk, meta);
            muxStats.audio.count++;
            if (muxStats.audio.firstTs === null) muxStats.audio.firstTs = chunk.timestamp;
            muxStats.audio.lastTs = chunk.timestamp;
          } catch (e) { encodeError = e; step("addAudioChunk threw", { error: String(e), atTs: chunk && chunk.timestamp }); }
        },
        error: (e) => { encodeError = e; step("audio encoder error", { error: String(e) }); },
      });
      try {
        audioEncoder.configure({
          codec: "mp4a.40.2", sampleRate: AUDIO_SR, numberOfChannels: AUDIO_CHANNELS, bitrate: AUDIO_BITRATE,
        });
        step("audio encoder configured");
      } catch (e) {
        step("audioEncoder.configure threw", { error: String(e) });
        try { audioEncoder.close(); } catch(_){}
        audioEncoder = null;
      }
    }

    // 5) Prepare scene canvas + imgs.  BEFORE the video loop (which
    // needs them) and BEFORE audio encoding (which is independent).
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d", { alpha: false });
    const imgs = await rasterizeAll(W, H);
    redirectImgsToExportCanvases(imgs);
    const bg = resolveExportBg(true, false);
    await initVideoLayersForExport();
    step("scene prepared", { totalFrames });

    // 6) Video frame loop.  Runs FIRST — mp4-muxer expects the video
    // track's first sample (a keyframe at ts=0) to reach the muxer
    // before other-track samples stack up.  When we encoded audio
    // first, the muxer had audio samples covering the full duration
    // in its buffer BEFORE seeing any video samples; some builds
    // silently produced audio-only output in that case.
    //
    // See v16→v18.2 changelog: this reorder is the fix for the
    // "graphics + audio → graphics disappear" export regression.
    const KEYFRAME_INTERVAL = fps * 2;
    const MAX_QUEUE = 8;   // bound in-flight encoder work
    setExportStatus(`Encoding ${totalFrames} frames…`, "work");
    for (let f = 0; f < totalFrames; f++) {
      if (encodeError) break;
      const t = f / fps;
      // Drive video sources — WebCodecs (from cache) and legacy (seek-based).
      // Neither depends on wall-clock: WebCodecs is a synchronous cache
      // lookup after prefetch, legacy uses per-frame HTMLVideoElement
      // seek which is deterministic though slower.
      await seekAllVideoLayersTo(t);              // legacy layers only (no-op otherwise)
      await paintWebCodecsLayersForExport(t);     // WebCodecs layers only (no-op otherwise)
      await updateTextLayersForExportFrame(imgs, t, W, H);
      await drawExportFrame(ctx, W, H, imgs, t, { bg }, crop);
      // Phase 1 diag: capture pre-encode PNG at target frame.  This
      // is the canvas EXACTLY as it enters new VideoFrame(canvas, ...).
      // The diff between this PNG and the decoded-MP4 PNG proves what
      // the encoder+muxer does to the pixels.
      if (_exportDiag.active && f === _exportDiag.frameIndex) {
        try {
          const pngBlob = await new Promise((res) => c.toBlob(res, "image/png"));
          _exportDiag.captures.preencodePng = pngBlob;
          _exportDiag.frameTimestampSec = t;
          step("diag: pre-encode PNG captured", { frame: f, bytes: pngBlob && pngBlob.size });
        } catch (e) { step("diag: pre-encode capture failed", { error: String(e) }); }
      }
      // Legacy v18.5 debug: dump one frame as PNG BEFORE it enters the
      // encoder.  Users can compare this PNG against the preview
      // canvas and against a frame extracted from the final MP4
      // — differences between {preview, PNG} isolate rendering
      // issues; differences between {PNG, MP4 frame} isolate
      // encoder issues.  Triggered by setting
      // `window.__phaserDumpFrame = <frameIndex>` before export.
      if (window.__phaserDumpFrame != null && Number(window.__phaserDumpFrame) === f) {
        try {
          c.toBlob((b) => {
            if (!b) return;
            const url = URL.createObjectURL(b);
            const a = document.createElement("a");
            a.href = url;
            a.download = `phaser-preencode-frame-${f}.png`;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            step("pre-encode frame PNG dumped", { frame: f, bytes: b.size });
          }, "image/png");
        } catch (e) { step("frame dump failed", { error: String(e) }); }
      }
      // Timestamp is explicit and monotonic — muxer duration = last_ts + 1_frame_us
      const timestamp_us = Math.round((f * 1_000_000) / fps);
      const duration_us  = Math.round(1_000_000 / fps);
      // v18.5: pass explicit colorSpace to VideoFrame.  Per WebCodecs
      // spec, colorSpace is a VideoFrame property, not an encoder
      // property.  Chrome propagates this through the encoder so the
      // H.264 SPS VUI gets correct color_primaries / transfer_
      // characteristics / matrix_coefficients / video_full_range_flag.
      // Actual respect for this flag varies by Chrome version + HW
      // accelerator; the diagnostic log at frame 0 records what
      // Chrome actually reports after construction.
      let vf;
      try {
        vf = new VideoFrame(c, {
          timestamp: timestamp_us,
          duration: duration_us,
          // Full-range sRGB → BT.709 matrix path.  Canvas source is
          // already sRGB/full-range so this is truthful metadata.
          colorSpace: {
            primaries: "bt709",
            transfer:  "iec61966-2-1",   // sRGB gamma
            matrix:    "bt709",
            fullRange: true,
          },
        });
      } catch (e) { step("VideoFrame construction failed at frame " + f, { error: String(e) }); break; }
      // Log the actual VideoFrame colorSpace once so users can see
      // what Chrome ended up using (may differ from requested).
      if (f === 0) {
        try {
          step("VideoFrame colorSpace at frame 0", {
            primaries: vf.colorSpace && vf.colorSpace.primaries,
            transfer:  vf.colorSpace && vf.colorSpace.transfer,
            matrix:    vf.colorSpace && vf.colorSpace.matrix,
            fullRange: vf.colorSpace && vf.colorSpace.fullRange,
            format: vf.format,
            codedWidth: vf.codedWidth,
            codedHeight: vf.codedHeight,
          });
        } catch (e) {}
      }
      try {
        encoder.encode(vf, { keyFrame: (f % KEYFRAME_INTERVAL) === 0 });
      } catch (e) { step("encoder.encode threw at frame " + f, { error: String(e) }); vf.close(); break; }
      vf.close();
      // Bound the queue so we don't hold too many encoded chunks in memory.
      while (encoder.encodeQueueSize > MAX_QUEUE && !encodeError) {
        await new Promise((r) => setTimeout(r, 4));
      }
      if (f % Math.max(1, Math.round(fps / 3)) === 0) {
        setExportStatus(`Encoding ${f + 1}/${totalFrames}…`, "work");
      }
    }

    // 7) Flush video encoder BEFORE encoding audio.  This ensures every
    // video chunk has reached the muxer (via the output callback)
    // before we start feeding audio samples.  Keeps the tracks
    // strictly separated in encode-order and prevents any
    // race-adjacent behavior where audio chunks might arrive while
    // video is still draining.
    step("flushing video encoder", { queueSize: encoder.encodeQueueSize });
    try { await encoder.flush(); } catch (e) { step("video flush threw", { error: String(e) }); }
    try { encoder.close(); } catch (e) {}
    step("video encoder flushed", { chunks: muxStats.video.count, keyframes: muxStats.video.keyframes,
      firstTs: muxStats.video.firstTs, lastTs: muxStats.video.lastTs });

    // 8) Render + encode audio LAST — after video is fully committed.
    //    Audio mixdown is offline via OfflineAudioContext (fast: <200ms
    //    for typical short-form durations), then chunked to AAC via
    //    AudioEncoder.  The muxer interleaves samples by timestamp
    //    when finalize() is called; encoding order doesn't affect the
    //    final MP4 layout so long as tracks are internally monotonic.
    if (audioEncoder) {
      try {
        setExportStatus("Rendering audio mixdown…", "work");
        const audioBuffer = await renderAudioMixdown(EXPORTOPTS.duration, AUDIO_SR);
        step("audio mixdown rendered", { seconds: audioBuffer.duration.toFixed(2), frames: audioBuffer.length, sampleRate: audioBuffer.sampleRate });
        await encodeAudioBufferToAAC(audioBuffer, audioEncoder);
        step("audio chunks enqueued", { queueSize: audioEncoder.encodeQueueSize });
        // CRITICAL: flush the audio encoder so every chunk reaches
        // the muxer before we finalize.  Without this some chunks
        // stay pending in the encoder's internal queue and never
        // reach the muxer, producing shorter audio track duration
        // than intended (or none at all).
        await audioEncoder.flush();
        step("audio encoder flushed", { chunks: muxStats.audio.count,
          firstTs: muxStats.audio.firstTs, lastTs: muxStats.audio.lastTs });
        try { audioEncoder.close(); } catch (e) {}
      } catch (e) {
        step("audio encode failed — continuing video-only", { error: String(e && e.message || e) });
        console.warn("[Phaser MP4 S3] audio encode failed, continuing video-only:", e);
        try { audioEncoder.close(); } catch(_){}
        audioEncoder = null;
      }
    }
    finalizeVideoLayersAfterExport();

    if (encodeError) { step("encode error, aborting", { error: String(encodeError) }); diag.finalPath = "fallback:encode-error"; return false; }

    try { muxer.finalize(); } catch (e) { step("muxer.finalize threw", { error: String(e) }); diag.finalPath = "fallback:muxer-finalize"; return false; }
    const buffer = muxer.target.buffer;
    if (!buffer || buffer.byteLength === 0) { step("muxer produced empty buffer"); diag.finalPath = "fallback:empty-output"; return false; }

    step("SUCCESS — saving MP4", {
      bytes: buffer.byteLength,
      video: muxStats.video,
      audio: muxStats.audio,
      audioSupported: !!audioEncoder,
    });
    diag.finalPath = "s3-success";
    diag.muxStats = muxStats;
    const outName = baseName("mp4");
    downloadBlob(new Blob([buffer], { type: "video/mp4" }), outName);
    const audioTag = audioEncoder ? ` · with audio (${muxStats.audio.count} chunks)` : (hasAudio ? " · video-only (audio encoding unsupported)" : "");
    const videoTag = ` · ${muxStats.video.count} video chunks`;
    setExportStatus(`Done — ${outName} saved (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB${videoTag}${audioTag})`, "done");
    closeSheet();

    // Phase 1 diagnostics: after MP4 is saved, run bitstream + container
    // inspection, extract the target frame from the MP4 via <video>
    // playback, compute histograms, and download all artifacts + a
    // diag-report.json.  Happens asynchronously — export return value
    // is not delayed.
    if (_exportDiag.active) {
      (async () => {
        try {
          setExportStatus("Running Phase 1 diagnostics…", "work");
          // 1. Parse SPS VUI from captured avcC description
          if (_exportDiag.captures.avcCDescription) {
            // The description is an AVCDecoderConfigurationRecord.
            // Skip the record header to find the first SPS.
            // Layout: 5 bytes header + 1 byte (numSPS with reserved bits)
            //         + 2 bytes SPS length + SPS bytes ...
            const desc = _exportDiag.captures.avcCDescription;
            let sps = null;
            try {
              const numSps = desc[5] & 0x1F;
              if (numSps >= 1) {
                const spsLen = (desc[6] << 8) | desc[7];
                sps = desc.slice(8, 8 + spsLen);
              }
            } catch (e) { /* leave sps=null */ }
            _exportDiag.report.sps_vui = sps
              ? parseSpsVui(sps)
              : { error: "Could not extract SPS from avcC description", descLength: desc.length };
          } else {
            _exportDiag.report.sps_vui = { error: "No avcC description was captured from any chunk" };
          }
          step("diag: SPS VUI parsed", _exportDiag.report.sps_vui);

          // 2. Scan MP4 for colr atom
          _exportDiag.report.container_colr = findColrAtom(buffer);
          step("diag: colr atom scan", _exportDiag.report.container_colr);

          // 3. Extract decoded MP4 frame via <video> playback
          const extractResult = await extractMp4FrameAsPng(buffer, _exportDiag.frameTimestampSec, W, H);
          if (extractResult && extractResult.blob) {
            _exportDiag.captures.decodedFramePng = extractResult.blob;
            step("diag: decoded MP4 frame extracted", { size: extractResult.blob.size, videoW: extractResult.videoWidth, videoH: extractResult.videoHeight });
          } else {
            _exportDiag.report.mp4_frame_extract = { error: (extractResult && extractResult.error) || "unknown" };
            step("diag: MP4 frame extraction failed", _exportDiag.report.mp4_frame_extract);
          }

          // 4. Compute histograms for pre-encode and decoded frame
          _exportDiag.report.histograms = {
            preencode: await computeImageStats(_exportDiag.captures.preencodePng),
            mp4_decoded: await computeImageStats(_exportDiag.captures.decodedFramePng),
          };
          step("diag: histograms computed", _exportDiag.report.histograms);

          // 5. Deliver all artifacts
          _exportDiag.report.captures_summary = {
            frameIndex: _exportDiag.frameIndex,
            frameTimestampSec: _exportDiag.frameTimestampSec,
            hadPreencodePng: !!_exportDiag.captures.preencodePng,
            hadDecodedFramePng: !!_exportDiag.captures.decodedFramePng,
            hadAvcCDescription: !!_exportDiag.captures.avcCDescription,
            mp4_size_bytes: buffer.byteLength,
            preview_screenshot: "Manual capture required — press H, seek to target time, screenshot the stage before running export next time",
          };
          await deliverDiagArtifacts(_exportDiag);
          diag.phase1 = _exportDiag.report;
          setExportStatus(`Phase 1 diagnostics complete — check downloads folder`, "done");
        } catch (e) {
          step("diag: post-export diagnostics failed", { error: String(e) });
        } finally {
          _exportDiag.active = false;
        }
      })();
    }
    return true;
  }

  // Adaptive bitrate — the old 12/16 Mbps was excessive and produced huge
  // files. Recommended range for 1080p Instagram content is 5-9 Mbps.
  function bitrateFor(quality) {
    if (quality === "ultra") return 9_000_000;
    if (quality === "2x")    return 14_000_000;
    return 5_000_000; // "high" default
  }
  // Estimated output size (bytes) = bitrate * duration / 8.
  function estimatedSizeBytes() {
    return Math.round(bitrateFor(EXPORTOPTS.quality) * EXPORTOPTS.duration / 8);
  }
  function humanBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024*1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024*1024)).toFixed(1) + " MB";
  }
  async function loadFFmpeg() {
    if (ffmpegInstance) return ffmpegInstance;
    const hasNew = typeof window.FFmpeg !== "undefined" && window.FFmpeg.FFmpeg, hasClassic = typeof window.FFmpeg !== "undefined" && window.FFmpeg.createFFmpeg;
    if (!hasNew && !hasClassic) return null;
    if (hasNew) { const { FFmpeg } = window.FFmpeg; const ff = new FFmpeg(); await ff.load(); ffmpegInstance = { api: "new", ff }; }
    else { const ff = window.FFmpeg.createFFmpeg({ log: false }); await ff.load(); ffmpegInstance = { api: "classic", ff }; }
    return ffmpegInstance;
  }
  async function exportMP4() {
    if (!layers.length) { toast("Add a layer first"); return; }

    // ---- Alpha exports route to WebM.  H.264 has no alpha channel; a
    // transparent PNG sequence or an alpha WebM is the correct output.
    const wantsAlpha = EXPORTOPTS.transparent && EXPORTOPTS.bg === "transparent";
    if (wantsAlpha) {
      toast("Alpha exports use WebM — H.264 has no alpha channel.");
      setExportStatus("Exporting alpha WebM (VP9)…", "work");
      // Delegate to the standard WebM export with transparent flag on.
      // The existing exportWebm handles alpha via VP9-in-WebM.
      if (el.exportWebmA) el.exportWebmA.click();
      else if (el.exportWebm) el.exportWebm.click();
      return;
    }

    // ---- Try S3 first (frame-accurate, no external deps).
    setExportStatus("Preparing frame-accurate MP4 export…", "work");
    const s3ok = await exportMP4_S3();
    if (s3ok) return;

    // ---- S3 failed: fall back to legacy ffmpeg.wasm transcode if it's
    // available (usually only on localhost / self-hosted).
    LAST_WEBM_BLOB = null;
    setExportStatus("Frame-accurate MP4 unavailable — recording WebM to transcode…", "work");
    await recordWebMForMp4();
    if (!LAST_WEBM_BLOB) { setExportStatus("Could not produce MP4 or WebM", "error"); return; }
    let ff = null; try { ff = await loadFFmpeg(); } catch (e) { console.error("[Phaser] ffmpeg load error:", e); ff = null; }
    if (!ff) {
      downloadBlob(LAST_WEBM_BLOB, baseName("webm"));
      setExportStatus("MP4 unavailable — saved WebM instead. Try Edge or Chrome for frame-accurate MP4 export.", "error");
      return;
    }
    try {
      setExportStatus("Encoding H.264 MP4 via ffmpeg.wasm…", "work");
      const inName = "in.webm", outName = baseName("mp4"), bytes = new Uint8Array(await LAST_WEBM_BLOB.arrayBuffer());
      const crf = EXPORTOPTS.quality === "ultra" || EXPORTOPTS.quality === "2x" ? "16" : "18";
      const args = ["-i", inName, "-c:v", "libx264", "-preset", "veryfast", "-crf", crf, "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-r", String(EXPORTOPTS.fps), "-c:a", "aac", "-b:a", "192k", outName];
      if (ff.api === "new") { await ff.ff.writeFile(inName, bytes); await ff.ff.exec(args); const out = await ff.ff.readFile(outName); downloadBlob(new Blob([out.buffer], { type: "video/mp4" }), outName); }
      else { ff.ff.FS("writeFile", inName, bytes); await ff.ff.run(...args); const out = ff.ff.FS("readFile", outName); downloadBlob(new Blob([out.buffer], { type: "video/mp4" }), outName); }
      setExportStatus("Done — " + outName + " saved (ffmpeg fallback)", "done"); closeSheet();
    } catch (e) {
      console.error("[Phaser] MP4 encode failed:", e);
      downloadBlob(LAST_WEBM_BLOB, baseName("webm"));
      setExportStatus("MP4 encode failed (" + (e && e.message ? e.message : "unknown") + ") — saved WebM as fallback.", "error");
    }
  }
  function recordWebMForMp4() {
    return new Promise(async (resolve) => {
      if (typeof MediaRecorder === "undefined") { resolve(); return; }
      const fps = EXPORTOPTS.fps;
      const totalDur = EXPORTOPTS.duration;
      const totalFrames = Math.max(1, Math.round(fps * totalDur));
      const frameInterval = 1000 / fps;
      const { W, H, crop } = exportDims();
      const c = document.createElement("canvas"); c.width = W; c.height = H;
      const ctx = c.getContext("2d");
      const imgs = await rasterizeAll(W, H);
      redirectImgsToExportCanvases(imgs);
      // Same deterministic capture pattern as exportWebM — every event
      // frame is guaranteed to reach the encoder.
      const useManualCapture = typeof c.captureStream === "function";
      const vStream = useManualCapture ? c.captureStream(0) : c.captureStream(fps);
      const vTrack = vStream.getVideoTracks()[0];
      const canRequestFrame = vTrack && typeof vTrack.requestFrame === "function";
      let mixed = vStream;
      if (EXPORTOPTS.includeAudio && audio.ready && audio.ctx) {
        try {
          audio.streamDest = audio.streamDest || audio.ctx.createMediaStreamDestination();
          audio.destGain.connect(audio.streamDest);
          const at = audio.streamDest.stream.getAudioTracks()[0];
          if (at) mixed = new MediaStream([...vStream.getVideoTracks(), at]);
          if (audio.ctx.state === "suspended") await audio.ctx.resume();
          audio.el.currentTime = 0; audio.el.play().catch(() => {});
        } catch (e) {}
      }
      let rec;
      try { rec = new MediaRecorder(mixed, { mimeType: pickWebmMime(), videoBitsPerSecond: bitrateFor(EXPORTOPTS.quality) }); }
      catch (e) { resolve(); return; }
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => { LAST_WEBM_BLOB = new Blob(chunks, { type: "video/webm" }); if (audio.ready) audio.el.pause(); finalizeVideoLayersAfterExport(); resolve(); };
      const bg = resolveExportBg(true, false);
      await initVideoLayersForExport();
      rec.start();
      const frameIntervalMs = 1000 / fps;
      const startWall = performance.now();
      let droppedFrames = 0;
      for (let f = 0; f < totalFrames; f++) {
        const t = f / fps;
        const targetWall = startWall + (f + 1) * frameIntervalMs;
        const nowBefore = performance.now();
        const behindMs = nowBefore - (startWall + f * frameIntervalMs);
        if (behindMs < frameIntervalMs * 1.5) {
          await driveVideoLayersRealtime(t % STATE.duration);
          await paintWebCodecsLayersForExport(t % STATE.duration);
          await updateTextLayersForExportFrame(imgs, t % STATE.duration, W, H);
          await drawExportFrame(ctx, W, H, imgs, t % STATE.duration, { bg }, crop);
        } else {
          droppedFrames++;
        }
        const wait = targetWall - performance.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (canRequestFrame) vTrack.requestFrame();
      }
      await new Promise((r) => setTimeout(r, Math.max(80, frameIntervalMs * 2)));
      rec.stop();
      if (droppedFrames) console.log("[Phaser export] paced-out frames (MP4 path):", droppedFrames, "/", totalFrames);
    });
  }
  function syncExportUI() {
    const setA = (sel, val, attr) => $$(sel).forEach((b) => b.classList.toggle("active", b.dataset[attr] == val));
    setA("#fpsSeg [data-fps]", EXPORTOPTS.fps, "fps"); setA("#durSeg [data-dur]", EXPORTOPTS.duration, "dur");
    setA("#vbgSeg [data-vbg]", EXPORTOPTS.bg, "vbg"); setA("#qualSeg [data-qual]", EXPORTOPTS.quality, "qual");
    setA("#targetSeg [data-target]", EXPORTOPTS.target, "target"); setA("#layerModeSeg [data-lmode]", EXPORTOPTS.lmode, "lmode");
    el.layerModeRow.hidden = EXPORTOPTS.target !== "layer";
    if (el.optTransparent) el.optTransparent.checked = EXPORTOPTS.transparent;
    if (el.optAudio) el.optAudio.checked = EXPORTOPTS.includeAudio;
    // Estimated video file size — bitrate × duration ÷ 8. This is a rough
    // estimate for MP4/WebM; PNG/PNG-sequence sizes are much smaller and
    // vary widely, so we intentionally show one video-oriented number.
    const es = document.getElementById("estSize");
    if (es) es.textContent = `~ ${humanBytes(estimatedSizeBytes())} · ${(bitrateFor(EXPORTOPTS.quality) / 1_000_000).toFixed(1)} Mbps`;
  }

  /* ---------------- WIRING ---------------- */
  function wire() {
    // rail tabs
    $$(".rail-tab").forEach((tab) => tab.addEventListener("click", () => {
      $$(".rail-tab").forEach((t) => t.classList.remove("active"));
      $$(".tab-view").forEach((v) => v.classList.remove("active"));
      tab.classList.add("active");
      const view = document.querySelector(`.tab-view[data-view="${tab.dataset.tab}"]`); if (view) view.classList.add("active");
    }));

    // upload + drag/drop (multi-file)
    el.dropzone.addEventListener("click", () => el.fileInput.click());
    el.dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.fileInput.click(); } });
    el.fileInput.addEventListener("change", (e) => handleFiles(e.target.files));
    ["dragenter", "dragover"].forEach((ev) => el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) => el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.remove("drag"); }));
    el.dropzone.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));

    /* v19.0 Text Tool wiring.  Click T to activate; next click on
       artboard creates text; Escape cancels. */
    if (el.toolSelect) el.toolSelect.addEventListener("click", () => setTool("select"));
    if (el.toolText) {
      el.toolText.addEventListener("click", () => {
        setTool(STATE.tool === "text" ? "select" : "text");
      });
    }
    /* v19.1 — Keyboard split:
       - Tool activation (T for text) is NO LONGER a keyboard shortcut.
         Content creation happens via the left tool strip only.
       - T / E / B / C now navigate right-inspector sections.
       - Ctrl/Cmd+Shift+> / < adjust font size on selected text layer.
       Escape still cancels an active non-select tool. */
    function scrollInspectorTo(sectionId) {
      const target = document.getElementById(sectionId);
      if (!target) return;
      // Un-hide first if it was hidden by conditional visibility
      // (Transform is always visible when a layer is selected).
      const scroller = target.closest(".panel-scroll");
      if (scroller) {
        // Compute offset relative to scroller
        const trect = target.getBoundingClientRect();
        const srect = scroller.getBoundingClientRect();
        scroller.scrollTop += (trect.top - srect.top) - 6;
      } else {
        target.scrollIntoView({ block: "start", behavior: "smooth" });
      }
      // Brief flash so user knows which section is active
      target.classList.add("inspector-nav-flash");
      setTimeout(() => target.classList.remove("inspector-nav-flash"), 600);
    }
    // Font-size step: keep it Photoshop-like — 2px baseline, 10× with Alt.
    function nudgeTextFontSize(dir, big) {
      if (!selectedLayer || selectedLayer.kind !== "TEXT") return;
      const step = big ? 10 : 2;
      const cur = selectedLayer.textStyle.fontSize || 64;
      const next = clamp(cur + dir * step, 4, 800);
      updateTextLayer(selectedLayer, { fontSize: next });
      renderInspector();
    }
    document.addEventListener("keydown", (e) => {
      const typing = e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable);
      if (typing) return;
      // Escape cancels tool mode / text edit overlay
      if (e.key === "Escape" && STATE.tool !== "select") { setTool("select"); e.preventDefault(); return; }

      // Ctrl/Cmd+Shift+> / <  — font-size nudge on selected text layer.
      // e.key on "." with shift → ">"; on "," with shift → "<".  We also
      // accept the direct ">" / "<" characters in case the browser
      // resolves them.  Alt held = 10× step.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
        if (e.key === ">" || e.key === "." || e.code === "Period") {
          e.preventDefault();
          nudgeTextFontSize(+1, e.altKey);
          return;
        }
        if (e.key === "<" || e.key === "," || e.code === "Comma") {
          e.preventDefault();
          nudgeTextFontSize(-1, e.altKey);
          return;
        }
      }

      // Right-inspector navigation shortcuts.  Plain key (no modifier).
      // Guarded so text tool remains mouse-driven.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = (e.key || "").toLowerCase();
      const nav = { t: "transformGroup", e: "fxGroup", b: null /* handled below */, c: "colorGroup" };
      if (k === "t") { e.preventDefault(); scrollInspectorTo("transformGroup"); return; }
      if (k === "e") { e.preventDefault(); scrollInspectorTo("fxGroup"); return; }
      if (k === "c") { e.preventDefault(); scrollInspectorTo("colorGroup"); return; }
      // v19.29 category shortcuts.  E stays as top-of-events (above).
      // V and G scroll to specific group headings within fxGroup so
      // the user lands right on the relevant effects.  A is reserved
      // for Align — the feature doesn't exist yet, so we show an
      // honest toast rather than silently doing nothing.
      const scrollToEventGroup = (groupId) => {
        scrollInspectorTo("fxGroup");
        // Defer to next frame so the fxGroup layout settles first.
        requestAnimationFrame(() => {
          const hd = document.querySelector(`.fx-event-group-hd[data-group-id="${groupId}"]`);
          if (hd && hd.scrollIntoView) hd.scrollIntoView({ behavior: "smooth", block: "start" });
          if (hd) {
            hd.classList.add("group-hd-flash");
            setTimeout(() => hd.classList.remove("group-hd-flash"), 1200);
          }
        });
      };
      if (k === "v") { e.preventDefault(); scrollToEventGroup("vector"); return; }
      if (k === "g") { e.preventDefault(); scrollToEventGroup("signal"); return; }
      if (k === "a") {
        // v19.31: real Align shortcut — opens the Align panel.
        e.preventDefault();
        scrollInspectorTo("alignGroup");
        return;
      }
      if (k === "b") {
        // Background lives in the RIGHT panel's last "Background" group.
        // Look for a heading matching "Background" to be robust to id changes.
        e.preventDefault();
        const groups = document.querySelectorAll(".panel-right .prop-group");
        for (const g of groups) {
          const h = g.querySelector("h3");
          if (h && /background/i.test(h.textContent || "")) { scrollInspectorTo(g.id || (g.id = "bgGroupAuto")); return; }
        }
      }
    });
    // Click on stage while text tool is active — create a text layer.
    // We listen on the stage (not the artboard) so clicks in padding
    // still work; stagePointToArtboard filters to the actual artboard.
    if (el.stage) {
      el.stage.addEventListener("click", (e) => {
        if (STATE.tool !== "text") return;
        // Don't fire on middle mouse or on ancillary UI elements
        if (e.button !== 0) return;
        const pt = stagePointToArtboard(e.clientX, e.clientY);
        if (!pt) {
          // Click was outside the artboard — click on center as fallback? No,
          // just cancel tool.  Standard Photoshop behavior.
          setTool("select");
          return;
        }
        const layer = createTextLayerAt(pt.x, pt.y);
        setTool("select");
        // v19.1: enter edit mode immediately.  Two RAFs so layout has
        // definitely happened (layer wrap positioned, size measured).
        requestAnimationFrame(() => requestAnimationFrame(() => startTextEdit(layer)));
      });
    }

    /* v19.2 SHAPE TOOL wiring.  Same modal-tool pattern as Text:
       click the button, then click or drag on the canvas.
       Click alone → default-sized shape at click point.
       Drag → shape sized to the drag rectangle.
       Shift-drag → constrain (square for rect, circle for ellipse,
                    45°/90° for line). */
    const _shapeBtns = { rect: el.toolRect, circle: el.toolCircle, ellipse: el.toolEllipse, line: el.toolLine, polygon: el.toolPolygon };
    Object.entries(_shapeBtns).forEach(([type, btn]) => {
      if (!btn) return;
      btn.addEventListener("click", () => {
        setTool(STATE.tool === type ? "select" : type);
      });
    });

    let _shapeDrag = null;   // { type, startPt, previewEl, moved }
    if (el.stage) {
      el.stage.addEventListener("mousedown", (e) => {
        if (!SHAPE_TYPES.includes(STATE.tool)) return;
        if (e.button !== 0) return;
        // Ignore mousedowns that started outside the artboard.
        const pt = stagePointToArtboard(e.clientX, e.clientY);
        if (!pt) return;
        e.preventDefault(); e.stopPropagation();
        // Preview rectangle in stage-space (not artboard), positioned by pageX/pageY
        const stageRect = el.stage.getBoundingClientRect();
        const previewEl = document.createElement("div");
        previewEl.className = "shape-drag-preview";
        el.stage.appendChild(previewEl);
        _shapeDrag = {
          type: STATE.tool,
          startPt: pt,                                        // artboard px
          startClient: { x: e.clientX, y: e.clientY },        // page px
          stageOff:   { left: stageRect.left, top: stageRect.top,
                        scrollLeft: el.stage.scrollLeft, scrollTop: el.stage.scrollTop },
          previewEl,
          moved: false,
          shiftKey: e.shiftKey,
        };
        // Initialize preview at 0×0 at start point
        previewEl.style.left = (e.clientX - stageRect.left + el.stage.scrollLeft) + "px";
        previewEl.style.top  = (e.clientY - stageRect.top  + el.stage.scrollTop) + "px";
        previewEl.style.width = "0px"; previewEl.style.height = "0px";
      });
    }
    function onShapeDragMove(e) {
      if (!_shapeDrag) return;
      const dx = e.clientX - _shapeDrag.startClient.x;
      const dy = e.clientY - _shapeDrag.startClient.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) _shapeDrag.moved = true;
      // Shift constraint: for rect/ellipse, square; for line, 45° snap.
      let adjDx = dx, adjDy = dy;
      if (e.shiftKey) {
        if (_shapeDrag.type === "line") {
          // Snap angle to nearest 45°
          const ang = Math.atan2(dy, dx);
          const snapAng = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(dx, dy);
          adjDx = Math.cos(snapAng) * len;
          adjDy = Math.sin(snapAng) * len;
        } else {
          // Force equal magnitude for square/circle
          const m = Math.max(Math.abs(dx), Math.abs(dy));
          adjDx = Math.sign(dx || 1) * m;
          adjDy = Math.sign(dy || 1) * m;
        }
      }
      // Update preview element (stage-space coords)
      const px = adjDx < 0 ? _shapeDrag.startClient.x + adjDx : _shapeDrag.startClient.x;
      const py = adjDy < 0 ? _shapeDrag.startClient.y + adjDy : _shapeDrag.startClient.y;
      _shapeDrag.previewEl.style.left = (px - _shapeDrag.stageOff.left + _shapeDrag.stageOff.scrollLeft) + "px";
      _shapeDrag.previewEl.style.top  = (py - _shapeDrag.stageOff.top  + _shapeDrag.stageOff.scrollTop) + "px";
      _shapeDrag.previewEl.style.width  = Math.abs(adjDx) + "px";
      _shapeDrag.previewEl.style.height = Math.abs(adjDy) + "px";
      _shapeDrag.lastAdj = { dx: adjDx, dy: adjDy };
      _shapeDrag.shiftKey = e.shiftKey;
    }
    function onShapeDragEnd(e) {
      if (!_shapeDrag) return;
      const drag = _shapeDrag;
      _shapeDrag = null;
      if (drag.previewEl) drag.previewEl.remove();
      const zoom = STATE.zoom || 1;
      let dxArt, dyArt;
      if (drag.moved && drag.lastAdj) {
        // Drag: convert page-space delta into artboard-space
        dxArt = drag.lastAdj.dx / zoom;
        dyArt = drag.lastAdj.dy / zoom;
      } else {
        // Click (no meaningful drag): use default size
        dxArt = 0; dyArt = 0;
      }
      const bounds = {
        x: drag.startPt.x, y: drag.startPt.y,
        w: dxArt, h: dyArt,
      };
      const layer = createShapeLayerAt(drag.type, bounds);
      setTool("select");
      renderInspector();
    }
    document.addEventListener("mousemove", onShapeDragMove);
    document.addEventListener("mouseup",   onShapeDragEnd);

    /* Shape inspector bindings — write back to selected shape. */
    function wireShapeInput(elmt, patchFn) {
      if (!elmt) return;
      const h = () => {
        if (!selectedLayer) return;
        const patch = patchFn(elmt);
        if (!patch) return;
        // v19.21: fan out to every selected layer, dispatching to the
        // right mutation path per layer kind.  SHAPE routes through
        // updateShapeLayer (rebuilds SVG); SVG uses direct DOM
        // mutation via applySvgFillStroke (snapshotted for Undo).
        // Non-matching kinds are silently skipped so a mixed
        // selection (e.g. IMG + SHAPE) doesn't error.
        const targets = selectedLayers.length > 1 ? selectedLayers : [selectedLayer];
        targets.forEach((L) => {
          if (L.kind === "SHAPE") updateShapeLayer(L, patch);
          else if (L.kind === "SVG") applySvgFillStroke(L, patch);
        });
        // Ensure preview reflects SVG mutations even when no clip is active.
        paintIfPaused();
      };
      elmt.addEventListener("input", h);
      elmt.addEventListener("change", h);
    }
    wireShapeInput(el.shapeFill,     (n) => { if (el.shapeFillHex) el.shapeFillHex.textContent = n.value.toUpperCase(); return { fill: n.value }; });
    wireShapeInput(el.shapeStroke,   (n) => { if (el.shapeStrokeHex) el.shapeStrokeHex.textContent = n.value.toUpperCase(); return { stroke: n.value }; });
    wireShapeInput(el.shapeFillOn,   (n) => ({ fillOn: !!n.checked }));
    wireShapeInput(el.shapeStrokeOn, (n) => ({ strokeOn: !!n.checked }));
    wireShapeInput(el.shapeStrokeW,  (n) => {
      const v = clamp(+n.value || 0, 0, 200);
      if (el.shapeStrokeWRange) el.shapeStrokeWRange.value = Math.min(60, v);
      return { strokeWidth: v };
    });
    wireShapeInput(el.shapeStrokeWRange, (n) => {
      const v = +n.value;
      if (el.shapeStrokeW) el.shapeStrokeW.value = v;
      return { strokeWidth: v };
    });
    wireShapeInput(el.shapeCornerR, (n) => {
      const v = clamp(+n.value || 0, 0, 500);
      if (el.shapeCornerRRange) el.shapeCornerRRange.value = Math.min(200, v);
      return { cornerRadius: v };
    });
    wireShapeInput(el.shapeCornerRRange, (n) => {
      const v = +n.value;
      if (el.shapeCornerR) el.shapeCornerR.value = v;
      return { cornerRadius: v };
    });
    wireShapeInput(el.shapeSides, (n) => {
      const v = clamp(+n.value | 0, 3, 24);
      if (el.shapeSidesRange) el.shapeSidesRange.value = v;
      return { sides: v };
    });
    wireShapeInput(el.shapeSidesRange, (n) => {
      const v = +n.value | 0;
      if (el.shapeSides) el.shapeSides.value = v;
      return { sides: v };
    });
    // v19.22: Fill / Stroke opacity — UI 0-100, model 0-1.  Both
    // number input and range slider stay in sync.
    wireShapeInput(el.shapeFillOpacity, (n) => {
      const v = clamp(+n.value, 0, 100);
      if (el.shapeFillOpacityRange) el.shapeFillOpacityRange.value = v;
      return { fillOpacity: v / 100 };
    });
    wireShapeInput(el.shapeFillOpacityRange, (n) => {
      const v = +n.value;
      if (el.shapeFillOpacity) el.shapeFillOpacity.value = v;
      return { fillOpacity: v / 100 };
    });
    wireShapeInput(el.shapeStrokeOpacity, (n) => {
      const v = clamp(+n.value, 0, 100);
      if (el.shapeStrokeOpacityRange) el.shapeStrokeOpacityRange.value = v;
      return { strokeOpacity: v / 100 };
    });
    wireShapeInput(el.shapeStrokeOpacityRange, (n) => {
      const v = +n.value;
      if (el.shapeStrokeOpacity) el.shapeStrokeOpacity.value = v;
      return { strokeOpacity: v / 100 };
    });
    // v19.22: SVG-only utilities.  Guarded on layer kind so if the
    // user clicks with a SHAPE selected (button hidden but defensive),
    // nothing happens.
    if (el.shapeMonoBtn) el.shapeMonoBtn.addEventListener("click", () => {
      if (!selectedLayer || selectedLayer.kind !== "SVG") return;
      const targetColor = (el.shapeFill && el.shapeFill.value) || "#7A5CFF";
      const n = applySvgMonochrome(selectedLayer, targetColor);
      toast(`Monochrome applied · ${n} primitive${n===1?"":"s"}`);
      paintIfPaused(); renderInspector();
    });
    if (el.shapeInvertBtn) el.shapeInvertBtn.addEventListener("click", () => {
      if (!selectedLayer || selectedLayer.kind !== "SVG") return;
      const n = applySvgInvert(selectedLayer);
      toast(`Colors inverted · ${n} primitive${n===1?"":"s"}`);
      paintIfPaused(); renderInspector();
    });

    /* v19.31 Align tools.  Operates on selectedLayers (multi) or
       selectedLayer (single).  Reference frame:
         - 1 layer selected → canvas (0-100 percent bounds)
         - 2+ layers selected → union bbox of selected layers
       Distribute (H/V) requires 3+ selected.
       Coordinates: cx/cy are the center of the layer in canvas percent.
       wPct/hPct are the layer's on-canvas width/height in percent. */
    function getAlignTargets() {
      const sel = (selectedLayers && selectedLayers.length ? selectedLayers : (selectedLayer ? [selectedLayer] : []));
      return sel.filter((L) => L && L.transform);
    }
    function alignReferenceBounds(targets) {
      if (targets.length >= 2) {
        // Union bbox in canvas-percent coordinates.
        let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
        for (const L of targets) {
          const t = L.transform;
          const left = t.cx - t.wPct / 2, right = t.cx + t.wPct / 2;
          const top  = t.cy - t.hPct / 2, bot   = t.cy + t.hPct / 2;
          if (left < minL) minL = left; if (right > maxR) maxR = right;
          if (top  < minT) minT = top;  if (bot   > maxB) maxB = bot;
        }
        return { left: minL, right: maxR, top: minT, bottom: maxB,
                 cxMid: (minL + maxR) / 2, cyMid: (minT + maxB) / 2 };
      }
      // Single-selection: reference is the canvas (0 to 100 percent).
      return { left: 0, right: 100, top: 0, bottom: 100, cxMid: 50, cyMid: 50 };
    }
    function doAlign(mode) {
      const targets = getAlignTargets();
      if (!targets.length) return;
      const ref = alignReferenceBounds(targets);
      for (const L of targets) {
        const t = L.transform;
        if      (mode === "L")  t.cx = ref.left  + t.wPct / 2;
        else if (mode === "R")  t.cx = ref.right - t.wPct / 2;
        else if (mode === "CH") t.cx = ref.cxMid;
        else if (mode === "T")  t.cy = ref.top    + t.hPct / 2;
        else if (mode === "B")  t.cy = ref.bottom - t.hPct / 2;
        else if (mode === "CV") t.cy = ref.cyMid;
      }
      renderInspector(); paintIfPaused();
      toast(`Aligned ${targets.length} layer${targets.length===1?"":"s"}: ${mode}`);
    }
    function doDistribute(axis) {
      const targets = getAlignTargets();
      if (targets.length < 3) { toast("Distribute needs 3+ selected layers"); return; }
      // Sort by axis, keep extremes fixed, evenly space the middle ones.
      const key = axis === "H" ? "cx" : "cy";
      const sorted = targets.slice().sort((a, b) => a.transform[key] - b.transform[key]);
      const first = sorted[0].transform[key], last = sorted[sorted.length - 1].transform[key];
      const gap = (last - first) / (sorted.length - 1);
      for (let i = 1; i < sorted.length - 1; i++) {
        sorted[i].transform[key] = first + gap * i;
      }
      renderInspector(); paintIfPaused();
      toast(`Distributed ${targets.length} layers ${axis === "H" ? "horizontally" : "vertically"}`);
    }
    const alignBtn = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener("click", fn); };
    alignBtn("alignL",  () => doAlign("L"));
    alignBtn("alignR",  () => doAlign("R"));
    alignBtn("alignCH", () => doAlign("CH"));
    alignBtn("alignT",  () => doAlign("T"));
    alignBtn("alignB",  () => doAlign("B"));
    alignBtn("alignCV", () => doAlign("CV"));
    alignBtn("distH",   () => doDistribute("H"));
    alignBtn("distV",   () => doDistribute("V"));

    /* Text inspector bindings — write back to the selected text layer. */
    function wireTextInput(elmt, patchFn) {
      if (!elmt) return;
      const handler = () => {
        if (!selectedLayer || selectedLayer.kind !== "TEXT") return;
        const patch = patchFn(elmt);
        if (patch) updateTextLayer(selectedLayer, patch);
      };
      elmt.addEventListener("input", handler);
      elmt.addEventListener("change", handler);
    }
    wireTextInput(el.textContent, (n) => ({ text: n.value || " " }));
    wireTextInput(el.textFontFamily, (n) => ({ fontFamily: n.value }));
    wireTextInput(el.textSize, (n) => {
      const v = clamp(+n.value || 64, 8, 800);
      if (el.textSizeRange) el.textSizeRange.value = Math.min(400, v);
      return { fontSize: v };
    });
    wireTextInput(el.textSizeRange, (n) => {
      const v = +n.value;
      if (el.textSize) el.textSize.value = v;
      return { fontSize: v };
    });
    wireTextInput(el.textWeight, (n) => ({ fontWeight: +n.value }));
    wireTextInput(el.textColor, (n) => {
      if (el.textColorHex) el.textColorHex.textContent = n.value.toUpperCase();
      return { color: n.value };
    });
    wireTextInput(el.textLetterSpacing, (n) => ({ letterSpacing: +n.value || 0 }));
    wireTextInput(el.textLineHeight, (n) => ({ lineHeight: Math.max(0.5, +n.value || 1.2) }));
    if (el.textAlignSeg) {
      el.textAlignSeg.querySelectorAll("[data-align]").forEach((btn) => {
        btn.addEventListener("click", () => {
          el.textAlignSeg.querySelectorAll("[data-align]").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          if (selectedLayer && selectedLayer.kind === "TEXT") {
            updateTextLayer(selectedLayer, { align: btn.dataset.align });
          }
        });
      });
    }

    /* Double-click a text layer to enter inline edit mode. */
    if (el.layerHost) {
      el.layerHost.addEventListener("dblclick", (e) => {
        // Find the enclosing .layer-el then match to a layer
        const wrap = e.target.closest && e.target.closest(".layer-el");
        if (!wrap) return;
        const layer = layers.find((L) => L.wrap === wrap);
        if (layer && layer.kind === "TEXT") { e.preventDefault(); e.stopPropagation(); startTextEdit(layer); }
      });
      // v19.32: right-click on a stage layer opens the same context
      // menu as right-click on its row in the layer panel.  Users
      // couldn't find the Replace Asset command in v19.31 because it
      // was only wired to layer rows; the stage is the more natural
      // discovery point.
      el.layerHost.addEventListener("contextmenu", (e) => {
        const wrap = e.target.closest && e.target.closest(".layer-el");
        if (!wrap) return;
        const layer = layers.find((L) => L.wrap === wrap);
        if (!layer) return;
        e.preventDefault();
        showLayerContextMenu(e.clientX, e.clientY, layer);
      });
    }
    el.stage.addEventListener("dragover", (e) => e.preventDefault());
    el.stage.addEventListener("drop", (e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); });
    el.exposeSubToggle.addEventListener("change", (e) => { STATE.exposeSub = e.target.checked; toast(STATE.exposeSub ? "New SVGs will expose sublayers" : "New SVGs grouped as one layer"); });

    // formats
    $$(".fmt").forEach((b) => b.addEventListener("click", () => setFormat(+b.dataset.w, +b.dataset.h, b.dataset.label)));

    // transport
    el.playBtn.addEventListener("click", togglePlay);
    if (el.topPlayBtn) el.topPlayBtn.addEventListener("click", togglePlay);
    el.loopBtn.addEventListener("click", () => { STATE.loop = !STATE.loop; el.loopBtn.classList.toggle("active", STATE.loop); el.loopBtn.dataset.on = String(STATE.loop); if (audio.el) audio.el.loop = STATE.loop; });
    document.addEventListener("keydown", (e) => {
      const typing = e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT";
      if (e.code === "Space" && !typing) { e.preventDefault(); togglePlay(); }
      if (e.key === "Escape") closeSheet();
      // v19.5: Delete / Backspace routing.  Priority order:
      //   1. If a timeline clip is selected → delete that clip (not the layer).
      //   2. Otherwise, if layer(s) are selected → delete them.
      //  This mirrors how every professional editor separates clip
      //  and layer deletion.  The user should never accidentally lose
      //  a layer while trying to remove a single effect instance.
      if ((e.key === "Delete" || e.key === "Backspace") && !typing) {
        if (selectedEventClip) {
          e.preventDefault();
          deleteSelectedClip();
          return;
        }
        if (selectedAudioClip) {
          e.preventDefault();
          deleteSelectedAudioClip();
          return;
        }
        if (selectedLayers.length) {
          e.preventDefault();
          deleteSelectedLayers();
        }
      }
      // v19.4: Cmd/Ctrl+D duplicates all selected layers at exact positions.
      if ((e.key === "d" || e.key === "D") && (e.metaKey || e.ctrlKey) && selectedLayers.length && !typing) {
        e.preventDefault();
        duplicateSelectedLayers();
      }
      // v19.16: Cmd/Ctrl+G groups; Cmd/Ctrl+Shift+G ungroups.
      if ((e.key === "g" || e.key === "G") && (e.metaKey || e.ctrlKey) && !typing) {
        e.preventDefault();
        if (e.shiftKey) ungroupSelectedLayer();
        else            groupSelectedLayers();
      }
      // v19.17: Cmd/Ctrl+A selects every layer on the canvas.
      //  - Skips locked layers (they can't be interacted with anyway)
      //  - Includes GROUP, SHAPE, SVG, IMG, TEXT, VIDEO uniformly
      //  - Matches Illustrator / Figma / Photoshop convention
      //  - Enables the "Ctrl+A then Ctrl+G" workflow for grouping
      //    every layer at once.
      if ((e.key === "a" || e.key === "A") && (e.metaKey || e.ctrlKey) && !typing) {
        e.preventDefault();
        const targets = layers.filter((L) => !L.locked);
        if (!targets.length) return;
        selectedLayers = targets.slice();
        selectedLayer = targets[targets.length - 1];
        renderLayers(); renderInspector(); renderTimeline(); updateSelectionBox();
        if (el.readoutSel) el.readoutSel.textContent = targets.length === 1 ? targets[0].name : `${targets.length} layers selected`;
      }
    });
    // v19.4 multi-layer operation helpers.
    function deleteSelectedLayers() {
      if (!selectedLayers.length) return;
      // Snapshot the array — deleteLayer mutates state which can
      // reorder `layers` and change selection.
      const toDelete = selectedLayers.slice();
      const count = toDelete.length;
      // Clear selection first so per-layer delete doesn't fight our loop.
      selectedLayer = null;
      selectedLayers = [];
      toDelete.forEach((L) => { if (layers.includes(L)) deleteLayer(L); });
      if (count > 1) toast(`Deleted ${count} layers`);
    }
    function duplicateSelectedLayers() {
      if (!selectedLayers.length) return;
      const originals = selectedLayers.slice();
      const dups = [];
      originals.forEach((L) => {
        duplicateLayer(L);
        // duplicateLayer appends to `layers` at the end; grab it.
        dups.push(layers[layers.length - 1]);
      });
      // Update selection to be the newly-created duplicates
      selectedLayers = dups;
      selectedLayer = dups[dups.length - 1] || null;
      renderLayers(); renderInspector(); renderTimeline(); updateSelectionBox();
      if (originals.length > 1) toast(`Duplicated ${originals.length} layers`);
    }
    /* v19.5 clip-delete helpers.  Called by the Delete key routing
       when a clip is the currently-selected element.  Removing a
       clip must NOT touch layer selection or the layer stack. */
    function deleteSelectedClip() {
      if (!selectedEventClip) return;
      const { layer, ec } = selectedEventClip;
      const idx = layer.clips.indexOf(ec);
      if (idx >= 0) layer.clips.splice(idx, 1);
      selectedEventClip = null;
      renderTimeline(); renderClipInspector(); renderEventButtons(); paintIfPaused();
      toast("Clip deleted");
    }
    function deleteSelectedAudioClip() {
      if (!selectedAudioClip) return;
      const ac = selectedAudioClip;
      const idx = audioClips.indexOf(ac);
      if (idx >= 0) audioClips.splice(idx, 1);
      selectedAudioClip = null;
      renderTimeline(); renderClipInspector(); paintIfPaused();
      toast("Audio clip deleted");
    }

    /* v19.16 GROUPING (wrapper-based).
       Combines multiple selected layers into a single GROUP layer
       that behaves like one animation target.  Effects applied to
       the group reach every member's primitives via
       getLayerPrimitiveNodes.  The group's own wrap becomes the
       parent DOM element for all members, so a single CSS transform
       moves / scales / rotates the composite as a unit.

       V1 constraints (per user agreement):
         - Members can't be edited while grouped (they're locked
           inside the group; ungroup to edit them individually).
         - Ungroup restores members to their ORIGINAL positions from
           before grouping.  Any group-level movement/scale/rotation
           is discarded on ungroup.  (Preserving cumulative group
           edits requires a proper transform-bake pass that's real
           work; deferred to v2.)
         - Nested groups aren't supported v1 — grouping a group
           flattens it back into individual layers first.
         - Morph on a group targets the FIRST primitive of the first
           member (existing behavior); "group morph" isn't meaningful
           without vertex remapping.

       Data model:
         group = {
           kind: "GROUP", id, name, visible, locked,
           wrap: <div>,     — container for member wraps
           transform: { cx, cy, wPct, hPct, rot },
           start, duration, allowTransform, clips: [],
           _members: [snapshot of member layers],
           _memberInsertIndex: original position in layers[],
           _originalTransforms: [snapshot of each member.transform],
           _originalWrapStyles: [snapshot of each wrap's positioning],
         }
    */
    function groupSelectedLayers() {
      if (selectedLayers.length < 2) { toast("Select 2 or more layers to group"); return; }
      // Filter out any GROUP that was itself selected — v1 doesn't
      // support nested groups; flatten it first.
      const members = selectedLayers.filter((L) => L.kind !== "GROUP");
      if (members.length < 2) { toast("Nested groups aren't supported yet"); return; }
      const A = STATE.format;
      // Compute canvas-space bounding box across all members.
      let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
      members.forEach((L) => {
        const T = L.transform;
        const wPx = (T.wPct / 100) * A.w;
        const hPx = (T.hPct / 100) * A.h;
        const cxPx = A.w / 2 + (T.cx / 100) * A.w;
        const cyPx = A.h / 2 + (T.cy / 100) * A.h;
        const l = cxPx - wPx / 2, t = cyPx - hPx / 2;
        if (l < minL) minL = l;
        if (t < minT) minT = t;
        if (l + wPx > maxR) maxR = l + wPx;
        if (t + hPx > maxB) maxB = t + hPx;
      });
      const groupWPx = maxR - minL, groupHPx = maxB - minT;
      const groupCxPx = minL + groupWPx / 2, groupCyPx = minT + groupHPx / 2;
      // Snapshot each member's wrap styles + transform BEFORE we move.
      const _originalWrapStyles = members.map((L) => ({
        left: L.wrap.style.left, top: L.wrap.style.top,
        width: L.wrap.style.width, height: L.wrap.style.height,
        transform: L.wrap.style.transform, opacity: L.wrap.style.opacity,
        filter: L.wrap.style.filter,
        parentNode: L.wrap.parentNode,
      }));
      const _originalTransforms = members.map((L) => ({ ...L.transform }));
      // Find insertion index — use the topmost (highest-index) member's slot.
      const memberIndices = members.map((L) => layers.indexOf(L)).filter((i) => i >= 0);
      const insertIndex = Math.max.apply(null, memberIndices);
      // Build group wrap.  Positioned exactly at the bbox in canvas
      // coordinates so member wraps (which are already at their own
      // canvas positions) end up visually where they were.
      const wrap = document.createElement("div");
      wrap.className = "layer-el layer-group";
      wrap.style.position = "absolute";
      wrap.style.left = minL + "px";
      wrap.style.top = minT + "px";
      wrap.style.width = groupWPx + "px";
      wrap.style.height = groupHPx + "px";
      wrap.style.transformOrigin = "center center";
      el.layerHost.appendChild(wrap);
      // Reparent each member wrap into the group wrap, adjusting
      // their left/top to be relative to the group's origin.  Their
      // widths / heights / transforms don't need changing — those are
      // in local coords already.
      // v19.20 (Option A′): also SUSPEND each member's clips into
      // _suspendedClips.  Any active effect DOM mutations get
      // cleared so members enter the group in a clean baseline state.
      // Ungroup restores the suspended clips.
      let suspendedCount = 0;
      members.forEach((L) => {
        // Clear any active vector-effect state so mutations don't
        // persist into the grouped state (opacity, dasharray, morph,
        // clip-path, etc.).  Without this, an active effect at group
        // time would visually stick until ungroup.
        if (L._dashApplied)          clearPathDash(L);
        if (L._shapeStyleApplied)    clearShapeStyleDelta(L);
        if (L._morphApplied)         clearMorph(L);
        if (L._fillRevealApplied)    clearFillReveal(L);
        if (L._segmentRevealApplied) clearSegmentReveal(L);
        // Also clear filter / opacity / transform mutations that
        // non-vector effects may have written.
        L.wrap.style.filter = "";
        L.wrap.style.opacity = "";
        // Preserve transform positioning below (adjust for group).
        // Move clips into suspension.
        if (L.clips && L.clips.length) {
          L._suspendedClips = L.clips;
          L.clips = [];
          suspendedCount += L._suspendedClips.length;
        }
        // Reparent + reposition wrap group-locally.
        const oldLeft = parseFloat(L.wrap.style.left) || 0;
        const oldTop  = parseFloat(L.wrap.style.top)  || 0;
        L.wrap.style.left = (oldLeft - minL) + "px";
        L.wrap.style.top  = (oldTop  - minT) + "px";
        wrap.appendChild(L.wrap);
      });
      // Create group layer.  Uses SHAPE-like transform structure so
      // composeLayer's existing transform math works unchanged.
      const groupTransform = {
        cx: ((groupCxPx - A.w / 2) / A.w) * 100,
        cy: ((groupCyPx - A.h / 2) / A.h) * 100,
        wPct: (groupWPx / A.w) * 100,
        hPct: (groupHPx / A.h) * 100,
        rot: 0, opacity: 100,
      };
      const groupLayer = {
        id: ++idSeq,
        name: `Group (${members.length})`,
        kind: "GROUP",
        assetId: null, complex: false,
        node: null,          // no synthetic root — effects use getLayerPrimitiveNodes
        wrap,
        subLayers: [],
        // natW/natH set to bbox pixel dims so the export path (which
        // reads them for rasterization scale) has sensible defaults
        // for groups.  Preview doesn't use natW/natH for GROUPs.
        natW: groupWPx, natH: groupHPx,
        // v19.17: natural size in canvas percent, frozen at group time.
        // composeLayer uses these to derive a CSS scale factor from
        // the current transform.wPct/hPct, so scaling a group actually
        // scales its member wraps together.
        _groupNatWpct: groupTransform.wPct,
        _groupNatHpct: groupTransform.hPct,
        // v19.17: identity transform snapshot for ungroup-time baking.
        // Deltas between transform and this get applied to each member
        // when ungrouping, so the visual state is preserved through
        // group → move/scale/rotate → ungroup.
        _identityTransform: { ...groupTransform },
        visible: true,
        locked: false,
        transform: groupTransform,
        start: 0, duration: STATE.duration,
        allowTransform: false,
        clips: [],
        recipe: makeRecipe((idSeq * 131) >>> 0),
        _members: members,
        _originalTransforms,
        _originalWrapStyles,
      };
      // Remove members from layers[] and insert group at member's
      // topmost position.  Use in-place mutation since `layers` is
      // declared const at module scope.
      for (let i = layers.length - 1; i >= 0; i--) {
        if (members.includes(layers[i])) layers.splice(i, 1);
      }
      const newIdx = Math.min(insertIndex, layers.length);
      layers.splice(newIdx, 0, groupLayer);
      // Clear multi-select — group becomes the sole selection.
      selectedLayers = [groupLayer];
      selectedLayer = groupLayer;
      renderLayers(); renderInspector(); renderTimeline(); updateSelectionBox(); paintIfPaused();
      // v19.20 (Option A′): explicit UX signal when member clips are
      // suspended, so users understand the v1 boundary rather than
      // thinking the feature is broken.
      if (suspendedCount > 0) {
        toast(`Grouped ${members.length} layers · ${suspendedCount} member animation${suspendedCount===1?"":"s"} paused (ungroup to edit or play)`, 4500);
      } else {
        toast(`Grouped ${members.length} layers`);
      }
    }
    function ungroupSelectedLayer() {
      // Ungroup every selected GROUP.
      const groups = selectedLayers.filter((L) => L.kind === "GROUP");
      if (!groups.length) { toast("Select a group to ungroup"); return; }
      let totalMembers = 0;
      const restored = [];
      groups.forEach((G) => {
        if (!G._members || !G._members.length) return;
        totalMembers += G._members.length;
        /* v19.17: BAKE the group's cumulative transform into every
           member so the visual state is preserved through group →
           move/scale/rotate → ungroup.  Deltas computed relative to
           the group's identity transform (snapshot at creation).

           For each member, we apply in order:
             1. Scale the member's OFFSET from group's original center
                by the group's scale factors (scaleX / scaleY).
             2. Rotate that scaled offset by the group's rotation delta
                around origin.
             3. Anchor to the group's CURRENT center (not original).
             4. Multiply member's own size by the scale factors.
             5. Add the group's rotation to the member's own rotation.

           Uniform-scale groups (scaleX ≈ scaleY) give perfect results.
           Non-uniform scale distorts rotated members slightly — that's
           a fundamental limitation of "bake into affine transform"
           without a full matrix stack.  Documented, not silently
           wrong. */
        const idT = G._identityTransform;
        const scaleX = G.transform.wPct / idT.wPct;
        const scaleY = G.transform.hPct / idT.hPct;
        const dRot   = G.transform.rot - idT.rot;
        const gCxNow = G.transform.cx, gCyNow = G.transform.cy;
        const gCxOrig = idT.cx, gCyOrig = idT.cy;
        const cosR = Math.cos(dRot * Math.PI / 180);
        const sinR = Math.sin(dRot * Math.PI / 180);
        G._members.forEach((L, i) => {
          const origT    = G._originalTransforms[i];
          const origWrap = G._originalWrapStyles[i];
          // Position: offset from original group center → scaled → rotated
          // → offset from current group center.
          const relX = origT.cx - gCxOrig;
          const relY = origT.cy - gCyOrig;
          const scaledX = relX * scaleX, scaledY = relY * scaleY;
          const rotatedX = scaledX * cosR - scaledY * sinR;
          const rotatedY = scaledX * sinR + scaledY * cosR;
          L.transform.cx = gCxNow + rotatedX;
          L.transform.cy = gCyNow + rotatedY;
          L.transform.wPct = origT.wPct * scaleX;
          L.transform.hPct = origT.hPct * scaleY;
          L.transform.rot  = (origT.rot || 0) + dRot;
          L.transform.opacity = origT.opacity;
          // Move wrap back to layerHost.  composeLayer will re-position
          // it from the new transform on the next paint.
          if (origWrap.parentNode) origWrap.parentNode.appendChild(L.wrap);
          // Clear the local styles that were set at group time — the
          // wrap needs to be positioned by composeLayer from scratch.
          L.wrap.style.transform = "";
          L.wrap.style.opacity = "";
          L.wrap.style.filter = "";
          // v19.20 (Option A′): restore suspended clips so member
          // animations resume playing.  The wrap positioning + baked
          // transform above ensures visual continuity; clips fire
          // again from the next paintIfPaused.
          if (L._suspendedClips) {
            L.clips = L._suspendedClips;
            delete L._suspendedClips;
          }
          restored.push(L);
        });
        // Remove the group layer + its wrap.
        const gi = layers.indexOf(G);
        if (gi >= 0) layers.splice(gi, 1);
        if (G.wrap && G.wrap.parentNode) G.wrap.parentNode.removeChild(G.wrap);
        // Re-insert members at the group's slot.
        layers.splice.apply(layers, [gi, 0].concat(G._members));
      });
      // Restored members become the new selection.
      selectedLayers = restored;
      selectedLayer = restored[restored.length - 1] || null;
      renderLayers(); renderInspector(); renderTimeline(); updateSelectionBox(); paintIfPaused();
      toast(`Ungrouped ${groups.length} group${groups.length===1?"":"s"} (${totalMembers} layers restored)`);
    }
    // v19.17: expose to module-scope forward references so duplicateLayer
    // (and any other outer-scope caller) can reach them.
    _groupSelectedLayers  = groupSelectedLayers;
    _ungroupSelectedLayer = ungroupSelectedLayer;

    // AI
    el.aiRun.addEventListener("click", runAI);
    el.aiPrompt.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runAI(); });

    // presets
    el.applyAll.addEventListener("click", applyMotionAll);
    if (el.clearPresetBtn) {
      el.clearPresetBtn.addEventListener("click", () => {
        if (!STATE._activePreset) { toast("No preset active"); return; }
        _removeActivePreset();
      });
    }

    // transform sliders + buttons
    bindTransform();
    el.tfCenter.addEventListener("click", tfCenter);
    el.tfFit.addEventListener("click", tfFit);
    el.tfFill.addEventListener("click", tfFill);
    el.tfReset.addEventListener("click", tfReset);
    if (el.tfOriginal) el.tfOriginal.addEventListener("click", tfOriginal);
    el.layerDup.addEventListener("click", () => selectedLayers.length && duplicateSelectedLayers());
    el.layerDel.addEventListener("click", () => selectedLayers.length && deleteSelectedLayers());
    // v19.9: Clear all effect clips from every selected layer.  Keeps
    // the layer itself.  Toast reports how many clips were removed
    // total so users can confirm the operation ran.
    if (el.layerClearFx) {
      el.layerClearFx.addEventListener("click", () => {
        if (!selectedLayers.length) return;
        let removed = 0;
        selectedLayers.forEach((L) => {
          removed += (L.clips || []).length;
          L.clips = [];
          // Also clear any live effect residue so the shape returns to baseline immediately.
          if (typeof clearPathDash === "function")       clearPathDash(L);
          if (typeof clearShapeStyleDelta === "function") clearShapeStyleDelta(L);
          if (typeof clearMorph === "function")           clearMorph(L);
        });
        // Any selected clip belonging to those layers is gone now.
        if (selectedEventClip && selectedLayers.includes(selectedEventClip.layer)) selectedEventClip = null;
        renderTimeline(); renderInspector(); renderEventButtons(); renderClipInspector(); paintIfPaused();
        if (removed === 0) toast("No effects to clear");
        else if (selectedLayers.length === 1) toast(`Cleared ${removed} effect${removed === 1 ? "" : "s"}`);
        else toast(`Cleared ${removed} effects from ${selectedLayers.length} layers`);
      });
    }
    el.layerHide.addEventListener("click", () => { if (selectedLayer) { toggleLayerVisible(selectedLayer); renderInspector(); } });
    el.layerLock.addEventListener("click", () => selectedLayer && toggleLayerLock(selectedLayer));

    // allow transform toggle
    el.allowTransform.addEventListener("change", (e) => { if (selectedLayer) { selectedLayer.allowTransform = e.target.checked; renderInspector(); paintIfPaused(); } });

    // ---- Video In/Out sliders + Fit-to-trim / Reset-trim (Phase 2) ----
    const vin  = document.getElementById("ctl-vin");
    const vout = document.getElementById("ctl-vout");
    if (vin) vin.addEventListener("input", (e) => {
      if (!selectedLayer || selectedLayer.kind !== "VIDEO") return;
      const L = selectedLayer;
      let v = +e.target.value;
      // Clamp so In < Out with a small gap.
      v = Math.max(0, Math.min(v, (L.srcOutPoint || L.videoDuration) - 0.05));
      L.srcInPoint = v;
      const lab = document.getElementById("val-vin"); if (lab) lab.textContent = v.toFixed(2);
      e.target.value = v.toFixed(2);
      paintIfPaused();
    });
    if (vout) vout.addEventListener("input", (e) => {
      if (!selectedLayer || selectedLayer.kind !== "VIDEO") return;
      const L = selectedLayer;
      let v = +e.target.value;
      v = Math.max((L.srcInPoint || 0) + 0.05, Math.min(v, L.videoDuration || v));
      L.srcOutPoint = v;
      const lab = document.getElementById("val-vout"); if (lab) lab.textContent = v.toFixed(2);
      e.target.value = v.toFixed(2);
      paintIfPaused();
    });
    if (el.vFitTrim) el.vFitTrim.addEventListener("click", () => {
      if (!selectedLayer || selectedLayer.kind !== "VIDEO") return;
      const L = selectedLayer;
      const trimLen = Math.max(0.05, (L.srcOutPoint || L.videoDuration) - (L.srcInPoint || 0));
      L.duration = Math.min(trimLen, Math.max(0.1, STATE.duration - L.start));
      renderTimeline(); paintIfPaused();
      toast(`Layer duration set to ${L.duration.toFixed(2)}s`);
    });
    if (el.vResetTrim) el.vResetTrim.addEventListener("click", () => {
      if (!selectedLayer || selectedLayer.kind !== "VIDEO") return;
      const L = selectedLayer;
      L.srcInPoint = 0;
      L.srcOutPoint = L.videoDuration || L.srcOutPoint || 0;
      renderInspector(); paintIfPaused();
    });

    // v19.22: legacy Color panel listeners removed with the panel.
    // The old ctl-sw stroke-width multiplier slider is gone — direct-value
    // stroke width lives in the unified Fill & Stroke panel now.

    // background
    el.bgColor.addEventListener("input", (e) => setBackground("custom", e.target.value));
    $$(".bg-swatch").forEach((s) => s.addEventListener("click", () => setBackground(s.dataset.bg)));
    if (el.audioReactiveToggle) el.audioReactiveToggle.addEventListener("change", (e) => { STATE.audioReactive = e.target.checked; toast(STATE.audioReactive ? "Audio-reactive on" : "Audio-reactive off"); });

    // audio
    el.audioBtn.addEventListener("click", () => el.audioInput.click());
    el.audioInput.addEventListener("change", (e) => { if (e.target.files[0]) initAudio(e.target.files[0]); });

    // timeline duration
    wireDurSeg(el.durSegTl);

    // zoom
    el.zoomIn.addEventListener("click", () => zoomAnchored(STATE.zoom * 1.2));
    el.zoomOut.addEventListener("click", () => zoomAnchored(STATE.zoom / 1.2));
    el.zoomFit.addEventListener("click", fitZoom);
    $$("#zoomPresets [data-zoom]").forEach((b) => b.addEventListener("click", () => zoomAnchored(+b.dataset.zoom)));

    /* v18.9 CANVAS NAVIGATION — cursor-anchored zoom.
       When zoom changes, keep the artboard point under the cursor
       fixed under the cursor.  This matches Figma / Photoshop /
       Illustrator behavior. */
    function zoomAnchored(newZoom, opts) {
      const clamped = clamp(newZoom, 0.05, 8);
      const stage = el.stage; if (!stage) { setZoom(clamped); return; }
      // Anchor point: given center (default) or explicit mouse position.
      const rect = stage.getBoundingClientRect();
      const anchorX = (opts && opts.clientX != null) ? (opts.clientX - rect.left) : rect.width / 2;
      const anchorY = (opts && opts.clientY != null) ? (opts.clientY - rect.top)  : rect.height / 2;
      // Absolute position (in scroll content coords) of the anchor before zoom
      const contentXBefore = stage.scrollLeft + anchorX;
      const contentYBefore = stage.scrollTop  + anchorY;
      // Same anchor position relative to the scaler's top-left
      const scalerRect = el.artboardScaler.getBoundingClientRect();
      const scalerLeftInStage = (scalerRect.left - rect.left) + stage.scrollLeft;
      const scalerTopInStage  = (scalerRect.top  - rect.top)  + stage.scrollTop;
      // Point on artboard (unscaled) under the anchor
      const artX = (contentXBefore - scalerLeftInStage) / STATE.zoom;
      const artY = (contentYBefore - scalerTopInStage)  / STATE.zoom;
      // Apply new zoom (goes through setZoom / applyZoom, which resizes scaler)
      STATE.zoom = clamped; STATE.zoomMode = "manual"; applyZoom();
      // After layout: place the same artboard point back under the anchor.
      requestAnimationFrame(() => {
        const rect2 = stage.getBoundingClientRect();
        const scalerRect2 = el.artboardScaler.getBoundingClientRect();
        const scalerLeftInStage2 = (scalerRect2.left - rect2.left) + stage.scrollLeft;
        const scalerTopInStage2  = (scalerRect2.top  - rect2.top)  + stage.scrollTop;
        const contentXAfter = scalerLeftInStage2 + artX * STATE.zoom;
        const contentYAfter = scalerTopInStage2  + artY * STATE.zoom;
        stage.scrollLeft = contentXAfter - anchorX;
        stage.scrollTop  = contentYAfter - anchorY;
      });
    }

    /* Ctrl/Cmd + wheel on the stage: cursor-anchored zoom.  Two-finger
       pinch on macOS produces wheel events with ctrlKey=true, so this
       supports pinch-zoom too. */
    if (el.stage) {
      el.stage.addEventListener("wheel", (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        zoomAnchored(STATE.zoom * factor, { clientX: e.clientX, clientY: e.clientY });
      }, { passive: false });
    }

    /* Space-hold + drag panning (Figma / Photoshop style).
       Space press (outside of text inputs) enters pan-ready mode:
       cursor becomes grab.  Mousedown in that state locks pointer
       events on stage and starts translating stage.scrollLeft/Top
       inversely with mouse movement.  Release space to exit.
       Also supports middle-mouse (button 1) for panning without space. */
    let panState = null;
    document.addEventListener("keydown", (e) => {
      if (e.code !== "Space") return;
      const typing = e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
      if (typing) return;
      if (!panState || !panState.active) {
        e.preventDefault();
        if (el.stage) el.stage.classList.add("pan-ready");
      }
    });
    document.addEventListener("keyup", (e) => {
      if (e.code !== "Space") return;
      if (el.stage) el.stage.classList.remove("pan-ready", "pan-active");
      if (panState && panState.active) endPan();
    });
    function startPan(e) {
      if (!el.stage) return;
      panState = {
        active: true,
        startX: e.clientX, startY: e.clientY,
        scrollLeft: el.stage.scrollLeft, scrollTop: el.stage.scrollTop,
      };
      el.stage.classList.add("pan-active");
      document.addEventListener("mousemove", onPan);
      document.addEventListener("mouseup", endPan);
    }
    function onPan(e) {
      if (!panState || !panState.active) return;
      const dx = e.clientX - panState.startX;
      const dy = e.clientY - panState.startY;
      el.stage.scrollLeft = panState.scrollLeft - dx;
      el.stage.scrollTop  = panState.scrollTop  - dy;
    }
    function endPan() {
      if (panState) panState.active = false;
      if (el.stage) el.stage.classList.remove("pan-active");
      document.removeEventListener("mousemove", onPan);
      document.removeEventListener("mouseup", endPan);
    }
    if (el.stage) {
      el.stage.addEventListener("mousedown", (e) => {
        // Space held → pan on any button.  Middle mouse (button 1) → pan without space.
        const spaceHeld = el.stage.classList.contains("pan-ready");
        const middleBtn = e.button === 1;
        if (spaceHeld || middleBtn) {
          e.preventDefault();
          startPan(e);
        }
      });
      // Prevent browser's default middle-click autoscroll cursor.
      el.stage.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
    }

    // export modal
    el.exportBtn.addEventListener("click", openSheet);
    el.exportClose.addEventListener("click", closeSheet);
    el.exportSheet.addEventListener("click", (e) => { if (e.target === el.exportSheet) closeSheet(); });
    el.exportPng.addEventListener("click", () => exportPNG(false));
    el.exportPngT.addEventListener("click", () => exportPNG(true));
    el.exportSeq.addEventListener("click", () => exportSequence(false));
    el.exportSeqT.addEventListener("click", () => exportSequence(true));
    el.exportWebm.addEventListener("click", () => exportWebM(false));
    el.exportWebmA.addEventListener("click", () => exportWebM(true));
    el.exportMp4.addEventListener("click", () => exportMP4());
    $$("#targetSeg [data-target]").forEach((b) => b.addEventListener("click", () => { EXPORTOPTS.target = b.dataset.target; if (EXPORTOPTS.target === "layer" && !selectedLayer) toast("Select a layer to export it alone"); syncExportUI(); }));
    $$("#layerModeSeg [data-lmode]").forEach((b) => b.addEventListener("click", () => { EXPORTOPTS.lmode = b.dataset.lmode; syncExportUI(); }));
    $$("#fpsSeg [data-fps]").forEach((b) => b.addEventListener("click", () => { EXPORTOPTS.fps = +b.dataset.fps; STATE.fps = EXPORTOPTS.fps; syncExportUI(); }));
    $$("#qualSeg [data-qual]").forEach((b) => b.addEventListener("click", () => { EXPORTOPTS.quality = b.dataset.qual; syncExportUI(); }));
    $$("#vbgSeg [data-vbg]").forEach((b) => b.addEventListener("click", () => { EXPORTOPTS.bg = b.dataset.vbg; syncExportUI(); }));
    wireDurSeg(document.getElementById("durSeg"));
    if (el.optTransparent) el.optTransparent.addEventListener("change", (e) => { EXPORTOPTS.transparent = e.target.checked; });
    if (el.optAudio) el.optAudio.addEventListener("change", (e) => { EXPORTOPTS.includeAudio = e.target.checked; });

    // ---- SFX library: import, drag/drop, list actions ----
    if (el.sfxDropzone && el.sfxInput) {
      el.sfxDropzone.addEventListener("click", () => el.sfxInput.click());
      el.sfxDropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.sfxInput.click(); } });
      el.sfxInput.addEventListener("change", (e) => handleSfxFiles(e.target.files));
      ["dragenter", "dragover"].forEach((ev) => el.sfxDropzone.addEventListener(ev, (e) => { e.preventDefault(); el.sfxDropzone.classList.add("drag"); }));
      ["dragleave", "drop"].forEach((ev) => el.sfxDropzone.addEventListener(ev, (e) => { e.preventDefault(); el.sfxDropzone.classList.remove("drag"); }));
      el.sfxDropzone.addEventListener("drop", (e) => handleSfxFiles(e.dataTransfer.files));
    }

    // ---- Attach SFX toggle for event clips ----
    if (el.attachSfx) {
      el.attachSfx.addEventListener("change", (e) => {
        STATE.attachSfx = e.target.checked;
        el.attachSfxSel.style.display = e.target.checked ? "" : "none";
      });
    }
    if (el.attachSfxSel) {
      el.attachSfxSel.addEventListener("change", (e) => { STATE.attachSfxId = e.target.value; });
    }

    // ---- Audio mixer sliders + mute buttons ----
    const mixHook = (id, key, valId) => {
      const s = document.getElementById(id); if (!s) return;
      s.addEventListener("input", (e) => {
        const v = +e.target.value;
        STATE[key] = v / 100;
        const vEl = document.getElementById(valId); if (vEl) vEl.textContent = v;
        refreshMixer();
      });
    };
    mixHook("mix-master", "mixMaster", "val-mv");
    mixHook("mix-music",  "mixMusic",  "val-mm");
    mixHook("mix-sfx",    "mixSfx",    "val-msfx");
    mixHook("mix-voice",  "mixVoice",  "val-mvoice");
    ["mixMuteMusic", "mixMuteSfx", "mixMuteVoice", "mixMuteAll"].forEach((id) => {
      const b = document.getElementById(id); if (!b) return;
      b.addEventListener("click", () => {
        const t = b.dataset.target;
        if (t === "master") STATE.muteMaster = !STATE.muteMaster;
        if (t === "music")  STATE.muteMusic  = !STATE.muteMusic;
        if (t === "sfx")    STATE.muteSfx    = !STATE.muteSfx;
        if (t === "voice")  STATE.muteVoice  = !STATE.muteVoice;
        refreshMixer(); renderTimeline();
        b.classList.toggle("active", STATE["mute" + t.charAt(0).toUpperCase() + t.slice(1)]);
      });
    });

    // ---- Beat sync extras ----
    if (el.snapBeat) el.snapBeat.addEventListener("change", (e) => { STATE.snapBeat = e.target.checked; });
    if (el.autoKeyframes) el.autoKeyframes.addEventListener("change", (e) => { STATE.autoKeyframes = e.target.checked; });

    // ---- Timeline zoom + marker button ----
    if (el.tlZoom) el.tlZoom.addEventListener("input", (e) => { STATE.tlZoom = +e.target.value; renderTimeline(); });
    // Item 2 — frame-snap toggle.  Reflects STATE.snapFrame (default on).
    if (el.snapFrameBtn) el.snapFrameBtn.addEventListener("click", () => {
      STATE.snapFrame = !STATE.snapFrame;
      el.snapFrameBtn.classList.toggle("is-on", STATE.snapFrame);
      toast(STATE.snapFrame ? "Frame snap: ON (Shift-drag to bypass)" : "Frame snap: OFF");
    });
    // v18.8: playhead snap + clip-edge snap toggles.
    if (el.snapPlayheadBtn) el.snapPlayheadBtn.addEventListener("click", () => {
      STATE.snapPlayhead = !STATE.snapPlayhead;
      el.snapPlayheadBtn.classList.toggle("is-on", STATE.snapPlayhead);
      toast(STATE.snapPlayhead ? "Snap to playhead: ON" : "Snap to playhead: OFF");
    });
    if (el.snapClipsBtn) el.snapClipsBtn.addEventListener("click", () => {
      STATE.snapClipEdges = !STATE.snapClipEdges;
      el.snapClipsBtn.classList.toggle("is-on", STATE.snapClipEdges);
      toast(STATE.snapClipEdges ? "Snap to clip edges: ON" : "Snap to clip edges: OFF");
    });
    // v19.31 Snap-to-Marker toggle.  Off by default so it's an opt-in
    // for timing-based workflows.
    const snapMarkerBtn = document.getElementById("snapMarkerBtn");
    if (snapMarkerBtn) snapMarkerBtn.addEventListener("click", () => {
      STATE.snapMarker = !STATE.snapMarker;
      snapMarkerBtn.classList.toggle("is-on", STATE.snapMarker);
      toast(STATE.snapMarker ? "Snap to markers: ON" : "Snap to markers: OFF");
    });
    // v18.8: Fit-all + zoom-to-selection buttons.
    if (el.zoomFitAllBtn) el.zoomFitAllBtn.addEventListener("click", () => zoomFitAll());
    if (el.zoomToSelBtn) el.zoomToSelBtn.addEventListener("click", () => {
      const ec = selectedEventClip
        ? { start: selectedEventClip.layer.start + selectedEventClip.ec.start, dur: selectedEventClip.ec.duration }
        : selectedAudioClip ? { start: selectedAudioClip.start, dur: selectedAudioClip.duration }
        : null;
      if (ec) zoomToRange(ec.start, ec.start + ec.dur);
      else toast("Select a clip to zoom to");
    });
    // v18.8: cursor-anchored mouse-wheel zoom on the timeline body.
    if (el.tlBody) el.tlBody.addEventListener("wheel", (e) => {
      // Only zoom when the user holds Ctrl/Cmd or uses horizontal wheel.
      // Otherwise let the browser scroll normally.
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.tlBody.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      // Time under the cursor before zoom change.
      const timeAtCursor = mouseX / (TL.pxPerSec || 1);
      // Adjust zoom.  Wheel delta positive = zoom out.
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.max(0.25, Math.min(16, (STATE.tlZoom || 1) * factor));
      STATE.tlZoom = newZoom;
      if (el.tlZoom) el.tlZoom.value = newZoom;
      renderTimeline();
      // After renderTimeline, TL.pxPerSec is updated.  Adjust scrollLeft
      // so the same time stays under the cursor.
      requestAnimationFrame(() => {
        const scroller = el.tlBody;
        if (!scroller) return;
        const newPxAtCursor = timeAtCursor * TL.pxPerSec;
        scroller.scrollLeft = newPxAtCursor - mouseX;
      });
    }, { passive: false });
    if (el.markerBtn) {
      el.markerBtn.addEventListener("click", () => {
        const t = STATE.time;
        const exists = markers.find((m) => m.type === "manual" && Math.abs(m.time - t) < 0.05);
        if (exists) { markers.splice(markers.indexOf(exists), 1); toast("Marker removed"); }
        else { markers.push({ type: "manual", time: t }); toast(`Marker @ ${t.toFixed(2)}s`); }
        renderTimeline();
      });
      // v19.33: right-click on Marker button → Grid Generator popover.
      // Consolidates the two related actions in one toolbar slot;
      // frees a slot so the Zoom cluster stays on the right at typical
      // viewport widths without the toolbar wrapping.
      el.markerBtn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openMarkerGridPopover(el.markerBtn);
      });
    }

    /* v19.32 Marker Grid Generator.
     *
     * Popover with two families of distributions:
     *   Regular       — every N seconds (0.25, 0.5, 1.0, custom)
     *   Progressive   — mathematical distributions:
     *                     - Golden Ratio     (0, φ, 2φ, 3φ, ...)  ish
     *                     - Exponential      (base^i * scale)
     *                     - Accelerating     (quadratic-in easing)
     *                     - Decelerating     (quadratic-out easing)
     *
     * All modes clear existing generated markers first (type "grid")
     * and re-emit — so users can iterate patterns quickly.  Manual
     * markers are preserved.  A "Clear generated" option removes
     * only grid markers.  Generated markers use type "grid" so
     * the code can distinguish them from manual and beat-detected.
     */
    const markerGridBtn = document.getElementById("markerGridBtn");
    // v19.33: standalone button removed from the toolbar; Grid popover
    // opens via right-click on the Marker button now.  Keep this
    // handler defensively in case any future skin re-adds a button
    // with this id — no harm if the element doesn't exist.
    if (markerGridBtn) markerGridBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openMarkerGridPopover(markerGridBtn);
    });
    function clearGeneratedMarkers() {
      for (let i = markers.length - 1; i >= 0; i--) if (markers[i].type === "grid") markers.splice(i, 1);
    }
    /* Regular interval: emit markers at 0, N, 2N, ... within duration. */
    function generateRegularGrid(intervalSec) {
      clearGeneratedMarkers();
      const dur = STATE.duration;
      if (intervalSec <= 0 || !isFinite(intervalSec)) return 0;
      let count = 0;
      for (let t = 0; t <= dur + 0.0001; t += intervalSec) {
        markers.push({ type: "grid", time: +t.toFixed(3) });
        count++;
      }
      renderTimeline();
      return count;
    }
    /* Golden-ratio progression.  Positions at φ^0, φ^1, φ^2, ...
       scaled to fit inside the timeline.  φ = 1.618... */
    function generateGoldenRatioGrid() {
      clearGeneratedMarkers();
      const phi = (1 + Math.sqrt(5)) / 2;
      const dur = STATE.duration;
      // Start at 1 second, then each next = prev * φ
      const times = [];
      let t = 1;
      while (t < dur) { times.push(t); t *= phi; }
      // Always include 0 as the first marker for a clear reference.
      markers.push({ type: "grid", time: 0 });
      for (const time of times) markers.push({ type: "grid", time: +time.toFixed(3) });
      renderTimeline();
      return times.length + 1;
    }
    /* Exponential: t_i = scale * (base^i - 1), stops within duration.
       Default base=2, scale set so the last marker is near duration. */
    function generateExponentialGrid(base = 2) {
      clearGeneratedMarkers();
      const dur = STATE.duration;
      // Pick a scale that lands ~8-12 markers across the timeline.
      // scale * (base^N - 1) = duration → N depends on scale.
      const N = 8;
      const scale = dur / (Math.pow(base, N) - 1);
      let count = 0;
      for (let i = 0; i <= N; i++) {
        const t = scale * (Math.pow(base, i) - 1);
        if (t > dur + 0.0001) break;
        markers.push({ type: "grid", time: +t.toFixed(3) });
        count++;
      }
      renderTimeline();
      return count;
    }
    /* Accelerating (quadratic-in): dense at start, sparse at end.
       t_i = duration * (i/N)^2 for i in 0..N. */
    function generateAcceleratingGrid(N = 10) {
      clearGeneratedMarkers();
      const dur = STATE.duration;
      for (let i = 0; i <= N; i++) {
        const p = i / N;
        markers.push({ type: "grid", time: +(dur * p * p).toFixed(3) });
      }
      renderTimeline();
      return N + 1;
    }
    /* Decelerating (quadratic-out): sparse at start, dense at end.
       t_i = duration * (1 - (1-i/N)^2). */
    function generateDeceleratingGrid(N = 10) {
      clearGeneratedMarkers();
      const dur = STATE.duration;
      for (let i = 0; i <= N; i++) {
        const p = i / N;
        markers.push({ type: "grid", time: +(dur * (1 - (1 - p) * (1 - p))).toFixed(3) });
      }
      renderTimeline();
      return N + 1;
    }

    /* v19.36 audio-reactive marker generation.
     *
     * Analyzes a raw AudioBuffer (mono-mixed) to detect events and
     * emit markers at their timestamps.  Three detectors:
     *
     *   generateOnsetMarkers(buffer, mode)
     *     mode="onset"      — general onset via spectral flux across
     *                         all bands.  Catches most transients:
     *                         drums, plucks, hits, syllables.
     *     mode="bass"       — energy peaks in the low band (~20-160Hz).
     *                         Catches kick drums, bass hits, sub drops.
     *     mode="transient"  — steep rises in the high band (~2-8kHz).
     *                         Catches hi-hats, snares, cymbals.
     *
     * Algorithm: STFT with 2048-sample frames + 50% hop; compute
     * per-frame energy in the target band; the detection function
     * is the positive-half-wave rectified difference between the
     * current and previous frame energies (spectral flux); peaks in
     * the detection function above an adaptive median-based
     * threshold with minimum inter-onset spacing (default 100ms)
     * become markers.
     *
     * Runs synchronously — a 4-minute stereo track analyzes in
     * ~200-400ms on modern hardware.  For longer tracks we could
     * push to a Worker; that's a future refinement. */
    function pickAudioBuffer() {
      // Prefer the main music buffer; fall back to the first sound
      // in the SFX library if music isn't loaded yet.
      if (audio && audio.buffer) return audio.buffer;
      if (typeof sounds !== "undefined" && sounds.length) return sounds[0].buffer || null;
      return null;
    }
    /* Detect onsets in a mono waveform via band-limited spectral flux. */
    function detectOnsets(buffer, opts) {
      const { bandLo = 0, bandHi = null, minGap = 0.1, thresholdMul = 2.5 } = opts || {};
      // Downmix to mono.
      const nCh = buffer.numberOfChannels;
      const N = buffer.length;
      const sr = buffer.sampleRate;
      const mono = new Float32Array(N);
      for (let ch = 0; ch < nCh; ch++) {
        const data = buffer.getChannelData(ch);
        for (let i = 0; i < N; i++) mono[i] += data[i] / nCh;
      }
      // Frame parameters — 2048-sample frame, 512-sample hop = ~86 frames/sec at 44.1kHz.
      const frameSize = 2048;
      const hopSize   = 512;
      const nFrames   = Math.max(0, Math.floor((N - frameSize) / hopSize) + 1);
      // Simple time-domain energy per band range.  We approximate the
      // band by bandpass filtering (a lightweight IIR) before computing
      // energy — much cheaper than FFT for our modest bin count.
      const nyq = sr / 2;
      const loFreq = bandLo;
      const hiFreq = bandHi != null ? bandHi : nyq;
      const filtered = bandPassFilter(mono, sr, loFreq, hiFreq);
      // Per-frame energy = sum of squared samples.
      const energy = new Float32Array(nFrames);
      for (let f = 0; f < nFrames; f++) {
        const start = f * hopSize;
        let e = 0;
        for (let i = 0; i < frameSize; i++) { const v = filtered[start + i]; e += v * v; }
        energy[f] = e;
      }
      // Detection function = positive first-order difference of energy.
      const detect = new Float32Array(nFrames);
      for (let f = 1; f < nFrames; f++) {
        const d = energy[f] - energy[f - 1];
        detect[f] = d > 0 ? d : 0;
      }
      // v19.36 stricter threshold: 80th-percentile of a ±30-frame
      // window × thresholdMul.  Median was too low for signals with
      // sparse impulses (median ≈ 0 → threshold ≈ 0 → false positives
      // everywhere).  Also enforce a global floor of 15% of peak so
      // very quiet ambient variations don't trigger.
      const windowFrames = 30;
      const thresholds = new Float32Array(nFrames);
      const window = new Float32Array(windowFrames * 2 + 1);
      let globalMax = 0;
      for (let f = 0; f < nFrames; f++) if (detect[f] > globalMax) globalMax = detect[f];
      const globalFloor = globalMax * 0.15;
      for (let f = 0; f < nFrames; f++) {
        const a = Math.max(0, f - windowFrames);
        const b = Math.min(nFrames - 1, f + windowFrames);
        const w = b - a + 1;
        for (let i = a, k = 0; i <= b; i++, k++) window[k] = detect[i];
        window.subarray(0, w).sort();
        const p80 = window[Math.floor(w * 0.8)];
        thresholds[f] = Math.max(p80 * thresholdMul, globalFloor);
      }
      // Peak-picking: local maxima above threshold, spaced ≥ minGap.
      // Center the marker in the frame window so timing lands close to
      // the actual attack rather than the frame's leading edge.
      const minFrameGap = Math.max(1, Math.floor((minGap * sr) / hopSize));
      const frameCenterOffset = frameSize / (2 * sr);
      const times = [];
      let lastOnsetFrame = -minFrameGap - 1;
      for (let f = 2; f < nFrames - 1; f++) {
        if (f - lastOnsetFrame < minFrameGap) continue;
        if (detect[f] <= thresholds[f]) continue;
        // Require a real local maximum (also above 2 frames back).
        if (detect[f] < detect[f - 1] || detect[f] < detect[f + 1]) continue;
        if (detect[f] < detect[f - 2]) continue;
        times.push((f * hopSize) / sr - frameCenterOffset);
        lastOnsetFrame = f;
      }
      return times;
    }
    /* Simple 2-pole Butterworth bandpass approximation via cascaded
       first-order high-pass + low-pass.  Not audiophile quality, but
       plenty accurate for onset detection since we only care about
       relative energy changes, not spectrum shape. */
    function bandPassFilter(samples, sr, loHz, hiHz) {
      const out = new Float32Array(samples.length);
      const N = samples.length;
      if (loHz <= 0 && hiHz >= sr / 2) { out.set(samples); return out; }
      // High-pass: y[n] = a * (y[n-1] + x[n] - x[n-1])
      // Low-pass:  y[n] = a * x[n] + (1-a) * y[n-1]
      const rcHi = 1 / (2 * Math.PI * Math.max(1, loHz));
      const rcLo = 1 / (2 * Math.PI * Math.max(1, hiHz));
      const dt = 1 / sr;
      const aHi = rcHi / (rcHi + dt);
      const aLo = dt / (rcLo + dt);
      let prevX = 0, prevY = 0;
      // Highpass pass (removes below loHz)
      for (let i = 0; i < N; i++) {
        const y = aHi * (prevY + samples[i] - prevX);
        out[i] = y;
        prevX = samples[i]; prevY = y;
      }
      // Lowpass pass (removes above hiHz)
      let yLp = 0;
      for (let i = 0; i < N; i++) {
        yLp = aLo * out[i] + (1 - aLo) * yLp;
        out[i] = yLp;
      }
      return out;
    }
    function generateAudioMarkers(mode) {
      const buffer = pickAudioBuffer();
      if (!buffer) { toast("Load a music track or a sound first"); return 0; }
      clearGeneratedMarkers();
      let times = [];
      // Bands from perceptual frequency ranges.
      if (mode === "bass") {
        times = detectOnsets(buffer, { bandLo: 20, bandHi: 160, minGap: 0.14, thresholdMul: 2.8 });
      } else if (mode === "transient") {
        times = detectOnsets(buffer, { bandLo: 2000, bandHi: 8000, minGap: 0.06, thresholdMul: 2.8 });
      } else {
        // Full-band onset — catches most percussive/note events.
        times = detectOnsets(buffer, { bandLo: 80, bandHi: 8000, minGap: 0.09, thresholdMul: 2.5 });
      }
      // Clamp to scene duration and emit as grid markers.
      const dur = STATE.duration;
      for (const t of times) {
        if (t > dur + 0.01) break;
        markers.push({ type: "grid", time: +t.toFixed(3) });
      }
      renderTimeline();
      return times.length;
    }
    // v19.36: also expose the audio-marker helpers on the debug hook
    // so tests can call them directly without opening the popover.
    // These are nested-scope closures so we splice them onto the
    // debug object here rather than the top-level assignment below.
    if (typeof window !== "undefined") {
      window.__phaserDebug = window.__phaserDebug || {};
      window.__phaserDebug.detectOnsets = detectOnsets;
      window.__phaserDebug.generateAudioMarkers = generateAudioMarkers;
      window.__phaserDebug.pickAudioBuffer = pickAudioBuffer;
    }

    let _gridPopover = null;
    function closeGridPopover() {
      if (_gridPopover && _gridPopover.parentNode) _gridPopover.parentNode.removeChild(_gridPopover);
      _gridPopover = null;
      document.removeEventListener("click", _gridPopoverOutside, true);
    }
    function _gridPopoverOutside(e) {
      if (_gridPopover && !_gridPopover.contains(e.target)) closeGridPopover();
    }
    function openMarkerGridPopover(anchor) {
      closeGridPopover();
      const rect = anchor.getBoundingClientRect();
      const pop = document.createElement("div");
      pop.className = "grid-popover";
      pop.style.left = rect.left + "px";
      pop.style.bottom = (window.innerHeight - rect.top + 6) + "px";
      pop.innerHTML = `
        <div class="grid-pop-hd">Generate marker grid</div>
        <div class="grid-pop-section">Regular intervals</div>
        <div class="grid-pop-row" data-cmd="reg-0.25">Every 0.25s</div>
        <div class="grid-pop-row" data-cmd="reg-0.5">Every 0.5s</div>
        <div class="grid-pop-row" data-cmd="reg-1">Every 1s</div>
        <div class="grid-pop-row grid-pop-custom">
          Every <input type="number" step="0.001" min="0.001" id="gridCustomInterval" value="0.5" class="tl-clip-time-input" style="width:56px"> s
          <button class="mini-btn" id="gridCustomApply">Apply</button>
        </div>
        <div class="grid-pop-section">Progressive</div>
        <div class="grid-pop-row" data-cmd="golden">Golden ratio (φ)</div>
        <div class="grid-pop-row" data-cmd="exp">Exponential (base 2)</div>
        <div class="grid-pop-row" data-cmd="accel">Accelerating</div>
        <div class="grid-pop-row" data-cmd="decel">Decelerating</div>
        <div class="grid-pop-section">From audio</div>
        <div class="grid-pop-row" data-cmd="onset">Onsets (all)</div>
        <div class="grid-pop-row" data-cmd="bass">Bass hits</div>
        <div class="grid-pop-row" data-cmd="transient">Transients (hats/snares)</div>
        <div class="grid-pop-section"></div>
        <div class="grid-pop-row grid-pop-clear" data-cmd="clear">Clear generated markers</div>
      `;
      document.body.appendChild(pop);
      _gridPopover = pop;
      pop.addEventListener("click", (e) => {
        e.stopPropagation();
        const row = e.target.closest("[data-cmd]");
        if (!row) return;
        const cmd = row.dataset.cmd;
        let n = 0;
        if (cmd === "reg-0.25") n = generateRegularGrid(0.25);
        else if (cmd === "reg-0.5") n = generateRegularGrid(0.5);
        else if (cmd === "reg-1")   n = generateRegularGrid(1.0);
        else if (cmd === "golden")  n = generateGoldenRatioGrid();
        else if (cmd === "exp")     n = generateExponentialGrid(2);
        else if (cmd === "accel")   n = generateAcceleratingGrid(10);
        else if (cmd === "decel")   n = generateDeceleratingGrid(10);
        else if (cmd === "onset")   n = generateAudioMarkers("onset");
        else if (cmd === "bass")    n = generateAudioMarkers("bass");
        else if (cmd === "transient") n = generateAudioMarkers("transient");
        else if (cmd === "clear") { clearGeneratedMarkers(); renderTimeline(); toast("Generated markers cleared"); closeGridPopover(); return; }
        toast(`Generated ${n} markers`);
        closeGridPopover();
      });
      const applyBtn = pop.querySelector("#gridCustomApply");
      if (applyBtn) applyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const val = parseFloat(document.getElementById("gridCustomInterval").value);
        if (!isFinite(val) || val <= 0) { toast("Enter a positive interval"); return; }
        const n = generateRegularGrid(val);
        toast(`Generated ${n} markers at ${val}s intervals`);
        closeGridPopover();
      });
      setTimeout(() => document.addEventListener("click", _gridPopoverOutside, true), 0);
    }

    // Keyboard 'M' for marker
    document.addEventListener("keydown", (e) => {
      const typing = e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT";
      if (typing) return;
      if (e.key === "m") { if (el.markerBtn) el.markerBtn.click(); }
      // S1 — Hide/Show timeline.  Toggles a body class; CSS collapses
      // the timeline footer and expands the canvas area.  A brief hint
      // appears in focus mode so users remember how to get back.
      if (e.key === "h" || e.key === "H") {
        e.preventDefault();
        const on = document.body.classList.toggle("focus-mode");
        // Wait for the browser to recompute the grid layout (topbar+
        // stage 2-row grid instead of topbar+stage+timeline 3-row).
        // Only then does el.stage.clientHeight reflect the new size,
        // so `fitZoom` reads the correct available space.
        requestAnimationFrame(() => {
          try { if (typeof fitZoom === "function" && STATE.zoomMode === "fit") fitZoom(); } catch (err) {}
        });
        toast(on ? "Focus mode — press H to show timeline" : "Timeline shown");
      }
      // ---- v18.8 Contextual frame-stepping keyboard navigation ----
      // Rules:
      //  - No clip selected       → Left/Right = playhead ± 1 frame; Shift = 10.
      //  - Event/audio clip selected → Left/Right = MOVE clip ± 1 frame; Shift = 10.
      //  - Alt held on either     → TRIM clip end ± 1 frame (Shift = 10).
      // Guarded by `!typing` (above) so form fields keep normal behavior.
      const fps = STATE.fps || 30;
      const bigStep = e.shiftKey ? 10 : 1;
      const secStep = bigStep / fps;
      const clipCtx = selectedEventClip || (selectedAudioClip ? { ec: selectedAudioClip, isAudio: true } : null);

      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        // v19.34: prioritize playhead seek — matches user request for
        // "precise frame-by-frame scrubbing".  Alt-Arrow now nudges
        // the selected clip; Alt-Shift-Arrow trims its end.  Plain
        // Arrow always seeks, regardless of selection state.
        if (e.altKey && clipCtx) {
          const ec = selectedEventClip ? selectedEventClip.ec : selectedAudioClip;
          const layer = selectedEventClip ? selectedEventClip.layer : null;
          const layerDur = layer ? layer.duration : STATE.duration;
          if (e.shiftKey) {
            // Alt+Shift+Arrow → trim end.
            const newDur = clamp(ec.duration + dir * secStep, MIN_CLIP_DUR,
              Math.max(MIN_CLIP_DUR, layerDur - ec.start));
            ec.duration = Math.round(newDur * fps) / fps;
          } else {
            // Alt+Arrow → move clip.
            const maxStart = Math.max(0, layerDur - ec.duration);
            const newStart = clamp(ec.start + dir * secStep, 0, maxStart);
            ec.start = Math.round(newStart * fps) / fps;
          }
          renderTimeline(); renderClipInspector(); paintIfPaused();
        } else {
          // Plain Arrow (or Shift-Arrow for 10-frame jumps) → seek.
          // paintIfPaused runs the effect pipeline so the scrubbed
          // frame renders correctly.
          if (typeof seekTo === "function") seekTo(STATE.time + dir * secStep);
        }
      } else if (e.key === "Home") {
        e.preventDefault();
        if (typeof seekTo === "function") seekTo(0);
      } else if (e.key === "End") {
        e.preventDefault();
        if (typeof seekTo === "function") seekTo(STATE.duration);
      } else if ((e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey) {
        // v18.9: F now fits the CANVAS to viewport (Photoshop/Figma
        // standard).  Shift+F fits the TIMELINE (previous v18.8
        // behavior).  This matches user expectation — in every major
        // editor, F is a canvas-viewport operation.
        e.preventDefault();
        if (e.shiftKey) {
          zoomFitAll();  // timeline fit
        } else {
          fitZoom();     // canvas fit — sets STATE.zoom = fit, STATE.zoomMode = "fit"
        }
      }
    });

    // S2 — Preview quality buttons.  Sets STATE.previewQuality and
    // resizes existing WebCodecs preview canvases to the new cap.
    // CSS scales the layer to fit the artboard regardless, so a
    // lower internal resolution just means fewer pixels per composite
    // (smoother scrubbing on high-res sources).  Export always uses
    // the separate full-source-resolution export canvas.
    document.querySelectorAll(".quality-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const q = btn.getAttribute("data-quality");
        if (!q || q === STATE.previewQuality) return;
        STATE.previewQuality = q;
        document.querySelectorAll(".quality-btn").forEach((b) => b.classList.toggle("active", b === btn));
        // Resize every WebCodecs video layer's preview canvas.
        layers.forEach((L) => {
          if (L.kind !== "VIDEO" || !L.videoSource || !L.node) return;
          const cap = previewCanvasSizeFor(L.natW, L.natH);
          if (L.node.width !== cap.w || L.node.height !== cap.h) {
            L.node.width  = cap.w;
            L.node.height = cap.h;
          }
        });
        paintIfPaused();
        toast(`Preview: ${q}`);
      });
    });

    // ---- Selected-clip inspector wiring ----
    // Every slider input performs the update THEN triggers the full
    // refresh chain: renderTimeline (clip position/width visible),
    // renderEventButtons (right-panel active dot), and paintIfPaused
    // (preview shows the change immediately when an event is active).
    const MIN_CLIP_DUR = 0.05;
    const bindClipSlider = (key, apply) => {
      const s = document.getElementById(`ctl-${key}`), vv = document.getElementById(`val-${key}`);
      const num = document.getElementById(`num-${key}`);
      // Single commit path — regardless of which input fired.  Numeric
      // input takes user's typed value; slider takes its value.  Both
      // funnel through the same clamp + STATE update in `apply`.
      const commit = (v) => {
        if (v === null || v === undefined || isNaN(v)) return;
        if (s && document.activeElement !== s) s.value = v;
        if (num && document.activeElement !== num) num.value = (+v).toFixed(3);
        if (vv) vv.textContent = (key === "cs" || key === "cd") ? (+v).toFixed(3) : Math.round(v);
        apply(v);
        renderTimeline(); renderEventButtons(); paintIfPaused();
      };
      if (s) s.addEventListener("input", (e) => commit(+e.target.value));
      if (num) num.addEventListener("input", (e) => commit(+e.target.value));
      // Also commit on blur / Enter so users can type a full value like
      // "1.500" without triggering re-renders on every keystroke.
      if (num) {
        num.addEventListener("blur", (e) => commit(+e.target.value));
        num.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(+e.target.value); num.blur(); } });
      }
    };
    bindClipSlider("cs", (v) => {
      if (selectedEventClip) {
        const L = selectedEventClip.layer, ec = selectedEventClip.ec;
        // slider value is scene time; store layer-relative
        ec.start = clamp(v - L.start, 0, Math.max(0, L.duration - ec.duration));
      } else if (selectedAudioClip) {
        selectedAudioClip.start = clamp(v, 0, Math.max(0, STATE.duration - selectedAudioClip.duration));
      }
    });
    bindClipSlider("cd", (v) => {
      if (selectedEventClip) {
        const L = selectedEventClip.layer, ec = selectedEventClip.ec;
        // Minimum 0.05s so tiny events like Hard Cut (default 0.08) stay
        // usable; previous 0.02 was too permissive and showed as "0.00".
        ec.duration = clamp(v, MIN_CLIP_DUR, Math.max(MIN_CLIP_DUR, L.duration - ec.start));
      } else if (selectedAudioClip) {
        selectedAudioClip.duration = clamp(v, MIN_CLIP_DUR, Math.max(MIN_CLIP_DUR, STATE.duration - selectedAudioClip.start));
      }
    });
    bindClipSlider("cv", (v) => { if (selectedAudioClip) selectedAudioClip.volume = v / 100; });

    // v18.8 timeline precision — commit handlers for the new fields:
    //   num-cs-f  (Start in frames)
    //   num-ce    (End in seconds)
    //   num-ce-f  (End in frames)
    //   num-cd-f  (Duration in frames)
    // All three values (Start / End / Duration) are interdependent.
    // Rules:
    //   - Editing Start moves the clip (keeping Duration).
    //   - Editing End changes Duration (keeping Start).
    //   - Editing Duration changes End (keeping Start).
    // Frame inputs convert via current fps, then use the same logic.
    // v19.31: `fromDrag` flag distinguishes mouse-drag calls (where
    // frame snap prevents sub-pixel jitter and is genuinely useful)
    // from typed numeric input (where the user has explicitly stated
    // the value they want and frame snap only corrupts precision).
    // Typing "2.750" at 30fps used to yield 2.767 because frame snap
    // rounded to the nearest 30fps frame.  With fromDrag=false, the
    // exact typed value is respected — matching how a Playhead
    // Position field would behave.
    function commitClipTime(kind, secValue, fromDrag = false) {
      const fps = STATE.fps || 30;
      const applySnap = (v) => (fromDrag && STATE.snapFrame) ? Math.round(v * fps) / fps : v;
      if (secValue == null || isNaN(secValue)) return;
      if (selectedEventClip) {
        const L = selectedEventClip.layer, ec = selectedEventClip.ec;
        if (kind === "start") {
          // secValue is ABSOLUTE scene time (matches display).  Convert to
          // layer-local and clamp so clip fits.
          const local = clamp(secValue - L.start, 0, Math.max(0, L.duration - ec.duration));
          ec.start = applySnap(local);
        } else if (kind === "end") {
          const endLocal = clamp(secValue - L.start, ec.start + MIN_CLIP_DUR, L.duration);
          const snappedEnd = applySnap(endLocal);
          ec.duration = Math.max(MIN_CLIP_DUR, snappedEnd - ec.start);
        } else if (kind === "duration") {
          const dur = clamp(secValue, MIN_CLIP_DUR, Math.max(MIN_CLIP_DUR, L.duration - ec.start));
          ec.duration = applySnap(dur);
        }
      } else if (selectedAudioClip) {
        const ac = selectedAudioClip;
        if (kind === "start") {
          ac.start = applySnap(clamp(secValue, 0, Math.max(0, STATE.duration - ac.duration)));
        } else if (kind === "end") {
          const end = clamp(secValue, ac.start + MIN_CLIP_DUR, STATE.duration);
          const snappedEnd = applySnap(end);
          ac.duration = Math.max(MIN_CLIP_DUR, snappedEnd - ac.start);
        } else if (kind === "duration") {
          ac.duration = applySnap(clamp(secValue, MIN_CLIP_DUR, Math.max(MIN_CLIP_DUR, STATE.duration - ac.start)));
        }
      } else if (selectedLayer) {
        // v19.33: layer-only fallback.  D/S/E edit layer.start /
        // layer.duration directly.  Same clamps as clip editing:
        // Start ≥ 0, End > Start + MIN, End ≤ scene duration.
        const L = selectedLayer;
        if (kind === "start") {
          L.start = applySnap(clamp(secValue, 0, Math.max(0, STATE.duration - L.duration)));
        } else if (kind === "end") {
          const end = clamp(secValue, L.start + MIN_CLIP_DUR, STATE.duration);
          const snappedEnd = applySnap(end);
          L.duration = Math.max(MIN_CLIP_DUR, snappedEnd - L.start);
        } else if (kind === "duration") {
          L.duration = applySnap(clamp(secValue, MIN_CLIP_DUR, Math.max(MIN_CLIP_DUR, STATE.duration - L.start)));
        }
      }
      renderTimeline(); renderClipInspector(); renderEventButtons(); paintIfPaused();
    }
    // Wire seconds End input
    const bindTimeField = (id, kind, isFrame) => {
      const n = document.getElementById(id);
      if (!n) return;
      const handler = () => {
        const raw = +n.value;
        if (isNaN(raw)) return;
        const fps = STATE.fps || 30;
        commitClipTime(kind, isFrame ? (raw / fps) : raw);
        // v19.32: brief accent flash on the input so users see the
        // commit landed — addresses the "fields don't seem to work"
        // report.  Only flashes when a clip is actually selected
        // (i.e., the field is enabled).
        if (!n.disabled) {
          n.classList.add("commit-flash");
          setTimeout(() => n.classList.remove("commit-flash"), 500);
        }
      };
      n.addEventListener("input", handler);
      n.addEventListener("blur", handler);
      n.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); handler(); n.blur(); } });
      // v19.32: click on disabled field shows a toast so users know
      // WHY the field isn't editable — no more "effectively inactive"
      // confusion.  Also applies to the disabled-hint via mousedown
      // since disabled inputs don't fire click.
      n.addEventListener("mousedown", (e) => {
        if (n.disabled) {
          // v19.33: differentiate the hint by state — user might have
          // zero layers, zero clips on a layer, or just haven't
          // selected anything yet.
          if (!layers.length && !audioClips.length) toast("Add a layer or asset first");
          else if (!selectedLayer) toast("Select a layer or clip to edit its timing");
          else toast("Select a clip on the timeline first (or select a layer to edit its timing)");
        }
      });
    };
    bindTimeField("num-ce",   "end",       false);
    bindTimeField("num-ce-f", "end",       true);
    bindTimeField("num-cs-f", "start",     true);
    bindTimeField("num-cd-f", "duration",  true);
    // v19.28: previously the seconds fields for Start (num-cs) and
    // Duration (num-cd) were rendered and populated but never wired
    // to input handlers, so typing 3-decimal values into them had no
    // effect.  Only the frame variants and End-seconds committed.
    // Wire them the same way as the others.
    bindTimeField("num-cs",   "start",     false);
    bindTimeField("num-cd",   "duration",  false);
    // v19.29: toolbar-hosted Start/End editors — share the same
    // commitClipTime pipeline as the inspector fields.  Both surfaces
    // edit the same clip state; renderClipInspector keeps both in
    // sync via setNumIf.
    // v19.30: also Duration input.
    bindTimeField("tlClipStart", "start", false);
    bindTimeField("tlClipEnd",   "end",   false);
    bindTimeField("tlClipDur",   "duration", false);

    /* v19.0 Playhead position input — always visible, editable.
       Accepts:
         "1.5"           → 1.5 seconds
         "45f"           → frame 45 at current fps
         "00:00:01:15"   → timecode HH:MM:SS:FF
         "00:01:15"      → MM:SS:FF (2-part timecode)
       Enter commits, Escape reverts to current time, blur commits. */
    function parsePlayheadInput(raw) {
      const s = String(raw || "").trim().toLowerCase();
      if (!s) return null;
      const fps = STATE.fps || 30;
      // Timecode HH:MM:SS:FF or MM:SS:FF
      if (s.includes(":")) {
        const parts = s.split(":").map((p) => parseInt(p, 10));
        if (parts.some(isNaN)) return null;
        let hh = 0, mm = 0, ss = 0, ff = 0;
        if (parts.length === 4) [hh, mm, ss, ff] = parts;
        else if (parts.length === 3) [mm, ss, ff] = parts;
        else if (parts.length === 2) [ss, ff] = parts;
        else return null;
        return hh * 3600 + mm * 60 + ss + ff / fps;
      }
      // Frames: "45f"
      if (s.endsWith("f")) {
        const frame = parseFloat(s.slice(0, -1));
        return isNaN(frame) ? null : frame / fps;
      }
      // Bare number = seconds
      const num = parseFloat(s);
      return isNaN(num) ? null : num;
    }
    if (el.timecode) {
      const commit = () => {
        const target = parsePlayheadInput(el.timecode.value);
        if (target != null && typeof seekTo === "function") {
          seekTo(clamp(target, 0, STATE.duration));
        } else {
          // Invalid → restore current position
          el.timecode.value = (STATE.time || 0).toFixed(3);
        }
      };
      el.timecode.addEventListener("focus", () => el.timecode.select());
      el.timecode.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); el.timecode.blur(); }
        else if (e.key === "Escape") { e.preventDefault(); el.timecode.value = (STATE.time || 0).toFixed(3); el.timecode.blur(); }
      });
      el.timecode.addEventListener("blur", commit);
    }
    if (el.clipMute) el.clipMute.addEventListener("click", () => {
      if (!selectedAudioClip) return;
      selectedAudioClip.muted = !selectedAudioClip.muted;
      el.clipMute.textContent = selectedAudioClip.muted ? "Unmute" : "Mute";
      renderTimeline();
    });
    if (el.clipDup) el.clipDup.addEventListener("click", () => {
      if (selectedEventClip) {
        const src = selectedEventClip.ec, layer = selectedEventClip.layer;
        // Deep-copy params so the duplicate is independent
        const dup = { ...src, id: ++idSeq, params: { ...(src.params || {}) },
          start: clamp(src.start + src.duration + 0.05, 0, Math.max(0, layer.duration - src.duration)) };
        layer.clips.push(dup);
        selectEventClip(layer, dup); // select the new duplicate so user can edit it
      } else if (selectedAudioClip) {
        const src = selectedAudioClip;
        const dup = { ...src, id: ++idSeq, start: clamp(src.start + src.duration + 0.05, 0, Math.max(0, STATE.duration - src.duration)), selected: false };
        audioClips.push(dup);
      }
      renderTimeline(); renderEventButtons();
    });
    if (el.clipDel) el.clipDel.addEventListener("click", () => {
      if (selectedEventClip) {
        const layer = selectedEventClip.layer;
        const i = layer.clips.indexOf(selectedEventClip.ec); if (i >= 0) layer.clips.splice(i, 1);
        selectedEventClip = null;
      } else if (selectedAudioClip) {
        const i = audioClips.indexOf(selectedAudioClip); if (i >= 0) audioClips.splice(i, 1);
        selectedAudioClip = null;
      }
      renderClipInspector(); renderTimeline(); renderEventButtons(); paintIfPaused();
    });
    if (el.clipPreview) el.clipPreview.addEventListener("click", () => {
      // For an audio clip: play its buffer once.
      // For an event clip: seek playhead to just before the clip start
      // and play so the event fires visibly.
      if (selectedAudioClip) { const s = sounds.find((x) => x.id === selectedAudioClip.soundId); if (s) previewSound(s); return; }
      if (selectedEventClip) {
        const L = selectedEventClip.layer, ec = selectedEventClip.ec;
        STATE.time = Math.max(0, L.start + ec.start - 0.05);
        rafStart = performance.now() - STATE.time * 1000;
        updatePlayheads(STATE.time);
        startPlayback();
        toast(`Previewing ${ec.fxKey}`);
      }
    });

    // ---- Playhead scrubbing: ruler click, playhead grab, and drag.
    // Also arrow-key frame stepping.  A single seekTo() function is the
    // canonical way to move the timeline clock; every entry point
    // funnels through it so behavior is identical whether you grab the
    // playhead, click the ruler, drag, or use keyboard.
    function seekTo(t, opts) {
      opts = opts || {};
      t = clamp(t, 0, STATE.duration || 0);
      // Snap to frame if snapFrame is on AND caller didn't request raw.
      if (STATE.snapFrame && !opts.raw) {
        const fps = STATE.fps || 30;
        t = Math.round(t * fps) / fps;
      }
      STATE.time = t;
      // Keep the playback clock in sync so pressing Play resumes from
      // the current timeline position, not from where playback started.
      rafStart = performance.now() - t * 1000;
      updatePlayheads(t);
      if (STATE.playing) {
        stopAllAudioClipSources();
        schedulePlayback(t);
        if (audio.ready && audio.el) { try { audio.el.currentTime = t; } catch (err) {} }
        // Video layers: re-seek immediately (both WebCodecs + legacy).
        layers.forEach((L) => { if (L.kind === "VIDEO") syncOrPaintVideoLayer(L, t, true); });
      } else {
        paintIfPaused();
      }
    }

    // Shared drag state for ruler / playhead scrubbing.
    let scrub = null;   // { rulerRect, active: bool }
    function tFromClientX(clientX) {
      const rect = el.tlRuler.getBoundingClientRect();
      return clamp((clientX - rect.left) / TL.pxPerSec, 0, STATE.duration || 0);
    }
    function startScrub(e) {
      if (e.button !== 0) return;   // left-button only
      e.preventDefault();
      scrub = { active: true };
      // v19.37: mark all video layers as scrubbing so their sync uses
      // coalesced fastSeek instead of exact currentTime writes.  Enables
      // the "fastSeek during drag, accurate seek on release" pattern.
      SCRUB.active = true;
      if (el.tlPlayhead) el.tlPlayhead.classList.add("is-scrubbing");
      document.body.style.userSelect = "none";
      seekTo(tFromClientX(e.clientX));
      document.addEventListener("mousemove", onScrubMove);
      document.addEventListener("mouseup", endScrub);
    }
    function onScrubMove(e) {
      if (!scrub || !scrub.active) return;
      // Shift-drag = 10× finer (bypass snap AND scale the delta down).
      // For scrubbing this means the cursor moves 10× the distance to
      // move 1 frame — good for fine positioning.  We compute the base
      // position and then offset by the shifted delta.
      if (e.shiftKey) {
        // Convert current cursor position to time, then move by 1/10
        // of the delta from the last position.
        const now = tFromClientX(e.clientX);
        const prev = STATE.time;
        seekTo(prev + (now - prev) / 10, { raw: true });
      } else {
        seekTo(tFromClientX(e.clientX));
      }
    }
    function endScrub() {
      scrub = null;
      if (el.tlPlayhead) el.tlPlayhead.classList.remove("is-scrubbing");
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onScrubMove);
      document.removeEventListener("mouseup", endScrub);
      // v19.37: leave scrub mode → one accurate seek to land on the
      // exact final frame.  Clears any pending coalesced target.
      SCRUB.active = false;
      layers.forEach((L) => {
        if (L.kind !== "VIDEO") return;
        if (L._vidCoalesce) L._vidCoalesce.pending = null;
        // Force the sync path to re-request the frame at the exact
        // final time (not fastSeek).  paintIfPaused runs a fresh
        // syncOrPaintVideoLayer for every video layer.
        if (L._vidCoalesce) L._vidCoalesce.lastAppliedT = -1;
        // v19.39: also sync the native preview element to the final
        // timeline position (kept paused since we're back to paused
        // state, unless play is active).  Ensures the native pipeline
        // is at the right frame when play resumes.
        if (L._previewVideoEl && L._previewVideoEl.readyState >= 1) {
          const tSrc = sourceTimeAt(L, STATE.time);
          try { L._previewVideoEl.currentTime = tSrc; } catch (e) {}
        }
      });
      paintIfPaused();
    }
    // Ruler: mousedown starts a scrub, mousemove continues, mouseup ends.
    // Replaces the previous click-only handler.
    if (el.tlRuler) el.tlRuler.addEventListener("mousedown", startScrub);
    // Playhead disc: users can grab the visible disc directly.
    if (el.tlPlayhead) el.tlPlayhead.addEventListener("mousedown", startScrub);

    // resize -> refit + relayout timeline
    // ============ CANVAS DIRECT MANIPULATION ============
    // Users can drag layers directly on the artboard.  Selection also
    // works by clicking any layer's wrap element.  Locked / hidden layers
    // aren't draggable / selectable from the canvas.
    let dragL = null;
    function pickLayerAtEvent(e) {
      const rect = el.artboard.getBoundingClientRect();
      const ax = (e.clientX - rect.left) / STATE.zoom; // artboard px (from artboard top-left)
      const ay = (e.clientY - rect.top) / STATE.zoom;
      // top-most first (layers array = bottom to top, so iterate from end)
      for (let i = layers.length - 1; i >= 0; i--) {
        const L = layers[i];
        if (!L.visible || L.locked) continue;
        const A = STATE.format, T = L.transform;
        const wPx = (T.wPct / 100) * A.w, hPx = (T.hPct / 100) * A.h;
        const cxPx = A.w / 2 + (T.cx / 100) * A.w;
        const cyPx = A.h / 2 + (T.cy / 100) * A.h;
        // v19.4: rotation-aware hit testing.  Previously the hit box
        // was axis-aligned around the layer's bounding rect, which
        // failed for rotated content (lines with 90°/45° rotations
        // where the visible geometry doesn't overlap the axis-aligned
        // box).  Now we inverse-rotate the click point around the
        // layer center, then test against the unrotated box.
        let px = ax - cxPx, py = ay - cyPx;
        if (T.rot) {
          const a = -T.rot * Math.PI / 180;
          const ca = Math.cos(a), sa = Math.sin(a);
          const rx = px * ca - py * sa, ry = px * sa + py * ca;
          px = rx; py = ry;
        }
        // v19.4: expand hit box for SHAPE lines so thin lines aren't
        // impossible to click.  Standard vector-tool convention:
        // visible stroke stays as-is, hit area padded by ~14px.
        let hitW = wPx, hitH = hPx;
        if (L.kind === "SHAPE" && L.shapeType === "line") {
          hitH = Math.max(hitH, 16);
        }
        if (px >= -hitW / 2 && px <= hitW / 2 && py >= -hitH / 2 && py <= hitH / 2) return L;
      }
      return null;
    }
    /* v19.6 BOX SELECTION.
       When the user mousedowns on the artboard OUTSIDE any layer,
       start a marquee.  Drag = extend rectangle; mouseup = select all
       layers whose bounding boxes intersect it.
       Shift held during marquee = ADD to existing selection.
       No shift = REPLACE selection.

       Interaction outline:
         - mousedown on empty artboard → start marquee
         - mousedown on a layer → existing layer-drag path (below)
         - mousedown on canvas while text/shape tool active → tool
           handlers take precedence (they preventDefault first).
    */
    let boxSel = null;   // { x0, y0, x1, y1, previewEl, additive }
    function isToolActive() {
      return STATE.tool && STATE.tool !== "select";
    }
    function startBoxSelect(e) {
      const rect = el.artboard.getBoundingClientRect();
      const stageRect = el.stage.getBoundingClientRect();
      const previewEl = document.createElement("div");
      previewEl.className = "marquee-select";
      el.stage.appendChild(previewEl);
      boxSel = {
        // Store in artboard-space coords (px, unscaled).
        startX: (e.clientX - rect.left) / STATE.zoom,
        startY: (e.clientY - rect.top) / STATE.zoom,
        curX: 0, curY: 0,
        // For positioning the preview inside .stage:
        startClient: { x: e.clientX, y: e.clientY },
        stageOff: { left: stageRect.left, top: stageRect.top,
                    scrollLeft: el.stage.scrollLeft, scrollTop: el.stage.scrollTop },
        previewEl,
        additive: e.shiftKey || e.metaKey || e.ctrlKey,
      };
      boxSel.curX = boxSel.startX;
      boxSel.curY = boxSel.startY;
      // Initial marquee at 0×0
      previewEl.style.left = (e.clientX - stageRect.left + el.stage.scrollLeft) + "px";
      previewEl.style.top  = (e.clientY - stageRect.top  + el.stage.scrollTop) + "px";
      previewEl.style.width = "0px"; previewEl.style.height = "0px";
    }
    function onBoxSelectMove(e) {
      if (!boxSel) return;
      const dxPage = e.clientX - boxSel.startClient.x;
      const dyPage = e.clientY - boxSel.startClient.y;
      // Normalize so left/top always the smaller
      const left = dxPage < 0 ? boxSel.startClient.x + dxPage : boxSel.startClient.x;
      const top  = dyPage < 0 ? boxSel.startClient.y + dyPage : boxSel.startClient.y;
      boxSel.previewEl.style.left = (left - boxSel.stageOff.left + boxSel.stageOff.scrollLeft) + "px";
      boxSel.previewEl.style.top  = (top  - boxSel.stageOff.top  + boxSel.stageOff.scrollTop) + "px";
      boxSel.previewEl.style.width  = Math.abs(dxPage) + "px";
      boxSel.previewEl.style.height = Math.abs(dyPage) + "px";
      // Update artboard-space extent
      boxSel.curX = boxSel.startX + dxPage / STATE.zoom;
      boxSel.curY = boxSel.startY + dyPage / STATE.zoom;
    }
    function endBoxSelect() {
      if (!boxSel) return;
      const box = boxSel;
      boxSel = null;
      if (box.previewEl) box.previewEl.remove();
      // Compute selection box in artboard-space
      const x1 = Math.min(box.startX, box.curX);
      const x2 = Math.max(box.startX, box.curX);
      const y1 = Math.min(box.startY, box.curY);
      const y2 = Math.max(box.startY, box.curY);
      // Skip near-zero marquees (accidental clicks with tiny wobble).
      if ((x2 - x1) < 4 && (y2 - y1) < 4) return;
      // Find all layer bounding boxes that INTERSECT the marquee.
      // Uses axis-aligned test on the layer's untransformed box; for
      // rotated layers we test against the AABB of the rotated corners.
      const A = STATE.format;
      const hit = [];
      layers.forEach((L) => {
        if (!L.visible || L.locked) return;
        const T = L.transform;
        const wPx = (T.wPct / 100) * A.w, hPx = (T.hPct / 100) * A.h;
        const cxPx = A.w / 2 + (T.cx / 100) * A.w;
        const cyPx = A.h / 2 + (T.cy / 100) * A.h;
        let bx1, by1, bx2, by2;
        if (T.rot) {
          // Rotated: compute AABB from rotated corners
          const a = T.rot * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
          const hw = wPx / 2, hh = hPx / 2;
          const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([px, py]) => ({
            x: cxPx + px * ca - py * sa,
            y: cyPx + px * sa + py * ca,
          }));
          const xs = corners.map((c) => c.x), ys = corners.map((c) => c.y);
          bx1 = Math.min.apply(null, xs); by1 = Math.min.apply(null, ys);
          bx2 = Math.max.apply(null, xs); by2 = Math.max.apply(null, ys);
        } else {
          bx1 = cxPx - wPx / 2; by1 = cyPx - hPx / 2;
          bx2 = cxPx + wPx / 2; by2 = cyPx + hPx / 2;
        }
        // AABB intersection
        if (bx2 >= x1 && bx1 <= x2 && by2 >= y1 && by1 <= y2) hit.push(L);
      });
      if (!hit.length) {
        if (!box.additive) {
          // Clicking empty canvas clears selection.
          selectLayer(null);
        }
        return;
      }
      if (box.additive) {
        // Add each hit to existing selection (skip duplicates)
        hit.forEach((L) => {
          if (!selectedLayers.includes(L)) selectLayer(L, { append: true });
        });
      } else {
        // Replace selection with all hits.
        selectedLayer = hit[hit.length - 1];
        selectedLayers = hit.slice();
        renderLayers(); renderInspector(); renderTimeline(); updateSelectionBox();
        if (el.readoutSel) {
          el.readoutSel.textContent = hit.length === 1 ? hit[0].name : `${hit.length} layers selected`;
        }
      }
    }
    document.addEventListener("mousemove", onBoxSelectMove);
    document.addEventListener("mouseup",   endBoxSelect);

    el.artboard.addEventListener("mousedown", (e) => {
      // Ignore clicks on selection-box handles / other UI overlays
      if (e.target.closest(".sel-handle")) return;
      // Yield to active tool modes (text / shape).  Those handlers
      // register on el.stage and preventDefault, so we detect them by
      // checking STATE.tool.
      if (isToolActive()) return;
      const L = pickLayerAtEvent(e);
      if (!L) {
        // v19.6: empty-canvas mousedown starts a marquee.
        e.preventDefault();
        startBoxSelect(e);
        return;
      }
      // v19.4/v19.5: Shift/Cmd-click on the canvas toggles additive selection.
      // If the picked layer is NOT already in the selection, single-select it.
      // If it IS in the selection AND no modifier, keep the existing multi-
      // selection so the user can drag the whole group.
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      const inSelection = selectedLayers.includes(L);
      if (additive) {
        selectLayer(L, { additive: true });
      } else if (!inSelection) {
        selectLayer(L);
      }
      // v19.5: multi-move.  When multiple layers are selected, dragging any
      // one of them translates ALL of them by the same delta.  Snapshot
      // each layer's starting cx/cy so we can reset if the drag misses.
      const targets = (selectedLayers.length > 1 && selectedLayers.includes(L))
        ? selectedLayers.slice()
        : [L];
      dragL = {
        layers: targets,
        x0: e.clientX, y0: e.clientY,
        starts: targets.map((tl) => ({ cx: tl.transform.cx, cy: tl.transform.cy })),
      };
      el.artboard.style.cursor = "grabbing";
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragL) return;
      const A = STATE.format;
      const dxPct = ((e.clientX - dragL.x0) / STATE.zoom / A.w) * 100;
      const dyPct = ((e.clientY - dragL.y0) / STATE.zoom / A.h) * 100;
      dragL.layers.forEach((L, i) => {
        L.transform.cx = clamp(dragL.starts[i].cx + dxPct, -200, 200);
        L.transform.cy = clamp(dragL.starts[i].cy + dyPct, -200, 200);
      });
      // Reflect primary layer's coords in the transform sliders.
      const primary = selectedLayer || dragL.layers[0];
      if (primary) {
        setSlider("x", Math.round(primary.transform.cx));
        setSlider("y", Math.round(primary.transform.cy));
      }
      updateSelectionBox(); paintIfPaused();
    });
    document.addEventListener("mouseup", () => { if (dragL) { dragL = null; el.artboard.style.cursor = ""; } });

    // Arrow keys nudge the selected layer(s). 1 px, or 10 px with Shift.
    // v19.5: nudges every layer in selectedLayers so multi-select
    // works the same way as canvas drag.
    document.addEventListener("keydown", (e) => {
      if (!selectedLayers.length) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/i.test(e.target.tagName)) return;
      const A = STATE.format, step = e.shiftKey ? 10 : 1;
      let dx = 0, dy = 0;
      if (e.key === "ArrowLeft")       dx = -step;
      else if (e.key === "ArrowRight") dx = step;
      else if (e.key === "ArrowUp")    dy = -step;
      else if (e.key === "ArrowDown")  dy = step;
      else return;
      // Only nudge layers when NO clip is selected (arrow keys have
      // context-dependent meaning: clip-nudge > layer-nudge > playhead-nudge).
      if (selectedEventClip || selectedAudioClip) return;
      e.preventDefault();
      const dxPct = (dx / A.w) * 100, dyPct = (dy / A.h) * 100;
      selectedLayers.forEach((L) => {
        L.transform.cx += dxPct;
        L.transform.cy += dyPct;
      });
      const primary = selectedLayer || selectedLayers[0];
      if (primary) {
        setSlider("x", Math.round(primary.transform.cx));
        setSlider("y", Math.round(primary.transform.cy));
      }
      updateSelectionBox(); paintIfPaused();
    });

    // ============ ALIGNMENT WIRING ============
    const alignBind = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener("click", fn); };
    alignBind("alignLeft",  alignLeft);
    alignBind("alignCH",    alignCenterH);
    alignBind("alignRight", alignRight);
    alignBind("alignTop",   alignTop);
    alignBind("alignCV",    alignMiddle);
    alignBind("alignBottom",alignBottom);
    alignBind("alignDistH", distributeH);
    alignBind("alignDistV", distributeV);
    alignBind("alignCenter",centerToCanvas);
    alignBind("alignFit",   tfFit);
    alignBind("alignFill",  tfFill);

    // ============ SNAP-TO-FRAME TOGGLE ============
    const snapFrameEl = document.getElementById("snapFrame");
    if (snapFrameEl) snapFrameEl.addEventListener("change", (e) => { STATE.snapFrame = e.target.checked; });

    // ============ ENABLE / DISABLE CLIP TOGGLE ============
    const enBtn = document.getElementById("clipEnable");
    if (enBtn) enBtn.addEventListener("click", () => {
      if (!selectedEventClip) return;
      selectedEventClip.ec.enabled = !(selectedEventClip.ec.enabled !== false);
      renderClipInspector(); renderTimeline(); renderEventButtons(); paintIfPaused();
    });

    window.addEventListener("resize", () => { if (STATE.zoomMode === "fit") fitZoom(); renderTimeline(); });
  }
  function wireDurSeg(seg) {
    if (!seg) return;
    seg.querySelectorAll("[data-dur]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.dur === "custom") { const v = parseFloat(prompt("Custom duration in seconds:", String(STATE.duration)) || STATE.duration); if (v > 0) setDuration(Math.min(60, v)); }
      else setDuration(+b.dataset.dur);
    }));
  }

  /* ---------------- INIT ---------------- */
  function init() {
    buildPresets();
    buildControls();
    setBackground(STATE.bgMode, STATE.bgColor);
    setFormat(1080, 1080, "Post 1:1");
    setDuration(8);
    syncExportUI();
    renderSfxList();
    renderSfxSelect();
    renderClipInspector();
    renderTimeline();
    wire();
    requestAnimationFrame(frame);
    // re-fit once layout has settled (fonts, flex sizing)
    requestAnimationFrame(() => fitZoom());
    setTimeout(() => { fitZoom(); renderTimeline(); }, 120);
    // Test hook: expose internals for automated verification (harmless in production).
    window.__phaserDebug = Object.assign(window.__phaserDebug || {}, { drawExportFrame, rasterizeAll, activeEventClipsAt, EVENT_EFFECTS, evaluateLayerAtTime, FX_EVENTS, FX_EVENT_DEF, fxSupportsLayer, applyTextFxAtTime, applyWeirdSlicesOnText, TEXT_FX_STRING, TEXT_FX_DOM, getState: () => STATE, getLayers: () => layers, createEventClip, sourceTimeAt, initVideoLayersForExport, driveVideoLayersRealtime, finalizeVideoLayersAfterExport, paintWebCodecsLayersForExport, duplicateLayer, createTextLayerAt, createShapeLayerAt, paintIfPaused, analyzeSvgLayer, analyzeMorph, primitiveToCanonicalPath, runSvgRepair, collectSvgRepairOps, releaseClipPaths, removeMasks, convertShapesToPaths, audio: () => audio });
  }
  document.addEventListener("DOMContentLoaded", init);
})();
