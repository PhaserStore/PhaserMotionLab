/* ============================================================
   PHASER — Motion Editor — script.js  (multi-layer + timeline)
   Vanilla JS. No npm, no React, no build, no server (basic version).
   GSAP + ffmpeg.wasm optional. GitHub Pages ready.

   MODEL
     layers[]   ordered back->front; each is an independent object with
                its own transform, timing (start/duration), effect set,
                and a per-layer "recipe" (phase/freq/amp/band/delay).
     Each layer renders as an absolutely-positioned DOM element inside
     #layerHost for the live preview, and is drawn onto a shared canvas
     for export so preview and output match.

   SECTIONS
     STATE · ASSETS · LAYERS · TIMELINE · AUDIO · EFFECTS ·
     RENDER LOOP · PRESETS · AI DIRECTOR · CONTROLS · BACKGROUND ·
     FORMAT · EXPORT · WIRING · INIT
   Every id/selector referenced here exists in index.html, and every
   button in index.html is wired in wire().
   ============================================================ */

(() => {
  "use strict";

  /* ---------------- STATE ---------------- */
  const STATE = {
    // scene-level effect strengths (overlays + shared params)
    speed: 50, glitch: 30, flicker: 25, scale: 30, rotation: 20,
    blur: 15, rgbSplit: 25, scanline: 40, noise: 20, audioReactivity: 60,
    // beat-sync engine
    beatSensitivity: 55, bassReaction: 70, midReaction: 50, highReaction: 50,
    smoothing: 60, peakThreshold: 60, motionIntensity: 70, syncTightness: 65,
    audioReactive: true,
    // output
    bgMode: "custom", bgColor: "#0B0B0F", bgColor2: "#1A1030",
    format: { w: 1080, h: 1080, label: "Post" },
    duration: 8, fps: 30, playing: false, loop: true, exportScale: 1,
    // live audio runtime
    audioLevel: 0, bassLevel: 0, midLevel: 0, highLevel: 0, beat: 0, peak: 0, buildup: 0,
    // playback clock
    time: 0,
  };

  const CONTROL_GROUPS = {
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
      { key: "speed", label: "Speed" },
      { key: "glitch", label: "Glitch" },
      { key: "blur", label: "Blur" },
      { key: "rgbSplit", label: "RGB split" },
      { key: "scanline", label: "Scanlines" },
      { key: "noise", label: "Noise" },
    ],
  };

  // The 12 effect modules available per layer (label + key).
  const FX_LIBRARY = [
    { key: "blurIn", label: "Blur-in" },
    { key: "hardCut", label: "Hard cut" },
    { key: "glitchFlicker", label: "Glitch flicker" },
    { key: "rgbSplit", label: "RGB split" },
    { key: "scanlineReveal", label: "Scanline" },
    { key: "digitalNoise", label: "Digital noise" },
    { key: "microShake", label: "Micro-shake" },
    { key: "hud", label: "HUD overlay" },
    { key: "symbolMorph", label: "Symbol morph" },
    { key: "breathingGlow", label: "Breathing glow" },
    { key: "card3d", label: "3D card" },
    { key: "ripple", label: "Ripple" },
  ];

  /* ---------------- PRESETS ----------------
     mode: base motion feel. fx: which modules turn on. patch: scene params. */
  const PRESETS = {
    "Ghost Software":       { mode: "ghost",   fx: ["rgbSplit","scanlineReveal","hud","microShake","glitchFlicker","digitalNoise","breathingGlow"], patch: { speed: 42, glitch: 22, flicker: 45, rgbSplit: 32, scanline: 55, noise: 28, bassReaction: 72 } },
    "Signal Loss":          { mode: "signal",  fx: ["hardCut","digitalNoise","rgbSplit","glitchFlicker","scanlineReveal"], patch: { speed: 55, glitch: 60, flicker: 80, blur: 22, rgbSplit: 50, scanline: 65, noise: 60 } },
    "Terrain Scanner":      { mode: "scanner", fx: ["scanlineReveal","hud","glitchFlicker","breathingGlow"], patch: { speed: 45, glitch: 20, flicker: 35, scanline: 75, noise: 20, bassReaction: 75 } },
    "Detroit Techno":       { mode: "poster",  fx: ["hardCut","glitchFlicker","breathingGlow","microShake"], patch: { speed: 65, glitch: 30, flicker: 40, scanline: 30, noise: 15, bassReaction: 95, motionIntensity: 90 } },
    "Data Corruption":      { mode: "data",    fx: ["digitalNoise","glitchFlicker","rgbSplit","microShake","hardCut"], patch: { speed: 80, glitch: 95, flicker: 55, rgbSplit: 80, scanline: 40, noise: 70 } },
    "Clean Motion Poster":  { mode: "fade",    fx: ["blurIn","breathingGlow"], patch: { speed: 35, glitch: 6, flicker: 10, blur: 14, rgbSplit: 8, scanline: 12, noise: 6 } },
    "CRT Monitor":          { mode: "crt",     fx: ["scanlineReveal","digitalNoise","breathingGlow","ripple"], patch: { speed: 30, glitch: 12, flicker: 28, blur: 9, scanline: 95, noise: 30 } },
    "Ghost Hardware Intro": { mode: "stagger", fx: ["blurIn","scanlineReveal","hud","rgbSplit","microShake"], patch: { speed: 48, glitch: 18, flicker: 30, blur: 12, rgbSplit: 32, scanline: 45, noise: 20, bassReaction: 80 } },
  };

  /* ---------------- DOM ---------------- */
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const el = {
    dropzone: $("#dropzone"), fileInput: $("#fileInput"),
    assetList: $("#assetList"), assetCount: $("#assetCount"),
    presetGrid: $("#presetGrid"), applyGhostAll: $("#applyGhostAll"),
    layerStack: $("#layerStack"), layerCount: $("#layerCount"),
    canvasFrame: $("#canvasFrame"), layerHost: $("#layerHost"), stageHint: $("#stageHint"),
    readoutFormat: $("#readoutFormat"), readoutFps: $("#readoutFps"), readoutSel: $("#readoutSel"),
    playBtn: $("#playBtn"), playIcon: $("#playIcon"), pauseIcon: $("#pauseIcon"),
    topPlayBtn: $("#topPlayBtn"), topPlayIcon: $("#topPlayIcon"), topPauseIcon: $("#topPauseIcon"),
    loopBtn: $("#loopBtn"), timecode: $("#timecode"),
    aiPrompt: $("#aiPrompt"), aiRun: $("#aiRun"), aiEcho: $("#aiEcho"),
    bgColor: $("#bgColor"), bgHex: $("#bgHex"), scaleSeg: $("#scaleSeg"),
    audioBtn: $("#audioBtn"), audioInput: $("#audioInput"),
    levelFill: $("#levelFill"), audioName: $("#audioName"),
    audioReactiveToggle: $("#audioReactiveToggle"), beatMeter: $("#beatMeter"),
    // layer props
    layerPropsEmpty: $("#layerPropsEmpty"), layerPropsBody: $("#layerPropsBody"),
    fxToggleGrid: $("#fxToggleGrid"),
    layerDup: $("#layerDup"), layerHide: $("#layerHide"), layerDel: $("#layerDel"),
    // timeline
    tlBody: $("#tlBody"), tlRuler: $("#tlRuler"), tlTracks: $("#tlTracks"), tlEmpty: $("#tlEmpty"), tlPlayhead: $("#tlPlayhead"),
    durSegTl: $("#durSegTl"),
    // export
    exportBtn: $("#exportBtn"), exportSheet: $("#exportSheet"), exportClose: $("#exportClose"),
    exportPng: $("#exportPng"), exportPngT: $("#exportPngT"), exportSeq: $("#exportSeq"), exportSeqT: $("#exportSeqT"),
    exportWebm: $("#exportWebm"), exportWebmA: $("#exportWebmA"), exportMp4: $("#exportMp4"),
    exportStatus: $("#exportStatus"), optTransparent: $("#optTransparent"), optAudio: $("#optAudio"),
    toast: $("#toast"),
  };

  /* ---------------- ASSETS + LAYERS ---------------- */
  const assets = [];    // imported files (source library)
  const layers = [];    // placed layers (the scene), index 0 = back
  let selectedLayer = null, idSeq = 0;

  function toast(msg) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.toast.classList.remove("show"), 2400);
  }

  function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let added = 0;
    files.forEach((file) => {
      const reader = new FileReader();
      if (file.type.includes("svg") || file.name.toLowerCase().endsWith(".svg")) {
        reader.onload = (e) => addSvgAsset(file.name, e.target.result);
        reader.readAsText(file);
        added++;
      } else if (file.type.startsWith("image/")) {
        reader.onload = (e) => addImageAsset(file.name, e.target.result);
        reader.readAsDataURL(file);
        added++;
      }
    });
    if (!added) toast("No supported files (SVG, PNG, JPG, WebP)");
  }

  function addSvgAsset(name, svgText) {
    try {
      const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
      const svg = doc.querySelector("svg");
      if (!svg || doc.querySelector("parsererror")) { toast(`Couldn't read ${name}`); return; }
      if (!svg.getAttribute("viewBox")) {
        const w = parseFloat(svg.getAttribute("width")) || 300, h = parseFloat(svg.getAttribute("height")) || 300;
        svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      }
      svg.removeAttribute("width"); svg.removeAttribute("height");
      registerAsset(name, "SVG", document.importNode(svg, true));
    } catch (e) { toast(`Couldn't read ${name}`); }
  }
  function addImageAsset(name, dataUrl) {
    const img = new Image();
    img.onload = () => registerAsset(name, "IMG", img, dataUrl);
    img.onerror = () => toast(`Couldn't load ${name}`);
    img.src = dataUrl; img.alt = name; img.crossOrigin = "anonymous";
  }
  function registerAsset(name, kind, node, dataUrl) {
    const asset = { id: ++idSeq, name, kind, node, dataUrl };
    assets.push(asset);
    renderAssetList();
    addLayerFromAsset(asset); // auto-place the first time it's imported
    toast(`Added ${name}`);
  }

  function renderAssetList() {
    el.assetCount.textContent = assets.length;
    if (!assets.length) { el.assetList.innerHTML = '<div class="empty-note">Nothing here yet. Add files to start.</div>'; return; }
    el.assetList.innerHTML = "";
    assets.forEach((a) => {
      const card = document.createElement("div");
      card.className = "asset-card";
      const thumb = a.kind === "IMG" ? `<img class="asset-thumb" src="${a.dataUrl}" alt="">` : `<div class="asset-thumb">${svgThumb(a.node)}</div>`;
      card.innerHTML = `<span class="asset-kind">${a.kind}</span><button class="asset-del" title="Remove from library">\u00d7</button>` + thumb;
      card.title = `${a.name} — click to add as a layer`;
      card.addEventListener("click", (e) => {
        if (e.target.classList.contains("asset-del")) { removeAsset(a); e.stopPropagation(); }
        else { addLayerFromAsset(a); toast(`Layer added: ${a.name}`); }
      });
      el.assetList.appendChild(card);
    });
  }
  function svgThumb(node) { const c = node.cloneNode(true); c.setAttribute("width", "100%"); c.setAttribute("height", "100%"); return c.outerHTML; }
  function removeAsset(a) {
    const i = assets.indexOf(a); if (i >= 0) assets.splice(i, 1);
    renderAssetList();
  }

  // Split <text> into per-glyph tspans (for glitch-flicker on text layers).
  function splitTextNodes(root) {
    root.querySelectorAll("text").forEach((t) => {
      const raw = t.textContent;
      if (!raw || t.dataset.split || t.querySelector("tspan")) return;
      t.dataset.split = "1"; t.textContent = "";
      [...raw].forEach((ch) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "tspan"); s.textContent = ch; s.setAttribute("data-glyph", "1"); t.appendChild(s); });
    });
  }

  /* ---------------- LAYER CREATION ---------------- */
  function addLayerFromAsset(asset) {
    const id = ++idSeq;
    // Build the live DOM node for the preview.
    let node;
    if (asset.kind === "SVG") { node = asset.node.cloneNode(true); splitTextNodes(node); }
    else { node = new Image(); node.src = asset.dataUrl; }
    const wrap = document.createElement("div");
    wrap.className = "layer-el";
    wrap.appendChild(node);
    el.layerHost.appendChild(wrap);

    // Parse SVG sublayers (independent animation targets).
    let subLayers = [];
    if (asset.kind === "SVG") {
      subLayers = Array.from(node.querySelectorAll("g, path, rect, circle, ellipse, polygon, polyline, line, text, use"))
        .filter((n) => !(n.tagName.toLowerCase() === "g" && n.children.length === 0));
      subLayers.forEach((s, i) => assignRecipe(s, id * 97 + i));
    }

    const layer = {
      id, name: asset.name, kind: asset.kind, assetId: asset.id,
      node, wrap, subLayers,
      visible: true,
      transform: { x: 0, y: 0, scale: 100, rot: 0, opacity: 100 },
      start: 0, duration: STATE.duration,
      fx: [],                        // active effect module keys
      recipe: makeRecipe(id * 131),  // layer-level recipe for stagger/variety
    };
    layers.push(layer);
    renderLayers(); renderTimeline(); selectLayer(layer);
    updateHintVisibility();
    if (!STATE.playing) togglePlay();
  }

  function makeRecipe(seed) {
    const rnd = mulberry32((seed + 1) >>> 0);
    const band = ["bass", "mid", "high"][Math.floor(rnd() * 3)];
    return { phase: rnd() * Math.PI * 2, ampX: 2 + rnd() * 9, ampY: 1 + rnd() * 6, freq: 0.6 + rnd() * 2.4, rot: (rnd() - 0.5) * 10, flickerBias: 0.3 + rnd() * 0.7, band, delay: rnd() * 0.8 };
  }
  function assignRecipe(node, seed) { node._recipe = makeRecipe(seed); }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  function updateHintVisibility() { el.stageHint.style.display = layers.length ? "none" : ""; }

  function duplicateLayer(layer) {
    const asset = assets.find((a) => a.id === layer.assetId) || { id: layer.assetId, name: layer.name, kind: layer.kind, node: layer.node, dataUrl: layer.node.src };
    addLayerFromAsset(asset);
    const dup = layers[layers.length - 1];
    dup.transform = { ...layer.transform, x: layer.transform.x + 4, y: layer.transform.y + 4 };
    dup.fx = layer.fx.slice(); dup.start = layer.start; dup.duration = layer.duration;
    renderLayers(); renderTimeline();
  }
  function deleteLayer(layer) {
    const i = layers.indexOf(layer); if (i < 0) return;
    if (layer.wrap && layer.wrap.parentNode) layer.wrap.parentNode.removeChild(layer.wrap);
    layers.splice(i, 1);
    if (selectedLayer === layer) selectedLayer = null;
    renderLayers(); renderTimeline(); renderLayerProps(); updateHintVisibility();
  }
  function toggleLayerVisible(layer) {
    layer.visible = !layer.visible;
    layer.wrap.style.display = layer.visible ? "" : "none";
    renderLayers();
  }

  /* ---------------- LAYER STACK (left panel) ---------------- */
  function renderLayers() {
    el.layerCount.textContent = layers.length;
    applyZOrder();
    if (!layers.length) { el.layerStack.innerHTML = '<li class="empty-note">Add an asset to create a layer.</li>'; return; }
    el.layerStack.innerHTML = "";
    // show front layer at top of the list (reverse of draw order)
    [...layers].reverse().forEach((layer) => {
      const li = document.createElement("li");
      li.className = "layer-row" + (layer === selectedLayer ? " selected" : "") + (layer.visible ? "" : " hidden-layer");
      li.draggable = true;
      li.dataset.id = layer.id;
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

  // Drag to reorder within the stack (updates draw order).
  let dragLayer = null;
  function addLayerDrag(li, layer) {
    li.addEventListener("dragstart", (e) => { dragLayer = layer; li.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
    li.addEventListener("dragend", () => { li.classList.remove("dragging"); $$(".layer-row").forEach((r) => r.classList.remove("drop-above", "drop-below")); dragLayer = null; });
    li.addEventListener("dragover", (e) => {
      e.preventDefault();
      const rect = li.getBoundingClientRect(), below = e.clientY > rect.top + rect.height / 2;
      $$(".layer-row").forEach((r) => r.classList.remove("drop-above", "drop-below"));
      li.classList.add(below ? "drop-below" : "drop-above");
    });
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!dragLayer || dragLayer === layer) return;
      const rect = li.getBoundingClientRect(), below = e.clientY > rect.top + rect.height / 2;
      const from = layers.indexOf(dragLayer);
      layers.splice(from, 1);
      let to = layers.indexOf(layer);
      // list is reversed (front on top); "below" in the list = lower z
      to = below ? to : to + 1;
      layers.splice(Math.max(0, to), 0, dragLayer);
      renderLayers(); renderTimeline();
    });
  }

  function applyZOrder() { layers.forEach((layer, i) => { if (layer.wrap) layer.wrap.style.zIndex = String(i + 1); }); }

  function selectLayer(layer) {
    selectedLayer = layer;
    renderLayers(); renderLayerProps(); renderTimeline();
    el.readoutSel.textContent = layer ? layer.name : "No layer selected";
    layers.forEach((l) => l.wrap && l.wrap.classList.toggle("selected-outline", l === layer));
  }

  /* ---------------- LAYER PROPS (right panel) ---------------- */
  function renderLayerProps() {
    const has = !!selectedLayer;
    el.layerPropsEmpty.hidden = has;
    el.layerPropsBody.hidden = !has;
    if (!has) return;
    const t = selectedLayer.transform;
    setSlider("x", t.x); setSlider("y", t.y); setSlider("lscale", t.scale); setSlider("lrot", t.rot); setSlider("lop", t.opacity);
    el.layerHide.textContent = selectedLayer.visible ? "Hide" : "Show";
    // fx toggles
    el.fxToggleGrid.innerHTML = "";
    FX_LIBRARY.forEach((fx) => {
      const b = document.createElement("button");
      b.className = "fx-toggle" + (selectedLayer.fx.includes(fx.key) ? " on" : "");
      b.innerHTML = `<span class="fx-dot"></span>${fx.label}`;
      b.addEventListener("click", () => {
        const idx = selectedLayer.fx.indexOf(fx.key);
        if (idx >= 0) selectedLayer.fx.splice(idx, 1); else selectedLayer.fx.push(fx.key);
        b.classList.toggle("on");
        if (!STATE.playing) togglePlay();
      });
      el.fxToggleGrid.appendChild(b);
    });
  }
  function setSlider(key, val) {
    const input = document.getElementById(`ctl-${key}`), out = document.getElementById(`val-${key}`);
    if (input) { input.value = val; const min = +input.min, max = +input.max; input.style.setProperty("--pct", ((val - min) / (max - min) * 100) + "%"); }
    if (out) out.textContent = Math.round(val);
  }
  function bindLayerSlider(key, prop) {
    const input = document.getElementById(`ctl-${key}`);
    if (!input) return;
    input.addEventListener("input", (e) => {
      if (!selectedLayer) return;
      selectedLayer.transform[prop] = +e.target.value;
      setSlider(key, +e.target.value);
      if (!STATE.playing) togglePlay();
    });
  }

  /* ---------------- TIMELINE ---------------- */
  const TL = { pxPerSec: 0, dragClip: null, mode: null, startX: 0, orig: null };

  function renderTimeline() {
    // ruler ticks
    const bodyW = el.tlTracks.clientWidth || el.tlBody.clientWidth || 600;
    TL.pxPerSec = bodyW / STATE.duration;
    el.tlRuler.innerHTML = "";
    for (let s = 0; s <= STATE.duration; s++) {
      const tick = document.createElement("div");
      tick.className = "tl-tick"; tick.style.left = (s * TL.pxPerSec) + "px";
      tick.textContent = s + "s";
      el.tlRuler.appendChild(tick);
    }
    // tracks
    el.tlEmpty.style.display = layers.length ? "none" : "";
    el.tlTracks.querySelectorAll(".tl-track").forEach((n) => n.remove());
    [...layers].reverse().forEach((layer) => {
      const track = document.createElement("div");
      track.className = "tl-track";
      const label = document.createElement("span");
      label.className = "tl-track-label"; label.textContent = layer.name;
      track.appendChild(label);
      const clip = document.createElement("div");
      clip.className = "tl-clip" + (layer === selectedLayer ? " selected" : "");
      clip.style.left = (layer.start * TL.pxPerSec) + "px";
      clip.style.width = Math.max(14, layer.duration * TL.pxPerSec) + "px";
      clip.innerHTML = `<span class="tl-handle left"></span><span class="tl-clip-label">${layer.name}</span><span class="tl-handle right"></span>`;
      clip.addEventListener("mousedown", (e) => startClipDrag(e, layer, clip));
      clip.addEventListener("click", (e) => { e.stopPropagation(); selectLayer(layer); });
      track.appendChild(clip);
      el.tlTracks.appendChild(track);
    });
  }

  function startClipDrag(e, layer, clip) {
    e.preventDefault(); selectLayer(layer);
    const isLeft = e.target.classList.contains("left"), isRight = e.target.classList.contains("right");
    TL.dragClip = { layer, clip }; TL.mode = isLeft ? "trim-left" : isRight ? "trim-right" : "move";
    TL.startX = e.clientX; TL.orig = { start: layer.start, duration: layer.duration };
    clip.classList.add("dragging");
    document.addEventListener("mousemove", onClipDrag);
    document.addEventListener("mouseup", endClipDrag);
  }
  function onClipDrag(e) {
    if (!TL.dragClip) return;
    const dx = (e.clientX - TL.startX) / TL.pxPerSec;
    const { layer } = TL.dragClip, o = TL.orig, D = STATE.duration;
    if (TL.mode === "move") { layer.start = clamp(o.start + dx, 0, Math.max(0, D - layer.duration)); }
    else if (TL.mode === "trim-left") { const ns = clamp(o.start + dx, 0, o.start + o.duration - 0.2); layer.duration = o.duration - (ns - o.start); layer.start = ns; }
    else if (TL.mode === "trim-right") { layer.duration = clamp(o.duration + dx, 0.2, D - layer.start); }
    const c = TL.dragClip.clip;
    c.style.left = (layer.start * TL.pxPerSec) + "px";
    c.style.width = Math.max(14, layer.duration * TL.pxPerSec) + "px";
  }
  function endClipDrag() {
    if (TL.dragClip) TL.dragClip.clip.classList.remove("dragging");
    TL.dragClip = null;
    document.removeEventListener("mousemove", onClipDrag);
    document.removeEventListener("mouseup", endClipDrag);
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function setDuration(sec) {
    STATE.duration = sec;
    // clamp existing clips
    layers.forEach((l) => { l.start = clamp(l.start, 0, sec); l.duration = clamp(l.duration, 0.2, sec - l.start); });
    EXPORTOPTS.duration = sec;
    syncDurationUI();
    renderTimeline();
  }
  function syncDurationUI() {
    [el.durSegTl, document.getElementById("durSeg")].forEach((seg) => {
      if (!seg) return;
      seg.querySelectorAll("[data-dur]").forEach((b) => b.classList.toggle("active", b.dataset.dur == STATE.duration || (b.dataset.dur === "custom" && ![4,8,15].includes(STATE.duration))));
    });
  }

  /* ============================================================
     AUDIO ENGINE — multi-band + peak/beat detection
     ============================================================ */
  const audio = { ctx: null, el: null, source: null, analyser: null, freqData: null, timeData: null, ready: false, lastBeat: 0, prevBass: 0, prevFlux: 0, env: { bass: 0, mid: 0, high: 0, level: 0 }, energyAvg: 0, destGain: null, streamDest: null };

  function initAudio(file) {
    try {
      if (audio.el) audio.el.pause();
      audio.el = new Audio(URL.createObjectURL(file));
      audio.el.loop = STATE.loop;
      audio.ctx = audio.ctx || new (window.AudioContext || window.webkitAudioContext)();
      audio.source = audio.ctx.createMediaElementSource(audio.el);
      audio.analyser = audio.ctx.createAnalyser();
      audio.analyser.fftSize = 2048; audio.analyser.smoothingTimeConstant = 0.75;
      audio.destGain = audio.ctx.createGain();
      audio.source.connect(audio.analyser);
      audio.source.connect(audio.destGain);
      audio.destGain.connect(audio.ctx.destination);
      audio.freqData = new Uint8Array(audio.analyser.frequencyBinCount);
      audio.timeData = new Uint8Array(audio.analyser.frequencyBinCount);
      audio.ready = true;
      el.audioName.textContent = file.name;
      toast("Audio loaded — reactions engaged");
    } catch (e) { toast("Could not initialize audio"); }
  }
  function bandAverage(lo, hi) {
    const nyq = (audio.ctx ? audio.ctx.sampleRate : 44100) / 2, bins = audio.analyser.frequencyBinCount;
    const a = Math.max(0, Math.floor((lo / nyq) * bins)), b = Math.min(bins - 1, Math.ceil((hi / nyq) * bins));
    let sum = 0, n = 0; for (let i = a; i <= b; i++) { sum += audio.freqData[i]; n++; }
    return n ? sum / (n * 255) : 0;
  }
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  function analyzeAudio() {
    if (!audio.ready || audio.el.paused || !STATE.audioReactive) {
      const d = 0.9;
      STATE.audioLevel *= d; STATE.bassLevel *= d; STATE.midLevel *= d; STATE.highLevel *= d;
      STATE.beat *= 0.85; STATE.peak *= 0.8; STATE.buildup *= 0.98;
      audio.env.bass *= d; audio.env.mid *= d; audio.env.high *= d; audio.env.level *= d;
      updateDebugMeter(); return;
    }
    audio.analyser.getByteFrequencyData(audio.freqData);
    audio.analyser.getByteTimeDomainData(audio.timeData);
    let sum = 0; for (let i = 0; i < audio.timeData.length; i++) { const v = (audio.timeData[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / audio.timeData.length);
    const bass = bandAverage(20, 160), mid = bandAverage(160, 2000), high = bandAverage(2000, 12000);
    const sm = 0.35 + (STATE.smoothing / 100) * 0.6, attack = 1 - sm, env = audio.env;
    env.bass = Math.max(bass, env.bass * sm + bass * attack);
    env.mid = Math.max(mid, env.mid * sm + mid * attack);
    env.high = Math.max(high, env.high * sm + high * attack);
    env.level = env.level * sm + rms * attack;
    STATE.bassLevel = env.bass; STATE.midLevel = env.mid; STATE.highLevel = env.high; STATE.audioLevel = env.level;
    const flux = Math.max(0, (bass + mid + high) - audio.prevFlux);
    audio.prevFlux = audio.prevFlux * 0.6 + (bass + mid + high) * 0.4;
    const peakGate = 0.04 + (STATE.peakThreshold / 100) * 0.25;
    if (flux > peakGate) STATE.peak = 1; else STATE.peak *= (0.65 + (STATE.syncTightness / 100) * 0.3);
    const now = performance.now(), sens = STATE.beatSensitivity / 100;
    const beatGate = 0.30 + (1 - sens) * 0.35, refractory = 120 + (1 - sens) * 260;
    if (bass > beatGate && bass > audio.prevBass * (1.05 + (1 - sens) * 0.25) && now - audio.lastBeat > refractory) { STATE.beat = 1; audio.lastBeat = now; }
    else STATE.beat *= (0.80 + (1 - STATE.syncTightness / 100) * 0.15);
    audio.prevBass = audio.prevBass * 0.7 + bass * 0.3;
    const energy = (bass + mid + high) / 3;
    audio.energyAvg = audio.energyAvg * 0.99 + energy * 0.01;
    STATE.buildup = clamp01(STATE.buildup + (energy > audio.energyAvg * 1.08 ? 0.01 : -0.006));
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

  /* ============================================================
     EFFECTS LIBRARY — each returns visual deltas for a layer
     ============================================================ */
  const EFFECTS = {
    blurIn(sig, t) { const k = Math.min(1, (t % 6) / 1.2); return { blur: (1 - k) * 12, opacity: 0.2 + k * 0.8, scale: 0.96 + k * 0.04 }; },
    hardCut(sig, t) { const trig = sig.peak > 0.6 || sig.beat > 0.7; return { flash: trig ? (Math.random() < 0.5 ? "#fff" : "#000") : null, flashA: trig ? 0.5 : 0 }; },
    glitchFlicker(sig, t) { const amt = STATE.flicker / 100, kick = sig.beat * 0.8 + sig.peak * 0.6; const cut = Math.random() < (0.05 + kick * 0.25) * amt; const micro = Math.random() < (0.03 + sig.high) * amt; return { opacity: cut ? 0.15 : (micro ? 0.6 : 1), tx: micro ? (Math.random() - 0.5) * 10 * (STATE.glitch / 100) : 0, ty: cut ? (Math.random() - 0.5) * 6 : 0 }; },
    rgbSplit(sig, t) { const base = (STATE.rgbSplit / 100) * 8, j = Math.sin(t * 40) * 0.5 + 0.5; return { rgb: base * (1 + sig.bass * 2 + sig.peak * 2) * (0.6 + j * 0.4) }; },
    scanlineReveal(sig, t) { return { ty: Math.sin(t * (1.2 + sig.mid * 3)) * 3 }; },
    digitalNoise(sig, t) { const b = STATE.noise / 100; return { tx: (sig.peak > 0.5 && Math.random() < 0.4) ? (Math.random() - 0.5) * 30 * b : 0 }; },
    microShake(sig, t) { const s = (STATE.glitch / 100) * 2 + 1, impact = 1 + sig.bass * 4 + sig.beat * 3; return { tx: (Math.random() - 0.5) * s * impact, ty: (Math.random() - 0.5) * s * impact, rot: (Math.random() - 0.5) * 0.4 * impact }; },
    hud(sig, t) { return { hud: true, hudFlicker: 0.6 + sig.mid * 0.4 }; },
    symbolMorph(sig, t) { const k = Math.sin(t * 0.8) * 0.5 + 0.5; return { scale: 1 + (k - 0.5) * 0.1, blur: k * 3 * (STATE.blur / 100 + 0.2), opacity: 0.7 + 0.3 * k }; },
    breathingGlow(sig, t) { const b = Math.sin(t * (1.4 + sig.bass * 2)) * 0.5 + 0.5, pop = sig.beat * 0.12 + sig.bass * 0.15; return { scale: 1 + b * 0.04 + pop, glow: 6 + b * 10 + sig.bass * 30 }; },
    card3d(sig, t) { return { rotX: Math.sin(t * 0.7) * (8 + sig.mid * 10), rotY: Math.cos(t * 0.5) * (10 + sig.mid * 12) }; },
    ripple(sig, t) { const w = Math.sin(t * (2 + sig.bass * 4)); return { tx: w * (6 + sig.bass * 20), skew: w * (1.5 + sig.bass * 3) }; },
  };

  /* ---------------- RENDER LOOP ---------------- */
  let rafStart = performance.now();
  let hudLayer = null, flashOverlay = null;
  const BASE_SCALE = 0.62; // fraction of canvas a 100%-scale layer fills

  function frame(now) {
    requestAnimationFrame(frame);
    analyzeAudio();
    if (!STATE.playing) return;
    const elapsed = (now - rafStart) / 1000;
    STATE.time = STATE.loop ? (elapsed % STATE.duration) : Math.min(elapsed, STATE.duration);
    const t = STATE.time, sig = audioSignal();

    // scene overlays (scanlines + noise) react to high band
    const scanFlicker = 0.8 + Math.sin(t * (6 + sig.high * 20)) * 0.2;
    el.canvasFrame.style.setProperty("--scanline-op", (STATE.scanline / 100) * scanFlicker * (1 + sig.high));
    el.canvasFrame.style.setProperty("--noise-op", (STATE.noise / 100) * (0.5 + Math.random() * 0.5) * (1 + sig.high * 1.5 + sig.peak));

    let anyHud = false, hudFlicker = 1, anyFlash = null, flashA = 0;

    layers.forEach((layer) => {
      if (!layer.wrap) return;
      // timeline gating: only visible within [start, start+duration]
      const active = layer.visible && t >= layer.start - 0.001 && t <= layer.start + layer.duration + 0.001;
      if (!active) { layer.wrap.style.opacity = "0"; return; }
      const lt = t - layer.start + layer.recipe.delay; // local layer time (staggered)
      const r = composeLayer(layer, lt, sig);
      if (r.hud) { anyHud = true; hudFlicker = r.hudFlicker; }
      if (r.flash) { anyFlash = r.flash; flashA = r.flashA; }
    });

    updateHud(anyHud, hudFlicker, t);
    updateFlash(anyFlash, flashA);
    updatePlayheads(t);
  }

  // Compose all of a layer's effects onto its wrap element. Returns
  // scene-level requests (hud/flash) bubbled up from its modules.
  function composeLayer(layer, t, sig) {
    const T = layer.transform;
    let tx = T.x, ty = T.y, scale = T.scale / 100, rot = T.rot, rotX = 0, rotY = 0, skew = 0;
    let opacity = T.opacity / 100, blur = 0, rgb = 0, glow = 0;
    let hud = false, hudFlicker = 1, flash = null, flashA = 0;

    // base "alive" idle motion so a layer with no fx still moves subtly
    const rc = layer.recipe;
    scale *= 1 + Math.sin(t * (0.6 + STATE.speed / 100 * 1.4) + rc.phase) * 0.02;

    for (const key of layer.fx) {
      const mod = EFFECTS[key]; if (!mod) continue;
      const d = mod(sig, t) || {};
      if (d.tx) tx += d.tx; if (d.ty) ty += d.ty;
      if (d.scale) scale *= d.scale; if (d.rot) rot += d.rot;
      if (d.rotX) rotX += d.rotX; if (d.rotY) rotY += d.rotY; if (d.skew) skew += d.skew;
      if (d.opacity !== undefined) opacity *= d.opacity;
      if (d.blur) blur += d.blur; if (d.rgb) rgb = Math.max(rgb, d.rgb);
      if (d.glow) glow = Math.max(glow, d.glow);
      if (d.hud) { hud = true; hudFlicker = d.hudFlicker; }
      if (d.flash) { flash = d.flash; flashA = d.flashA; }
    }
    // scene blur param nudges everything slightly
    blur += (STATE.blur / 100) * 3 * (1 + sig.level);

    // size: translate percentages relative to canvas, center origin
    const w = el.canvasFrame.clientWidth, h = el.canvasFrame.clientHeight;
    const baseW = w * BASE_SCALE, baseH = h * BASE_SCALE;
    layer.wrap.style.width = baseW + "px";
    layer.wrap.style.height = baseH + "px";
    layer.wrap.style.marginLeft = (-baseW / 2) + "px";
    layer.wrap.style.marginTop = (-baseH / 2) + "px";
    const pxX = (tx / 100) * w, pxY = (ty / 100) * h;

    layer.wrap.style.transform =
      `perspective(800px) translate(${pxX.toFixed(1)}px, ${pxY.toFixed(1)}px) scale(${scale.toFixed(3)}) ` +
      `rotate(${rot.toFixed(2)}deg) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg) skewX(${skew.toFixed(2)}deg)`;
    layer.wrap.style.opacity = clamp01(opacity).toFixed(2);
    layer.wrap.style.filter =
      `blur(${blur.toFixed(2)}px) ` +
      (rgb ? `drop-shadow(${rgb.toFixed(1)}px 0 0 rgba(255,60,80,0.5)) drop-shadow(${(-rgb).toFixed(1)}px 0 0 rgba(60,180,255,0.5)) ` : "") +
      (glow ? `drop-shadow(0 0 ${glow.toFixed(1)}px rgba(122,92,255,0.6))` : "");

    // per-SVG-sublayer variety
    if (layer.kind === "SVG" && layer.subLayers && layer.subLayers.length > 1) animateSubLayers(layer, t, sig);

    return { hud, hudFlicker, flash, flashA };
  }

  function animateSubLayers(layer, t, sig) {
    const fl = STATE.flicker / 100;
    layer.subLayers.forEach((node) => {
      const rc = node._recipe; if (!rc) return;
      const lt = t - rc.delay;
      const band = rc.band === "bass" ? sig.bass : rc.band === "mid" ? sig.mid : sig.high;
      const dx = Math.sin(lt * rc.freq + rc.phase) * rc.ampX * (1 + band * 3);
      const dy = Math.cos(lt * rc.freq * 0.7 + rc.phase) * rc.ampY * (1 + band * 2);
      const rot = Math.sin(lt * rc.freq * 0.5 + rc.phase) * rc.rot;
      let op = 0.72 + 0.28 * Math.sin(lt * rc.freq * 1.3 + rc.phase);
      if (layer.fx.includes("glitchFlicker") && Math.random() < 0.03 * fl * rc.flickerBias) op *= 0.25;
      node.style.transformBox = "fill-box"; node.style.transformOrigin = "center";
      node.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px) rotate(${rot.toFixed(2)}deg)`;
      node.style.opacity = clamp01(op).toFixed(2);
    });
  }

  function updateHud(want, flicker, t) {
    if (!want) { if (hudLayer) hudLayer.style.display = "none"; return; }
    if (!hudLayer) {
      hudLayer = document.createElement("div"); hudLayer.className = "fx fx-hud";
      hudLayer.innerHTML = '<span class="hud-c hud-tl">\u2310 SYS.PHASER</span><span class="hud-c hud-tr">REC \u25cf</span><span class="hud-c hud-bl">X:0420 Y:1080</span><span class="hud-c hud-br">v3.0 // LIVE</span><span class="hud-corner hud-c-tl"></span><span class="hud-corner hud-c-tr"></span><span class="hud-corner hud-c-bl"></span><span class="hud-corner hud-c-br"></span>';
      el.canvasFrame.appendChild(hudLayer);
    }
    hudLayer.style.display = "block";
    hudLayer.style.opacity = (0.5 + 0.5 * flicker * (0.6 + 0.4 * Math.sin(t * 8))).toFixed(2);
  }
  function updateFlash(color, alpha) {
    if (!flashOverlay) { flashOverlay = document.createElement("div"); flashOverlay.className = "fx fx-flash"; el.canvasFrame.appendChild(flashOverlay); }
    if (color && alpha > 0) { flashOverlay.style.background = color; flashOverlay.style.opacity = alpha; } else flashOverlay.style.opacity = 0;
  }
  function updatePlayheads(t) {
    const pct = STATE.duration ? (t / STATE.duration) : 0;
    if (el.tlPlayhead) el.tlPlayhead.style.left = (pct * (el.tlTracks.clientWidth || 0)) + "px";
    if (el.timecode) el.timecode.textContent = t.toFixed(1) + "s";
  }

  function togglePlay() {
    STATE.playing = !STATE.playing;
    const show = (icon, pause) => { if (icon) icon.style.display = STATE.playing ? "none" : "block"; if (pause) pause.style.display = STATE.playing ? "block" : "none"; };
    show(el.playIcon, el.pauseIcon); show(el.topPlayIcon, el.topPauseIcon);
    if (STATE.playing) { rafStart = performance.now() - STATE.time * 1000; if (audio.ready) { if (audio.ctx.state === "suspended") audio.ctx.resume(); audio.el.play().catch(() => {}); } }
    else if (audio.ready) audio.el.pause();
  }

  /* ---------------- PRESETS ---------------- */
  let currentPreset = null;
  function buildPresets() {
    Object.keys(PRESETS).forEach((name) => {
      const b = document.createElement("button");
      b.className = "preset";
      b.innerHTML = `<span class="preset-dot"></span><span>${name}</span>`;
      b.addEventListener("click", () => applyPreset(name));
      el.presetGrid.appendChild(b);
    });
  }
  function applyPreset(name, toAll) {
    const p = PRESETS[name]; if (!p) return;
    currentPreset = name;
    Object.entries(p.patch).forEach(([k, v]) => { if (k in STATE) STATE[k] = v; });
    syncControls();
    // targets: all layers if requested or nothing selected; else selected
    const targets = (toAll || !selectedLayer) ? layers : [selectedLayer];
    targets.forEach((layer, i) => {
      layer.fx = p.fx.slice();
      // stagger + depth so layers differ
      if (targets.length > 1) {
        layer.recipe = makeRecipe((layer.id * 131 + i * 997) >>> 0);
        layer.start = Math.min(STATE.duration * 0.5, i * 0.25);
      }
      if (layer.kind === "SVG" && layer.subLayers) layer.subLayers.forEach((s, j) => assignRecipe(s, layer.id * 97 + i * 31 + j));
    });
    $$(".preset").forEach((c) => c.classList.toggle("active", c.textContent.trim() === name));
    renderTimeline(); renderLayerProps();
    if (!STATE.playing) togglePlay();
    if (window.gsap && selectedLayer && selectedLayer.wrap) window.gsap.fromTo(selectedLayer.wrap, { opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1, duration: 0.5, ease: "power2.out" });
    toast(targets.length > 1 ? `Applied ${name} to ${targets.length} layers` : `Applied ${name}`);
  }
  function applyGhostMotionAll() {
    if (!layers.length) { toast("Add layers first"); return; }
    applyPreset("Ghost Software", true);
    toast("Ghost motion applied to all layers");
  }

  /* ---------------- AI DIRECTOR ---------------- */
  const AI_RULES = [
    { kw: ["more ghost software", "ghost software", "ghost hardware", "ghost"], apply: () => { applyPreset("Ghost Software", !selectedLayer); setBackground("custom", "#070709"); }, say: "Ghost software" },
    { kw: ["cleaner", "clean", "minimal", "elegant"], apply: () => { set("glitch", 10); set("noise", 8); set("flicker", 14); bump("blur", -6); layerFxAll(["blurIn", "breathingGlow"]); }, say: "Cleaner" },
    { kw: ["aggressive", "harder", "intense", "harsh"], apply: () => { bump("glitch", 25); bump("rgbSplit", 20); bump("bassReaction", 20); bump("motionIntensity", 20); layerFxAll(["hardCut", "rgbSplit", "microShake", "glitchFlicker", "breathingGlow"]); }, say: "More aggressive" },
    { kw: ["synced to the beat", "more synced", "sync to the beat", "beat sync", "on beat"], apply: () => { bump("beatSensitivity", 25); bump("bassReaction", 25); bump("peakThreshold", -10); bump("syncTightness", 20); bump("motionIntensity", 15); STATE.audioReactive = true; if (el.audioReactiveToggle) el.audioReactiveToggle.checked = true; }, say: "Tighter beat sync" },
    { kw: ["1:1 post", "square", "1080 x 1080", "post"], apply: () => { setFormat(1080, 1080, "Post"); }, say: "Square 1:1 post" },
    { kw: ["ig reel", "instagram reel", "reel", "vertical", "9:16"], apply: () => { setFormat(1080, 1920, "Reel"); setDuration(8); }, say: "Reel-ready (1080\u00d71920)" },
    { kw: ["transparent png", "transparent", "alpha", "no background"], apply: () => { setBackground("transparent"); EXPORTOPTS.transparent = true; if (el.optTransparent) el.optTransparent.checked = true; }, say: "Transparent output armed" },
    { kw: ["export mp4", "mp4", "h.264", "h264"], apply: () => { openSheet(); }, say: "MP4 workflow — see Export" },
    { kw: ["every layer different", "each layer different", "vary layers", "layers different"], apply: () => { layers.forEach((l, i) => { l.recipe = makeRecipe((l.id * 131 + Math.floor(Math.random() * 99999))); l.start = Math.min(STATE.duration * 0.5, i * 0.3); if (l.subLayers) l.subLayers.forEach((s, j) => assignRecipe(s, Math.floor(Math.random() * 99999) + j)); }); renderTimeline(); }, say: "Every layer differs" },
    { kw: ["glitchy", "glitch", "corrupt"], apply: () => { bump("glitch", 30); bump("rgbSplit", 20); bump("noise", 15); layerFxAdd("glitchFlicker"); }, say: "More glitch" },
    { kw: ["slow", "slower", "calm"], apply: () => { set("speed", 25); bump("flicker", -15); }, say: "Slower" },
    { kw: ["fast", "faster", "rapid"], apply: () => { set("speed", 85); bump("flicker", 15); }, say: "Faster" },
    { kw: ["dark", "darker", "moody"], apply: () => { setBackground("custom", "#050506"); bump("scanline", 15); }, say: "Darker" },
    { kw: ["scanline", "scanlines", "crt"], apply: () => { bump("scanline", 35); applyPreset("CRT Monitor", !selectedLayer); }, say: "Scanlines" },
    { kw: ["hud", "overlay", "coordinates", "labels"], apply: () => layerFxAdd("hud"), say: "HUD overlays" },
    { kw: ["hologram", "3d", "card"], apply: () => layerFxAdd("card3d"), say: "3D card" },
    { kw: ["ripple", "wave", "distort"], apply: () => layerFxAdd("ripple"), say: "Ripple" },
  ];
  const bump = (k, d) => (STATE[k] = clampP(STATE[k] + d));
  const set = (k, v) => (STATE[k] = clampP(v));
  const clampP = (v) => Math.max(0, Math.min(100, v));
  function layerFxAll(fxArr) { (selectedLayer ? [selectedLayer] : layers).forEach((l) => l.fx = fxArr.slice()); renderLayerProps(); }
  function layerFxAdd(fx) { (selectedLayer ? [selectedLayer] : layers).forEach((l) => { if (!l.fx.includes(fx)) l.fx.push(fx); }); renderLayerProps(); }

  function runAI() {
    const text = el.aiPrompt.value.toLowerCase().trim();
    if (!text) { el.aiEcho.textContent = "Type a direction first, like \u201cmake it more synced to the beat.\u201d"; return; }
    const hits = [];
    AI_RULES.forEach((r) => { if (r.kw.some((k) => text.includes(k))) { r.apply(); hits.push(r.say); } });
    syncControls();
    if (!STATE.playing) togglePlay();
    el.aiEcho.textContent = hits.length ? hits.join(" \u00b7 ") : "No keywords matched. Try: ghost software, cleaner, aggressive, synced to the beat, 1:1 post, IG reel, transparent PNG, every layer different.";
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
    const wrap = document.createElement("div"); wrap.className = "control";
    wrap.innerHTML = `<span class="ctl-label">${label}</span><span class="ctl-val" id="val-${key}">${STATE[key]}</span><input type="range" min="0" max="100" value="${STATE[key]}" id="ctl-${key}" style="--pct:${STATE[key]}%">`;
    container.appendChild(wrap);
    wrap.querySelector("input").addEventListener("input", (e) => { STATE[key] = +e.target.value; document.getElementById(`val-${key}`).textContent = STATE[key]; e.target.style.setProperty("--pct", STATE[key] + "%"); if (!STATE.playing) togglePlay(); });
  }
  function syncControls() {
    [...CONTROL_GROUPS.beatsync, ...CONTROL_GROUPS.effects].forEach(({ key }) => {
      const input = document.getElementById(`ctl-${key}`), val = document.getElementById(`val-${key}`);
      if (input) { input.value = STATE[key]; input.style.setProperty("--pct", STATE[key] + "%"); }
      if (val) val.textContent = STATE[key];
    });
  }

  /* ---------------- BACKGROUND ---------------- */
  function setBackground(mode, color) {
    STATE.bgMode = mode; if (color) STATE.bgColor = color;
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
    setTimeout(renderTimeline, 30);
  }

  /* ============================================================
     EXPORT — composites ALL layers onto one canvas, honoring
     each layer's transform, timeline gating and effects.
     transparent => real alpha (no bg / no vignette / clipped scanlines).
     ============================================================ */
  const EXPORTOPTS = { transparent: false, duration: 8, fps: 30, includeAudio: true, quality: "high", bg: "selected" };

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

  // Rasterize a layer's source node to an <img> we can drawImage.
  function layerToImage(layer) {
    return new Promise((resolve) => {
      if (layer.kind === "IMG") { resolve(layer.node); return; }
      const svgStr = new XMLSerializer().serializeToString(layer.node);
      const url = URL.createObjectURL(new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" }));
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  async function drawExportFrame(ctx, W, H, imgs, t, opts) {
    const transparent = !opts.bg;
    ctx.clearRect(0, 0, W, H);
    if (!transparent) {
      if (typeof opts.bg === "object" && opts.bg.grad) { const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, opts.bg.grad[0]); g.addColorStop(1, opts.bg.grad[1]); ctx.fillStyle = g; }
      else ctx.fillStyle = opts.bg;
      ctx.fillRect(0, 0, W, H);
    }
    const scale = W / STATE.format.w, sig = audioSignal();
    const baseW = W * BASE_SCALE, baseH = H * BASE_SCALE;

    layers.forEach((layer) => {
      if (!layer.visible) return;
      if (t < layer.start - 0.001 || t > layer.start + layer.duration + 0.001) return;
      const img = imgs[layer.id]; if (!img) return;
      const lt = t - layer.start + layer.recipe.delay;
      const T = layer.transform;
      let tx = (T.x / 100) * W, ty = (T.y / 100) * H, sc = (T.scale / 100), rot = T.rot, op = T.opacity / 100, blur = 0, rgb = 0, glow = 0;
      sc *= 1 + Math.sin(lt * (0.6 + STATE.speed / 100 * 1.4) + layer.recipe.phase) * 0.02;
      for (const key of layer.fx) {
        const d = (EFFECTS[key] ? EFFECTS[key](sig, lt) : {}) || {};
        if (d.tx) tx += d.tx * scale; if (d.ty) ty += d.ty * scale;
        if (d.scale) sc *= d.scale; if (d.rot) rot += d.rot;
        if (d.opacity !== undefined) op *= d.opacity;
        if (d.blur) blur += d.blur; if (d.rgb) rgb = Math.max(rgb, d.rgb * scale); if (d.glow) glow = Math.max(glow, d.glow);
      }
      // fit source image into baseW/baseH box preserving aspect
      const fit = Math.min(baseW / img.width, baseH / img.height) * sc;
      const dw = img.width * fit, dh = img.height * fit;
      ctx.save();
      ctx.globalAlpha = clamp01(op);
      ctx.translate(W / 2 + tx, H / 2 + ty);
      ctx.rotate(rot * Math.PI / 180);
      if (glow) { ctx.shadowColor = "rgba(122,92,255,0.6)"; ctx.shadowBlur = glow * scale; }
      if (rgb > 0.3) {
        ctx.globalCompositeOperation = "screen"; const a = ctx.globalAlpha; ctx.globalAlpha = a * 0.5;
        ctx.drawImage(img, -dw / 2 + rgb, -dh / 2, dw, dh);
        ctx.drawImage(img, -dw / 2 - rgb, -dh / 2, dw, dh);
        ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = a;
      }
      ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
    });

    // scene scanlines
    if (STATE.scanline > 0) {
      if (transparent) ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = `rgba(0,0,0,${(STATE.scanline / 100) * 0.5 * (1 + sig.high)})`;
      for (let y = 0; y < H; y += 3 * scale) ctx.fillRect(0, y, W, Math.max(1, scale));
      ctx.globalCompositeOperation = "source-over";
    }
    // scene noise (respect alpha)
    if (STATE.noise > 0) {
      const n = ctx.getImageData(0, 0, W, H), amt = (STATE.noise / 100) * 40 * (1 + sig.high), d = n.data;
      for (let i = 0; i < d.length; i += 4) { if (transparent && d[i + 3] === 0) continue; if (Math.random() < 0.3) { const v = (Math.random() - 0.5) * amt; d[i] += v; d[i + 1] += v; d[i + 2] += v; } }
      ctx.putImageData(n, 0, 0);
    }
    if (!transparent) {
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
      g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.45)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      // hard-cut flash on any layer with the effect
      const flashing = layers.some((l) => l.visible && l.fx.includes("hardCut")) && (sig.peak > 0.6 || sig.beat > 0.7);
      if (flashing) { ctx.fillStyle = Math.random() < 0.5 ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.5)"; ctx.fillRect(0, 0, W, H); }
    }
  }

  function makeCanvas() { const s = STATE.exportScale, c = document.createElement("canvas"); c.width = STATE.format.w * s; c.height = STATE.format.h * s; return c; }
  function downloadBlob(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1500); }
  function setExportStatus(msg, kind) { if (el.exportStatus) { el.exportStatus.textContent = msg; el.exportStatus.dataset.kind = kind || "info"; } if (kind === "done" || kind === "error") toast(msg); }
  async function rasterizeAll() { const imgs = {}; for (const layer of layers) imgs[layer.id] = await layerToImage(layer); return imgs; }
  function reelName(ext) { return (STATE.format.label === "Post" ? "phaser-motion-post" : "phaser-motion-reel") + "." + ext; }

  async function exportPNG(tOverride) {
    if (!layers.length) { toast("Add a layer first"); return; }
    const transparent = tOverride !== undefined ? tOverride : (EXPORTOPTS.transparent || EXPORTOPTS.bg === "transparent");
    setExportStatus(transparent ? "Rendering transparent PNG…" : "Rendering PNG…", "work");
    const c = makeCanvas(), ctx = c.getContext("2d"), imgs = await rasterizeAll();
    await drawExportFrame(ctx, c.width, c.height, imgs, STATE.time, { bg: transparent ? null : resolveExportBg(false) });
    c.toBlob((b) => { downloadBlob(b, transparent ? "phaser-still-transparent.png" : "phaser-still.png"); setExportStatus("Done — PNG saved", "done"); closeSheet(); }, "image/png");
  }
  async function exportSequence(tOverride) {
    if (!layers.length) { toast("Add a layer first"); return; }
    const transparent = tOverride !== undefined ? tOverride : (EXPORTOPTS.transparent || EXPORTOPTS.bg === "transparent");
    const fps = EXPORTOPTS.fps, dur = EXPORTOPTS.duration, total = Math.round(fps * dur);
    setExportStatus(`Rendering ${total} frames (${dur}s @ ${fps}fps)…`, "work");
    const c = makeCanvas(), ctx = c.getContext("2d"), imgs = await rasterizeAll(), bg = transparent ? null : resolveExportBg(false);
    for (let f = 0; f < total; f++) {
      await drawExportFrame(ctx, c.width, c.height, imgs, f / fps, { bg });
      await new Promise((res) => c.toBlob((b) => { downloadBlob(b, `phaser-seq-${String(f).padStart(4, "0")}.png`); setTimeout(res, 55); }, "image/png"));
      if (f % 10 === 0) setExportStatus(`Rendering frame ${f + 1}/${total}…`, "work");
    }
    setExportStatus("Done — sequence saved", "done"); closeSheet();
  }
  function pickWebmMime() { return ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm"; }

  async function exportWebM(alphaOverride) {
    if (!layers.length) { toast("Add a layer first"); return; }
    if (typeof MediaRecorder === "undefined") { setExportStatus("This browser can't record video — use PNG sequence", "error"); return; }
    const fps = EXPORTOPTS.fps, wantAlpha = alphaOverride !== undefined ? alphaOverride : (EXPORTOPTS.transparent && EXPORTOPTS.bg === "transparent");
    setExportStatus(`Recording WebM (${EXPORTOPTS.duration}s @ ${fps}fps)…`, "work");
    const c = makeCanvas(), ctx = c.getContext("2d"), imgs = await rasterizeAll();
    const vStream = c.captureStream(fps); let mixed = vStream;
    if (EXPORTOPTS.includeAudio && audio.ready && audio.ctx) {
      try { audio.streamDest = audio.streamDest || audio.ctx.createMediaStreamDestination(); audio.destGain.connect(audio.streamDest); const at = audio.streamDest.stream.getAudioTracks()[0]; if (at) mixed = new MediaStream([...vStream.getVideoTracks(), at]); if (audio.ctx.state === "suspended") await audio.ctx.resume(); audio.el.currentTime = 0; audio.el.play().catch(() => {}); } catch (e) {}
    }
    const bg = wantAlpha ? null : resolveExportBg(true);
    let rec; try { rec = new MediaRecorder(mixed, { mimeType: pickWebmMime(), videoBitsPerSecond: EXPORTOPTS.quality === "high" ? 12000000 : 6000000 }); } catch (e) { setExportStatus("Recording not supported here — use PNG sequence", "error"); return; }
    const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => { const blob = new Blob(chunks, { type: "video/webm" }); LAST_WEBM_BLOB = blob; downloadBlob(blob, wantAlpha ? "phaser-motion-alpha.webm" : reelName("webm")); setExportStatus("Done — WebM saved", "done"); closeSheet(); };
    const t0 = performance.now(); rec.start();
    (function rf(now) { const e2 = (now - t0) / 1000; drawExportFrame(ctx, c.width, c.height, imgs, e2 % STATE.duration, { bg }); if (e2 < EXPORTOPTS.duration) requestAnimationFrame(rf); else { rec.stop(); if (audio.ready) audio.el.pause(); } })(performance.now());
  }

  /* MP4 (H.264) via ffmpeg.wasm — FFMPEG.WASM INTEGRATION POINT
     Records WebM (selected bg + audio) then transcodes. ffmpeg tags are
     commented out in index.html by default (~30MB); uncomment to enable.
     Without them, exports WebM and shows the required message. */
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
    if (!layers.length) { toast("Add a layer first"); return; }
    setExportStatus("Preparing render…", "work");
    if (!LAST_WEBM_BLOB) { setExportStatus("Recording source video for MP4…", "work"); await recordWebMForMp4(); if (!LAST_WEBM_BLOB) { setExportStatus("Could not record source video", "error"); return; } }
    let ff = null; try { ff = await loadFFmpeg(); } catch (e) { ff = null; }
    if (!ff) { downloadBlob(LAST_WEBM_BLOB, reelName("webm")); setExportStatus("MP4 export requires ffmpeg.wasm encoding. WebM and PNG sequence are available now — saved WebM. Uncomment the ffmpeg tags in index.html to enable H.264 MP4.", "error"); return; }
    try {
      setExportStatus("Encoding H.264 MP4…", "work");
      const inName = "in.webm", outName = reelName("mp4"), bytes = new Uint8Array(await LAST_WEBM_BLOB.arrayBuffer());
      const args = ["-i", inName, "-c:v", "libx264", "-preset", "veryfast", "-crf", EXPORTOPTS.quality === "high" ? "18" : "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-r", String(EXPORTOPTS.fps), "-c:a", "aac", "-b:a", "192k", outName];
      if (ff.api === "new") { await ff.ff.writeFile(inName, bytes); await ff.ff.exec(args); const out = await ff.ff.readFile(outName); downloadBlob(new Blob([out.buffer], { type: "video/mp4" }), outName); }
      else { ff.ff.FS("writeFile", inName, bytes); await ff.ff.run(...args); const out = ff.ff.FS("readFile", outName); downloadBlob(new Blob([out.buffer], { type: "video/mp4" }), outName); }
      setExportStatus("Done — " + outName + " saved", "done"); closeSheet();
    } catch (e) { downloadBlob(LAST_WEBM_BLOB, reelName("webm")); setExportStatus("MP4 encode failed — saved WebM as fallback", "error"); }
  }
  function recordWebMForMp4() {
    return new Promise(async (resolve) => {
      if (typeof MediaRecorder === "undefined") { resolve(); return; }
      const fps = EXPORTOPTS.fps, c = makeCanvas(), ctx = c.getContext("2d"), imgs = await rasterizeAll();
      const vStream = c.captureStream(fps); let mixed = vStream;
      if (EXPORTOPTS.includeAudio && audio.ready && audio.ctx) { try { audio.streamDest = audio.streamDest || audio.ctx.createMediaStreamDestination(); audio.destGain.connect(audio.streamDest); const at = audio.streamDest.stream.getAudioTracks()[0]; if (at) mixed = new MediaStream([...vStream.getVideoTracks(), at]); if (audio.ctx.state === "suspended") await audio.ctx.resume(); audio.el.currentTime = 0; audio.el.play().catch(() => {}); } catch (e) {} }
      let rec; try { rec = new MediaRecorder(mixed, { mimeType: pickWebmMime(), videoBitsPerSecond: 12000000 }); } catch (e) { resolve(); return; }
      const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => { LAST_WEBM_BLOB = new Blob(chunks, { type: "video/webm" }); if (audio.ready) audio.el.pause(); resolve(); };
      const bg = resolveExportBg(true), t0 = performance.now(); rec.start();
      (function rf(now) { const e2 = (now - t0) / 1000; drawExportFrame(ctx, c.width, c.height, imgs, e2 % STATE.duration, { bg }); if (e2 < EXPORTOPTS.duration) requestAnimationFrame(rf); else rec.stop(); })(performance.now());
    });
  }
  function syncExportUI() {
    const setA = (sel, val, attr) => $$(sel).forEach((b) => b.classList.toggle("active", b.dataset[attr] == val));
    setA("#fpsSeg [data-fps]", EXPORTOPTS.fps, "fps");
    setA("#durSeg [data-dur]", EXPORTOPTS.duration, "dur");
    setA("#vbgSeg [data-vbg]", EXPORTOPTS.bg, "vbg");
    if (el.optTransparent) el.optTransparent.checked = EXPORTOPTS.transparent;
    if (el.optAudio) el.optAudio.checked = EXPORTOPTS.includeAudio;
  }

  /* ---------------- WIRING ---------------- */
  function wire() {
    // rail tabs
    $$(".rail-tab").forEach((tab) => tab.addEventListener("click", () => {
      $$(".rail-tab").forEach((t) => t.classList.remove("active"));
      $$(".tab-view").forEach((v) => v.classList.remove("active"));
      tab.classList.add("active");
      const view = document.querySelector(`.tab-view[data-view="${tab.dataset.tab}"]`);
      if (view) view.classList.add("active");
    }));

    // upload + drag/drop (multi-file)
    el.dropzone.addEventListener("click", () => el.fileInput.click());
    el.dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.fileInput.click(); } });
    el.fileInput.addEventListener("change", (e) => handleFiles(e.target.files));
    ["dragenter", "dragover"].forEach((ev) => el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) => el.dropzone.addEventListener(ev, (e) => { e.preventDefault(); el.dropzone.classList.remove("drag"); }));
    el.dropzone.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));
    el.canvasFrame.addEventListener("dragover", (e) => e.preventDefault());
    el.canvasFrame.addEventListener("drop", (e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); });

    // formats
    $$(".fmt").forEach((b) => b.addEventListener("click", () => setFormat(+b.dataset.w, +b.dataset.h, b.dataset.label)));

    // transport (bottom + top)
    el.playBtn.addEventListener("click", togglePlay);
    if (el.topPlayBtn) el.topPlayBtn.addEventListener("click", togglePlay);
    el.loopBtn.addEventListener("click", () => { STATE.loop = !STATE.loop; el.loopBtn.classList.toggle("active", STATE.loop); el.loopBtn.dataset.on = String(STATE.loop); if (audio.el) audio.el.loop = STATE.loop; });
    document.addEventListener("keydown", (e) => { if (e.code === "Space" && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "INPUT") { e.preventDefault(); togglePlay(); } if (e.key === "Escape") closeSheet(); if ((e.key === "Delete" || e.key === "Backspace") && selectedLayer && e.target.tagName !== "TEXTAREA" && e.target.tagName !== "INPUT") { deleteLayer(selectedLayer); } });

    // AI
    el.aiRun.addEventListener("click", runAI);
    el.aiPrompt.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runAI(); });

    // presets
    el.applyGhostAll.addEventListener("click", applyGhostMotionAll);

    // layer transform sliders
    bindLayerSlider("x", "x"); bindLayerSlider("y", "y"); bindLayerSlider("lscale", "scale"); bindLayerSlider("lrot", "rot"); bindLayerSlider("lop", "opacity");
    el.layerDup.addEventListener("click", () => selectedLayer && duplicateLayer(selectedLayer));
    el.layerDel.addEventListener("click", () => selectedLayer && deleteLayer(selectedLayer));
    el.layerHide.addEventListener("click", () => { if (selectedLayer) { toggleLayerVisible(selectedLayer); renderLayerProps(); } });

    // background
    el.bgColor.addEventListener("input", (e) => setBackground("custom", e.target.value));
    $$(".bg-swatch").forEach((s) => s.addEventListener("click", () => setBackground(s.dataset.bg)));
    el.scaleSeg.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => { STATE.exportScale = +b.dataset.scale; el.scaleSeg.querySelectorAll(".seg-btn").forEach((x) => x.classList.remove("active")); b.classList.add("active"); }));
    if (el.audioReactiveToggle) el.audioReactiveToggle.addEventListener("change", (e) => { STATE.audioReactive = e.target.checked; toast(STATE.audioReactive ? "Audio-reactive on" : "Audio-reactive off"); });

    // audio
    el.audioBtn.addEventListener("click", () => el.audioInput.click());
    el.audioInput.addEventListener("change", (e) => { if (e.target.files[0]) initAudio(e.target.files[0]); });

    // timeline duration (bottom bar)
    wireDurSeg(el.durSegTl);

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
    $$("#fpsSeg [data-fps]").forEach((b) => b.addEventListener("click", () => { EXPORTOPTS.fps = +b.dataset.fps; STATE.fps = EXPORTOPTS.fps; el.readoutFps.textContent = STATE.fps + " fps"; syncExportUI(); }));
    wireDurSeg(document.getElementById("durSeg"));
    $$("#vbgSeg [data-vbg]").forEach((b) => b.addEventListener("click", () => { EXPORTOPTS.bg = b.dataset.vbg; syncExportUI(); }));
    if (el.optTransparent) el.optTransparent.addEventListener("change", (e) => { EXPORTOPTS.transparent = e.target.checked; });
    if (el.optAudio) el.optAudio.addEventListener("change", (e) => { EXPORTOPTS.includeAudio = e.target.checked; });

    // re-layout timeline on resize
    window.addEventListener("resize", () => renderTimeline());
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
    setFormat(1080, 1080, "Post");
    setDuration(8);
    el.readoutFps.textContent = STATE.fps + " fps";
    syncExportUI();
    renderTimeline();
    wire();
    requestAnimationFrame(frame);
  }
  document.addEventListener("DOMContentLoaded", init);
})();
