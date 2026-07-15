/* ============================================================
   PHASER — Motion Editor — script.js  (v2)
   Vanilla JS. No build step. GSAP optional (preset intros).

   WHAT CHANGED IN v2 (additive; nothing removed):
     • AUDIO ENGINE  multi-band (bass/mid/high) + RMS + peak +
                     transient + beat detection, all smoothed and
                     exposed through tunable sensitivity controls.
     • EFFECTS       modular EFFECTS library. Each module is a pure
                     function of (params, audio, time) -> visual deltas.
                     Applied to BOTH the live preview and the export
                     canvas so what you see is what you render.
     • BACKGROUND    black / white / transparent / custom / gradient.
                     Checkerboard is preview-only and never rendered
                     into transparent exports (real alpha).
     • EXPORT        PNG (opaque/transparent), PNG sequence
                     (opaque/transparent, selectable duration/fps),
                     WebM (fps + audio muxing + optional alpha),
                     and MP4 (ffmpeg.wasm architecture w/ a clearly
                     marked integration point + graceful fallback).
     • AI DIRECTOR   expanded rule set per the brief.

   Architecture:
     STATE        single source of truth for all params
     ASSETS       import + SVG parsing + asset cards + layers
     AUDIO        Web Audio API multi-band analysis
     EFFECTS      reusable effect modules (SVG/text/img)
     PRESETS      declarative param patches + render mode + fx recipe
     RENDER LOOP  requestAnimationFrame drives every effect
     AI PARSER    rule-based keywords -> STATE (swap for API later)
     CONTROLS     grouped sliders bound to STATE
     EXPORT       PNG / PNG-seq / WebM / MP4  (see EXPORT section)
   ============================================================ */

(() => {
  "use strict";

  /* ---------------- STATE ---------------- */
  const STATE = {
    // core motion
    speed: 50, glitch: 30, flicker: 25, scale: 30, rotation: 20,
    blur: 15, rgbSplit: 25, scanline: 40, noise: 20, audioReactivity: 60,

    // NEW: beat-sync engine controls (0..100 unless noted)
    beatSensitivity: 55,   // how easily peaks/beats trigger
    bassReaction: 70,      // bass -> scale pulse / shake / glow
    midReaction: 50,       // mid  -> flicker / rotation / layer move
    highReaction: 50,      // high -> scanline / noise / rgb / microglitch
    smoothing: 60,         // analyser + envelope smoothing
    peakThreshold: 60,     // transient detection threshold
    motionIntensity: 70,   // global multiplier for audio-driven motion
    syncTightness: 65,     // how snappy the reaction envelope decays
    audioReactive: true,   // master on/off

    // appearance / output
    bgMode: "custom",      // black | white | transparent | custom | gradient
    bgColor: "#0B0B0F",
    bgColor2: "#1A1030",   // gradient second stop
    format: { w: 1080, h: 1920, label: "9:16" },
    preset: null, playing: false, loop: true, exportScale: 1,

    // live audio runtime (smoothed 0..1), written by the audio engine
    audioLevel: 0, bassLevel: 0, midLevel: 0, highLevel: 0,
    beat: 0,               // decays after each detected beat
    peak: 0,               // decays after each transient
    buildup: 0,            // slow-moving energy accumulator (0..1)
  };

  // Controls split across the right-panel groups (existing + new).
  const CONTROL_GROUPS = {
    animation: [
      { key: "speed",    label: "Speed" },
      { key: "scale",    label: "Scale" },
      { key: "rotation", label: "Rotation" },
      { key: "flicker",  label: "Flicker" },
      { key: "audioReactivity", label: "Audio reactivity" },
    ],
    effects: [
      { key: "glitch",   label: "Glitch" },
      { key: "blur",     label: "Blur" },
      { key: "rgbSplit", label: "RGB split" },
      { key: "scanline", label: "Scanlines" },
      { key: "noise",    label: "Noise" },
    ],
    // NEW group injected into the right panel by JS (see buildControls)
    beatsync: [
      { key: "beatSensitivity", label: "Beat sensitivity" },
      { key: "bassReaction",    label: "Bass reaction" },
      { key: "midReaction",     label: "Mid reaction" },
      { key: "highReaction",    label: "High reaction" },
      { key: "smoothing",       label: "Smoothing" },
      { key: "peakThreshold",   label: "Peak threshold" },
      { key: "motionIntensity", label: "Motion intensity" },
      { key: "syncTightness",   label: "Sync tightness" },
    ],
  };

  /* ---------------- PRESETS ----------------
     Each preset keeps its original param patch + `mode`, and now also
     declares an `fx` recipe: the set of effect modules it activates,
     matching the brief's preset system. Effects read live params, so
     the recipe simply flips modules on and biases a few sliders. */
  const PRESETS = {
    "Ghost Hardware":   { mode: "ghost",    fx: ["rgbSplit","scanlineReveal","hud","microShake","glitchFlicker","noise","breathingGlow"], speed: 40, glitch: 20, flicker: 45, scale: 15, rotation: 8,  blur: 10, rgbSplit: 30, scanline: 55, noise: 30, bassReaction: 70 },
    "Glitch Pulse":     { mode: "glitch",   fx: ["glitchFlicker","rgbSplit","digitalNoise","microShake"], speed: 70, glitch: 85, flicker: 40, scale: 20, rotation: 5,  blur: 5,  rgbSplit: 70, scanline: 35, noise: 40 },
    "Signal Loss":      { mode: "signal",   fx: ["hardCut","digitalNoise","rgbSplit","glitchFlicker","scanlineReveal"], speed: 55, glitch: 60, flicker: 80, scale: 8,  rotation: 3,  blur: 25, rgbSplit: 50, scanline: 65, noise: 60 },
    "CRT Scanline":     { mode: "crt",      fx: ["scanlineReveal","digitalNoise","breathingGlow","glitchFlicker"], speed: 30, glitch: 15, flicker: 30, scale: 5,  rotation: 0,  blur: 8,  rgbSplit: 20, scanline: 90, noise: 25 },
    "Data Corruption":  { mode: "data",     fx: ["digitalNoise","glitchFlicker","rgbSplit","microShake","hardCut"], speed: 80, glitch: 95, flicker: 55, scale: 25, rotation: 12, blur: 6,  rgbSplit: 80, scanline: 40, noise: 70 },
    "Wireframe Reveal": { mode: "wireframe",fx: ["scanlineReveal","hud","blurIn"], speed: 45, glitch: 10, flicker: 15, scale: 35, rotation: 6,  blur: 4,  rgbSplit: 10, scanline: 25, noise: 10 },
    "Opacity Flicker":  { mode: "opacity",  fx: ["glitchFlicker"], speed: 60, glitch: 20, flicker: 90, scale: 5,  rotation: 0,  blur: 3,  rgbSplit: 15, scanline: 30, noise: 20 },
    "Bass Pulse":       { mode: "bass",     fx: ["breathingGlow","microShake","rgbSplit"], speed: 50, glitch: 25, flicker: 20, scale: 60, rotation: 5,  blur: 8,  rgbSplit: 30, scanline: 30, noise: 20, audioReactivity: 90, bassReaction: 90 },
    "Wave Distortion":  { mode: "wave",     fx: ["ripple","rgbSplit","scanlineReveal"], speed: 65, glitch: 40, flicker: 25, scale: 30, rotation: 15, blur: 20, rgbSplit: 45, scanline: 35, noise: 30 },
    "Rotation Drift":   { mode: "rotate",   fx: ["card3d","breathingGlow"], speed: 35, glitch: 10, flicker: 12, scale: 12, rotation: 70, blur: 6,  rgbSplit: 15, scanline: 20, noise: 12 },
    "Scale Pop":        { mode: "scalepop", fx: ["breathingGlow","microShake"], speed: 75, glitch: 15, flicker: 20, scale: 85, rotation: 8,  blur: 4,  rgbSplit: 20, scanline: 25, noise: 15 },
    "Layer Stagger":    { mode: "stagger",  fx: ["glitchFlicker","scanlineReveal","hud"], speed: 50, glitch: 20, flicker: 30, scale: 40, rotation: 10, blur: 5,  rgbSplit: 25, scanline: 30, noise: 18 },
    "Cyber Fade In":    { mode: "fade",     fx: ["blurIn","breathingGlow","hud"], speed: 40, glitch: 15, flicker: 20, scale: 30, rotation: 4,  blur: 12, rgbSplit: 20, scanline: 35, noise: 20 },
    "Microtype Scanner":{ mode: "scanner",  fx: ["scanlineReveal","hud","glitchFlicker"], speed: 55, glitch: 25, flicker: 35, scale: 10, rotation: 2,  blur: 6,  rgbSplit: 30, scanline: 70, noise: 25 },
    "Techno Poster":    { mode: "poster",   fx: ["hardCut","breathingGlow","rgbSplit","microShake"], speed: 60, glitch: 45, flicker: 30, scale: 45, rotation: 18, blur: 10, rgbSplit: 40, scanline: 40, noise: 30 },
    // NEW named presets from the brief (reuse modes, distinct recipes)
    "Terrain Scanner":  { mode: "scanner",  fx: ["scanlineReveal","hud","glitchFlicker","breathingGlow"], speed: 45, glitch: 20, flicker: 35, scale: 20, rotation: 4, blur: 6, rgbSplit: 25, scanline: 75, noise: 20, bassReaction: 75 },
    "Detroit Techno":   { mode: "poster",   fx: ["hardCut","glitchFlicker","breathingGlow"], speed: 65, glitch: 30, flicker: 40, scale: 55, rotation: 6, blur: 4, rgbSplit: 25, scanline: 30, noise: 15, bassReaction: 95, motionIntensity: 90 },
    "Clean Motion Poster": { mode: "fade",  fx: ["blurIn","breathingGlow"], speed: 35, glitch: 5, flicker: 10, scale: 35, rotation: 4, blur: 14, rgbSplit: 8, scanline: 12, noise: 6 },
    "CRT Monitor":      { mode: "crt",      fx: ["scanlineReveal","digitalNoise","breathingGlow","ripple"], speed: 30, glitch: 12, flicker: 28, scale: 8, rotation: 0, blur: 9, rgbSplit: 18, scanline: 95, noise: 30 },
    "Ghost Hardware Intro": { mode: "stagger", fx: ["blurIn","scanlineReveal","hud","rgbSplit","microShake"], speed: 48, glitch: 18, flicker: 30, scale: 42, rotation: 8, blur: 12, rgbSplit: 32, scanline: 45, noise: 20, bassReaction: 80 },
  };

  /* ---------------- DOM ---------------- */
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const el = {
    dropzone: $("#dropzone"), fileInput: $("#fileInput"),
    assetList: $("#assetList"), assetCount: $("#assetCount"),
    presetGrid: $("#presetGrid"),
    layerList: $("#layerList"), layerCount: $("#layerCount"),
    canvasFrame: $("#canvasFrame"), assetHost: $("#assetHost"), stageHint: $("#stageHint"),
    fxScanlines: $("#fxScanlines"), fxNoise: $("#fxNoise"),
    formatPill: $("#formatPill"),
    readoutFormat: $("#readoutFormat"),
    playBtn: $("#playBtn"), playIcon: $("#playIcon"), pauseIcon: $("#pauseIcon"),
    loopBtn: $("#loopBtn"),
    aiPrompt: $("#aiPrompt"), aiRun: $("#aiRun"), aiEcho: $("#aiEcho"),
    bgColor: $("#bgColor"), bgHex: $("#bgHex"),
    scaleSeg: $("#scaleSeg"),
    audioBtn: $("#audioBtn"), audioInput: $("#audioInput"),
    waveform: $("#waveform"), waveEmpty: $("#waveEmpty"),
    levelFill: $("#levelFill"), playhead: $("#playhead"),
    timecode: $("#timecode"), audioName: $("#audioName"),
    exportBtn: $("#exportBtn"), exportSheet: $("#exportSheet"), exportClose: $("#exportClose"),
    exportPng: $("#exportPng"), exportWebm: $("#exportWebm"), exportSeq: $("#exportSeq"),
    toast: $("#toast"),
    // NEW (added in index.html) — resolved lazily; may be null if markup missing
    rightScroll: $(".panel-right .panel-scroll"),
    controlsBeat: $('.controls[data-group="beatsync"]'),
  };

  /* ---------------- ASSETS ---------------- */
  const assets = [];
  let activeAsset = null, svgLayers = [], idSeq = 0;

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.toast.classList.remove("show"), 2400);
  }

  function handleFiles(fileList) {
    const file = fileList && fileList[0];
    if (!file) return;
    const reader = new FileReader();
    if (file.type.includes("svg") || file.name.toLowerCase().endsWith(".svg")) {
      reader.onload = (e) => addSvgAsset(file.name, e.target.result);
      reader.readAsText(file);
    } else if (file.type.startsWith("image/")) {
      reader.onload = (e) => addImageAsset(file.name, e.target.result);
      reader.readAsDataURL(file);
    } else {
      toast("That file type isn't supported");
    }
  }

  function addSvgAsset(name, svgText) {
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const svg = doc.querySelector("svg");
    if (!svg) { toast("Couldn't read that SVG"); return; }
    if (!svg.getAttribute("viewBox")) {
      const w = parseFloat(svg.getAttribute("width")) || 300;
      const h = parseFloat(svg.getAttribute("height")) || 300;
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    }
    svg.removeAttribute("width"); svg.removeAttribute("height");
    registerAsset(name, "SVG", document.importNode(svg, true));
  }

  function addImageAsset(name, dataUrl) {
    const img = new Image();
    img.src = dataUrl; img.alt = name; img.crossOrigin = "anonymous";
    registerAsset(name, "IMG", img, dataUrl);
  }

  function registerAsset(name, kind, node, dataUrl) {
    const asset = { id: ++idSeq, name, kind, node, dataUrl };
    assets.push(asset);
    renderAssetList();
    selectAsset(asset);
    toast(`Added ${name}`);
  }

  function renderAssetList() {
    el.assetCount.textContent = assets.length;
    if (!assets.length) {
      el.assetList.innerHTML = '<div class="empty-note">Nothing here yet. Add a file to start.</div>';
      return;
    }
    el.assetList.innerHTML = "";
    assets.forEach((a) => {
      const card = document.createElement("div");
      card.className = "asset-card" + (activeAsset === a ? " active" : "");
      const thumb = a.kind === "IMG"
        ? `<img class="asset-thumb" src="${a.dataUrl}" alt="${a.name}">`
        : `<div class="asset-thumb">${svgThumb(a.node)}</div>`;
      card.innerHTML =
        `<span class="asset-kind">${a.kind}</span>` +
        `<button class="asset-del" title="Remove" aria-label="Remove ${a.name}">×</button>` +
        thumb;
      card.addEventListener("click", (e) => {
        if (e.target.classList.contains("asset-del")) { removeAsset(a); e.stopPropagation(); }
        else selectAsset(a);
      });
      el.assetList.appendChild(card);
    });
  }

  function svgThumb(node) {
    const clone = node.cloneNode(true);
    clone.setAttribute("width", "100%");
    clone.setAttribute("height", "100%");
    return clone.outerHTML;
  }

  function removeAsset(a) {
    const i = assets.indexOf(a);
    if (i >= 0) assets.splice(i, 1);
    if (activeAsset === a) {
      activeAsset = null; svgLayers = [];
      el.assetHost.innerHTML = "";
      el.assetHost.appendChild(el.stageHint);
      el.stageHint.style.display = "";
      renderLayers();
    }
    renderAssetList();
  }

  // Split <text> elements into per-character <tspan> wrappers so the
  // Glitch-Flicker-Text effect can address letters independently.
  function splitTextNodes(root) {
    root.querySelectorAll("text").forEach((textEl) => {
      const raw = textEl.textContent;
      if (!raw || textEl.dataset.split) return;
      textEl.dataset.split = "1";
      // Only split simple single-run text nodes (no existing tspans).
      if (textEl.querySelector("tspan")) return;
      textEl.textContent = "";
      [...raw].forEach((ch) => {
        const span = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
        span.textContent = ch;
        span.setAttribute("data-glyph", "1");
        textEl.appendChild(span);
      });
    });
  }

  function selectAsset(a) {
    activeAsset = a;
    el.assetHost.innerHTML = "";
    el.stageHint.style.display = "none";
    const clone = a.node.cloneNode(true);
    el.assetHost.appendChild(clone);
    a.live = clone;

    svgLayers = [];
    if (a.kind === "SVG") {
      splitTextNodes(clone);
      // Meaningful, animatable elements become independent layers.
      // Prefer top-level groups; fall back to individual shapes/paths/text.
      svgLayers = Array.from(clone.querySelectorAll(
        "g, path, rect, circle, ellipse, polygon, polyline, line, text, use, symbol"
      )).filter((n) => {
        // skip empty groups that only wrap a single child already listed
        return !(n.tagName.toLowerCase() === "g" && n.children.length === 0);
      });
      if (!svgLayers.length) svgLayers = [clone];
      // Assign a stable per-layer animation "recipe" for variety.
      svgLayers.forEach((layer, i) => assignLayerRecipe(layer, i));
    }
    renderAssetList();
    renderLayers();
    if (STATE.preset) applyPresetIntro();
  }

  // Give each SVG layer its own amplitude / frequency / phase / effect
  // mix so "make every layer different" is real, not cosmetic.
  function assignLayerRecipe(layer, i) {
    const rnd = mulberry32(i * 2654435761 >>> 0);
    layer._recipe = {
      phase: rnd() * Math.PI * 2,
      ampX: 2 + rnd() * 8,
      ampY: 1 + rnd() * 5,
      freq: 0.6 + rnd() * 2.4,
      rot: (rnd() - 0.5) * 8,
      flickerBias: 0.3 + rnd() * 0.7,
      band: ["bass", "mid", "high"][Math.floor(rnd() * 3)], // which band drives it
      delay: rnd() * 0.8,                                    // stagger in seconds
    };
  }

  // Small deterministic PRNG so recipes are stable per layer index.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function renderLayers() {
    if (!activeAsset || activeAsset.kind !== "SVG" || !svgLayers.length) {
      el.layerList.innerHTML = '<li class="empty-note">Select an SVG to see its layers.</li>';
      el.layerCount.textContent = "0";
      return;
    }
    el.layerCount.textContent = svgLayers.length;
    el.layerList.innerHTML = "";
    svgLayers.forEach((layer, i) => {
      const tag = layer.tagName.toLowerCase();
      const li = document.createElement("li");
      li.className = "layer-item";
      li.innerHTML =
        `<span class="layer-icon">${layerGlyph(tag)}</span>` +
        `<span class="layer-name">${tag}${layer.id ? " · " + layer.id : " " + (i + 1)}</span>`;
      li.addEventListener("mouseenter", () => { layer.style.outline = "1px solid var(--accent)"; layer.style.outlineOffset = "2px"; });
      li.addEventListener("mouseleave", () => { layer.style.outline = "none"; });
      el.layerList.appendChild(li);
    });
  }

  function layerGlyph(tag) {
    const g = {
      g:      '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="2" y="2" width="10" height="10" rx="2" stroke="currentColor" stroke-width="1.2"/></svg>',
      text:   '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3h8M7 3v8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
      circle: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.2"/></svg>',
    };
    return g[tag] || '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2l5 5-5 5-5-5 5-5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  }

  /* ============================================================
     AUDIO ENGINE (v2)
     Multi-band analysis with envelope followers per band, transient
     (peak) detection, beat detection on the bass band, and a slow
     "buildup" accumulator. Everything is smoothed and shaped by the
     beat-sync controls so reactions feel musical, not random.
     ============================================================ */
  const audio = {
    ctx: null, el: null, source: null, analyser: null,
    freqData: null, timeData: null, ready: false,
    lastBeat: 0, prevBass: 0, prevFlux: 0,
    // per-band smoothed envelopes
    env: { bass: 0, mid: 0, high: 0, level: 0 },
    // for buildup detection (rolling average of energy)
    energyAvg: 0,
    destGain: null, streamDest: null, // for muxing audio into WebM export
  };

  function initAudio(file) {
    if (audio.el) audio.el.pause();
    audio.el = new Audio(URL.createObjectURL(file));
    audio.el.loop = STATE.loop;
    audio.el.crossOrigin = "anonymous";
    audio.ctx = audio.ctx || new (window.AudioContext || window.webkitAudioContext)();
    audio.source = audio.ctx.createMediaElementSource(audio.el);
    audio.analyser = audio.ctx.createAnalyser();
    audio.analyser.fftSize = 2048; // finer bands than before
    audio.analyser.smoothingTimeConstant = 0.75;
    // Split path: analyser (for reading) + a gain we also tap for export.
    audio.destGain = audio.ctx.createGain();
    audio.source.connect(audio.analyser);
    audio.source.connect(audio.destGain);
    audio.destGain.connect(audio.ctx.destination);
    audio.freqData = new Uint8Array(audio.analyser.frequencyBinCount);
    audio.timeData = new Uint8Array(audio.analyser.frequencyBinCount);
    audio.ready = true;
    el.waveEmpty.style.display = "none";
    el.playhead.style.opacity = "1";
    el.audioName.textContent = file.name;
    toast("Audio loaded — reactions engaged");
  }

  // Map an analyser bin index to Hz, then pick band ranges.
  function bandAverage(lowHz, highHz) {
    const nyq = (audio.ctx ? audio.ctx.sampleRate : 44100) / 2;
    const bins = audio.analyser.frequencyBinCount;
    const lo = Math.max(0, Math.floor((lowHz / nyq) * bins));
    const hi = Math.min(bins - 1, Math.ceil((highHz / nyq) * bins));
    let sum = 0, n = 0;
    for (let i = lo; i <= hi; i++) { sum += audio.freqData[i]; n++; }
    return n ? sum / (n * 255) : 0;
  }

  function analyzeAudio() {
    if (!audio.ready || audio.el.paused || !STATE.audioReactive) {
      // graceful decay to silence when paused / disabled
      const d = 0.9;
      STATE.audioLevel *= d; STATE.bassLevel *= d;
      STATE.midLevel *= d; STATE.highLevel *= d;
      STATE.beat *= 0.85; STATE.peak *= 0.8; STATE.buildup *= 0.98;
      audio.env.bass *= d; audio.env.mid *= d; audio.env.high *= d; audio.env.level *= d;
      if (audio.ready) { drawWaveform(); updateTransport(); }
      updateDebugMeter();
      return;
    }
    audio.analyser.getByteFrequencyData(audio.freqData);
    audio.analyser.getByteTimeDomainData(audio.timeData);

    // RMS amplitude (time domain)
    let sum = 0;
    for (let i = 0; i < audio.timeData.length; i++) { const v = (audio.timeData[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / audio.timeData.length);

    // Bands (Hz): bass 20-160, mid 160-2000, high 2000-12000
    const bass = bandAverage(20, 160);
    const mid  = bandAverage(160, 2000);
    const high = bandAverage(2000, 12000);

    // Envelope smoothing: `smoothing` slider blends new vs. previous.
    // Higher smoothing = slower, silkier; lower = snappier.
    const sm = 0.35 + (STATE.smoothing / 100) * 0.6;    // 0.35..0.95
    const attack = 1 - sm;                              // fast rise
    const env = audio.env;
    env.bass  = Math.max(bass,  env.bass  * sm + bass  * attack);
    env.mid   = Math.max(mid,   env.mid   * sm + mid   * attack);
    env.high  = Math.max(high,  env.high  * sm + high  * attack);
    env.level = env.level * sm + rms * attack;

    STATE.bassLevel  = env.bass;
    STATE.midLevel   = env.mid;
    STATE.highLevel  = env.high;
    STATE.audioLevel = env.level;

    // --- Transient / peak detection via spectral flux (rising energy) ---
    const flux = Math.max(0, (bass + mid + high) - audio.prevFlux);
    audio.prevFlux = audio.prevFlux * 0.6 + (bass + mid + high) * 0.4;
    const peakGate = 0.04 + (STATE.peakThreshold / 100) * 0.25; // 0.04..0.29
    if (flux > peakGate) STATE.peak = 1; else STATE.peak *= (0.65 + (STATE.syncTightness/100) * 0.3);

    // --- Beat detection on bass with adaptive threshold ---
    const now = performance.now();
    const sens = STATE.beatSensitivity / 100;             // 0..1
    const beatGate = 0.30 + (1 - sens) * 0.35;            // easier when sens high
    const refractory = 120 + (1 - sens) * 260;            // ms between beats
    if (bass > beatGate && bass > audio.prevBass * (1.05 + (1 - sens) * 0.25) && now - audio.lastBeat > refractory) {
      STATE.beat = 1; audio.lastBeat = now;
    } else {
      // decay shaped by sync tightness: tighter => faster decay
      STATE.beat *= (0.80 + (1 - STATE.syncTightness / 100) * 0.15);
    }
    audio.prevBass = audio.prevBass * 0.7 + bass * 0.3;

    // --- Buildup: slow accumulator that rises during sustained energy ---
    const energy = (bass + mid + high) / 3;
    audio.energyAvg = audio.energyAvg * 0.99 + energy * 0.01;
    const rising = energy > audio.energyAvg * 1.08;
    STATE.buildup = clamp01(STATE.buildup + (rising ? 0.01 : -0.006));

    drawWaveform();
    updateTransport();
    updateDebugMeter();
  }
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  function drawWaveform() {
    const c = el.waveform, ctx = c.getContext("2d");
    const w = (c.width = c.clientWidth), h = (c.height = c.clientHeight);
    ctx.clearRect(0, 0, w, h);
    if (!audio.ready) return;
    const mid = h / 2, step = w / audio.timeData.length;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    for (let i = 0; i < audio.timeData.length; i++) {
      ctx.lineTo(i * step, ((audio.timeData[i] - 128) / 128) * (h * 0.42) + mid);
    }
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "rgba(124,92,255,0.55)");
    grad.addColorStop(1, "rgba(179,156,255,0.55)");
    ctx.strokeStyle = STATE.beat > 0.5 ? "#B39CFF" : grad;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // beat pip
    if (STATE.beat > 0.6) { ctx.fillStyle = "rgba(179,156,255,0.15)"; ctx.fillRect(0, 0, w, h); }
    el.levelFill.style.height = Math.min(100, STATE.audioLevel * 240) + "%";
  }

  function updateTransport() {
    if (!audio.ready) return;
    const cur = audio.el.currentTime, dur = audio.el.duration || 1;
    el.playhead.style.left = (cur / dur) * 100 + "%";
    const m = Math.floor(cur / 60), s = Math.floor(cur % 60);
    el.timecode.textContent = `${m}:${String(s).padStart(2, "0")}`;
  }

  // Debug meter (bass/mid/high/peak/beat). Rendered into #beatMeter if present.
  let debugMeter = null;
  function updateDebugMeter() {
    if (!debugMeter) debugMeter = document.getElementById("beatMeter");
    if (!debugMeter) return;
    const set = (sel, v, colorHot) => {
      const bar = debugMeter.querySelector(sel);
      if (bar) { bar.style.width = Math.min(100, v * 100) + "%"; if (colorHot !== undefined) bar.classList.toggle("hot", colorHot); }
    };
    set(".m-bass > i", STATE.bassLevel);
    set(".m-mid > i",  STATE.midLevel);
    set(".m-high > i", STATE.highLevel);
    set(".m-peak > i", STATE.peak);
    const beatDot = debugMeter.querySelector(".m-beat-dot");
    if (beatDot) beatDot.classList.toggle("on", STATE.beat > 0.5);
  }

  function togglePlay() {
    STATE.playing = !STATE.playing;
    el.playIcon.style.display = STATE.playing ? "none" : "block";
    el.pauseIcon.style.display = STATE.playing ? "block" : "none";
    if (STATE.playing) { startTime = performance.now(); if (audio.ready) { if (audio.ctx.state === "suspended") audio.ctx.resume(); audio.el.play(); } }
    else if (audio.ready) audio.el.pause();
  }

  /* ============================================================
     EFFECTS LIBRARY (modular)
     Each module is a pure-ish function that reads STATE + a shared
     `sig` (audio signal snapshot) + time, and returns CSS the render
     loop composes onto the asset host (and, where relevant, drives the
     DOM overlays). Canvas-export equivalents live in the EXPORT section
     so rendered output matches the preview.

     Every module is written to work on the whole asset (image or SVG
     root) AND, where it makes sense, on individual SVG layers.
     ============================================================ */

  // Build a per-frame audio signal snapshot, scaled by the reaction
  // controls + master motion intensity. This is the single place that
  // translates "how loud is the bass" into "how much motion".
  function audioSignal() {
    const on = STATE.audioReactive && audio.ready ? 1 : 0;
    const motion = STATE.motionIntensity / 100;
    return {
      on,
      bass: on * STATE.bassLevel * (STATE.bassReaction / 100) * motion,
      mid:  on * STATE.midLevel  * (STATE.midReaction  / 100) * motion,
      high: on * STATE.highLevel * (STATE.highReaction / 100) * motion,
      level: on * STATE.audioLevel * motion,
      beat: on * STATE.beat,
      peak: on * STATE.peak,
      buildup: on * STATE.buildup,
      // when no audio, fall back to a gentle idle pulse so it still looks alive
      idle: on ? 0 : 1,
    };
  }

  // Registry: name -> module. A module returns an object with any of:
  //   { tx, ty, scale, rot, opacity, blur, rgb, hue, extraFilter }
  // The render loop sums transforms and multiplies opacity/scale.
  const EFFECTS = {
    // 1. Glitch Flicker (opacity cuts + jitter; stronger on peaks)
    glitchFlicker(p, sig, t) {
      const amt = (STATE.flicker / 100);
      const beatKick = sig.beat * 0.8 + sig.peak * 0.6;
      const cut = Math.random() < (0.05 + beatKick * 0.25) * amt;
      const micro = Math.random() < (0.03 + sig.high) * amt;
      return {
        opacity: cut ? 0.15 : (micro ? 0.6 : 1),
        tx: micro ? (Math.random() - 0.5) * 10 * (STATE.glitch / 100) : 0,
        ty: cut ? (Math.random() - 0.5) * 6 : 0,
      };
    },
    // 2. RGB split / chromatic displacement (bass/peak boosted)
    rgbSplit(p, sig, t) {
      const base = (STATE.rgbSplit / 100) * 8;
      const jitter = Math.sin(t * 40) * 0.5 + 0.5;
      const rgb = base * (1 + sig.bass * 2 + sig.peak * 2) * (0.6 + jitter * 0.4);
      return { rgb };
    },
    // 3. Scanline reveal / sweep (drives overlay opacity in loop; here adds subtle y)
    scanlineReveal(p, sig, t) {
      return { ty: Math.sin(t * (1.2 + sig.mid * 3)) * 3 };
    },
    // 4. Digital noise / pixel breakup (overlay driven in loop; adds glitch shove)
    digitalNoise(p, sig, t) {
      const b = (STATE.noise / 100);
      const shove = (sig.peak > 0.5 && Math.random() < 0.4) ? (Math.random() - 0.5) * 30 * b : 0;
      return { tx: shove };
    },
    // 5. Micro-shake / camera instability (bass = harder)
    microShake(p, sig, t) {
      const s = (STATE.glitch / 100) * 2 + 1;
      const impact = 1 + sig.bass * 4 + sig.beat * 3;
      return {
        tx: (Math.random() - 0.5) * s * impact,
        ty: (Math.random() - 0.5) * s * impact,
        rot: (Math.random() - 0.5) * 0.4 * impact,
      };
    },
    // 6. Blur-in / focus (intro: blur+opacity+scale settle over ~1.2s, re-armed on beat drops)
    blurIn(p, sig, t) {
      const dur = 1.2;
      const k = Math.min(1, (t % 6) / dur); // periodic reveal within a 6s loop
      return { blur: (1 - k) * 12, opacity: 0.2 + k * 0.8, scale: 0.96 + k * 0.04 };
    },
    // 7. Hard cut / strobe (peak/beat triggered white or black flash via overlay)
    hardCut(p, sig, t) {
      // returns a flash request the loop paints as a fullscreen overlay
      const trigger = sig.peak > 0.6 || sig.beat > 0.7;
      return { flash: trigger ? (Math.random() < 0.5 ? "#fff" : "#000") : null, flashA: trigger ? 0.5 : 0 };
    },
    // 8. HUD overlays (toggles the HUD layer + flickers it; loop handles DOM)
    hud(p, sig, t) { return { hud: true, hudFlicker: 0.6 + sig.mid * 0.4 }; },
    // 9. Symbol morph (fake morph via scale/blur crossfade pulse)
    symbolMorph(p, sig, t) {
      const k = (Math.sin(t * 0.8) * 0.5 + 0.5);
      return { scale: 1 + (k - 0.5) * 0.1, blur: k * 3 * (STATE.blur / 100 + 0.2), opacity: 0.7 + 0.3 * k };
    },
    // 10. Breathing glow / pulse (bpm/bass synced)
    breathingGlow(p, sig, t) {
      const breathe = Math.sin(t * (1.4 + sig.bass * 2)) * 0.5 + 0.5;
      const pop = sig.beat * 0.12 + sig.bass * 0.15;
      return { scale: 1 + breathe * 0.04 + pop, glow: 6 + breathe * 10 + sig.bass * 30 };
    },
    // 11. 3D card / fake hologram rotation
    card3d(p, sig, t) {
      const rx = Math.sin(t * 0.7) * (8 + sig.mid * 10);
      const ry = Math.cos(t * 0.5) * (10 + sig.mid * 12);
      return { rotX: rx, rotY: ry };
    },
    // 12. Ripple / digital wave (bass-synced horizontal offset feel)
    ripple(p, sig, t) {
      const wave = Math.sin(t * (2 + sig.bass * 4));
      return { tx: wave * (6 + sig.bass * 20), skew: wave * (1.5 + sig.bass * 3) };
    },
  };

  // Which effect modules are active right now (from preset recipe or manual).
  let activeFx = ["rgbSplit", "breathingGlow"]; // sensible default

  /* ---------------- RENDER LOOP ---------------- */
  let startTime = performance.now();
  let flashOverlay = null, hudLayer = null;

  function frame(now) {
    requestAnimationFrame(frame);
    analyzeAudio();
    if (!STATE.playing) return;
    const t = (now - startTime) / 1000;
    const sig = audioSignal();

    // Overlay opacities (scanlines + noise) react to high band + noise param.
    const scanBase = (STATE.scanline / 100);
    const scanFlicker = 0.8 + Math.sin(t * (6 + sig.high * 20)) * 0.2;
    el.canvasFrame.style.setProperty("--scanline-op", scanBase * scanFlicker * (1 + sig.high));
    const noiseBase = (STATE.noise / 100);
    el.canvasFrame.style.setProperty("--noise-op", noiseBase * (0.5 + Math.random() * 0.5) * (1 + sig.high * 1.5 + sig.peak));

    if (!activeAsset || !activeAsset.live) return;

    // Compose all active effect modules onto the asset host.
    composeEffects(activeAsset.live, t, sig);

    // Per-layer variety for SVGs (each layer uses its own recipe + band).
    if (activeAsset.kind === "SVG" && svgLayers.length > 1) animateLayers(t, sig);
  }

  function composeEffects(host, t, sig) {
    let tx = 0, ty = 0, scale = 1, rot = 0, rotX = 0, rotY = 0, skew = 0;
    let opacity = 1, blur = 0, rgb = 0, glow = 0, hue = 0;
    let wantHud = false, hudFlicker = 1, flash = null, flashA = 0;

    // Always include the base "mode" motion so existing presets still feel right.
    const baseMode = STATE.preset ? PRESETS[STATE.preset].mode : "default";
    const baseline = baseModeMotion(baseMode, t, sig);
    tx += baseline.tx; ty += baseline.ty; scale *= baseline.scale; rot += baseline.rot; opacity *= baseline.opacity;

    for (const name of activeFx) {
      const mod = EFFECTS[name];
      if (!mod) continue;
      const r = mod(null, sig, t) || {};
      if (r.tx) tx += r.tx;
      if (r.ty) ty += r.ty;
      if (r.scale) scale *= r.scale;
      if (r.rot) rot += r.rot;
      if (r.rotX) rotX += r.rotX;
      if (r.rotY) rotY += r.rotY;
      if (r.skew) skew += r.skew;
      if (r.opacity !== undefined) opacity *= r.opacity;
      if (r.blur) blur += r.blur;
      if (r.rgb) rgb = Math.max(rgb, r.rgb);
      if (r.glow) glow = Math.max(glow, r.glow);
      if (r.hue) hue += r.hue;
      if (r.hud) { wantHud = true; hudFlicker = r.hudFlicker; }
      if (r.flash) { flash = r.flash; flashA = r.flashA; }
    }

    // global blur param baseline + audio
    blur += (STATE.blur / 100) * 5 * (1 + sig.level);

    const persp = 700;
    host.style.transformOrigin = "center center";
    host.style.transform =
      `perspective(${persp}px) translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) ` +
      `scale(${scale.toFixed(3)}) rotate(${rot.toFixed(2)}deg) ` +
      `rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg) skewX(${skew.toFixed(2)}deg)`;
    host.style.opacity = clamp01(opacity).toFixed(2);
    const shadow = rgb;
    host.style.filter =
      `blur(${blur.toFixed(2)}px) ` +
      `drop-shadow(${shadow.toFixed(1)}px 0 0 rgba(255,60,80,0.5)) ` +
      `drop-shadow(${(-shadow).toFixed(1)}px 0 0 rgba(60,180,255,0.5)) ` +
      (glow ? `drop-shadow(0 0 ${glow.toFixed(1)}px rgba(124,92,255,0.6)) ` : "") +
      (hue ? `hue-rotate(${hue.toFixed(0)}deg)` : "");

    // HUD + flash overlays (DOM, preview only; export paints its own)
    updateHud(wantHud, hudFlicker, t, sig);
    updateFlash(flash, flashA);
  }

  // Base per-mode motion kept from v1 so presets remain recognizable.
  function baseModeMotion(mode, t, sig) {
    const spd = 0.4 + (STATE.speed / 100) * 2.2;
    const sc = STATE.scale / 100, rot = STATE.rotation / 100, fl = STATE.flicker / 100, g = STATE.glitch / 100;
    const wobble = Math.sin(t * spd * 2), fast = Math.sin(t * spd * 9);
    let o = { tx: 0, ty: 0, scale: 1, rot: 0, opacity: 1 };
    switch (mode) {
      case "glitch": case "data":
        o.tx = Math.random() < 0.15 ? (Math.random() - 0.5) * 40 * g : 0;
        o.opacity = Math.random() < 0.08 * fl ? 0.4 : 1; break;
      case "signal": o.tx = (Math.random() - 0.5) * 30 * g; o.opacity = Math.random() < 0.25 * fl ? 0.2 : 1; break;
      case "bass": case "scalepop": o.scale = 1 + sc * 0.5 * (0.5 + 0.5 * wobble) + sig.bass * 0.5; break;
      case "rotate": o.rot = t * spd * 20 * rot; break;
      case "wave": o.tx = wobble * 30 * sc; o.rot = wobble * 10 * rot; o.scale = 1 + Math.sin(t * spd * 3) * 0.08 * sc; break;
      case "opacity": o.opacity = 0.4 + 0.6 * Math.abs(Math.sin(t * spd * 7 * (0.5 + fl))); break;
      case "crt": case "scanner": o.ty = Math.sin(t * spd * 1.5) * 4; o.opacity = 0.9 + 0.1 * fast; break;
      case "ghost": o.opacity = 0.6 + 0.4 * Math.abs(Math.sin(t * spd * 2)); o.tx = wobble * 6; break;
      case "fade": o.opacity = Math.min(1, (t % 4) / 2); o.scale = 0.9 + Math.min(1, (t % 4) / 2) * 0.1; break;
      case "poster": o.scale = 1 + Math.sin(t * spd * 2) * 0.12 * sc + sig.bass * 0.3; o.rot = Math.sin(t * spd) * 8 * rot; break;
      case "stagger": case "wireframe": o.scale = 1 + Math.sin(t * spd * 2) * 0.05 * sc; break;
      default: o.scale = 1 + Math.sin(t * spd * 2) * 0.04 + sig.bass * 0.15; o.tx = wobble * 4;
    }
    o.scale += sig.beat * 0.1;
    return o;
  }

  // Per-layer animation: each layer uses its recipe + the band it's bound to.
  function animateLayers(t, sig) {
    const fl = STATE.flicker / 100;
    svgLayers.forEach((layer) => {
      const rc = layer._recipe; if (!rc) return;
      const lt = t - rc.delay;
      const bandVal = rc.band === "bass" ? sig.bass : rc.band === "mid" ? sig.mid : sig.high;
      const dx = Math.sin(lt * rc.freq + rc.phase) * rc.ampX * (1 + bandVal * 3);
      const dy = Math.cos(lt * rc.freq * 0.7 + rc.phase) * rc.ampY * (1 + bandVal * 2);
      const rot = Math.sin(lt * rc.freq * 0.5 + rc.phase) * rc.rot;
      const flick = Math.random() < 0.03 * fl * rc.flickerBias ? 0.25 : 1;
      const op = (0.7 + 0.3 * Math.sin(lt * rc.freq * 1.3 + rc.phase)) * flick;
      layer.style.transformBox = "fill-box";
      layer.style.transformOrigin = "center";
      layer.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px) rotate(${rot.toFixed(2)}deg)`;
      layer.style.opacity = clamp01(op).toFixed(2);
    });
  }

  // HUD overlay: build once, flicker per frame. Minimal, premium, per brief.
  function updateHud(want, flicker, t, sig) {
    if (!want) { if (hudLayer) hudLayer.style.display = "none"; return; }
    if (!hudLayer) {
      hudLayer = document.createElement("div");
      hudLayer.className = "fx fx-hud";
      hudLayer.innerHTML = hudMarkup();
      el.canvasFrame.appendChild(hudLayer);
    }
    hudLayer.style.display = "block";
    hudLayer.style.opacity = (0.5 + 0.5 * flicker * (0.6 + 0.4 * Math.sin(t * 8))).toFixed(2);
  }
  function hudMarkup() {
    return `
      <span class="hud-c hud-tl">⌐ SYS.PHASER</span>
      <span class="hud-c hud-tr">REC ●</span>
      <span class="hud-c hud-bl">X:0420 Y:1080</span>
      <span class="hud-c hud-br">v2.0 // LIVE</span>
      <span class="hud-corner hud-c-tl"></span><span class="hud-corner hud-c-tr"></span>
      <span class="hud-corner hud-c-bl"></span><span class="hud-corner hud-c-br"></span>`;
  }

  function updateFlash(color, alpha) {
    if (!flashOverlay) {
      flashOverlay = document.createElement("div");
      flashOverlay.className = "fx fx-flash";
      el.canvasFrame.appendChild(flashOverlay);
    }
    if (color && alpha > 0) { flashOverlay.style.background = color; flashOverlay.style.opacity = alpha; }
    else { flashOverlay.style.opacity = 0; }
  }

  /* ---------------- PRESETS UI ---------------- */
  function buildPresets() {
    Object.keys(PRESETS).forEach((name) => {
      const b = document.createElement("button");
      b.className = "preset";
      b.innerHTML = `<span class="preset-dot"></span><span>${name}</span>`;
      b.addEventListener("click", () => applyPreset(name));
      el.presetGrid.appendChild(b);
    });
  }

  function applyPreset(name) {
    STATE.preset = name;
    const p = PRESETS[name];
    Object.keys(p).forEach((k) => { if (k !== "mode" && k !== "fx") STATE[k] = p[k]; });
    activeFx = (p.fx && p.fx.slice()) || ["rgbSplit", "breathingGlow"];
    syncControls();
    $$(".preset").forEach((c) => c.classList.toggle("active", c.textContent.trim() === name));
    if (!STATE.playing) togglePlay();
    applyPresetIntro();
    toast(`Applied ${name}`);
  }

  function applyPresetIntro() {
    if (!activeAsset || !activeAsset.live) return;
    startTime = performance.now();
    if (window.gsap) window.gsap.fromTo(activeAsset.live, { opacity: 0, scale: 0.85 }, { opacity: 1, scale: 1, duration: 0.6, ease: "power2.out" });
  }

  /* ---------------- AI PARSER (rule-based; expanded per brief) ---------------- */
  const AI_RULES = [
    // beat sync
    { kw: ["synced to the beat", "more synced", "sync harder", "sync to the beat", "on beat", "beat sync"],
      apply: () => { bump("beatSensitivity", 25); bump("bassReaction", 25); bump("peakThreshold", -10); bump("syncTightness", 20); bump("motionIntensity", 15); STATE.audioReactive = true; }, say: "Tighter beat sync" },
    { kw: ["bass", "kick", "drop", "low end"], apply: () => { bump("bassReaction", 30); bump("motionIntensity", 15); STATE.preset = "Bass Pulse"; }, say: "Bass-driven" },
    // ghost software
    { kw: ["ghost software", "ghost hardware", "ghost"], apply: () => { STATE.preset = "Ghost Hardware"; activeFx = PRESETS["Ghost Hardware"].fx.slice(); setBackground("custom", "#070709"); bump("scanline", 15); bump("rgbSplit", 10); }, say: "Ghost software" },
    // cleaner
    { kw: ["cleaner", "clean", "minimal", "readable", "elegant"], apply: () => { set("glitch", 10); set("noise", 8); set("flicker", 14); bump("blur", -6); activeFx = ["breathingGlow", "blurIn"]; }, say: "Cleaner" },
    // aggressive
    { kw: ["aggressive", "harder", "intense", "harsh", "brutal"], apply: () => { bump("glitch", 25); bump("rgbSplit", 20); bump("bassReaction", 20); bump("motionIntensity", 20); activeFx = ["hardCut", "rgbSplit", "microShake", "glitchFlicker", "breathingGlow"]; }, say: "More aggressive" },
    // IG reel
    { kw: ["ig reel", "instagram reel", "reel", "vertical", "9:16"], apply: () => { setFormat(1080, 1920, "9:16"); EXPORTOPTS.fps = 30; EXPORTOPTS.duration = 8; }, say: "Reel-ready (1080×1920, 30fps)" },
    // transparent png
    { kw: ["transparent png", "transparent", "alpha", "no background"], apply: () => { setBackground("transparent"); EXPORTOPTS.transparent = true; }, say: "Transparent output armed" },
    // export mp4
    { kw: ["export mp4", "mp4", "h.264", "h264"], apply: () => { openSheet(); toast("MP4 selected — see Export"); }, say: "MP4 workflow" },
    // every layer different
    { kw: ["every layer different", "each layer", "layers different", "vary layers"], apply: () => { if (activeAsset && activeAsset.kind === "SVG") { svgLayers.forEach((l, i) => assignLayerRecipe(l, i + Math.floor(Math.random() * 999))); } }, say: "Layers randomized" },
    // legacy keywords retained
    { kw: ["glitchy", "corrupt"], apply: () => { bump("glitch", 30); bump("rgbSplit", 20); bump("noise", 15); }, say: "More glitch" },
    { kw: ["slow", "slower", "calm", "gentle"], apply: () => { set("speed", 25); bump("flicker", -15); }, say: "Slower" },
    { kw: ["fast", "faster", "hyper", "rapid"], apply: () => { set("speed", 85); bump("flicker", 15); }, say: "Faster" },
    { kw: ["dark", "darker", "moody"], apply: () => { setBackground("custom", "#050506"); bump("scanline", 15); }, say: "Darker" },
    { kw: ["bright", "brighter", "light"], apply: () => { setBackground("custom", "#15161a"); bump("blur", -10); }, say: "Brighter" },
    { kw: ["scanline", "scanlines", "crt"], apply: () => { bump("scanline", 35); STATE.preset = "CRT Monitor"; activeFx = PRESETS["CRT Monitor"].fx.slice(); }, say: "Scanlines" },
    { kw: ["flicker", "strobe"], apply: () => { bump("flicker", 35); if (!activeFx.includes("hardCut")) activeFx.push("hardCut"); }, say: "More flicker" },
    { kw: ["poster", "print"], apply: () => { STATE.preset = "Techno Poster"; activeFx = PRESETS["Techno Poster"].fx.slice(); }, say: "Poster motion" },
    { kw: ["loop", "loopable", "seamless"], apply: () => { STATE.loop = true; el.loopBtn.classList.add("active"); el.loopBtn.dataset.on = "true"; }, say: "Loop on" },
    { kw: ["hud", "overlay", "labels", "coordinates"], apply: () => { if (!activeFx.includes("hud")) activeFx.push("hud"); }, say: "HUD overlays" },
    { kw: ["hologram", "3d", "card", "rotate card"], apply: () => { if (!activeFx.includes("card3d")) activeFx.push("card3d"); }, say: "3D card" },
    { kw: ["ripple", "wave", "distort"], apply: () => { if (!activeFx.includes("ripple")) activeFx.push("ripple"); }, say: "Ripple" },
  ];
  const bump = (k, d) => (STATE[k] = clamp(STATE[k] + d));
  const set = (k, v) => (STATE[k] = clamp(v));
  const clamp = (v) => Math.max(0, Math.min(100, v));

  function runAI() {
    const text = el.aiPrompt.value.toLowerCase().trim();
    if (!text) { el.aiEcho.textContent = "Type a direction first, like \u201cmake it more synced to the beat.\u201d"; return; }
    const hits = [];
    AI_RULES.forEach((r) => { if (r.kw.some((k) => text.includes(k))) { r.apply(); hits.push(r.say); } });
    if (STATE.preset && PRESETS[STATE.preset]) $$(".preset").forEach((c) => c.classList.toggle("active", c.textContent.trim() === STATE.preset));
    syncControls();
    if (!STATE.playing) togglePlay();
    applyPresetIntro();
    el.aiEcho.textContent = hits.length ? hits.join(" · ") : "No keywords matched. Try: synced to the beat, ghost software, cleaner, aggressive, IG reel, transparent PNG, export MP4, every layer different.";
  }

  /* ---------------- CONTROLS ---------------- */
  function buildControls() {
    Object.entries(CONTROL_GROUPS).forEach(([group, items]) => {
      const container = document.querySelector(`.controls[data-group="${group}"]`);
      if (!container) return; // beatsync container is created in ensureBeatSyncPanel()
      items.forEach(({ key, label }) => addSlider(container, key, label));
    });
  }

  function addSlider(container, key, label) {
    const wrap = document.createElement("div");
    wrap.className = "control";
    wrap.innerHTML =
      `<span class="ctl-label">${label}</span>` +
      `<span class="ctl-val" id="val-${key}">${STATE[key]}</span>` +
      `<input type="range" min="0" max="100" value="${STATE[key]}" id="ctl-${key}" style="--pct:${STATE[key]}%">`;
    container.appendChild(wrap);
    const input = wrap.querySelector("input");
    input.addEventListener("input", (e) => {
      STATE[key] = +e.target.value;
      document.getElementById(`val-${key}`).textContent = STATE[key];
      e.target.style.setProperty("--pct", STATE[key] + "%");
      if (!STATE.playing) togglePlay();
    });
  }

  function syncControls() {
    [...CONTROL_GROUPS.animation, ...CONTROL_GROUPS.effects, ...CONTROL_GROUPS.beatsync].forEach(({ key }) => {
      const input = document.getElementById(`ctl-${key}`), val = document.getElementById(`val-${key}`);
      if (input) { input.value = STATE[key]; input.style.setProperty("--pct", STATE[key] + "%"); }
      if (val) val.textContent = STATE[key];
    });
  }

  // Inject the Beat-Sync group + debug meter into the right panel without
  // needing hand-authored markup for each slider (keeps index.html small).
  function ensureBeatSyncPanel() {
    if (!el.rightScroll || document.getElementById("beatSyncGroup")) return;
    const section = document.createElement("section");
    section.className = "prop-group";
    section.id = "beatSyncGroup";
    section.innerHTML = `
      <div class="group-head">
        <h3>Beat sync</h3>
        <label class="switch" title="Audio-reactive on/off">
          <input type="checkbox" id="audioReactiveToggle" ${STATE.audioReactive ? "checked" : ""}>
          <span class="switch-track"><span class="switch-thumb"></span></span>
        </label>
      </div>
      <div id="beatMeter" class="beat-meter">
        <div class="m-row"><span>BASS</span><div class="m-bar m-bass"><i></i></div></div>
        <div class="m-row"><span>MID</span><div class="m-bar m-mid"><i></i></div></div>
        <div class="m-row"><span>HIGH</span><div class="m-bar m-high"><i></i></div></div>
        <div class="m-row"><span>PEAK</span><div class="m-bar m-peak"><i></i></div></div>
        <div class="m-row m-beat-row"><span>BEAT</span><span class="m-beat-dot"></span></div>
      </div>
      <div class="controls" data-group="beatsync"></div>`;
    // place it right after the Animation group if possible, else append
    const groups = $$(".panel-right .prop-group");
    if (groups.length >= 2) groups[1].after(section); else el.rightScroll.appendChild(section);
    el.controlsBeat = section.querySelector('.controls[data-group="beatsync"]');
    CONTROL_GROUPS.beatsync.forEach(({ key, label }) => addSlider(el.controlsBeat, key, label));
    section.querySelector("#audioReactiveToggle").addEventListener("change", (e) => {
      STATE.audioReactive = e.target.checked;
      toast(STATE.audioReactive ? "Audio-reactive on" : "Audio-reactive off");
    });
  }

  /* ---------------- BACKGROUND ---------------- */
  // bgMode: black | white | transparent | custom | gradient
  function setBackground(mode, color) {
    STATE.bgMode = mode;
    if (color) STATE.bgColor = color;
    let css;
    switch (mode) {
      case "black": STATE.bgColor = "#000000"; css = "#000000"; break;
      case "white": STATE.bgColor = "#FFFFFF"; css = "#FFFFFF"; break;
      case "gradient": css = `linear-gradient(150deg, ${STATE.bgColor}, ${STATE.bgColor2})`; break;
      case "transparent": css = "transparent"; break;
      default: css = STATE.bgColor; // custom
    }
    // Preview: transparent shows the checkerboard (preview-only).
    el.canvasFrame.classList.toggle("checkerboard", mode === "transparent");
    el.canvasFrame.style.setProperty("--frame-bg", mode === "transparent" ? "transparent" : css);
    if (el.bgColor) el.bgColor.value = /^#/.test(STATE.bgColor) ? STATE.bgColor : "#0B0B0F";
    if (el.bgHex) el.bgHex.textContent = mode === "transparent" ? "TRANSPARENT" : (mode === "gradient" ? "GRADIENT" : STATE.bgColor.toUpperCase());
    // reflect active swatch in the UI if present
    $$(".bg-swatch").forEach((s) => s.classList.toggle("active", s.dataset.bg === mode));
  }
  function syncBg() { setBackground(STATE.bgMode, STATE.bgColor); }

  /* ---------------- FORMAT ---------------- */
  function setFormat(w, h, label) {
    STATE.format = { w, h, label };
    el.canvasFrame.style.aspectRatio = `${w} / ${h}`;
    el.readoutFormat.textContent = `${w} × ${h}`;
    $$(".fmt").forEach((b) => b.classList.toggle("active", +b.dataset.w === w && +b.dataset.h === h && b.dataset.label === label));
  }

  /* ============================================================
     EXPORT SYSTEM (v2)
     One shared frame renderer, drawExportFrame(), is used by every
     exporter so PNG / sequence / WebM / MP4 all look identical to the
     preview. `transparent` skips the background + vignette and returns
     real alpha. Instagram video (WebM/MP4) uses the selected solid/
     gradient background per the brief ("MP4 + selected background").
     ============================================================ */

  // Central export options (mutated by the export modal UI).
  const EXPORTOPTS = {
    transparent: false,   // alpha output (PNG / PNG-seq / optional WebM)
    duration: 8,          // seconds (video + sequence)
    fps: 30,              // 30 or 60
    includeAudio: true,   // mux uploaded audio into WebM/MP4
    quality: "high",      // high | medium
    bg: "selected",       // selected | black | white | transparent(for supported)
  };

  function openSheet() { el.exportSheet.hidden = false; syncExportUI(); }
  function closeSheet() { el.exportSheet.hidden = true; }

  // Resolve the background the export should paint.
  // Returns null when the frame must be transparent (real alpha).
  function resolveExportBg(forVideo) {
    // Video: never transparent unless explicitly transparent-webm path.
    if (forVideo && EXPORTOPTS.bg !== "transparent") {
      if (EXPORTOPTS.bg === "black") return "#000000";
      if (EXPORTOPTS.bg === "white") return "#FFFFFF";
      return currentBgPaint(); // selected
    }
    if (EXPORTOPTS.transparent || EXPORTOPTS.bg === "transparent") return null;
    if (EXPORTOPTS.bg === "black") return "#000000";
    if (EXPORTOPTS.bg === "white") return "#FFFFFF";
    return currentBgPaint();
  }

  // The paint used for "selected" background (solid or gradient token).
  function currentBgPaint() {
    if (STATE.bgMode === "transparent") return null;
    if (STATE.bgMode === "gradient") return { grad: [STATE.bgColor, STATE.bgColor2] };
    if (STATE.bgMode === "white") return "#FFFFFF";
    if (STATE.bgMode === "black") return "#000000";
    return STATE.bgColor;
  }

  // Shared frame renderer. Draws bg (or leaves alpha), the asset with
  // RGB split + rotation/scale, scanlines, noise, glow, HUD, flash —
  // matching what the preview composes. `t` is seconds into the loop.
  async function drawExportFrame(ctx, W, H, img, t, opts) {
    const transparent = !opts.bg;
    ctx.clearRect(0, 0, W, H);

    // --- background ---
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

    const scale = W / STATE.format.w;
    const sig = audioSignal();

    // --- asset ---
    if (img) {
      const spd = 0.4 + (STATE.speed / 100) * 2.2, wobble = Math.sin(t * spd * 2);
      let scaleV = 1 + wobble * 0.05 * (STATE.scale / 100) + sig.bass * 0.2 + sig.beat * 0.08;
      // breathing / scalepop presets add pulse
      if (activeFx.includes("breathingGlow")) scaleV += (Math.sin(t * (1.4 + sig.bass * 2)) * 0.5 + 0.5) * 0.04;
      const rotV = STATE.preset === "Rotation Drift"
        ? t * spd * 20 * (STATE.rotation / 100)
        : wobble * 6 * (STATE.rotation / 100);
      const r = Math.min(W * 0.72 / img.width, H * 0.72 / img.height) * scaleV;
      const dw = img.width * r, dh = img.height * r;
      const rgb = (STATE.rgbSplit / 100) * 8 * scale * (1 + sig.bass * 2 + sig.peak * 2);
      const shakeX = activeFx.includes("microShake") ? (Math.random() - 0.5) * (2 + sig.bass * 8) * scale : 0;
      const shakeY = activeFx.includes("microShake") ? (Math.random() - 0.5) * (2 + sig.bass * 8) * scale : 0;

      ctx.save();
      ctx.translate(W / 2 + shakeX, H / 2 + shakeY);
      ctx.rotate(rotV * Math.PI / 180);
      // RGB split via additive draws
      if (rgb > 0.3) {
        ctx.globalAlpha = 0.5; ctx.globalCompositeOperation = "screen";
        ctx.drawImage(img, -dw / 2 + rgb, -dh / 2, dw, dh);
        ctx.drawImage(img, -dw / 2 - rgb, -dh / 2, dw, dh);
        ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
      }
      // opacity flicker
      let op = 1;
      if (activeFx.includes("glitchFlicker")) {
        const amt = STATE.flicker / 100;
        if (Math.random() < (0.05 + sig.beat * 0.25 + sig.peak * 0.2) * amt) op = 0.2;
      }
      ctx.globalAlpha = op;
      ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
    }

    // --- scanlines ---
    if (STATE.scanline > 0) {
      // In transparent mode, clip scanlines to existing artwork (source-atop)
      // so they never lay an opaque veil over empty alpha.
      if (transparent) ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = `rgba(0,0,0,${(STATE.scanline / 100) * 0.5 * (1 + sig.high)})`;
      for (let y = 0; y < H; y += 3 * scale) ctx.fillRect(0, y, W, Math.max(1, scale));
      ctx.globalCompositeOperation = "source-over";
    }
    // --- noise (respect transparency: only tint existing pixels' alpha) ---
    if (STATE.noise > 0) {
      const n = ctx.getImageData(0, 0, W, H), amt = (STATE.noise / 100) * 40 * (1 + sig.high);
      const d = n.data;
      for (let i = 0; i < d.length; i += 4) {
        if (transparent && d[i + 3] === 0) continue; // keep fully-transparent px clear
        if (Math.random() < 0.3) { const v = (Math.random() - 0.5) * amt; d[i] += v; d[i + 1] += v; d[i + 2] += v; }
      }
      ctx.putImageData(n, 0, 0);
    }
    // --- vignette (only on opaque output) ---
    if (!transparent) {
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
      g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.45)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    // --- hard-cut flash overlay (opaque output only; a full-frame flash
    //     would destroy alpha, so transparent exports skip it) ---
    if (!transparent && activeFx.includes("hardCut") && (sig.peak > 0.6 || sig.beat > 0.7)) {
      ctx.fillStyle = Math.random() < 0.5 ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, W, H);
    }
  }

  // Rasterize the current asset (SVG serialized, or the <img>).
  function assetToImage(asset) {
    return new Promise((resolve) => {
      if (!asset) { resolve(null); return; }
      if (asset.kind === "IMG") { resolve(asset.node); return; }
      const svgStr = new XMLSerializer().serializeToString(asset.live);
      const url = URL.createObjectURL(new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" }));
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  function makeCanvas() {
    const scale = STATE.exportScale;
    const c = document.createElement("canvas");
    c.width = STATE.format.w * scale; c.height = STATE.format.h * scale;
    return c;
  }

  function downloadBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }

  function setExportStatus(msg, kind) {
    const s = document.getElementById("exportStatus");
    if (s) { s.textContent = msg; s.dataset.kind = kind || "info"; }
    if (msg) toast(msg);
  }

  /* ---- A) PNG STILL (opaque or transparent) ---- */
  async function exportPNG(transparentOverride) {
    if (!activeAsset) { toast("Add an asset first"); return; }
    const transparent = transparentOverride !== undefined ? transparentOverride : (EXPORTOPTS.transparent || EXPORTOPTS.bg === "transparent");
    setExportStatus(transparent ? "Rendering transparent PNG…" : "Rendering PNG…", "work");
    const c = makeCanvas(), ctx = c.getContext("2d");
    const img = await assetToImage(activeAsset);
    const t = STATE.playing ? (performance.now() - startTime) / 1000 : 0;
    await drawExportFrame(ctx, c.width, c.height, img, t, { bg: transparent ? null : resolveExportBg(false) });
    c.toBlob((blob) => {
      downloadBlob(blob, transparent ? `phaser-still-transparent.png` : `phaser-still.png`);
      setExportStatus("Done — PNG saved", "done"); closeSheet();
    }, "image/png");
  }

  /* ---- B) PNG SEQUENCE (opaque or transparent, selectable duration/fps) ---- */
  async function exportSequence(transparentOverride) {
    if (!activeAsset) { toast("Add an asset first"); return; }
    const transparent = transparentOverride !== undefined ? transparentOverride : (EXPORTOPTS.transparent || EXPORTOPTS.bg === "transparent");
    const fps = EXPORTOPTS.fps, dur = EXPORTOPTS.duration, total = Math.round(fps * dur);
    setExportStatus(`Rendering ${total} frames (${dur}s @ ${fps}fps)…`, "work");
    const c = makeCanvas(), ctx = c.getContext("2d");
    const img = await assetToImage(activeAsset);
    const bg = transparent ? null : resolveExportBg(false);
    for (let f = 0; f < total; f++) {
      await drawExportFrame(ctx, c.width, c.height, img, f / fps, { bg });
      await new Promise((res) => c.toBlob((blob) => {
        downloadBlob(blob, `phaser-seq-${String(f).padStart(4, "0")}.png`);
        setTimeout(res, 60);
      }, "image/png"));
      if (f % 15 === 0) setExportStatus(`Rendering frame ${f + 1}/${total}…`, "work");
    }
    setExportStatus("Done — sequence saved", "done"); closeSheet();
  }

  /* ---- C) WEBM VIDEO (fps + audio muxing + optional alpha) ---- */
  async function exportWebM(alphaOverride) {
    if (!activeAsset) { toast("Add an asset first"); return; }
    if (typeof MediaRecorder === "undefined") { setExportStatus("This browser can't record video — use PNG sequence", "error"); return; }
    const fps = EXPORTOPTS.fps;
    const wantAlpha = alphaOverride !== undefined ? alphaOverride : (EXPORTOPTS.transparent && EXPORTOPTS.bg === "transparent");
    const mime = pickWebmMime(wantAlpha);
    if (wantAlpha && !mime.includes("alpha") && !MediaRecorder.isTypeSupported("video/webm;codecs=vp9")) {
      toast("Transparent WebM not supported here — exporting opaque");
    }
    setExportStatus(`Recording WebM (${EXPORTOPTS.duration}s @ ${fps}fps)…`, "work");

    const c = makeCanvas(), ctx = c.getContext("2d");
    const img = await assetToImage(activeAsset);
    const videoStream = c.captureStream(fps);

    // Mux audio: tap the audio graph if the user loaded a track.
    let mixedStream = videoStream;
    if (EXPORTOPTS.includeAudio && audio.ready && audio.ctx) {
      try {
        audio.streamDest = audio.streamDest || audio.ctx.createMediaStreamDestination();
        audio.destGain.connect(audio.streamDest);
        const aTrack = audio.streamDest.stream.getAudioTracks()[0];
        if (aTrack) { mixedStream = new MediaStream([...videoStream.getVideoTracks(), aTrack]); }
        // restart audio from 0 for a clean capture
        if (audio.ctx.state === "suspended") await audio.ctx.resume();
        audio.el.currentTime = 0; audio.el.play();
      } catch (e) { /* fall back to silent video */ }
    }

    const bg = wantAlpha ? null : resolveExportBg(true);
    const rec = new MediaRecorder(mixedStream, {
      mimeType: mime,
      videoBitsPerSecond: EXPORTOPTS.quality === "high" ? 12_000_000 : 6_000_000,
    });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      downloadBlob(blob, wantAlpha ? "phaser-motion-alpha.webm" : "phaser-motion.webm");
      setExportStatus("Done — WebM saved", "done");
      // keep a handle so MP4 transcode can reuse the exact bytes
      LAST_WEBM_BLOB = blob;
      closeSheet();
    };

    const t0 = performance.now();
    rec.start();
    (function recFrame(now) {
      const elapsed = (now - t0) / 1000;
      drawExportFrame(ctx, c.width, c.height, img, elapsed, { bg });
      if (elapsed < EXPORTOPTS.duration) requestAnimationFrame(recFrame);
      else { rec.stop(); if (audio.ready) audio.el.pause(); }
    })(performance.now());
  }

  function pickWebmMime(wantAlpha) {
    // VP9 supports alpha; prefer it when transparency is requested.
    const list = wantAlpha
      ? ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
      : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    return list.find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm";
  }

  /* ---- D) MP4 VIDEO (H.264) via ffmpeg.wasm ----
     Instagram wants H.264 MP4 with a solid/selected background + audio.
     Strategy: record the animation as WebM (above), then transcode to
     MP4 with ffmpeg.wasm. ffmpeg is heavy (~30MB), so it is LAZY-LOADED
     only when MP4 is requested, and the whole thing degrades gracefully. */

  let LAST_WEBM_BLOB = null;   // reused by the transcoder if present
  let ffmpegInstance = null;   // cached across exports

  // ⇩⇩⇩ FFMPEG.WASM INTEGRATION POINT ⇩⇩⇩
  // To enable real MP4 encoding, add these two <script> tags to index.html
  // (or import the ESM build), then flip FFMPEG_AVAILABLE handling below:
  //
  //   <script src="https://unpkg.com/@ffmpeg/[email protected]/dist/umd/ffmpeg.js"></script>
  //   <script src="https://unpkg.com/@ffmpeg/[email protected]/dist/umd/util.js"></script>
  //
  // The code below already: (1) records WebM with audio, (2) loads ffmpeg
  // on demand, (3) runs the H.264 transcode, (4) downloads phaser-motion-reel.mp4.
  // If the ffmpeg globals are absent, it falls back to delivering the WebM
  // and tells the user exactly what to add. THIS IS THE ONLY PLACE MP4
  // ENCODING LIVES — everything upstream (frames, audio) is already done.
  async function loadFFmpeg() {
    if (ffmpegInstance) return ffmpegInstance;
    // Support both the classic (createFFmpeg) and new (FFmpeg class) builds.
    const hasNew = typeof window.FFmpeg !== "undefined" && window.FFmpeg.FFmpeg;
    const hasClassic = typeof window.FFmpeg !== "undefined" && window.FFmpeg.createFFmpeg;
    if (!hasNew && !hasClassic) return null; // not present -> caller falls back

    if (hasNew) {
      const { FFmpeg } = window.FFmpeg;
      const ff = new FFmpeg();
      await ff.load(); // optionally pass { coreURL, wasmURL } for self-hosting
      ffmpegInstance = { api: "new", ff };
    } else {
      const ff = window.FFmpeg.createFFmpeg({ log: false });
      await ff.load();
      ffmpegInstance = { api: "classic", ff };
    }
    return ffmpegInstance;
  }

  async function exportMP4() {
    if (!activeAsset) { toast("Add an asset first"); return; }
    setExportStatus("Preparing MP4…", "work");

    // 1) Ensure we have source video bytes: reuse the last WebM, or record now.
    if (!LAST_WEBM_BLOB) {
      setExportStatus("Recording source video for MP4…", "work");
      await recordWebMForMp4();               // records with selected bg + audio
      if (!LAST_WEBM_BLOB) { setExportStatus("Could not record source video", "error"); return; }
    }

    // 2) Try to transcode with ffmpeg.wasm.
    let ff = null;
    try { ff = await loadFFmpeg(); } catch (e) { ff = null; }

    if (!ff) {
      // ---- GRACEFUL FALLBACK (no ffmpeg.wasm on the page) ----
      // The full pipeline is ready; only the encoder script is missing.
      downloadBlob(LAST_WEBM_BLOB, "phaser-motion-reel.webm");
      setExportStatus(
        "MP4 encoder not loaded — saved WebM instead. Add the ffmpeg.wasm <script> tags noted in script.js to enable H.264 MP4.",
        "error"
      );
      return;
    }

    // 3) Real transcode WebM -> H.264 MP4 (audio copied/encoded to AAC).
    try {
      setExportStatus("Encoding H.264 MP4… (this can take a moment)", "work");
      const inputName = "in.webm", outputName = "phaser-motion-reel.mp4";
      const bytes = new Uint8Array(await LAST_WEBM_BLOB.arrayBuffer());

      if (ff.api === "new") {
        await ff.ff.writeFile(inputName, bytes);
        await ff.ff.exec([
          "-i", inputName,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", EXPORTOPTS.quality === "high" ? "18" : "23",
          "-pix_fmt", "yuv420p", "-movflags", "+faststart",
          "-r", String(EXPORTOPTS.fps),
          "-c:a", "aac", "-b:a", "192k",
          outputName,
        ]);
        const out = await ff.ff.readFile(outputName);
        downloadBlob(new Blob([out.buffer], { type: "video/mp4" }), outputName);
      } else {
        ff.ff.FS("writeFile", inputName, bytes);
        await ff.ff.run(
          "-i", inputName,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", EXPORTOPTS.quality === "high" ? "18" : "23",
          "-pix_fmt", "yuv420p", "-movflags", "+faststart",
          "-r", String(EXPORTOPTS.fps),
          "-c:a", "aac", "-b:a", "192k",
          outputName
        );
        const out = ff.ff.FS("readFile", outputName);
        downloadBlob(new Blob([out.buffer], { type: "video/mp4" }), outputName);
      }
      setExportStatus("Done — phaser-motion-reel.mp4 saved", "done");
      closeSheet();
    } catch (e) {
      console.error(e);
      downloadBlob(LAST_WEBM_BLOB, "phaser-motion-reel.webm");
      setExportStatus("MP4 encode failed — saved WebM as fallback", "error");
    }
  }

  // Records a WebM specifically as MP4 source: always opaque, selected bg, audio.
  function recordWebMForMp4() {
    return new Promise(async (resolve) => {
      if (typeof MediaRecorder === "undefined") { resolve(); return; }
      const fps = EXPORTOPTS.fps;
      const c = makeCanvas(), ctx = c.getContext("2d");
      const img = await assetToImage(activeAsset);
      const videoStream = c.captureStream(fps);
      let mixedStream = videoStream;
      if (EXPORTOPTS.includeAudio && audio.ready && audio.ctx) {
        try {
          audio.streamDest = audio.streamDest || audio.ctx.createMediaStreamDestination();
          audio.destGain.connect(audio.streamDest);
          const aTrack = audio.streamDest.stream.getAudioTracks()[0];
          if (aTrack) mixedStream = new MediaStream([...videoStream.getVideoTracks(), aTrack]);
          if (audio.ctx.state === "suspended") await audio.ctx.resume();
          audio.el.currentTime = 0; audio.el.play();
        } catch (e) {}
      }
      const rec = new MediaRecorder(mixedStream, { mimeType: pickWebmMime(false), videoBitsPerSecond: 12_000_000 });
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => { LAST_WEBM_BLOB = new Blob(chunks, { type: "video/webm" }); if (audio.ready) audio.el.pause(); resolve(); };
      const bg = resolveExportBg(true);
      const t0 = performance.now();
      rec.start();
      (function rf(now) {
        const elapsed = (now - t0) / 1000;
        drawExportFrame(ctx, c.width, c.height, img, elapsed, { bg });
        if (elapsed < EXPORTOPTS.duration) requestAnimationFrame(rf); else rec.stop();
      })(performance.now());
    });
  }

  // Keep the export modal UI in sync with EXPORTOPTS.
  function syncExportUI() {
    const setActive = (sel, val, attr) => $$(sel).forEach((b) => b.classList.toggle("active", b.dataset[attr] == val));
    setActive("[data-fps]", EXPORTOPTS.fps, "fps");
    setActive("[data-dur]", EXPORTOPTS.duration, "dur");
    setActive("[data-vbg]", EXPORTOPTS.bg, "vbg");
    const tp = document.getElementById("optTransparent");
    if (tp) tp.checked = EXPORTOPTS.transparent;
    const au = document.getElementById("optAudio");
    if (au) au.checked = EXPORTOPTS.includeAudio;
  }

  /* ---------------- WIRING ---------------- */
  function wire() {
    // left rail tabs
    $$(".rail-tab").forEach((tab) => tab.addEventListener("click", () => {
      $$(".rail-tab").forEach((t) => t.classList.remove("active"));
      $$(".tab-view").forEach((v) => v.classList.remove("active"));
      tab.classList.add("active");
      document.querySelector(`.tab-view[data-view="${tab.dataset.tab}"]`).classList.add("active");
    }));

    // upload
    el.dropzone.addEventListener("click", () => el.fileInput.click());
    el.dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.fileInput.click(); } });
    el.fileInput.addEventListener("change", (e) => handleFiles(e.target.files));
    ["dragenter", "dragover"].forEach((ev) => el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) => el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.remove("drag"); }));
    el.dropzone.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));
    el.canvasFrame.addEventListener("dragover", (e) => e.preventDefault());
    el.canvasFrame.addEventListener("drop", (e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); });

    // format
    $$(".fmt").forEach((b) => b.addEventListener("click", () => setFormat(+b.dataset.w, +b.dataset.h, b.dataset.label)));

    // transport
    el.playBtn.addEventListener("click", togglePlay);
    el.loopBtn.addEventListener("click", () => {
      STATE.loop = !STATE.loop;
      el.loopBtn.classList.toggle("active", STATE.loop);
      el.loopBtn.dataset.on = String(STATE.loop);
      if (audio.el) audio.el.loop = STATE.loop;
    });
    document.addEventListener("keydown", (e) => {
      if (e.code === "Space" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "INPUT") { e.preventDefault(); togglePlay(); }
    });

    // AI
    el.aiRun.addEventListener("click", runAI);
    el.aiPrompt.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runAI(); });

    // appearance: custom color still works; also drives "custom" bg mode
    el.bgColor.addEventListener("input", (e) => { setBackground("custom", e.target.value); });
    el.scaleSeg.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => {
      STATE.exportScale = +b.dataset.scale;
      el.scaleSeg.querySelectorAll(".seg-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
    }));

    // background swatches (added in index.html): black/white/transparent/custom/gradient
    $$(".bg-swatch").forEach((s) => s.addEventListener("click", () => setBackground(s.dataset.bg)));

    // audio
    el.audioBtn.addEventListener("click", () => el.audioInput.click());
    el.audioInput.addEventListener("change", (e) => { if (e.target.files[0]) initAudio(e.target.files[0]); });

    // ---- export modal ----
    el.exportBtn.addEventListener("click", openSheet);
    el.exportClose.addEventListener("click", closeSheet);
    el.exportSheet.addEventListener("click", (e) => { if (e.target === el.exportSheet) closeSheet(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

    // existing three buttons keep working (PNG / WebM / sequence)
    el.exportPng && el.exportPng.addEventListener("click", () => exportPNG(false));
    el.exportWebm && el.exportWebm.addEventListener("click", () => exportWebM(false));
    el.exportSeq && el.exportSeq.addEventListener("click", () => exportSequence(false));

    // NEW export buttons (added in index.html)
    bindClick("#exportPngT", () => exportPNG(true));
    bindClick("#exportSeqT", () => exportSequence(true));
    bindClick("#exportMp4", () => exportMP4());
    bindClick("#exportWebmA", () => exportWebM(true)); // transparent webm (advanced)

    // export option toggles
    $$("[data-fps]").forEach((b) => b.addEventListener("click", () => { EXPORTOPTS.fps = +b.dataset.fps; syncExportUI(); }));
    $$("[data-dur]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.dur === "custom") {
        const v = parseFloat(prompt("Custom duration in seconds:", String(EXPORTOPTS.duration)) || EXPORTOPTS.duration);
        if (v > 0) EXPORTOPTS.duration = Math.min(60, v);
      } else EXPORTOPTS.duration = +b.dataset.dur;
      syncExportUI();
    }));
    $$("[data-vbg]").forEach((b) => b.addEventListener("click", () => { EXPORTOPTS.bg = b.dataset.vbg; syncExportUI(); }));
    bindChange("#optTransparent", (e) => { EXPORTOPTS.transparent = e.target.checked; });
    bindChange("#optAudio", (e) => { EXPORTOPTS.includeAudio = e.target.checked; });
  }

  function bindClick(sel, fn) { const n = document.querySelector(sel); if (n) n.addEventListener("click", fn); }
  function bindChange(sel, fn) { const n = document.querySelector(sel); if (n) n.addEventListener("change", fn); }

  /* ---------------- INIT ---------------- */
  function init() {
    buildPresets();
    buildControls();
    ensureBeatSyncPanel();  // inject Beat-sync group + debug meter
    setBackground(STATE.bgMode, STATE.bgColor);
    setFormat(1080, 1920, "9:16");
    wire();
    syncExportUI();
    requestAnimationFrame(frame);
  }
  document.addEventListener("DOMContentLoaded", init);
})();
