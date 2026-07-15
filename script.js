/* ============================================================
   PHASER — Motion Editor — script.js  (complete, synchronized)
   Vanilla JS. No build step, no npm, no server. GitHub Pages ready.
   GSAP + ffmpeg.wasm are optional; the app runs fully without them.

   Sections:
     STATE        single source of truth for every parameter
     ASSETS       import, SVG layer parsing, per-layer recipes
     AUDIO        Web Audio API multi-band analysis + beat detection
     EFFECTS      reusable effect modules (SVG / text / image)
     RENDER LOOP  requestAnimationFrame drives all effects
     PRESETS      declarative recipes combining effects
     AI DIRECTOR  rule-based prompt parser
     CONTROLS     grouped sliders bound to STATE
     BACKGROUND   black / white / transparent / custom / gradient
     EXPORT       PNG / PNG-seq / WebM (+audio) / MP4 (ffmpeg hook)
   Every getElementById / querySelector below has a matching element
   in index.html, and every button in index.html is wired here.
   ============================================================ */

(() => {
  "use strict";

  /* ---------------- STATE ---------------- */
  const STATE = {
    // core motion
    speed: 50, glitch: 30, flicker: 25, scale: 30, rotation: 20,
    blur: 15, rgbSplit: 25, scanline: 40, noise: 20, audioReactivity: 60,
    // beat-sync engine
    beatSensitivity: 55, bassReaction: 70, midReaction: 50, highReaction: 50,
    smoothing: 60, peakThreshold: 60, motionIntensity: 70, syncTightness: 65,
    audioReactive: true,
    // appearance / output
    bgMode: "custom", bgColor: "#0B0B0F", bgColor2: "#1A1030",
    format: { w: 1080, h: 1920, label: "Reel" },
    preset: null, playing: false, loop: true, exportScale: 1,
    // live audio runtime (smoothed 0..1)
    audioLevel: 0, bassLevel: 0, midLevel: 0, highLevel: 0,
    beat: 0, peak: 0, buildup: 0,
  };

  const CONTROL_GROUPS = {
    animation: [
      { key: "speed", label: "Speed" },
      { key: "scale", label: "Scale" },
      { key: "rotation", label: "Rotation" },
      { key: "flicker", label: "Flicker" },
      { key: "audioReactivity", label: "Audio reactivity" },
    ],
    beatsync: [
      { key: "beatSensitivity", label: "Beat sensitivity" },
      { key: "bassReaction", label: "Bass reaction" },
      { key: "midReaction", label: "Mid reaction" },
      { key: "highReaction", label: "High reaction" },
      { key: "peakThreshold", label: "Peak threshold" },
      { key: "smoothing", label: "Smoothing" },
      { key: "motionIntensity", label: "Motion intensity" },
      { key: "syncTightness", label: "Sync tightness" },
    ],
    effects: [
      { key: "glitch", label: "Glitch" },
      { key: "blur", label: "Blur" },
      { key: "rgbSplit", label: "RGB split" },
      { key: "scanline", label: "Scanlines" },
      { key: "noise", label: "Noise" },
    ],
  };

  /* ---------------- PRESETS ----------------
     Each preset: a param patch + a render `mode` + an `fx` recipe
     (which effect modules are active). Matches the brief's 8 presets
     plus the earlier library kept for continuity. */
  const PRESETS = {
    "Ghost Software":       { mode: "ghost",   fx: ["rgbSplit","scanlineReveal","hud","microShake","glitchFlicker","digitalNoise","breathingGlow"], speed: 42, glitch: 22, flicker: 45, scale: 16, rotation: 8, blur: 10, rgbSplit: 32, scanline: 55, noise: 28, bassReaction: 72 },
    "Signal Loss":          { mode: "signal",  fx: ["hardCut","digitalNoise","rgbSplit","glitchFlicker","scanlineReveal"], speed: 55, glitch: 60, flicker: 80, scale: 8, rotation: 3, blur: 22, rgbSplit: 50, scanline: 65, noise: 60 },
    "Terrain Scanner":      { mode: "scanner", fx: ["scanlineReveal","hud","glitchFlicker","breathingGlow"], speed: 45, glitch: 20, flicker: 35, scale: 20, rotation: 4, blur: 6, rgbSplit: 25, scanline: 75, noise: 20, bassReaction: 75 },
    "Detroit Techno":       { mode: "poster",  fx: ["hardCut","glitchFlicker","breathingGlow","microShake"], speed: 65, glitch: 30, flicker: 40, scale: 55, rotation: 6, blur: 4, rgbSplit: 25, scanline: 30, noise: 15, bassReaction: 95, motionIntensity: 90 },
    "Data Corruption":      { mode: "data",    fx: ["digitalNoise","glitchFlicker","rgbSplit","microShake","hardCut"], speed: 80, glitch: 95, flicker: 55, scale: 25, rotation: 12, blur: 6, rgbSplit: 80, scanline: 40, noise: 70 },
    "Clean Motion Poster":  { mode: "fade",    fx: ["blurIn","breathingGlow"], speed: 35, glitch: 6, flicker: 10, scale: 35, rotation: 4, blur: 14, rgbSplit: 8, scanline: 12, noise: 6 },
    "CRT Monitor":          { mode: "crt",     fx: ["scanlineReveal","digitalNoise","breathingGlow","ripple"], speed: 30, glitch: 12, flicker: 28, scale: 8, rotation: 0, blur: 9, rgbSplit: 18, scanline: 95, noise: 30 },
    "Ghost Hardware Intro": { mode: "stagger", fx: ["blurIn","scanlineReveal","hud","rgbSplit","microShake"], speed: 48, glitch: 18, flicker: 30, scale: 42, rotation: 8, blur: 12, rgbSplit: 32, scanline: 45, noise: 20, bassReaction: 80 },
  };

  /* ---------------- DOM ---------------- */
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const el = {
    dropzone: $("#dropzone"), fileInput: $("#fileInput"),
    assetList: $("#assetList"), assetCount: $("#assetCount"),
    presetGrid: $("#presetGrid"), generateGhost: $("#generateGhost"),
    layerList: $("#layerList"), layerCount: $("#layerCount"),
    canvasFrame: $("#canvasFrame"), assetHost: $("#assetHost"), stageHint: $("#stageHint"),
    readoutFormat: $("#readoutFormat"),
    playBtn: $("#playBtn"), playIcon: $("#playIcon"), pauseIcon: $("#pauseIcon"), loopBtn: $("#loopBtn"),
    aiPrompt: $("#aiPrompt"), aiRun: $("#aiRun"), aiEcho: $("#aiEcho"),
    bgColor: $("#bgColor"), bgHex: $("#bgHex"), scaleSeg: $("#scaleSeg"),
    audioBtn: $("#audioBtn"), audioInput: $("#audioInput"),
    waveform: $("#waveform"), waveEmpty: $("#waveEmpty"),
    levelFill: $("#levelFill"), playhead: $("#playhead"),
    timecode: $("#timecode"), audioName: $("#audioName"),
    audioReactiveToggle: $("#audioReactiveToggle"), beatMeter: $("#beatMeter"),
    exportBtn: $("#exportBtn"), exportSheet: $("#exportSheet"), exportClose: $("#exportClose"),
    exportPng: $("#exportPng"), exportPngT: $("#exportPngT"),
    exportSeq: $("#exportSeq"), exportSeqT: $("#exportSeqT"),
    exportWebm: $("#exportWebm"), exportWebmA: $("#exportWebmA"), exportMp4: $("#exportMp4"),
    exportStatus: $("#exportStatus"),
    optTransparent: $("#optTransparent"), optAudio: $("#optAudio"),
    toast: $("#toast"),
  };

  /* ---------------- ASSETS ---------------- */
  const assets = [];
  let activeAsset = null, svgLayers = [], idSeq = 0;

  function toast(msg) {
    if (!el.toast) return;
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
        `<button class="asset-del" title="Remove" aria-label="Remove ${a.name}">\u00d7</button>` +
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

  // Split <text> into per-glyph <tspan> so glitch-flicker can address letters.
  function splitTextNodes(root) {
    root.querySelectorAll("text").forEach((textEl) => {
      const raw = textEl.textContent;
      if (!raw || textEl.dataset.split || textEl.querySelector("tspan")) return;
      textEl.dataset.split = "1";
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
      svgLayers = Array.from(clone.querySelectorAll(
        "g, path, rect, circle, ellipse, polygon, polyline, line, text, use, symbol"
      )).filter((n) => !(n.tagName.toLowerCase() === "g" && n.children.length === 0));
      if (!svgLayers.length) svgLayers = [clone];   // parsing fallback: whole SVG
      svgLayers.forEach((layer, i) => assignLayerRecipe(layer, i));
    }
    renderAssetList();
    renderLayers();
    if (STATE.preset) applyPresetIntro();
  }

  // Unique per-layer recipe: phase, amplitude, frequency, band, delay, fx bias.
  const RECIPE_FX = ["glitchFlicker", "rgbSplit", "microShake", "breathingGlow", "scanlineReveal", "ripple"];
  function assignLayerRecipe(layer, seed) {
    const rnd = mulberry32((seed + 1) * 2654435761 >>> 0);
    const band = ["bass", "mid", "high"][Math.floor(rnd() * 3)];
    layer._recipe = {
      phase: rnd() * Math.PI * 2,
      ampX: 2 + rnd() * 9,
      ampY: 1 + rnd() * 6,
      freq: 0.6 + rnd() * 2.6,
      rot: (rnd() - 0.5) * 10,
      flickerBias: 0.3 + rnd() * 0.7,
      band,
      delay: rnd() * 0.9,
      fx: RECIPE_FX[Math.floor(rnd() * RECIPE_FX.length)],
    };
  }
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
      const rc = layer._recipe;
      const li = document.createElement("li");
      li.className = "layer-item";
      li.innerHTML =
        `<span class="layer-icon">${layerGlyph(tag)}</span>` +
        `<span class="layer-name">${tag}${layer.id ? " \u00b7 " + layer.id : " " + (i + 1)}</span>` +
        (rc ? `<span class="layer-recipe">${rc.band}</span>` : "");
      li.addEventListener("mouseenter", () => { layer.style.outline = "1px solid var(--accent)"; layer.style.outlineOffset = "2px"; });
      li.addEventListener("mouseleave", () => { layer.style.outline = "none"; });
      el.layerList.appendChild(li);
    });
  }

  function layerGlyph(tag) {
    const g = {
      g: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="2" y="2" width="10" height="10" rx="2" stroke="currentColor" stroke-width="1.2"/></svg>',
      text: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3h8M7 3v8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
      circle: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.2"/></svg>',
    };
    return g[tag] || '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2l5 5-5 5-5-5 5-5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  }

  // "Generate Ghost Motion": re-seed every layer + apply the Ghost Software recipe.
  function generateGhostMotion() {
    if (!activeAsset) { toast("Add an SVG or image first"); return; }
    if (activeAsset.kind === "SVG" && svgLayers.length) {
      svgLayers.forEach((l, i) => assignLayerRecipe(l, i + Math.floor(Math.random() * 99999)));
      renderLayers();
    }
    applyPreset("Ghost Software");
    toast("Ghost motion generated");
  }

  /* ============================================================
     AUDIO ENGINE — multi-band analysis + beat / peak detection
     ============================================================ */
  const audio = {
    ctx: null, el: null, source: null, analyser: null,
    freqData: null, timeData: null, ready: false,
    lastBeat: 0, prevBass: 0, prevFlux: 0,
    env: { bass: 0, mid: 0, high: 0, level: 0 },
    energyAvg: 0, destGain: null, streamDest: null,
  };

  function initAudio(file) {
    try {
      if (audio.el) audio.el.pause();
      audio.el = new Audio(URL.createObjectURL(file));
      audio.el.loop = STATE.loop;
      audio.ctx = audio.ctx || new (window.AudioContext || window.webkitAudioContext)();
      audio.source = audio.ctx.createMediaElementSource(audio.el);
      audio.analyser = audio.ctx.createAnalyser();
      audio.analyser.fftSize = 2048;
      audio.analyser.smoothingTimeConstant = 0.75;
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
    } catch (e) {
      toast("Could not initialize audio");
    }
  }

  function bandAverage(lowHz, highHz) {
    const nyq = (audio.ctx ? audio.ctx.sampleRate : 44100) / 2;
    const bins = audio.analyser.frequencyBinCount;
    const lo = Math.max(0, Math.floor((lowHz / nyq) * bins));
    const hi = Math.min(bins - 1, Math.ceil((highHz / nyq) * bins));
    let sum = 0, n = 0;
    for (let i = lo; i <= hi; i++) { sum += audio.freqData[i]; n++; }
    return n ? sum / (n * 255) : 0;
  }
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  function analyzeAudio() {
    if (!audio.ready || audio.el.paused || !STATE.audioReactive) {
      const d = 0.9;
      STATE.audioLevel *= d; STATE.bassLevel *= d; STATE.midLevel *= d; STATE.highLevel *= d;
      STATE.beat *= 0.85; STATE.peak *= 0.8; STATE.buildup *= 0.98;
      audio.env.bass *= d; audio.env.mid *= d; audio.env.high *= d; audio.env.level *= d;
      if (audio.ready) { drawWaveform(); updateTransport(); }
      updateDebugMeter();
      return;
    }
    audio.analyser.getByteFrequencyData(audio.freqData);
    audio.analyser.getByteTimeDomainData(audio.timeData);

    let sum = 0;
    for (let i = 0; i < audio.timeData.length; i++) { const v = (audio.timeData[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / audio.timeData.length);
    const bass = bandAverage(20, 160), mid = bandAverage(160, 2000), high = bandAverage(2000, 12000);

    const sm = 0.35 + (STATE.smoothing / 100) * 0.6, attack = 1 - sm, env = audio.env;
    env.bass = Math.max(bass, env.bass * sm + bass * attack);
    env.mid = Math.max(mid, env.mid * sm + mid * attack);
    env.high = Math.max(high, env.high * sm + high * attack);
    env.level = env.level * sm + rms * attack;
    STATE.bassLevel = env.bass; STATE.midLevel = env.mid; STATE.highLevel = env.high; STATE.audioLevel = env.level;

    // transient / peak via spectral flux
    const flux = Math.max(0, (bass + mid + high) - audio.prevFlux);
    audio.prevFlux = audio.prevFlux * 0.6 + (bass + mid + high) * 0.4;
    const peakGate = 0.04 + (STATE.peakThreshold / 100) * 0.25;
    if (flux > peakGate) STATE.peak = 1; else STATE.peak *= (0.65 + (STATE.syncTightness / 100) * 0.3);

    // adaptive bass beat detection
    const now = performance.now(), sens = STATE.beatSensitivity / 100;
    const beatGate = 0.30 + (1 - sens) * 0.35, refractory = 120 + (1 - sens) * 260;
    if (bass > beatGate && bass > audio.prevBass * (1.05 + (1 - sens) * 0.25) && now - audio.lastBeat > refractory) {
      STATE.beat = 1; audio.lastBeat = now;
    } else {
      STATE.beat *= (0.80 + (1 - STATE.syncTightness / 100) * 0.15);
    }
    audio.prevBass = audio.prevBass * 0.7 + bass * 0.3;

    // buildup accumulator
    const energy = (bass + mid + high) / 3;
    audio.energyAvg = audio.energyAvg * 0.99 + energy * 0.01;
    STATE.buildup = clamp01(STATE.buildup + (energy > audio.energyAvg * 1.08 ? 0.01 : -0.006));

    drawWaveform(); updateTransport(); updateDebugMeter();
  }

  function drawWaveform() {
    const c = el.waveform, ctx = c.getContext("2d");
    const w = (c.width = c.clientWidth), h = (c.height = c.clientHeight);
    ctx.clearRect(0, 0, w, h);
    if (!audio.ready) return;
    const mid = h / 2, step = w / audio.timeData.length;
    ctx.beginPath(); ctx.moveTo(0, mid);
    for (let i = 0; i < audio.timeData.length; i++) ctx.lineTo(i * step, ((audio.timeData[i] - 128) / 128) * (h * 0.42) + mid);
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "rgba(122,92,255,0.55)"); grad.addColorStop(1, "rgba(179,156,255,0.55)");
    ctx.strokeStyle = STATE.beat > 0.5 ? "#B39CFF" : grad; ctx.lineWidth = 1.5; ctx.stroke();
    if (STATE.beat > 0.6) { ctx.fillStyle = "rgba(179,156,255,0.14)"; ctx.fillRect(0, 0, w, h); }
    el.levelFill.style.height = Math.min(100, STATE.audioLevel * 240) + "%";
  }

  function updateTransport() {
    if (!audio.ready) return;
    const cur = audio.el.currentTime, dur = audio.el.duration || 1;
    el.playhead.style.left = (cur / dur) * 100 + "%";
    const m = Math.floor(cur / 60), s = Math.floor(cur % 60);
    el.timecode.textContent = `${m}:${String(s).padStart(2, "0")}`;
  }

  function updateDebugMeter() {
    if (!el.beatMeter) return;
    const set = (sel, v) => { const bar = el.beatMeter.querySelector(sel); if (bar) bar.style.width = Math.min(100, v * 100) + "%"; };
    set(".m-bass > i", STATE.bassLevel); set(".m-mid > i", STATE.midLevel);
    set(".m-high > i", STATE.highLevel); set(".m-peak > i", STATE.peak);
    const dot = el.beatMeter.querySelector(".m-beat-dot");
    if (dot) dot.classList.toggle("on", STATE.beat > 0.5);
  }

  function togglePlay() {
    STATE.playing = !STATE.playing;
    el.playIcon.style.display = STATE.playing ? "none" : "block";
    el.pauseIcon.style.display = STATE.playing ? "block" : "none";
    if (STATE.playing) {
      startTime = performance.now();
      if (audio.ready) { if (audio.ctx.state === "suspended") audio.ctx.resume(); audio.el.play().catch(() => {}); }
    } else if (audio.ready) audio.el.pause();
  }

  /* ============================================================
     EFFECTS LIBRARY (modular) — each returns visual deltas
     ============================================================ */
  function audioSignal() {
    const on = STATE.audioReactive && audio.ready ? 1 : 0;
    const motion = STATE.motionIntensity / 100;
    return {
      on,
      bass: on * STATE.bassLevel * (STATE.bassReaction / 100) * motion,
      mid: on * STATE.midLevel * (STATE.midReaction / 100) * motion,
      high: on * STATE.highLevel * (STATE.highReaction / 100) * motion,
      level: on * STATE.audioLevel * motion,
      beat: on * STATE.beat, peak: on * STATE.peak, buildup: on * STATE.buildup,
    };
  }

  const EFFECTS = {
    glitchFlicker(sig, t) {
      const amt = STATE.flicker / 100, kick = sig.beat * 0.8 + sig.peak * 0.6;
      const cut = Math.random() < (0.05 + kick * 0.25) * amt;
      const micro = Math.random() < (0.03 + sig.high) * amt;
      return { opacity: cut ? 0.15 : (micro ? 0.6 : 1), tx: micro ? (Math.random() - 0.5) * 10 * (STATE.glitch / 100) : 0, ty: cut ? (Math.random() - 0.5) * 6 : 0 };
    },
    rgbSplit(sig, t) {
      const base = (STATE.rgbSplit / 100) * 8, j = Math.sin(t * 40) * 0.5 + 0.5;
      return { rgb: base * (1 + sig.bass * 2 + sig.peak * 2) * (0.6 + j * 0.4) };
    },
    scanlineReveal(sig, t) { return { ty: Math.sin(t * (1.2 + sig.mid * 3)) * 3 }; },
    digitalNoise(sig, t) {
      const b = STATE.noise / 100;
      return { tx: (sig.peak > 0.5 && Math.random() < 0.4) ? (Math.random() - 0.5) * 30 * b : 0 };
    },
    microShake(sig, t) {
      const s = (STATE.glitch / 100) * 2 + 1, impact = 1 + sig.bass * 4 + sig.beat * 3;
      return { tx: (Math.random() - 0.5) * s * impact, ty: (Math.random() - 0.5) * s * impact, rot: (Math.random() - 0.5) * 0.4 * impact };
    },
    blurIn(sig, t) {
      const k = Math.min(1, (t % 6) / 1.2);
      return { blur: (1 - k) * 12, opacity: 0.2 + k * 0.8, scale: 0.96 + k * 0.04 };
    },
    hardCut(sig, t) {
      const trig = sig.peak > 0.6 || sig.beat > 0.7;
      return { flash: trig ? (Math.random() < 0.5 ? "#fff" : "#000") : null, flashA: trig ? 0.5 : 0 };
    },
    hud(sig, t) { return { hud: true, hudFlicker: 0.6 + sig.mid * 0.4 }; },
    symbolMorph(sig, t) {
      const k = Math.sin(t * 0.8) * 0.5 + 0.5;
      return { scale: 1 + (k - 0.5) * 0.1, blur: k * 3 * (STATE.blur / 100 + 0.2), opacity: 0.7 + 0.3 * k };
    },
    breathingGlow(sig, t) {
      const b = Math.sin(t * (1.4 + sig.bass * 2)) * 0.5 + 0.5, pop = sig.beat * 0.12 + sig.bass * 0.15;
      return { scale: 1 + b * 0.04 + pop, glow: 6 + b * 10 + sig.bass * 30 };
    },
    card3d(sig, t) { return { rotX: Math.sin(t * 0.7) * (8 + sig.mid * 10), rotY: Math.cos(t * 0.5) * (10 + sig.mid * 12) }; },
    ripple(sig, t) { const w = Math.sin(t * (2 + sig.bass * 4)); return { tx: w * (6 + sig.bass * 20), skew: w * (1.5 + sig.bass * 3) }; },
  };

  let activeFx = ["rgbSplit", "breathingGlow"];

  /* ---------------- RENDER LOOP ---------------- */
  let startTime = performance.now();
  let flashOverlay = null, hudLayer = null;

  function frame(now) {
    requestAnimationFrame(frame);
    analyzeAudio();
    if (!STATE.playing) return;
    const t = (now - startTime) / 1000, sig = audioSignal();

    const scanBase = STATE.scanline / 100, scanFlicker = 0.8 + Math.sin(t * (6 + sig.high * 20)) * 0.2;
    el.canvasFrame.style.setProperty("--scanline-op", scanBase * scanFlicker * (1 + sig.high));
    el.canvasFrame.style.setProperty("--noise-op", (STATE.noise / 100) * (0.5 + Math.random() * 0.5) * (1 + sig.high * 1.5 + sig.peak));

    if (!activeAsset || !activeAsset.live) return;
    composeEffects(activeAsset.live, t, sig);
    if (activeAsset.kind === "SVG" && svgLayers.length > 1) animateLayers(t, sig);
  }

  function composeEffects(host, t, sig) {
    let tx = 0, ty = 0, scale = 1, rot = 0, rotX = 0, rotY = 0, skew = 0;
    let opacity = 1, blur = 0, rgb = 0, glow = 0, hue = 0;
    let wantHud = false, hudFlicker = 1, flash = null, flashA = 0;

    const baseline = baseModeMotion(STATE.preset ? PRESETS[STATE.preset].mode : "default", t, sig);
    tx += baseline.tx; ty += baseline.ty; scale *= baseline.scale; rot += baseline.rot; opacity *= baseline.opacity;

    for (const name of activeFx) {
      const mod = EFFECTS[name]; if (!mod) continue;
      const r = mod(sig, t) || {};
      if (r.tx) tx += r.tx; if (r.ty) ty += r.ty;
      if (r.scale) scale *= r.scale; if (r.rot) rot += r.rot;
      if (r.rotX) rotX += r.rotX; if (r.rotY) rotY += r.rotY; if (r.skew) skew += r.skew;
      if (r.opacity !== undefined) opacity *= r.opacity;
      if (r.blur) blur += r.blur; if (r.rgb) rgb = Math.max(rgb, r.rgb);
      if (r.glow) glow = Math.max(glow, r.glow); if (r.hue) hue += r.hue;
      if (r.hud) { wantHud = true; hudFlicker = r.hudFlicker; }
      if (r.flash) { flash = r.flash; flashA = r.flashA; }
    }
    blur += (STATE.blur / 100) * 5 * (1 + sig.level);

    host.style.transformOrigin = "center center";
    host.style.transform =
      `perspective(700px) translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${scale.toFixed(3)}) ` +
      `rotate(${rot.toFixed(2)}deg) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg) skewX(${skew.toFixed(2)}deg)`;
    host.style.opacity = clamp01(opacity).toFixed(2);
    const shadow = rgb;
    host.style.filter =
      `blur(${blur.toFixed(2)}px) ` +
      `drop-shadow(${shadow.toFixed(1)}px 0 0 rgba(255,60,80,0.5)) ` +
      `drop-shadow(${(-shadow).toFixed(1)}px 0 0 rgba(60,180,255,0.5)) ` +
      (glow ? `drop-shadow(0 0 ${glow.toFixed(1)}px rgba(122,92,255,0.6)) ` : "") +
      (hue ? `hue-rotate(${hue.toFixed(0)}deg)` : "");

    updateHud(wantHud, hudFlicker, t);
    updateFlash(flash, flashA);
  }

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

  // Per-layer: each uses its own recipe + bound band + its own fx module.
  function animateLayers(t, sig) {
    const fl = STATE.flicker / 100;
    svgLayers.forEach((layer) => {
      const rc = layer._recipe; if (!rc) return;
      const lt = t - rc.delay;
      const bandVal = rc.band === "bass" ? sig.bass : rc.band === "mid" ? sig.mid : sig.high;
      let dx = Math.sin(lt * rc.freq + rc.phase) * rc.ampX * (1 + bandVal * 3);
      let dy = Math.cos(lt * rc.freq * 0.7 + rc.phase) * rc.ampY * (1 + bandVal * 2);
      let rot = Math.sin(lt * rc.freq * 0.5 + rc.phase) * rc.rot;
      let op = 0.7 + 0.3 * Math.sin(lt * rc.freq * 1.3 + rc.phase);
      // layer's own effect flavor
      if (rc.fx === "glitchFlicker" && Math.random() < 0.03 * fl * rc.flickerBias) op *= 0.25;
      if (rc.fx === "microShake") { dx += (Math.random() - 0.5) * 3 * (1 + bandVal * 3); dy += (Math.random() - 0.5) * 3; }
      if (rc.fx === "breathingGlow") { const b = Math.sin(lt * 1.4) * 0.5 + 0.5; rot += 0; op = Math.min(1, op + b * 0.1); }
      layer.style.transformBox = "fill-box";
      layer.style.transformOrigin = "center";
      layer.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px) rotate(${rot.toFixed(2)}deg)`;
      layer.style.opacity = clamp01(op).toFixed(2);
    });
  }

  function updateHud(want, flicker, t) {
    if (!want) { if (hudLayer) hudLayer.style.display = "none"; return; }
    if (!hudLayer) {
      hudLayer = document.createElement("div");
      hudLayer.className = "fx fx-hud";
      hudLayer.innerHTML =
        '<span class="hud-c hud-tl">\u2310 SYS.PHASER</span>' +
        '<span class="hud-c hud-tr">REC \u25cf</span>' +
        '<span class="hud-c hud-bl">X:0420 Y:1080</span>' +
        '<span class="hud-c hud-br">v2.0 // LIVE</span>' +
        '<span class="hud-corner hud-c-tl"></span><span class="hud-corner hud-c-tr"></span>' +
        '<span class="hud-corner hud-c-bl"></span><span class="hud-corner hud-c-br"></span>';
      el.canvasFrame.appendChild(hudLayer);
    }
    hudLayer.style.display = "block";
    hudLayer.style.opacity = (0.5 + 0.5 * flicker * (0.6 + 0.4 * Math.sin(t * 8))).toFixed(2);
  }

  function updateFlash(color, alpha) {
    if (!flashOverlay) {
      flashOverlay = document.createElement("div");
      flashOverlay.className = "fx fx-flash";
      el.canvasFrame.appendChild(flashOverlay);
    }
    if (color && alpha > 0) { flashOverlay.style.background = color; flashOverlay.style.opacity = alpha; }
    else flashOverlay.style.opacity = 0;
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

  /* ---------------- AI DIRECTOR (rule-based) ---------------- */
  const AI_RULES = [
    { kw: ["synced to the beat", "more synced", "sync harder", "sync to the beat", "on beat", "beat sync"],
      apply: () => { bump("beatSensitivity", 25); bump("bassReaction", 25); bump("peakThreshold", -10); bump("syncTightness", 20); bump("motionIntensity", 15); STATE.audioReactive = true; if (el.audioReactiveToggle) el.audioReactiveToggle.checked = true; }, say: "Tighter beat sync" },
    { kw: ["ghost software", "ghost hardware", "ghost"], apply: () => { applyPreset("Ghost Software"); setBackground("custom", "#070709"); }, say: "Ghost software" },
    { kw: ["cleaner", "clean", "minimal", "readable", "elegant"], apply: () => { set("glitch", 10); set("noise", 8); set("flicker", 14); bump("blur", -6); activeFx = ["breathingGlow", "blurIn"]; }, say: "Cleaner" },
    { kw: ["aggressive", "harder", "intense", "harsh"], apply: () => { bump("glitch", 25); bump("rgbSplit", 20); bump("bassReaction", 20); bump("motionIntensity", 20); activeFx = ["hardCut", "rgbSplit", "microShake", "glitchFlicker", "breathingGlow"]; }, say: "More aggressive" },
    { kw: ["ig reel", "instagram reel", "reel", "vertical"], apply: () => { setFormat(1080, 1920, "Reel"); EXPORTOPTS.fps = 30; EXPORTOPTS.duration = 8; syncExportUI(); }, say: "Reel-ready (1080\u00d71920, 30fps)" },
    { kw: ["transparent png", "transparent", "alpha", "no background"], apply: () => { setBackground("transparent"); EXPORTOPTS.transparent = true; if (el.optTransparent) el.optTransparent.checked = true; }, say: "Transparent output armed" },
    { kw: ["export mp4", "mp4", "h.264", "h264"], apply: () => { openSheet(); }, say: "MP4 workflow — see Export" },
    { kw: ["every layer different", "each layer", "layers different", "vary layers"], apply: () => { if (activeAsset && activeAsset.kind === "SVG") { svgLayers.forEach((l, i) => assignLayerRecipe(l, i + Math.floor(Math.random() * 99999))); renderLayers(); } }, say: "Layers randomized" },
    { kw: ["glitchy", "glitch", "corrupt"], apply: () => { bump("glitch", 30); bump("rgbSplit", 20); bump("noise", 15); if (!activeFx.includes("glitchFlicker")) activeFx.push("glitchFlicker"); }, say: "More glitch" },
    { kw: ["slow", "slower", "calm", "gentle"], apply: () => { set("speed", 25); bump("flicker", -15); }, say: "Slower" },
    { kw: ["fast", "faster", "hyper", "rapid"], apply: () => { set("speed", 85); bump("flicker", 15); }, say: "Faster" },
    { kw: ["dark", "darker", "moody"], apply: () => { setBackground("custom", "#050506"); bump("scanline", 15); }, say: "Darker" },
    { kw: ["bright", "brighter", "light"], apply: () => { setBackground("custom", "#15161a"); bump("blur", -10); }, say: "Brighter" },
    { kw: ["scanline", "scanlines", "crt"], apply: () => { bump("scanline", 35); applyPreset("CRT Monitor"); }, say: "Scanlines" },
    { kw: ["flicker", "strobe"], apply: () => { bump("flicker", 35); if (!activeFx.includes("hardCut")) activeFx.push("hardCut"); }, say: "More flicker" },
    { kw: ["poster", "print"], apply: () => { applyPreset("Detroit Techno"); }, say: "Poster motion" },
    { kw: ["hud", "overlay", "labels", "coordinates"], apply: () => { if (!activeFx.includes("hud")) activeFx.push("hud"); }, say: "HUD overlays" },
    { kw: ["hologram", "3d", "card"], apply: () => { if (!activeFx.includes("card3d")) activeFx.push("card3d"); }, say: "3D card" },
    { kw: ["ripple", "wave", "distort"], apply: () => { if (!activeFx.includes("ripple")) activeFx.push("ripple"); }, say: "Ripple" },
  ];
  const bump = (k, d) => (STATE[k] = clampP(STATE[k] + d));
  const set = (k, v) => (STATE[k] = clampP(v));
  const clampP = (v) => Math.max(0, Math.min(100, v));

  function runAI() {
    const text = el.aiPrompt.value.toLowerCase().trim();
    if (!text) { el.aiEcho.textContent = "Type a direction first, like \u201cmake it more synced to the beat.\u201d"; return; }
    const hits = [];
    AI_RULES.forEach((r) => { if (r.kw.some((k) => text.includes(k))) { r.apply(); hits.push(r.say); } });
    if (STATE.preset && PRESETS[STATE.preset]) $$(".preset").forEach((c) => c.classList.toggle("active", c.textContent.trim() === STATE.preset));
    syncControls();
    if (!STATE.playing) togglePlay();
    el.aiEcho.textContent = hits.length ? hits.join(" \u00b7 ") : "No keywords matched. Try: synced to the beat, ghost software, cleaner, aggressive, IG reel, transparent PNG, export MP4, every layer different.";
  }

  /* ---------------- CONTROLS ---------------- */
  function buildControls() {
    Object.entries(CONTROL_GROUPS).forEach(([group, items]) => {
      const container = document.querySelector(`.controls[data-group="${group}"]`);
      if (!container) return;
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
    wrap.querySelector("input").addEventListener("input", (e) => {
      STATE[key] = +e.target.value;
      document.getElementById(`val-${key}`).textContent = STATE[key];
      e.target.style.setProperty("--pct", STATE[key] + "%");
      if (!STATE.playing) togglePlay();
    });
  }
  function syncControls() {
    [...CONTROL_GROUPS.animation, ...CONTROL_GROUPS.beatsync, ...CONTROL_GROUPS.effects].forEach(({ key }) => {
      const input = document.getElementById(`ctl-${key}`), val = document.getElementById(`val-${key}`);
      if (input) { input.value = STATE[key]; input.style.setProperty("--pct", STATE[key] + "%"); }
      if (val) val.textContent = STATE[key];
    });
  }

  /* ---------------- BACKGROUND ---------------- */
  function setBackground(mode, color) {
    STATE.bgMode = mode;
    if (color) STATE.bgColor = color;
    let css;
    switch (mode) {
      case "black": STATE.bgColor = "#000000"; css = "#000000"; break;
      case "white": STATE.bgColor = "#FFFFFF"; css = "#FFFFFF"; break;
      case "gradient": css = `linear-gradient(150deg, ${STATE.bgColor}, ${STATE.bgColor2})`; break;
      case "transparent": css = "transparent"; break;
      default: css = STATE.bgColor;
    }
    el.canvasFrame.classList.toggle("checkerboard", mode === "transparent");
    el.canvasFrame.style.setProperty("--frame-bg", mode === "transparent" ? "transparent" : css);
    if (el.bgColor && /^#/.test(STATE.bgColor)) el.bgColor.value = STATE.bgColor;
    if (el.bgHex) el.bgHex.textContent = mode === "transparent" ? "TRANSPARENT" : (mode === "gradient" ? "GRADIENT" : STATE.bgColor.toUpperCase());
    $$(".bg-swatch").forEach((s) => s.classList.toggle("active", s.dataset.bg === mode));
  }

  /* ---------------- FORMAT ---------------- */
  function setFormat(w, h, label) {
    STATE.format = { w, h, label };
    el.canvasFrame.style.aspectRatio = `${w} / ${h}`;
    el.readoutFormat.textContent = `${w} \u00d7 ${h}`;
    $$(".fmt").forEach((b) => b.classList.toggle("active", +b.dataset.w === w && +b.dataset.h === h && b.dataset.label === label));
  }

  /* ============================================================
     EXPORT SYSTEM
     One shared drawExportFrame() so PNG / seq / WebM / MP4 all
     match the preview. transparent => real alpha (no bg/vignette).
     ============================================================ */
  const EXPORTOPTS = { transparent: false, duration: 4, fps: 30, includeAudio: true, quality: "high", bg: "selected" };

  function openSheet() { el.exportSheet.hidden = false; syncExportUI(); setExportStatus("Ready", "info"); }
  function closeSheet() { el.exportSheet.hidden = true; }

  function resolveExportBg(forVideo) {
    if (forVideo && EXPORTOPTS.bg !== "transparent") {
      if (EXPORTOPTS.bg === "black") return "#000000";
      if (EXPORTOPTS.bg === "white") return "#FFFFFF";
      return currentBgPaint();
    }
    if (EXPORTOPTS.transparent || EXPORTOPTS.bg === "transparent") return null;
    if (EXPORTOPTS.bg === "black") return "#000000";
    if (EXPORTOPTS.bg === "white") return "#FFFFFF";
    return currentBgPaint();
  }
  function currentBgPaint() {
    if (STATE.bgMode === "transparent") return null;
    if (STATE.bgMode === "gradient") return { grad: [STATE.bgColor, STATE.bgColor2] };
    if (STATE.bgMode === "white") return "#FFFFFF";
    if (STATE.bgMode === "black") return "#000000";
    return STATE.bgColor;
  }

  async function drawExportFrame(ctx, W, H, img, t, opts) {
    const transparent = !opts.bg;
    ctx.clearRect(0, 0, W, H);
    if (!transparent) {
      if (typeof opts.bg === "object" && opts.bg.grad) {
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, opts.bg.grad[0]); g.addColorStop(1, opts.bg.grad[1]); ctx.fillStyle = g;
      } else ctx.fillStyle = opts.bg;
      ctx.fillRect(0, 0, W, H);
    }
    const scale = W / STATE.format.w, sig = audioSignal();

    if (img) {
      const spd = 0.4 + (STATE.speed / 100) * 2.2, wobble = Math.sin(t * spd * 2);
      let scaleV = 1 + wobble * 0.05 * (STATE.scale / 100) + sig.bass * 0.2 + sig.beat * 0.08;
      if (activeFx.includes("breathingGlow")) scaleV += (Math.sin(t * (1.4 + sig.bass * 2)) * 0.5 + 0.5) * 0.04;
      const rotV = STATE.preset === "Ghost Hardware Intro" ? wobble * 6 * (STATE.rotation / 100) : wobble * 6 * (STATE.rotation / 100);
      const r = Math.min(W * 0.72 / img.width, H * 0.72 / img.height) * scaleV;
      const dw = img.width * r, dh = img.height * r;
      const rgb = (STATE.rgbSplit / 100) * 8 * scale * (1 + sig.bass * 2 + sig.peak * 2);
      const shakeX = activeFx.includes("microShake") ? (Math.random() - 0.5) * (2 + sig.bass * 8) * scale : 0;
      const shakeY = activeFx.includes("microShake") ? (Math.random() - 0.5) * (2 + sig.bass * 8) * scale : 0;

      ctx.save();
      ctx.translate(W / 2 + shakeX, H / 2 + shakeY);
      ctx.rotate(rotV * Math.PI / 180);
      if (rgb > 0.3) {
        ctx.globalAlpha = 0.5; ctx.globalCompositeOperation = "screen";
        ctx.drawImage(img, -dw / 2 + rgb, -dh / 2, dw, dh);
        ctx.drawImage(img, -dw / 2 - rgb, -dh / 2, dw, dh);
        ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
      }
      let op = 1;
      if (activeFx.includes("glitchFlicker")) {
        const amt = STATE.flicker / 100;
        if (Math.random() < (0.05 + sig.beat * 0.25 + sig.peak * 0.2) * amt) op = 0.2;
      }
      ctx.globalAlpha = op;
      ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
    }

    if (STATE.scanline > 0) {
      if (transparent) ctx.globalCompositeOperation = "source-atop"; // clip to artwork
      ctx.fillStyle = `rgba(0,0,0,${(STATE.scanline / 100) * 0.5 * (1 + sig.high)})`;
      for (let y = 0; y < H; y += 3 * scale) ctx.fillRect(0, y, W, Math.max(1, scale));
      ctx.globalCompositeOperation = "source-over";
    }
    if (STATE.noise > 0) {
      const n = ctx.getImageData(0, 0, W, H), amt = (STATE.noise / 100) * 40 * (1 + sig.high), d = n.data;
      for (let i = 0; i < d.length; i += 4) {
        if (transparent && d[i + 3] === 0) continue;
        if (Math.random() < 0.3) { const v = (Math.random() - 0.5) * amt; d[i] += v; d[i + 1] += v; d[i + 2] += v; }
      }
      ctx.putImageData(n, 0, 0);
    }
    if (!transparent) {
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
      g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.45)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    if (!transparent && activeFx.includes("hardCut") && (sig.peak > 0.6 || sig.beat > 0.7)) {
      ctx.fillStyle = Math.random() < 0.5 ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, W, H);
    }
  }

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
    const s = STATE.exportScale, c = document.createElement("canvas");
    c.width = STATE.format.w * s; c.height = STATE.format.h * s; return c;
  }
  function downloadBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }
  function setExportStatus(msg, kind) {
    if (el.exportStatus) { el.exportStatus.textContent = msg; el.exportStatus.dataset.kind = kind || "info"; }
    if (kind === "done" || kind === "error") toast(msg);
  }

  /* A) PNG STILL */
  async function exportPNG(transparentOverride) {
    if (!activeAsset) { toast("Add an asset first"); return; }
    const transparent = transparentOverride !== undefined ? transparentOverride : (EXPORTOPTS.transparent || EXPORTOPTS.bg === "transparent");
    setExportStatus(transparent ? "Rendering transparent PNG…" : "Rendering PNG…", "work");
    const c = makeCanvas(), ctx = c.getContext("2d"), img = await assetToImage(activeAsset);
    const t = STATE.playing ? (performance.now() - startTime) / 1000 : 0;
    await drawExportFrame(ctx, c.width, c.height, img, t, { bg: transparent ? null : resolveExportBg(false) });
    c.toBlob((blob) => { downloadBlob(blob, transparent ? "phaser-still-transparent.png" : "phaser-still.png"); setExportStatus("Done — PNG saved", "done"); closeSheet(); }, "image/png");
  }

  /* B) PNG SEQUENCE */
  async function exportSequence(transparentOverride) {
    if (!activeAsset) { toast("Add an asset first"); return; }
    const transparent = transparentOverride !== undefined ? transparentOverride : (EXPORTOPTS.transparent || EXPORTOPTS.bg === "transparent");
    const fps = EXPORTOPTS.fps, dur = EXPORTOPTS.duration, total = Math.round(fps * dur);
    setExportStatus(`Rendering ${total} frames (${dur}s @ ${fps}fps)…`, "work");
    const c = makeCanvas(), ctx = c.getContext("2d"), img = await assetToImage(activeAsset);
    const bg = transparent ? null : resolveExportBg(false);
    for (let f = 0; f < total; f++) {
      await drawExportFrame(ctx, c.width, c.height, img, f / fps, { bg });
      await new Promise((res) => c.toBlob((blob) => { downloadBlob(blob, `phaser-seq-${String(f).padStart(4, "0")}.png`); setTimeout(res, 60); }, "image/png"));
      if (f % 10 === 0) setExportStatus(`Rendering frame ${f + 1}/${total}…`, "work");
    }
    setExportStatus("Done — sequence saved", "done"); closeSheet();
  }

  /* C) WEBM VIDEO */
  async function exportWebM(alphaOverride) {
    if (!activeAsset) { toast("Add an asset first"); return; }
    if (typeof MediaRecorder === "undefined") { setExportStatus("This browser can't record video — use PNG sequence", "error"); return; }
    const fps = EXPORTOPTS.fps;
    const wantAlpha = alphaOverride !== undefined ? alphaOverride : (EXPORTOPTS.transparent && EXPORTOPTS.bg === "transparent");
    setExportStatus(`Recording WebM (${EXPORTOPTS.duration}s @ ${fps}fps)…`, "work");
    const c = makeCanvas(), ctx = c.getContext("2d"), img = await assetToImage(activeAsset);
    const videoStream = c.captureStream(fps);
    let mixed = videoStream;
    if (EXPORTOPTS.includeAudio && audio.ready && audio.ctx) {
      try {
        audio.streamDest = audio.streamDest || audio.ctx.createMediaStreamDestination();
        audio.destGain.connect(audio.streamDest);
        const aTrack = audio.streamDest.stream.getAudioTracks()[0];
        if (aTrack) mixed = new MediaStream([...videoStream.getVideoTracks(), aTrack]);
        if (audio.ctx.state === "suspended") await audio.ctx.resume();
        audio.el.currentTime = 0; audio.el.play().catch(() => {});
      } catch (e) {}
    }
    const bg = wantAlpha ? null : resolveExportBg(true);
    let rec;
    try { rec = new MediaRecorder(mixed, { mimeType: pickWebmMime(), videoBitsPerSecond: EXPORTOPTS.quality === "high" ? 12000000 : 6000000 }); }
    catch (e) { setExportStatus("Recording not supported here — use PNG sequence", "error"); return; }
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      downloadBlob(blob, wantAlpha ? "phaser-motion-alpha.webm" : "phaser-motion.webm");
      LAST_WEBM_BLOB = blob;
      setExportStatus("Done — WebM saved", "done"); closeSheet();
    };
    const t0 = performance.now();
    rec.start();
    (function rf(now) {
      const elapsed = (now - t0) / 1000;
      drawExportFrame(ctx, c.width, c.height, img, elapsed, { bg });
      if (elapsed < EXPORTOPTS.duration) requestAnimationFrame(rf); else { rec.stop(); if (audio.ready) audio.el.pause(); }
    })(performance.now());
  }
  function pickWebmMime() {
    return ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm";
  }

  /* D) MP4 VIDEO (H.264) via ffmpeg.wasm
     ============================================================
     FFMPEG.WASM INTEGRATION POINT
     The full pipeline is here: record WebM (selected bg + audio),
     lazy-load ffmpeg.wasm, transcode to H.264 phaser-motion-reel.mp4.
     ffmpeg is ~30MB so its two <script> tags are COMMENTED OUT in
     index.html by default. Uncomment them to enable real MP4. Until
     then this shows a clear message and offers WebM (no app break).
     This is the ONLY place MP4 encoding lives.
     ============================================================ */
  let LAST_WEBM_BLOB = null, ffmpegInstance = null;

  async function loadFFmpeg() {
    if (ffmpegInstance) return ffmpegInstance;
    const hasNew = typeof window.FFmpeg !== "undefined" && window.FFmpeg.FFmpeg;
    const hasClassic = typeof window.FFmpeg !== "undefined" && window.FFmpeg.createFFmpeg;
    if (!hasNew && !hasClassic) return null;
    if (hasNew) { const { FFmpeg } = window.FFmpeg; const ff = new FFmpeg(); await ff.load(); ffmpegInstance = { api: "new", ff }; }
    else { const ff = window.FFmpeg.createFFmpeg({ log: false }); await ff.load(); ffmpegInstance = { api: "classic", ff }; }
    return ffmpegInstance;
  }

  async function exportMP4() {
    if (!activeAsset) { toast("Add an asset first"); return; }
    setExportStatus("Preparing render…", "work");
    if (!LAST_WEBM_BLOB) {
      setExportStatus("Recording source video for MP4…", "work");
      await recordWebMForMp4();
      if (!LAST_WEBM_BLOB) { setExportStatus("Could not record source video", "error"); return; }
    }
    let ff = null;
    try { ff = await loadFFmpeg(); } catch (e) { ff = null; }
    if (!ff) {
      downloadBlob(LAST_WEBM_BLOB, "phaser-motion-reel.webm");
      setExportStatus("MP4 export requires ffmpeg.wasm encoding. WebM and PNG sequence are available now — saved WebM. Uncomment the ffmpeg tags in index.html to enable H.264 MP4.", "error");
      return;
    }
    try {
      setExportStatus("Encoding H.264 MP4…", "work");
      const inName = "in.webm", outName = "phaser-motion-reel.mp4";
      const bytes = new Uint8Array(await LAST_WEBM_BLOB.arrayBuffer());
      const args = ["-i", inName, "-c:v", "libx264", "-preset", "veryfast", "-crf", EXPORTOPTS.quality === "high" ? "18" : "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-r", String(EXPORTOPTS.fps), "-c:a", "aac", "-b:a", "192k", outName];
      if (ff.api === "new") {
        await ff.ff.writeFile(inName, bytes);
        await ff.ff.exec(args);
        const out = await ff.ff.readFile(outName);
        downloadBlob(new Blob([out.buffer], { type: "video/mp4" }), outName);
      } else {
        ff.ff.FS("writeFile", inName, bytes);
        await ff.ff.run(...args);
        const out = ff.ff.FS("readFile", outName);
        downloadBlob(new Blob([out.buffer], { type: "video/mp4" }), outName);
      }
      setExportStatus("Done — phaser-motion-reel.mp4 saved", "done"); closeSheet();
    } catch (e) {
      downloadBlob(LAST_WEBM_BLOB, "phaser-motion-reel.webm");
      setExportStatus("MP4 encode failed — saved WebM as fallback", "error");
    }
  }

  function recordWebMForMp4() {
    return new Promise(async (resolve) => {
      if (typeof MediaRecorder === "undefined") { resolve(); return; }
      const fps = EXPORTOPTS.fps, c = makeCanvas(), ctx = c.getContext("2d"), img = await assetToImage(activeAsset);
      const videoStream = c.captureStream(fps);
      let mixed = videoStream;
      if (EXPORTOPTS.includeAudio && audio.ready && audio.ctx) {
        try {
          audio.streamDest = audio.streamDest || audio.ctx.createMediaStreamDestination();
          audio.destGain.connect(audio.streamDest);
          const aTrack = audio.streamDest.stream.getAudioTracks()[0];
          if (aTrack) mixed = new MediaStream([...videoStream.getVideoTracks(), aTrack]);
          if (audio.ctx.state === "suspended") await audio.ctx.resume();
          audio.el.currentTime = 0; audio.el.play().catch(() => {});
        } catch (e) {}
      }
      let rec;
      try { rec = new MediaRecorder(mixed, { mimeType: pickWebmMime(), videoBitsPerSecond: 12000000 }); }
      catch (e) { resolve(); return; }
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => { LAST_WEBM_BLOB = new Blob(chunks, { type: "video/webm" }); if (audio.ready) audio.el.pause(); resolve(); };
      const bg = resolveExportBg(true), t0 = performance.now();
      rec.start();
      (function rf(now) {
        const elapsed = (now - t0) / 1000;
        drawExportFrame(ctx, c.width, c.height, img, elapsed, { bg });
        if (elapsed < EXPORTOPTS.duration) requestAnimationFrame(rf); else rec.stop();
      })(performance.now());
    });
  }

  function syncExportUI() {
    const setA = (sel, val, attr) => $$(sel).forEach((b) => b.classList.toggle("active", b.dataset[attr] == val));
    setA("[data-fps]", EXPORTOPTS.fps, "fps");
    setA("[data-dur]", EXPORTOPTS.duration, "dur");
    setA("[data-vbg]", EXPORTOPTS.bg, "vbg");
    if (el.optTransparent) el.optTransparent.checked = EXPORTOPTS.transparent;
    if (el.optAudio) el.optAudio.checked = EXPORTOPTS.includeAudio;
  }

  /* ---------------- WIRING ---------------- */
  function wire() {
    $$(".rail-tab").forEach((tab) => tab.addEventListener("click", () => {
      $$(".rail-tab").forEach((t) => t.classList.remove("active"));
      $$(".tab-view").forEach((v) => v.classList.remove("active"));
      tab.classList.add("active");
      const view = document.querySelector(`.tab-view[data-view="${tab.dataset.tab}"]`);
      if (view) view.classList.add("active");
    }));

    el.dropzone.addEventListener("click", () => el.fileInput.click());
    el.dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.fileInput.click(); } });
    el.fileInput.addEventListener("change", (e) => handleFiles(e.target.files));
    ["dragenter", "dragover"].forEach((ev) => el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) => el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.remove("drag"); }));
    el.dropzone.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));
    el.canvasFrame.addEventListener("dragover", (e) => e.preventDefault());
    el.canvasFrame.addEventListener("drop", (e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); });

    $$(".fmt").forEach((b) => b.addEventListener("click", () => setFormat(+b.dataset.w, +b.dataset.h, b.dataset.label)));

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

    el.aiRun.addEventListener("click", runAI);
    el.aiPrompt.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runAI(); });

    el.generateGhost.addEventListener("click", generateGhostMotion);

    el.bgColor.addEventListener("input", (e) => setBackground("custom", e.target.value));
    $$(".bg-swatch").forEach((s) => s.addEventListener("click", () => setBackground(s.dataset.bg)));
    el.scaleSeg.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => {
      STATE.exportScale = +b.dataset.scale;
      el.scaleSeg.querySelectorAll(".seg-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
    }));
    if (el.audioReactiveToggle) el.audioReactiveToggle.addEventListener("change", (e) => { STATE.audioReactive = e.target.checked; toast(STATE.audioReactive ? "Audio-reactive on" : "Audio-reactive off"); });

    el.audioBtn.addEventListener("click", () => el.audioInput.click());
    el.audioInput.addEventListener("change", (e) => { if (e.target.files[0]) initAudio(e.target.files[0]); });

    // export modal
    el.exportBtn.addEventListener("click", openSheet);
    el.exportClose.addEventListener("click", closeSheet);
    el.exportSheet.addEventListener("click", (e) => { if (e.target === el.exportSheet) closeSheet(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
    el.exportPng.addEventListener("click", () => exportPNG(false));
    el.exportPngT.addEventListener("click", () => exportPNG(true));
    el.exportSeq.addEventListener("click", () => exportSequence(false));
    el.exportSeqT.addEventListener("click", () => exportSequence(true));
    el.exportWebm.addEventListener("click", () => exportWebM(false));
    el.exportWebmA.addEventListener("click", () => exportWebM(true));
    el.exportMp4.addEventListener("click", () => exportMP4());
    $$("[data-fps]").forEach((b) => b.addEventListener("click", () => { EXPORTOPTS.fps = +b.dataset.fps; syncExportUI(); }));
    $$("[data-dur]").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.dur === "custom") { const v = parseFloat(prompt("Custom duration in seconds:", String(EXPORTOPTS.duration)) || EXPORTOPTS.duration); if (v > 0) EXPORTOPTS.duration = Math.min(60, v); }
      else EXPORTOPTS.duration = +b.dataset.dur;
      syncExportUI();
    }));
    $$("[data-vbg]").forEach((b) => b.addEventListener("click", () => { EXPORTOPTS.bg = b.dataset.vbg; syncExportUI(); }));
    if (el.optTransparent) el.optTransparent.addEventListener("change", (e) => { EXPORTOPTS.transparent = e.target.checked; });
    if (el.optAudio) el.optAudio.addEventListener("change", (e) => { EXPORTOPTS.includeAudio = e.target.checked; });
  }

  /* ---------------- INIT ---------------- */
  function init() {
    buildPresets();
    buildControls();
    setBackground(STATE.bgMode, STATE.bgColor);
    setFormat(1080, 1920, "Reel");
    syncExportUI();
    wire();
    requestAnimationFrame(frame);
  }
  document.addEventListener("DOMContentLoaded", init);
})();
