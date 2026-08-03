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
    snapPlayhead: true, snapClipEdges: true,
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
    { key: "scanRevealEvent", label: "Scan Reveal",      defDur: 0.90, group: "core", placement: "layerStart" },
    { key: "coordBlinkEvt",   label: "Coordinate Blink", defDur: 0.30, group: "core" },
    { key: "dataBreakEvent",  label: "Data Break",       defDur: 0.18, group: "core" },
    { key: "pathEnergize",    label: "Path Energize",    defDur: 1.20, group: "core" },
    { key: "layerSwap",       label: "Layer Swap",       defDur: 0.10, group: "core" },
    { key: "textReplace",     label: "Text Replace",     defDur: 0.30, group: "core" },
    // --- REVEAL effects (migrated from FX_LIBRARY, default at layer start) ---
    { key: "blurIn",       label: "Blur In",           defDur: 0.80, group: "reveal",  placement: "layerStart", sustained: true },
    { key: "lineDraw",     label: "Line Draw",         defDur: 1.20, group: "reveal",  placement: "layerStart", sustained: true },
    { key: "trimPaths",    label: "Trim Paths",        defDur: 1.00, group: "reveal",  placement: "layerStart", sustained: true },
    { key: "symbolTrans",  label: "Symbol Transition", defDur: 0.50, group: "reveal",  sustained: true },
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
  ];
  const FX_EVENT_KEYS = new Set(FX_EVENTS.map((f) => f.key));
  // Lookup: key → definition (for placement / defDur / sustained flag)
  const FX_EVENT_DEF = new Map(FX_EVENTS.map((f) => [f.key, f]));
  const FX_EVENT_GROUPS = [
    { id: "reveal",    label: "Reveal" },
    { id: "sustained", label: "Sustained" },
    { id: "core",      label: "Core" },
    { id: "motion",    label: "Motion" },
    { id: "signal",    label: "Signal / Glitch" },
    { id: "overlay", label: "Overlay / HUD" },
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
      default: return { ...base };
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
    presetGrid: $("#presetGrid"), applyAll: $("#applyAll"),
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
    // video (Phase 2)
    videoGroup: $("#videoGroup"), videoDurLabel: $("#videoDurLabel"),
    vFitTrim: $("#vFitTrim"), vResetTrim: $("#vResetTrim"),
    // color
    colorEmpty: $("#colorEmpty"), colorBody: $("#colorBody"), colorNote: $("#colorNote"),
    fillColor: $("#fillColor"), fillHex: $("#fillHex"), strokeColor: $("#strokeColor"), strokeHex: $("#strokeHex"),
    colApplyFill: $("#colApplyFill"), colApplyStroke: $("#colApplyStroke"), colApplyAll: $("#colApplyAll"),
    colRestore: $("#colRestore"), colMono: $("#colMono"), colInvert: $("#colInvert"),
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
  const layers = [];   // index 0 = back
  let selectedLayer = null, idSeq = 0;

  function toast(msg) {
    if (!el.toast) return;
    el.toast.textContent = msg; el.toast.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(() => el.toast.classList.remove("show"), 2400);
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
      const idx = this._sampleByPts.get(frame.timestamp);
      if (idx === undefined) { try { frame.close(); } catch(e){} return; }
      const byteSize = (frame.allocationSize && frame.allocationSize()) || (this._width * this._height * 4);
      // Resolve pending BEFORE caching (so waiters get the frame even if cache
      // immediately evicts).  Cache also pins by "just-inserted head" position.
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
      } catch (e) { this._lastError = e; }
    }

    _resetDecoderForRewind() {
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
      return this._cache.get(idx);
    }

    getFrameAtSourceTime(tSource) {
      if (this._closed) return Promise.reject(new Error("VideoSource closed"));
      const idx = this._sampleIndexForTime(tSource);
      if (idx < 0) return Promise.reject(new Error("No samples"));
      const cached = this._cache.get(idx);
      if (cached) return Promise.resolve(cached);
      // Attach or create a pending resolver.
      const existing = this._pendingResolvers.get(idx);
      const promise = new Promise((resolve, reject) => {
        const entry = { resolve, reject };
        if (existing) existing.push(entry);
        else { this._pendingResolvers.set(idx, [entry]); }
      });
      if (!existing) {
        // We haven't started waiting for this idx yet — kick off decode.
        this._triggerDecodeTo(idx);
        // Safety timeout so the promise can't hang forever if the decoder wedges.
        setTimeout(() => {
          const rs = this._pendingResolvers.get(idx);
          if (rs) { this._pendingResolvers.delete(idx); for (const r of rs) r.reject(new Error("decode timeout")); }
        }, 2000);
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
    // v19.1: update all tool-strip buttons.  Select vs Text vs future.
    if (el.toolSelect) el.toolSelect.classList.toggle("is-active", STATE.tool === "select");
    if (el.toolText)   el.toolText.classList.toggle("is-active", STATE.tool === "text");
    // Update stage cursor
    if (el.stage) el.stage.classList.toggle("tool-text-active", STATE.tool === "text");
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
    // Path B: release the decoder + close all cached VideoFrames.
    // Without this, GPU memory leaks with every deleted video layer.
    if (layer.videoSource) { try { layer.videoSource.close(); } catch (e) {} layer.videoSource = null; }
    // S2: drop the export-resolution canvas reference so GC can reclaim.
    if (layer._exportCanvas) layer._exportCanvas = null;
    if (layer.wrap && layer.wrap.parentNode) layer.wrap.parentNode.removeChild(layer.wrap);
    layers.splice(i, 1);
    if (selectedLayer === layer) selectedLayer = null;
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
      li.className = "layer-row" + (layer === selectedLayer ? " selected" : "") + (layer.visible ? "" : " hidden-layer") + (layer.locked ? " locked-layer" : "");
      li.draggable = true; li.dataset.id = layer.id;
      const thumb = layer.kind === "IMG" ? `<img src="${layer.node.src}" alt="">` : svgThumb(layer.node);
      li.innerHTML =
        `<span class="layer-drag" title="Drag to reorder"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="4" cy="3" r="1" fill="currentColor"/><circle cx="8" cy="3" r="1" fill="currentColor"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="8" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="9" r="1" fill="currentColor"/><circle cx="8" cy="9" r="1" fill="currentColor"/></svg></span>` +
        `<span class="layer-thumb">${thumb}</span>` +
        `<span class="layer-meta"><span class="layer-title">${layer.name}</span><span class="layer-sub">${layer.kind}${layer.subLayers && layer.subLayers.length ? " \u00b7 " + layer.subLayers.length + " parts" : ""}</span></span>` +
        `<button class="layer-eye" title="Hide / show">${layer.visible ? eyeOpen() : eyeClosed()}</button>`;
      li.addEventListener("click", (e) => { if (e.target.closest(".layer-eye")) { toggleLayerVisible(layer); e.stopPropagation(); } else selectLayer(layer); });
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
  }
  function applyZOrder() { layers.forEach((layer, i) => { if (layer.wrap) layer.wrap.style.zIndex = String(i + 1); }); }

  function selectLayer(layer) {
    selectedLayer = layer;
    renderLayers(); renderInspector(); renderTimeline(); updateSelectionBox();
    el.readoutSel.textContent = layer ? layer.name : "No layer selected";
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
    const isSvg = has && selectedLayer.kind === "SVG";
    const isVideo = has && selectedLayer.kind === "VIDEO";
    const isText = has && selectedLayer.kind === "TEXT";
    el.colorEmpty.hidden = isSvg; el.colorBody.hidden = !isSvg;
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
      FX_EVENT_GROUPS.forEach((grp) => {
        const events = FX_EVENTS.filter((e) => e.group === grp.id);
        if (!events.length) return;
        const hd = document.createElement("div");
        hd.className = "fx-event-group-hd"; hd.textContent = grp.label;
        el.fxEventGrid.appendChild(hd);
        const wrap = document.createElement("div"); wrap.className = "fx-event-grid-inner";
        events.forEach((fx) => {
          const b = document.createElement("button");
          b.className = "fx-event";
          b.dataset.eventKey = fx.key;
          b.innerHTML = `<span class="fx-dot"></span>${fx.label}`;
          b.title = `Toggle a ${fx.label} clip on the selected layer at the playhead. Click again to disable / enable it.`;
          b.addEventListener("click", () => toggleEventClipOnLayer(fx.key, fx.label));
          wrap.appendChild(b);
        });
        el.fxEventGrid.appendChild(wrap);
      });
    }
    // Update visual state to reflect existing clips on the selected layer
    renderEventButtons();
    if (isSvg) { el.colorNote.hidden = !selectedLayer.complex; }
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
      let hasEnabled = false, hasAny = false, isSel = false;
      if (selectedLayer && selectedLayer.clips) {
        for (const c of selectedLayer.clips) {
          if (c.fxKey !== key) continue;
          hasAny = true;
          if (c.enabled !== false) hasEnabled = true;
          if (selectedEventClip && selectedEventClip.layer === selectedLayer && selectedEventClip.ec === c) isSel = true;
        }
      }
      btn.classList.toggle("is-active",   hasEnabled);
      btn.classList.toggle("is-disabled", hasAny && !hasEnabled);
      btn.classList.toggle("is-selected", isSel);
    });
  }

  /* Click behaviour for an Event Clip button:
     - No layer selected → toast a hint.
     - No clip of this type on layer → create a new one at the playhead.
     - Existing clip(s) of this type → toggle enabled/disabled on the
       most-relevant one (selected clip of that type if any; otherwise the
       clip closest to the current playhead).
     Never blindly creates duplicates. */
  function toggleEventClipOnLayer(fxKey, label) {
    if (!selectedLayer) { toast("Select a layer first"); return; }
    const layer = selectedLayer;
    const candidates = (layer.clips || []).filter((c) => c.fxKey === fxKey);
    let target = null;
    if (candidates.length) {
      // Prefer the currently-selected clip if it matches
      if (selectedEventClip && selectedEventClip.layer === layer && candidates.includes(selectedEventClip.ec)) {
        target = selectedEventClip.ec;
      } else {
        // Otherwise pick the clip whose midpoint is closest to the playhead
        const pt = STATE.time - layer.start;
        target = candidates.reduce((best, c) => {
          const dc = Math.abs((c.start + c.duration / 2) - pt);
          if (!best) return c;
          const db = Math.abs((best.start + best.duration / 2) - pt);
          return dc < db ? c : best;
        }, null);
      }
    }
    if (target) {
      target.enabled = target.enabled === false ? true : false;
      toast(`${label} ${target.enabled ? "enabled" : "disabled"}`);
      // If we disabled it, keep selection; if we re-enabled it while
      // paused, refresh the preview.
      renderTimeline(); renderEventButtons(); renderClipInspector(); paintIfPaused();
      return;
    }
    // No existing clip → create a fresh one
    const c = createEventClip(fxKey, layer);
    if (c) {
      toast(`+ ${label} @ ${(layer.start + c.start).toFixed(2)}s`);
      selectEventClip(layer, c);
      startPlayback();
    }
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
  function applyFill(color) { if (!selSvg()) return; selectedLayer.node.querySelectorAll(COLOR_TARGET).forEach((n) => { const f = n.getAttribute("fill"); if (f !== "none") { n.setAttribute("fill", color); n.style.fill = color; } }); }
  function applyStroke(color) { if (!selSvg()) return; selectedLayer.node.querySelectorAll(COLOR_TARGET).forEach((n) => { const s = n.getAttribute("stroke"); if (s && s !== "none") { n.setAttribute("stroke", color); n.style.stroke = color; } }); }
  function applyAllPaths(color) { if (!selSvg()) return; selectedLayer.node.querySelectorAll(COLOR_TARGET).forEach((n) => { n.setAttribute("fill", color); n.style.fill = color; }); }
  function applyStrokeWidth(mult) { if (!selSvg()) return; selectedLayer.originalColors.forEach((o) => { if (o.sw != null) { const base = parseFloat(o.sw) || 1; o.n.setAttribute("stroke-width", (base * mult).toFixed(2)); } }); }
  function restoreColors() { if (!selSvg()) return; selectedLayer.originalColors.forEach((o) => { setOrRemove(o.n, "fill", o.fill); setOrRemove(o.n, "stroke", o.stroke); setOrRemove(o.n, "stroke-width", o.sw); o.n.style.fill = o.styleFill || ""; o.n.style.stroke = o.styleStroke || ""; }); toast("Original colors restored"); }
  function monochrome() { if (!selSvg()) return; const c = el.fillColor.value; selectedLayer.node.querySelectorAll(COLOR_TARGET).forEach((n) => { const f = n.getAttribute("fill"); const s = n.getAttribute("stroke"); if (f && f !== "none") { n.setAttribute("fill", c); n.style.fill = c; } if (s && s !== "none") { n.setAttribute("stroke", c); n.style.stroke = c; } }); toast("Monochrome applied"); }
  function invertColors() { if (!selSvg()) return; selectedLayer.node.querySelectorAll(COLOR_TARGET).forEach((n) => { ["fill", "stroke"].forEach((attr) => { const v = n.getAttribute(attr); const inv = invertHex(v); if (inv) { n.setAttribute(attr, inv); n.style[attr] = inv; } }); }); toast("Colors inverted"); }
  function selSvg() { return selectedLayer && selectedLayer.kind === "SVG"; }
  function setOrRemove(n, attr, val) { if (val == null) n.removeAttribute(attr); else n.setAttribute(attr, val); }
  function invertHex(v) { if (!v || v === "none") return null; const m = v.match(/^#?([0-9a-f]{6})$/i); if (!m) return null; const num = parseInt(m[1], 16); const inv = (0xFFFFFF - num).toString(16).padStart(6, "0"); return "#" + inv; }

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
    // Major ticks every second — always visible with the second label.
    for (let s = 0; s <= STATE.duration; s++) { const tick = document.createElement("div"); tick.className = "tl-tick"; tick.style.left = (s * TL.pxPerSec) + "px"; tick.textContent = s + "s"; el.tlRuler.appendChild(tick); }
    // Minor ticks: half-second marks appear when a second is wide
    // enough to fit them; frame marks appear when frames are wide
    // enough to distinguish visually.  Prevents visual clutter at
    // low zoom while surfacing frame boundaries at high zoom.
    const fps = STATE.fps || 30;
    const pxPerFrame = TL.pxPerSec / fps;
    if (TL.pxPerSec >= 140) {
      // Show half-second minor ticks
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
  // Compute the effective time delta from a mousemove.  When the Shift
  // key is held, the delta is scaled by 10 so users get precise
  // sub-frame nudging.  Both drag handlers use this so behavior is
  // consistent across layer clips, event clips, and audio clips.
  function tlDeltaFromEvent(e, startX) {
    const rawDx = (e.clientX - startX) / TL.pxPerSec;
    return e.shiftKey ? rawDx / 10 : rawDx;
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
    if (!e.shiftKey) {
      // v18.8 magnetic snap.  Layer times are absolute; excludeClip
      // is the layer itself so we don't self-snap its opposite edge.
      if (TL.mode === "move" || TL.mode === "trim-left") {
        layer.start = applyMagneticSnap(layer.start, layer);
        if (TL.mode === "trim-left") {
          const endHeld = o.start + o.duration;
          layer.duration = Math.max(0.2, endHeld - layer.start);
        }
      }
      if (TL.mode === "trim-right") {
        const endSnapped = applyMagneticSnap(layer.start + layer.duration, layer);
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
    if (!e.shiftKey) {
      // v18.8: magnetic snap to playhead + other clip edges.  Runs in
      // absolute scene time; event clip times are stored layer-local.
      if (D.mode === "move" || D.mode === "trim-left") {
        const abs = D.layer.start + D.ec.start;
        const snapped = applyMagneticSnap(abs, D.ec);
        D.ec.start = snapped - D.layer.start;
        if (D.mode === "trim-left") {
          const endHeld = D.orig.start + D.orig.duration;
          D.ec.duration = Math.max(0.02, endHeld - D.ec.start);
        }
      }
      if (D.mode === "trim-right") {
        const endAbs = D.layer.start + D.ec.start + D.ec.duration;
        const snapped = applyMagneticSnap(endAbs, D.ec);
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
    if (!e.shiftKey) {
      // v18.8: magnetic snap.  Audio clip times are absolute.
      if (D.mode === "move" || D.mode === "trim-left") {
        const snapped = applyMagneticSnap(D.ac.start, D.ac);
        D.ac.start = snapped;
        if (D.mode === "trim-left") {
          const endHeld = D.orig.start + D.orig.duration;
          D.ac.duration = Math.max(0.05, endHeld - D.ac.start);
        }
      }
      if (D.mode === "trim-right") {
        const endAbs = D.ac.start + D.ac.duration;
        const snapped = applyMagneticSnap(endAbs, D.ac);
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
    if (!el.clipEmpty || !el.clipBody) return;
    el.clipEmpty.hidden = hasAny; el.clipBody.hidden = !hasAny;
    // Params rows visibility
    const paramsHost = document.getElementById("clipParams");
    if (paramsHost) paramsHost.innerHTML = "";
    // Enable-toggle button label
    const enBtn = document.getElementById("clipEnable");
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
  function applyMagneticSnap(t, excludeClip) {
    // Convert pixel tolerance to seconds at current zoom.
    const tol = MAGNETIC_SNAP_PX / (TL.pxPerSec || 1);
    // Frame snap first (integer pixel-grid).
    if (STATE.snapFrame) t = snapTimeToFrame(t);
    let bestTarget = null, bestDist = tol;
    // Collect all snap targets in scene time.
    const targets = [];
    if (STATE.snapPlayhead) targets.push(STATE.time);
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
      const d = Math.abs(t - target);
      if (d < bestDist) { bestDist = d; bestTarget = target; }
    }
    // v18.8 visual feedback: brief snap flash on the playhead when a
    // magnetic snap actually fired.  Only shown when the snap target
    // is the playhead itself (most common case + most useful signal).
    if (bestTarget !== null && el.tlPlayhead && STATE.snapPlayhead
        && Math.abs(bestTarget - STATE.time) < 0.001) {
      el.tlPlayhead.classList.add("snap-hit");
      clearTimeout(el.tlPlayhead._snapClear);
      el.tlPlayhead._snapClear = setTimeout(() => {
        el.tlPlayhead.classList.remove("snap-hit");
      }, 120);
    }
    return bestTarget !== null ? bestTarget : t;
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
  };

  /* ============================================================ EVENT EFFECTS
     Short timeline events. Each takes `p` = progress (0..1) inside the
     clip. They return the same delta shape as EFFECTS. Applied only when
     the playhead is within the event clip.
     ============================================================ */
  const EVENT_EFFECTS = {
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
  };

  // For each event key, which live layer field it modifies (used to
  // reset state cleanly when the event ends).
  function activeEventClipsAt(layer, t) {
    if (!layer.clips || !layer.clips.length) return [];
    const layerStart = layer.start;
    return layer.clips.filter((c) => {
      if (c.enabled === false) return false; // disabled clip: still visible on timeline, no effect
      const s = layerStart + c.start, e = s + c.duration;
      return t >= s && t <= e;
    }).map((c) => ({ c, p: clamp01((t - (layerStart + c.start)) / Math.max(0.001, c.duration)) }));
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
  function syncVideoLayerToTimeline(layer, t, playing) {
    const v = layer.videoEl;
    if (!v || v.readyState < 2) return;   // metadata not decoded yet
    const active = layer.visible && t >= layer.start - 0.001 && t <= layer.start + layer.duration + 0.001;
    if (!active) { if (!v.paused) { try { v.pause(); } catch (e) {} } return; }
    const desired = sourceTimeAt(layer, t);
    const drift   = Math.abs(v.currentTime - desired);
    if (drift > VIDEO_DRIFT_TOL) {
      try { v.currentTime = desired; } catch (e) {}
    }
    if (playing) {
      if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
    } else {
      if (!v.paused) { try { v.pause(); } catch (e) {} }
    }
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
    if (!active) return;   // opacity will be zeroed by composeLayer; canvas retains last drawn frame
    const tSource = sourceTimeAt(layer, t);
    const frame = layer.videoSource.getFrameSyncIfCached(tSource);
    if (frame) {
      try {
        const ctx = layer.node.getContext("2d");
        ctx.drawImage(frame, 0, 0, layer.node.width, layer.node.height);
      } catch (e) {}
    } else {
      // Kick off async decode; result lands in the cache and gets drawn on a subsequent RAF.
      layer.videoSource.getFrameAtSourceTime(tSource).then((f) => {
        if (!layer.node || !layer.node.getContext) return;
        try {
          const ctx = layer.node.getContext("2d");
          ctx.drawImage(f, 0, 0, layer.node.width, layer.node.height);
        } catch (e) {}
      }).catch(() => {});
    }
    // Speculative prefetch — keeps a rolling window of ~15 frames warm.
    // Harmless if the target is beyond the trim range (out-of-bounds request just fails).
    const ahead = tSource + 0.5;
    if (ahead < (layer.srcOutPoint || layer.videoDuration || 0)) {
      layer.videoSource.getFrameAtSourceTime(ahead).catch(() => {});
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
      if (L.kind !== "VIDEO" || !L.videoEl) return;
      try { L.videoEl.pause(); } catch (e) {}
      try { L.videoEl.currentTime = L.srcInPoint || 0; } catch (e) {}
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
  async function paintWebCodecsLayersForExport(t) {
    const vids = layers.filter((L) => L.kind === "VIDEO" && L.videoSource && L.visible);
    if (!vids.length) return;
    await Promise.all(vids.map(async (L) => {
      const inWindow = t >= L.start - 0.001 && t <= L.start + L.duration + 0.001;
      if (!inWindow) return;
      // S2 — export uses a SEPARATE full-source-resolution canvas, so
      // the preview-quality cap on L.node doesn't degrade the export.
      // Lazily allocate the export canvas the first time we need it.
      if (!L._exportCanvas || L._exportCanvas.width !== L.natW || L._exportCanvas.height !== L.natH) {
        L._exportCanvas = document.createElement("canvas");
        L._exportCanvas.width  = L.natW;
        L._exportCanvas.height = L.natH;
      }
      const tSource = sourceTimeAt(L, t);
      // Fast path: sync cache hit.
      let frame = L.videoSource.getFrameSyncIfCached(tSource);
      if (!frame) {
        try { frame = await L.videoSource.getFrameAtSourceTime(tSource); }
        catch (e) { return; }
      }
      try {
        const ctx = L._exportCanvas.getContext("2d");
        ctx.drawImage(frame, 0, 0, L._exportCanvas.width, L._exportCanvas.height);
      } catch (e) {}
      // Prefetch a rolling window ahead of the current position so
      // subsequent iterations hit the sync cache path.
      const ahead = tSource + 0.5;
      const srcOut = L.srcOutPoint || L.videoDuration || 0;
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
    if (def && def.sustained) {
      const mod = EFFECTS[clip.fxKey]; if (!mod) return null;
      const clipLocal = sceneTime - (layer.start + clip.start);
      return mod(sig, clipLocal) || null;
    }
    const mod = EVENT_EFFECTS[clip.fxKey]; if (!mod) return null;
    return mod(p, sig, clip.params) || null;
  }

  function composeLayer(layer, t, sig, sceneTime) {
    const T = layer.transform;
    // static base transform (position/size/rotation set by user)
    let tx = 0, ty = 0, extraScale = 1, rot = 0, rotX = 0, rotY = 0, skew = 0;
    let opacity = T.opacity / 100, blur = 0, rgb = 0, glow = 0;
    let hud = false, hudFlicker = 1, flash = null, flashA = 0, scanBoost = 0, breakup = 0;
    let pathDraw = null, pathTrim = null;
    let radarBar = null, scanMask = null, freeze = false;
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

    // SVG stroke-dash animation for Line Draw / Trim Paths / Path Energize
    if (layer.kind === "SVG" && (pathDraw !== null || pathTrim !== null)) applyPathDash(layer, pathDraw, pathTrim);
    else if (layer.kind === "SVG" && layer._dashApplied) clearPathDash(layer);

    // Scan mask (event-only): reveal from left as p goes 0->1
    if (scanMask !== null) { layer.wrap.style.clipPath = `inset(0 ${((1 - scanMask) * 100).toFixed(1)}% 0 0)`; layer._clipApplied = true; }
    else if (layer._clipApplied) { layer.wrap.style.clipPath = ""; layer._clipApplied = false; }

    // Frame Hold: skip transform update, keep whatever was on screen
    if (freeze) return { hud, hudFlicker, flash, flashA, scanBoost, breakup, radarBar };

    // artboard-space placement: size in %, center offset in %
    const A = STATE.format;
    const wPx = (T.wPct / 100) * A.w * extraScale, hPx = (T.hPct / 100) * A.h * extraScale;
    const cxPx = (T.cx / 100) * A.w + (allowT ? (tx / 100) * A.w : 0);
    const cyPx = (T.cy / 100) * A.h + (allowT ? (ty / 100) * A.h : 0);
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
    if (layer.kind === "SVG" && layer._dashApplied) clearPathDash(layer);
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
    // If there's a layer that has an event clip active at the current
    // playhead, paint an animated frame so event params visibly affect
    // the preview. Otherwise fall back to the plain static frame.
    const t = STATE.time;
    const hasActiveEvent = layers.some((L) => activeEventClipsAt(L, t).length > 0);
    if (hasActiveEvent) renderOneAnimatedFrame();
    else renderStaticFrame();
  }

  // Line Draw / Trim Paths: animate stroke-dasharray/offset on SVG strokes.
  function pathStrokes(layer) {
    if (!layer._strokes) {
      layer._strokes = Array.from(layer.node.querySelectorAll("path, line, polyline, polygon, circle, ellipse, rect")).map((n) => {
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
    Object.entries(p.patch).forEach(([k, v]) => { if (k in STATE) STATE[k] = v; });
    syncControls();
    const targets = (toAll || !selectedLayer) ? layers : [selectedLayer];
    if (!targets.length) { toast("Add a layer first"); return; }
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
        createEventClip(fxKey, layer);
      });
      // presets never force transform motion on; keep it as the user set it
      if (p.stagger && targets.length > 1) { layer.recipe = makeRecipe((layer.id * 131 + i * 997) >>> 0); layer.start = Math.min(STATE.duration * 0.5, i * 0.25); }
      else if (targets.length > 1) { layer.recipe = makeRecipe((layer.id * 131 + i * 331) >>> 0); }
    });
    $$(".preset").forEach((c) => c.classList.toggle("active", c.textContent.trim() === name));
    renderTimeline(); renderInspector();
    startPlayback();
    toast(targets.length > 1 ? `Applied ${name} to ${targets.length} layers` : `Applied ${name}`);
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
    // SVG / TEXT / SVG-with-sublayers: rasterize + cache.
    const cached = _pixelSweepRasterCache.get(layer.id);
    if (cached && cached.canvas && cached.loaded) return cached.canvas;
    // If a rasterization is in-flight, return the (possibly blank)
    // canvas that will be populated by the async decode.  Avoid
    // spinning up a second one for the same layer.
    if (cached && cached.canvas) return cached.canvas;

    const w = layer.natW || 512, h = layer.natH || 512;
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    const entry = { canvas: c, version: 1, loaded: false };
    _pixelSweepRasterCache.set(layer.id, entry);
    // Rasterize the SVG via serialize → Blob URL → Image → drawImage.
    try {
      const svgStr = new XMLSerializer().serializeToString(layer.node);
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
      // ---- SVG rasterization ----
      // v18.3 SHARPNESS FIX: previously we returned an
      // HTMLImageElement from a Blob URL.  For SVGs with only a
      // viewBox (no explicit width/height attributes), the browser
      // defaults naturalWidth to 150 — so drawImage(img@150, ..., dw)
      // at export destinations like 1080 or 2160 becomes a 7×-14×
      // BITMAP upscale.  Thin wireframe strokes vanish.
      //
      // Now we rasterize into a canvas at the LARGER of:
      //   - the target export dimensions (typically artboard size)
      //   - 2× the SVG's declared natW/natH (so preview also gets
      //     high-quality rasterization when no target is passed)
      // capped at 4096 to avoid GPU/VRAM limits on extreme resolutions.
      // Preserves aspect ratio.  The resulting canvas is a proper
      // bitmap CanvasImageSource; downstream drawImage calls will
      // downsample crisply instead of upsampling from a low-res
      // browser-default bitmap.
      const natW = layer.natW || 400;
      const natH = layer.natH || 400;
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

      const svgStr = new XMLSerializer().serializeToString(layer.node);
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
      const cxPx = (T.cx / 100) * A.w + (allowT ? (s.tx / 100) * A.w : 0);
      const cyPx = (T.cy / 100) * A.h + (allowT ? (s.ty / 100) * A.h : 0);
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
    const scanTotal = clamp01(STATE.scanline / 100 + (drawList.some((l) => l.fx.length || l.clips.length) ? 0 : 0));
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
    for (let f = 0; f < total; f++) { await seekAllVideoLayersTo(f / fps); await paintWebCodecsLayersForExport(f / fps); await drawExportFrame(ctx, W, H, imgs, f / fps, { bg }, crop); await new Promise((res) => c.toBlob((b) => { downloadBlob(b, `phaser-seq-${String(f).padStart(4, "0")}.png`); setTimeout(res, 55); }, "image/png")); if (f % 10 === 0) setExportStatus(`Rendering frame ${f + 1}/${total}…`, "work"); }
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
      if ((e.key === "Delete" || e.key === "Backspace") && selectedLayer && !typing) deleteLayer(selectedLayer);
    });

    // AI
    el.aiRun.addEventListener("click", runAI);
    el.aiPrompt.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runAI(); });

    // presets
    el.applyAll.addEventListener("click", applyMotionAll);

    // transform sliders + buttons
    bindTransform();
    el.tfCenter.addEventListener("click", tfCenter);
    el.tfFit.addEventListener("click", tfFit);
    el.tfFill.addEventListener("click", tfFill);
    el.tfReset.addEventListener("click", tfReset);
    if (el.tfOriginal) el.tfOriginal.addEventListener("click", tfOriginal);
    el.layerDup.addEventListener("click", () => selectedLayer && duplicateLayer(selectedLayer));
    el.layerDel.addEventListener("click", () => selectedLayer && deleteLayer(selectedLayer));
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

    // color
    el.fillColor.addEventListener("input", (e) => { el.fillHex.textContent = e.target.value.toUpperCase(); });
    el.strokeColor.addEventListener("input", (e) => { el.strokeHex.textContent = e.target.value.toUpperCase(); });
    el.colApplyFill.addEventListener("click", () => { applyFill(el.fillColor.value); toast("Fill applied"); });
    el.colApplyStroke.addEventListener("click", () => { applyStroke(el.strokeColor.value); toast("Stroke applied"); });
    el.colApplyAll.addEventListener("click", () => { applyAllPaths(el.fillColor.value); toast("Applied to all paths"); });
    el.colRestore.addEventListener("click", restoreColors);
    el.colMono.addEventListener("click", monochrome);
    el.colInvert.addEventListener("click", invertColors);
    const sw = document.getElementById("ctl-sw");
    if (sw) sw.addEventListener("input", (e) => { setSlider("sw", +e.target.value); applyStrokeWidth(+e.target.value / 100); });

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
    if (el.markerBtn) el.markerBtn.addEventListener("click", () => {
      const t = STATE.time;
      const exists = markers.find((m) => m.type === "manual" && Math.abs(m.time - t) < 0.05);
      if (exists) { markers.splice(markers.indexOf(exists), 1); toast("Marker removed"); }
      else { markers.push({ type: "manual", time: t }); toast(`Marker @ ${t.toFixed(2)}s`); }
      renderTimeline();
    });

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
        if (clipCtx) {
          // Nudge or trim the selected clip.
          const ec = selectedEventClip ? selectedEventClip.ec : selectedAudioClip;
          const layer = selectedEventClip ? selectedEventClip.layer : null;
          const layerDur = layer ? layer.duration : STATE.duration;
          if (e.altKey) {
            // Trim end (right edge): grow/shrink by ±step.
            const newDur = clamp(ec.duration + dir * secStep, MIN_CLIP_DUR,
              Math.max(MIN_CLIP_DUR, layerDur - ec.start));
            ec.duration = Math.round(newDur * fps) / fps;
          } else {
            // Move clip.
            const maxStart = Math.max(0, layerDur - ec.duration);
            const newStart = clamp(ec.start + dir * secStep, 0, maxStart);
            ec.start = Math.round(newStart * fps) / fps;
          }
          renderTimeline(); renderClipInspector(); paintIfPaused();
        } else {
          // No clip selected → playhead nudge.
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
    function commitClipTime(kind, secValue) {
      const fps = STATE.fps || 30;
      if (secValue == null || isNaN(secValue)) return;
      if (selectedEventClip) {
        const L = selectedEventClip.layer, ec = selectedEventClip.ec;
        if (kind === "start") {
          // secValue is ABSOLUTE scene time (matches display).  Convert to
          // layer-local and clamp so clip fits.
          const local = clamp(secValue - L.start, 0, Math.max(0, L.duration - ec.duration));
          ec.start = STATE.snapFrame ? Math.round(local * fps) / fps : local;
        } else if (kind === "end") {
          const endLocal = clamp(secValue - L.start, ec.start + MIN_CLIP_DUR, L.duration);
          const snappedEnd = STATE.snapFrame ? Math.round(endLocal * fps) / fps : endLocal;
          ec.duration = Math.max(MIN_CLIP_DUR, snappedEnd - ec.start);
        } else if (kind === "duration") {
          const dur = clamp(secValue, MIN_CLIP_DUR, Math.max(MIN_CLIP_DUR, L.duration - ec.start));
          ec.duration = STATE.snapFrame ? Math.round(dur * fps) / fps : dur;
        }
      } else if (selectedAudioClip) {
        const ac = selectedAudioClip;
        if (kind === "start") {
          ac.start = clamp(secValue, 0, Math.max(0, STATE.duration - ac.duration));
          if (STATE.snapFrame) ac.start = Math.round(ac.start * fps) / fps;
        } else if (kind === "end") {
          const end = clamp(secValue, ac.start + MIN_CLIP_DUR, STATE.duration);
          const snappedEnd = STATE.snapFrame ? Math.round(end * fps) / fps : end;
          ac.duration = Math.max(MIN_CLIP_DUR, snappedEnd - ac.start);
        } else if (kind === "duration") {
          ac.duration = clamp(secValue, MIN_CLIP_DUR, Math.max(MIN_CLIP_DUR, STATE.duration - ac.start));
          if (STATE.snapFrame) ac.duration = Math.round(ac.duration * fps) / fps;
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
      };
      n.addEventListener("input", handler);
      n.addEventListener("blur", handler);
      n.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); handler(); n.blur(); } });
    };
    bindTimeField("num-ce",   "end",       false);
    bindTimeField("num-ce-f", "end",       true);
    bindTimeField("num-cs-f", "start",     true);
    bindTimeField("num-cd-f", "duration",  true);

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
        const leftPx = A.w / 2 + (T.cx / 100) * A.w - wPx / 2;
        const topPx = A.h / 2 + (T.cy / 100) * A.h - hPx / 2;
        if (ax >= leftPx && ax <= leftPx + wPx && ay >= topPx && ay <= topPx + hPx) return L;
      }
      return null;
    }
    el.artboard.addEventListener("mousedown", (e) => {
      // Ignore clicks on selection-box handles / other UI overlays
      if (e.target.closest(".sel-handle")) return;
      const L = pickLayerAtEvent(e); if (!L) return;
      selectLayer(L);
      dragL = { layer: L, x0: e.clientX, y0: e.clientY, cx0: L.transform.cx, cy0: L.transform.cy };
      el.artboard.style.cursor = "grabbing";
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragL) return;
      const A = STATE.format;
      const dxPx = (e.clientX - dragL.x0) / STATE.zoom;
      const dyPx = (e.clientY - dragL.y0) / STATE.zoom;
      dragL.layer.transform.cx = clamp(dragL.cx0 + (dxPx / A.w) * 100, -200, 200);
      dragL.layer.transform.cy = clamp(dragL.cy0 + (dyPx / A.h) * 100, -200, 200);
      setSlider("x", Math.round(dragL.layer.transform.cx));
      setSlider("y", Math.round(dragL.layer.transform.cy));
      updateSelectionBox(); paintIfPaused();
    });
    document.addEventListener("mouseup", () => { if (dragL) { dragL = null; el.artboard.style.cursor = ""; } });

    // Arrow keys nudge the selected layer (1 px, or 10 px with Shift).
    document.addEventListener("keydown", (e) => {
      if (!selectedLayer) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/i.test(e.target.tagName)) return;
      const A = STATE.format, step = e.shiftKey ? 10 : 1;
      let handled = true;
      if (e.key === "ArrowLeft")       selectedLayer.transform.cx -= (step / A.w) * 100;
      else if (e.key === "ArrowRight") selectedLayer.transform.cx += (step / A.w) * 100;
      else if (e.key === "ArrowUp")    selectedLayer.transform.cy -= (step / A.h) * 100;
      else if (e.key === "ArrowDown")  selectedLayer.transform.cy += (step / A.h) * 100;
      else handled = false;
      if (handled) {
        e.preventDefault();
        setSlider("x", Math.round(selectedLayer.transform.cx));
        setSlider("y", Math.round(selectedLayer.transform.cy));
        updateSelectionBox(); paintIfPaused();
      }
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
    window.__phaserDebug = { drawExportFrame, rasterizeAll, activeEventClipsAt, EVENT_EFFECTS, evaluateLayerAtTime, FX_EVENTS, getState: () => STATE, getLayers: () => layers, createEventClip, sourceTimeAt, initVideoLayersForExport, driveVideoLayersRealtime, finalizeVideoLayersAfterExport, duplicateLayer, createTextLayerAt };
  }
  document.addEventListener("DOMContentLoaded", init);
})();
