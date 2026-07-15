/* ============================================================
   PHASER — Motion Editor — script.js
   Vanilla JS. No build step. GSAP optional (preset intros).

   Architecture:
     STATE        single source of truth for all params
     ASSETS       import + SVG parsing + asset cards + layers
     AUDIO        Web Audio API amplitude / bass / beat
     PRESETS      declarative param patches + render mode
     RENDER LOOP  requestAnimationFrame drives every effect
     AI PARSER    rule-based keywords -> STATE (swap for API later)
     CONTROLS     grouped sliders bound to STATE
     EXPORT       PNG frame / WebM clip / PNG sequence
   ============================================================ */

(() => {
  "use strict";

  /* ---------------- STATE ---------------- */
  const STATE = {
    speed: 50, glitch: 30, flicker: 25, scale: 30, rotation: 20,
    blur: 15, rgbSplit: 25, scanline: 40, noise: 20, audioReactivity: 60,
    bgColor: "#0B0B0F",
    format: { w: 1080, h: 1920, label: "9:16" },
    preset: null, playing: false, loop: true, exportScale: 1,
    audioLevel: 0, bassLevel: 0, beat: 0,
  };

  // Controls split into the two right-panel groups.
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
  };

  const PRESETS = {
    "Ghost Hardware":   { mode: "ghost",    speed: 40, glitch: 20, flicker: 45, scale: 15, rotation: 8,  blur: 10, rgbSplit: 30, scanline: 55, noise: 30 },
    "Glitch Pulse":     { mode: "glitch",   speed: 70, glitch: 85, flicker: 40, scale: 20, rotation: 5,  blur: 5,  rgbSplit: 70, scanline: 35, noise: 40 },
    "Signal Loss":      { mode: "signal",   speed: 55, glitch: 60, flicker: 80, scale: 8,  rotation: 3,  blur: 25, rgbSplit: 50, scanline: 65, noise: 60 },
    "CRT Scanline":     { mode: "crt",      speed: 30, glitch: 15, flicker: 30, scale: 5,  rotation: 0,  blur: 8,  rgbSplit: 20, scanline: 90, noise: 25 },
    "Data Corruption":  { mode: "data",     speed: 80, glitch: 95, flicker: 55, scale: 25, rotation: 12, blur: 6,  rgbSplit: 80, scanline: 40, noise: 70 },
    "Wireframe Reveal": { mode: "wireframe",speed: 45, glitch: 10, flicker: 15, scale: 35, rotation: 6,  blur: 4,  rgbSplit: 10, scanline: 25, noise: 10 },
    "Opacity Flicker":  { mode: "opacity",  speed: 60, glitch: 20, flicker: 90, scale: 5,  rotation: 0,  blur: 3,  rgbSplit: 15, scanline: 30, noise: 20 },
    "Bass Pulse":       { mode: "bass",     speed: 50, glitch: 25, flicker: 20, scale: 60, rotation: 5,  blur: 8,  rgbSplit: 30, scanline: 30, noise: 20, audioReactivity: 90 },
    "Wave Distortion":  { mode: "wave",     speed: 65, glitch: 40, flicker: 25, scale: 30, rotation: 15, blur: 20, rgbSplit: 45, scanline: 35, noise: 30 },
    "Rotation Drift":   { mode: "rotate",   speed: 35, glitch: 10, flicker: 12, scale: 12, rotation: 70, blur: 6,  rgbSplit: 15, scanline: 20, noise: 12 },
    "Scale Pop":        { mode: "scalepop", speed: 75, glitch: 15, flicker: 20, scale: 85, rotation: 8,  blur: 4,  rgbSplit: 20, scanline: 25, noise: 15 },
    "Layer Stagger":    { mode: "stagger",  speed: 50, glitch: 20, flicker: 30, scale: 40, rotation: 10, blur: 5,  rgbSplit: 25, scanline: 30, noise: 18 },
    "Cyber Fade In":    { mode: "fade",     speed: 40, glitch: 15, flicker: 20, scale: 30, rotation: 4,  blur: 12, rgbSplit: 20, scanline: 35, noise: 20 },
    "Microtype Scanner":{ mode: "scanner",  speed: 55, glitch: 25, flicker: 35, scale: 10, rotation: 2,  blur: 6,  rgbSplit: 30, scanline: 70, noise: 25 },
    "Techno Poster":    { mode: "poster",   speed: 60, glitch: 45, flicker: 30, scale: 45, rotation: 18, blur: 10, rgbSplit: 40, scanline: 40, noise: 30 },
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
  };

  /* ---------------- ASSETS ---------------- */
  const assets = [];
  let activeAsset = null, svgLayers = [], idSeq = 0;

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.toast.classList.remove("show"), 2200);
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

  function selectAsset(a) {
    activeAsset = a;
    el.assetHost.innerHTML = "";
    el.stageHint.style.display = "none";
    const clone = a.node.cloneNode(true);
    el.assetHost.appendChild(clone);
    a.live = clone;

    svgLayers = [];
    if (a.kind === "SVG") {
      svgLayers = Array.from(clone.querySelectorAll("g, path, rect, circle, ellipse, polygon, polyline, line, text"));
      if (!svgLayers.length) svgLayers = [clone];
    }
    renderAssetList();
    renderLayers();
    if (STATE.preset) applyPresetIntro();
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

  /* ---------------- AUDIO ---------------- */
  const audio = { ctx: null, el: null, source: null, analyser: null, freqData: null, timeData: null, ready: false, lastBeat: 0 };

  function initAudio(file) {
    if (audio.el) audio.el.pause();
    audio.el = new Audio(URL.createObjectURL(file));
    audio.el.loop = true;
    audio.ctx = audio.ctx || new (window.AudioContext || window.webkitAudioContext)();
    audio.source = audio.ctx.createMediaElementSource(audio.el);
    audio.analyser = audio.ctx.createAnalyser();
    audio.analyser.fftSize = 1024;
    audio.analyser.smoothingTimeConstant = 0.8;
    audio.source.connect(audio.analyser);
    audio.analyser.connect(audio.ctx.destination);
    audio.freqData = new Uint8Array(audio.analyser.frequencyBinCount);
    audio.timeData = new Uint8Array(audio.analyser.frequencyBinCount);
    audio.ready = true;
    el.waveEmpty.style.display = "none";
    el.playhead.style.opacity = "1";
    el.audioName.textContent = file.name;
    toast("Audio loaded");
  }

  function analyzeAudio() {
    if (!audio.ready || audio.el.paused) {
      STATE.audioLevel *= 0.9; STATE.bassLevel *= 0.9; STATE.beat *= 0.85;
      return;
    }
    audio.analyser.getByteFrequencyData(audio.freqData);
    audio.analyser.getByteTimeDomainData(audio.timeData);
    let sum = 0;
    for (let i = 0; i < audio.timeData.length; i++) { const v = (audio.timeData[i] - 128) / 128; sum += v * v; }
    STATE.audioLevel = STATE.audioLevel * 0.6 + Math.sqrt(sum / audio.timeData.length) * 0.4;
    let bass = 0; const bins = 12;
    for (let i = 0; i < bins; i++) bass += audio.freqData[i];
    bass /= bins * 255;
    STATE.bassLevel = STATE.bassLevel * 0.6 + bass * 0.4;
    const now = performance.now();
    if (bass > 0.55 && bass > STATE.bassLevel * 1.15 && now - audio.lastBeat > 180) { STATE.beat = 1; audio.lastBeat = now; }
    else STATE.beat *= 0.85;
    drawWaveform();
    updateTransport();
  }

  function drawWaveform() {
    const c = el.waveform, ctx = c.getContext("2d");
    const w = (c.width = c.clientWidth), h = (c.height = c.clientHeight);
    ctx.clearRect(0, 0, w, h);
    if (!audio.ready) return;
    // filled waveform
    const mid = h / 2, step = w / audio.timeData.length;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    for (let i = 0; i < audio.timeData.length; i++) {
      ctx.lineTo(i * step, ((audio.timeData[i] - 128) / 128) * (h * 0.42) + mid);
    }
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "rgba(124,92,255,0.5)");
    grad.addColorStop(1, "rgba(179,156,255,0.5)");
    ctx.strokeStyle = STATE.beat > 0.5 ? "#B39CFF" : grad;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    el.levelFill.style.height = Math.min(100, STATE.audioLevel * 220) + "%";
  }

  function updateTransport() {
    if (!audio.ready) return;
    const cur = audio.el.currentTime, dur = audio.el.duration || 1;
    el.playhead.style.left = (cur / dur) * 100 + "%";
    const m = Math.floor(cur / 60), s = Math.floor(cur % 60);
    el.timecode.textContent = `${m}:${String(s).padStart(2, "0")}`;
  }

  function togglePlay() {
    STATE.playing = !STATE.playing;
    el.playIcon.style.display = STATE.playing ? "none" : "block";
    el.pauseIcon.style.display = STATE.playing ? "block" : "none";
    if (STATE.playing) { startTime = performance.now(); if (audio.ready) { if (audio.ctx.state === "suspended") audio.ctx.resume(); audio.el.play(); } }
    else if (audio.ready) audio.el.pause();
  }

  /* ---------------- RENDER LOOP ---------------- */
  let startTime = performance.now();

  function frame(now) {
    requestAnimationFrame(frame);
    analyzeAudio();
    if (!STATE.playing) return;
    const t = (now - startTime) / 1000;
    const spd = 0.4 + (STATE.speed / 100) * 2.2;
    const react = STATE.audioReactivity / 100;
    const audioBoost = 1 + react * (STATE.audioLevel * 1.5 + STATE.beat * 1.2);
    const bassBoost = react * (STATE.bassLevel * 1.6 + STATE.beat);

    const scanFlicker = 0.85 + Math.sin(t * spd * 6) * 0.15 * (STATE.flicker / 100);
    el.canvasFrame.style.setProperty("--scanline-op", (STATE.scanline / 100) * scanFlicker);
    el.canvasFrame.style.setProperty("--noise-op", (STATE.noise / 100) * (0.6 + Math.random() * 0.4 * (STATE.noise / 100)));

    if (!activeAsset || !activeAsset.live) return;
    animateAsset(activeAsset.live, STATE.preset ? PRESETS[STATE.preset].mode : "default", t, spd, audioBoost, bassBoost);
    if (activeAsset.kind === "SVG" && svgLayers.length > 1) animateLayers(t, spd);
  }

  function animateAsset(host, mode, t, spd, audioBoost, bassBoost) {
    const g = STATE.glitch / 100, fl = STATE.flicker / 100, sc = STATE.scale / 100, rot = STATE.rotation / 100;
    const blur = (STATE.blur / 100) * 6 * audioBoost, rgb = (STATE.rgbSplit / 100) * 8;
    let tx = 0, ty = 0, scaleV = 1, rotV = 0, opacity = 1;
    const wobble = Math.sin(t * spd * 2), fast = Math.sin(t * spd * 9);

    switch (mode) {
      case "glitch": case "data":
        tx = Math.random() < 0.15 ? (Math.random() - 0.5) * 40 * g : 0;
        ty = Math.random() < 0.1 ? (Math.random() - 0.5) * 20 * g : 0;
        opacity = Math.random() < 0.08 * fl ? 0.3 : 1; break;
      case "signal":
        tx = (Math.random() - 0.5) * 30 * g; opacity = Math.random() < 0.25 * fl ? 0.15 : 1; break;
      case "bass": case "scalepop":
        scaleV = 1 + sc * 0.5 * (0.5 + 0.5 * wobble) + bassBoost * 0.4; break;
      case "rotate": rotV = t * spd * 20 * rot; break;
      case "wave":
        tx = wobble * 30 * sc; rotV = wobble * 10 * rot; scaleV = 1 + Math.sin(t * spd * 3) * 0.08 * sc; break;
      case "opacity": opacity = 0.4 + 0.6 * Math.abs(Math.sin(t * spd * 7 * (0.5 + fl))); break;
      case "crt": case "scanner": ty = Math.sin(t * spd * 1.5) * 4; opacity = 0.9 + 0.1 * fast; break;
      case "ghost": opacity = 0.55 + 0.45 * Math.abs(Math.sin(t * spd * 2)); tx = wobble * 6; break;
      case "fade": opacity = Math.min(1, (t % 4) / 2); scaleV = 0.9 + Math.min(1, (t % 4) / 2) * 0.1; break;
      case "poster": scaleV = 1 + Math.sin(t * spd * 2) * 0.12 * sc + bassBoost * 0.3; rotV = Math.sin(t * spd) * 8 * rot; break;
      case "stagger": case "wireframe": scaleV = 1 + Math.sin(t * spd * 2) * 0.05 * sc; break;
      default: scaleV = 1 + Math.sin(t * spd * 2) * 0.04 + bassBoost * 0.15; tx = wobble * 4;
    }
    scaleV += STATE.beat * 0.12 * (STATE.audioReactivity / 100);

    host.style.transform = `translate(${tx}px, ${ty}px) scale(${scaleV.toFixed(3)}) rotate(${rotV.toFixed(2)}deg)`;
    host.style.opacity = opacity.toFixed(2);
    const hue = (mode === "data" || mode === "glitch") ? Math.sin(t * spd * 4) * 40 * g : 0;
    const shadow = rgb * (1 + STATE.beat);
    host.style.filter =
      `blur(${blur.toFixed(2)}px) drop-shadow(${shadow.toFixed(1)}px 0 0 rgba(124,92,255,0.55)) ` +
      `drop-shadow(${(-shadow).toFixed(1)}px 0 0 rgba(179,156,255,0.55)) hue-rotate(${hue.toFixed(0)}deg)`;
  }

  function animateLayers(t, spd) {
    const fl = STATE.flicker / 100;
    svgLayers.forEach((layer, i) => {
      const phase = i * 0.35;
      const flick = Math.random() < 0.04 * fl ? 0.2 : 1;
      layer.style.opacity = (0.75 + 0.25 * Math.sin(t * spd * 3 + phase)) * flick;
      layer.style.transformBox = "fill-box";
      layer.style.transform = `translate(${(Math.sin(t * spd + phase) * 3 * (STATE.glitch / 100)).toFixed(2)}px,0)`;
    });
  }

  /* ---------------- PRESETS ---------------- */
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
    Object.keys(p).forEach((k) => { if (k !== "mode") STATE[k] = p[k]; });
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

  /* ---------------- AI PARSER (rule-based; swap body for API) ---------------- */
  const AI_RULES = [
    { kw: ["glitch", "glitchy", "broken", "corrupt"], apply: () => { bump("glitch", 30); bump("rgbSplit", 20); bump("noise", 15); }, say: "More glitch" },
    { kw: ["bass", "beat", "sync", "drop"], apply: () => { bump("audioReactivity", 30); bump("scale", 20); STATE.preset = "Bass Pulse"; }, say: "Synced to bass" },
    { kw: ["slow", "slower", "calm", "gentle"], apply: () => { set("speed", 25); bump("flicker", -15); }, say: "Slower" },
    { kw: ["fast", "faster", "hyper", "rapid"], apply: () => { set("speed", 85); bump("flicker", 15); }, say: "Faster" },
    { kw: ["dark", "darker", "moody"], apply: () => { STATE.bgColor = "#050506"; bump("scanline", 15); syncBg(); }, say: "Darker" },
    { kw: ["bright", "brighter", "light"], apply: () => { STATE.bgColor = "#15161a"; bump("blur", -10); syncBg(); }, say: "Brighter" },
    { kw: ["scanline", "scanlines", "crt"], apply: () => { bump("scanline", 35); STATE.preset = "CRT Scanline"; }, say: "Scanlines added" },
    { kw: ["flicker", "flickery", "strobe"], apply: () => bump("flicker", 35), say: "More flicker" },
    { kw: ["reel", "vertical", "9:16"], apply: () => setFormat(1080, 1920, "9:16"), say: "Format → 9:16" },
    { kw: ["poster", "print"], apply: () => { STATE.preset = "Techno Poster"; }, say: "Poster motion" },
    { kw: ["minimal", "clean", "simple", "readable"], apply: () => { set("glitch", 12); set("noise", 10); set("flicker", 15); bump("blur", -8); }, say: "Cleaned up" },
    { kw: ["intense", "harder", "aggressive", "more"], apply: () => { bump("glitch", 20); bump("scale", 15); bump("audioReactivity", 15); }, say: "More intense" },
    { kw: ["loop", "loopable", "seamless"], apply: () => { STATE.loop = true; el.loopBtn.classList.add("active"); el.loopBtn.dataset.on = "true"; }, say: "Loop on" },
    { kw: ["ghost", "hardware"], apply: () => { STATE.preset = "Ghost Hardware"; }, say: "Ghost hardware" },
  ];
  const bump = (k, d) => (STATE[k] = clamp(STATE[k] + d));
  const set = (k, v) => (STATE[k] = clamp(v));
  const clamp = (v) => Math.max(0, Math.min(100, v));

  function runAI() {
    const text = el.aiPrompt.value.toLowerCase().trim();
    if (!text) { el.aiEcho.textContent = "Type a direction first, like \u201cmake it more glitchy.\u201d"; return; }
    const hits = [];
    AI_RULES.forEach((r) => { if (r.kw.some((k) => text.includes(k))) { r.apply(); hits.push(r.say); } });
    if (STATE.preset && PRESETS[STATE.preset]) $$(".preset").forEach((c) => c.classList.toggle("active", c.textContent.trim() === STATE.preset));
    syncControls();
    if (!STATE.playing) togglePlay();
    applyPresetIntro();
    el.aiEcho.textContent = hits.length ? hits.join(" · ") : "No keywords matched. Try: glitch, bass, slow, dark, scanlines, minimal.";
  }

  /* ---------------- CONTROLS ---------------- */
  function buildControls() {
    Object.entries(CONTROL_GROUPS).forEach(([group, items]) => {
      const container = document.querySelector(`.controls[data-group="${group}"]`);
      items.forEach(({ key, label }) => {
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
      });
    });
  }

  function syncControls() {
    [...CONTROL_GROUPS.animation, ...CONTROL_GROUPS.effects].forEach(({ key }) => {
      const input = document.getElementById(`ctl-${key}`), val = document.getElementById(`val-${key}`);
      if (input) { input.value = STATE[key]; input.style.setProperty("--pct", STATE[key] + "%"); }
      if (val) val.textContent = STATE[key];
    });
  }

  function syncBg() {
    el.bgColor.value = STATE.bgColor;
    el.bgHex.textContent = STATE.bgColor.toUpperCase();
    el.canvasFrame.style.setProperty("--frame-bg", STATE.bgColor);
  }

  /* ---------------- FORMAT ---------------- */
  function setFormat(w, h, label) {
    STATE.format = { w, h, label };
    el.canvasFrame.style.aspectRatio = `${w} / ${h}`;
    el.readoutFormat.textContent = `${w} × ${h}`;
    $$(".fmt").forEach((b) => b.classList.toggle("active", +b.dataset.w === w && +b.dataset.h === h && b.dataset.label === label));
  }

  /* ---------------- EXPORT ---------------- */
  function openSheet() { el.exportSheet.hidden = false; }
  function closeSheet() { el.exportSheet.hidden = true; }

  async function captureFrameCanvas() {
    const scale = STATE.exportScale;
    const W = STATE.format.w * scale, H = STATE.format.h * scale;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = STATE.bgColor; ctx.fillRect(0, 0, W, H);
    if (activeAsset && activeAsset.live) {
      const img = await assetToImage(activeAsset);
      if (img) {
        const r = Math.min(W * 0.72 / img.width, H * 0.72 / img.height);
        const dw = img.width * r, dh = img.height * r, dx = (W - dw) / 2, dy = (H - dh) / 2;
        const rgb = (STATE.rgbSplit / 100) * 8 * scale;
        ctx.globalAlpha = 0.55; ctx.globalCompositeOperation = "screen";
        ctx.drawImage(img, dx + rgb, dy, dw, dh); ctx.drawImage(img, dx - rgb, dy, dw, dh);
        ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
        ctx.drawImage(img, dx, dy, dw, dh);
      }
    }
    if (STATE.scanline > 0) { ctx.fillStyle = `rgba(0,0,0,${(STATE.scanline / 100) * 0.5})`; for (let y = 0; y < H; y += 3 * scale) ctx.fillRect(0, y, W, scale); }
    if (STATE.noise > 0) {
      const n = ctx.getImageData(0, 0, W, H), amt = (STATE.noise / 100) * 40;
      for (let i = 0; i < n.data.length; i += 4) if (Math.random() < 0.3) { const v = (Math.random() - 0.5) * amt; n.data[i] += v; n.data[i+1] += v; n.data[i+2] += v; }
      ctx.putImageData(n, 0, 0);
    }
    const grad = ctx.createRadialGradient(W/2, H/2, Math.min(W,H)*0.3, W/2, H/2, Math.max(W,H)*0.7);
    grad.addColorStop(0, "rgba(0,0,0,0)"); grad.addColorStop(1, "rgba(0,0,0,0.5)");
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
    return canvas;
  }

  function assetToImage(asset) {
    return new Promise((resolve) => {
      if (asset.kind === "IMG") { resolve(asset.node); return; }
      const svgStr = new XMLSerializer().serializeToString(asset.live);
      const url = URL.createObjectURL(new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" }));
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  function downloadCanvas(canvas, name) {
    canvas.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, "image/png");
  }

  async function exportPNG() {
    if (!activeAsset) { toast("Add an asset first"); return; }
    closeSheet(); toast("Rendering frame…");
    downloadCanvas(await captureFrameCanvas(), `phaser_frame_${Date.now()}.png`);
  }

  async function exportWebM(durationMs = 4000) {
    if (!activeAsset) { toast("Add an asset first"); return; }
    if (typeof MediaRecorder === "undefined") { toast("Video isn't supported here — try a frame sequence"); return; }
    closeSheet(); toast("Recording clip…");
    const scale = STATE.exportScale;
    const canvas = document.createElement("canvas");
    canvas.width = STATE.format.w * scale; canvas.height = STATE.format.h * scale;
    const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: pickWebmMime(), videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(chunks, { type: "video/webm" }));
      a.download = `phaser_clip_${Date.now()}.webm`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast("Clip saved");
    };
    const ctx = canvas.getContext("2d"), img = await assetToImage(activeAsset), t0 = performance.now();
    rec.start();
    /* ── MP4 HOOK: transcode this WebM blob with ffmpeg.wasm, or POST
       the blob / frame sequence to a server running FFmpeg. Frames are
       already full-res, so only the encode step needs adding. ── */
    (function recFrame(now) {
      const elapsed = now - t0;
      drawExportFrame(ctx, canvas, img, elapsed / 1000);
      elapsed < durationMs ? requestAnimationFrame(recFrame) : rec.stop();
    })(performance.now());
  }

  function pickWebmMime() {
    return ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm";
  }

  function drawExportFrame(ctx, canvas, img, t) {
    const W = canvas.width, H = canvas.height, scale = W / STATE.format.w;
    ctx.fillStyle = STATE.bgColor; ctx.fillRect(0, 0, W, H);
    if (img) {
      const spd = 0.4 + (STATE.speed / 100) * 2.2, wobble = Math.sin(t * spd * 2);
      const scaleV = 1 + wobble * 0.06 * (STATE.scale / 100);
      const rotV = STATE.preset === "Rotation Drift" ? t * spd * 20 * (STATE.rotation/100) : wobble * 6 * (STATE.rotation/100);
      const r = Math.min(W * 0.72 / img.width, H * 0.72 / img.height) * scaleV;
      const dw = img.width * r, dh = img.height * r, rgb = (STATE.rgbSplit / 100) * 8 * scale;
      ctx.save(); ctx.translate(W/2, H/2); ctx.rotate(rotV * Math.PI / 180);
      ctx.globalAlpha = 0.55; ctx.globalCompositeOperation = "screen";
      ctx.drawImage(img, -dw/2 + rgb, -dh/2, dw, dh); ctx.drawImage(img, -dw/2 - rgb, -dh/2, dw, dh);
      ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
      ctx.drawImage(img, -dw/2, -dh/2, dw, dh); ctx.restore();
    }
    if (STATE.scanline > 0) { ctx.fillStyle = `rgba(0,0,0,${(STATE.scanline / 100) * 0.5})`; for (let y = 0; y < H; y += 3 * scale) ctx.fillRect(0, y, W, scale); }
  }

  async function exportSequence(frames = 30) {
    if (!activeAsset) { toast("Add an asset first"); return; }
    closeSheet(); toast(`Rendering ${frames} frames…`);
    const scale = STATE.exportScale;
    const canvas = document.createElement("canvas");
    canvas.width = STATE.format.w * scale; canvas.height = STATE.format.h * scale;
    const ctx = canvas.getContext("2d"), img = await assetToImage(activeAsset);
    for (let f = 0; f < frames; f++) {
      drawExportFrame(ctx, canvas, img, f / 15);
      await new Promise((res) => canvas.toBlob((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = `phaser_seq_${String(f).padStart(3, "0")}.png`; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 500);
        setTimeout(res, 90);
      }, "image/png"));
    }
    toast("Sequence saved");
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

    // appearance
    el.bgColor.addEventListener("input", (e) => { STATE.bgColor = e.target.value; syncBg(); });
    el.scaleSeg.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => {
      STATE.exportScale = +b.dataset.scale;
      el.scaleSeg.querySelectorAll(".seg-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
    }));

    // audio
    el.audioBtn.addEventListener("click", () => el.audioInput.click());
    el.audioInput.addEventListener("change", (e) => { if (e.target.files[0]) initAudio(e.target.files[0]); });

    // export
    el.exportBtn.addEventListener("click", openSheet);
    el.exportClose.addEventListener("click", closeSheet);
    el.exportSheet.addEventListener("click", (e) => { if (e.target === el.exportSheet) closeSheet(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
    el.exportPng.addEventListener("click", exportPNG);
    el.exportWebm.addEventListener("click", () => exportWebM());
    el.exportSeq.addEventListener("click", () => exportSequence());
  }

  /* ---------------- INIT ---------------- */
  function init() {
    buildPresets();
    buildControls();
    syncBg();
    setFormat(1080, 1920, "9:16");
    wire();
    requestAnimationFrame(frame);
  }
  document.addEventListener("DOMContentLoaded", init);
})();
