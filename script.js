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
    // scene overlay strengths (shared params)
    speed: 45, glitch: 25, flicker: 30, blur: 15, rgbSplit: 25, scanline: 40, noise: 18, glow: 40,
    // beat-sync engine
    beatSensitivity: 55, bassReaction: 70, midReaction: 50, highReaction: 55,
    smoothing: 60, peakThreshold: 60, motionIntensity: 65, syncTightness: 65,
    audioReactive: true,
    // output
    bgMode: "custom", bgColor: "#0B0B0F", bgColor2: "#1A1030",
    format: { w: 1080, h: 1080, label: "Post 1:1" },
    duration: 8, fps: 30, playing: false, loop: true,
    exposeSub: false,   // default: group SVG as single layer
    zoom: 1, zoomMode: "fit",
    time: 0,
    // live audio runtime
    audioLevel: 0, bassLevel: 0, midLevel: 0, highLevel: 0, beat: 0, peak: 0, buildup: 0,
  };

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
  const FX_LIBRARY = [
    { key: "blurIn",        label: "Blur-in",           transform: false },
    { key: "hardCut",       label: "Hard Cut",          transform: false },
    { key: "flickerBlocks", label: "Flicker Blocks",    transform: false },
    { key: "rgbOffset",     label: "RGB Offset",        transform: false },
    { key: "scanReveal",    label: "Scan Reveal",       transform: false },
    { key: "dataBreakup",   label: "Data Breakup",      transform: false },
    { key: "hudOverlay",    label: "HUD Overlay",       transform: false },
    { key: "pulseGlow",     label: "Pulse Glow",        transform: false },
    { key: "symbolTrans",   label: "Symbol Transition", transform: false },
    { key: "textFlicker",   label: "Text Flicker",      transform: false },
    { key: "lineDraw",      label: "Line Draw",         transform: false },
    { key: "trimPaths",     label: "Trim Paths",        transform: false },
    { key: "radarSweep",    label: "Radar Sweep",       transform: false },
    { key: "coordBlink",    label: "Coordinate Blink",  transform: false },
    { key: "dataStream",    label: "Data Stream",       transform: false },
    { key: "oscilloscope",  label: "Oscilloscope",      transform: false },
    { key: "digitalWave",   label: "Digital Wave",      transform: false },
    { key: "signalShake",   label: "Signal Shake",      transform: true  },
    { key: "hologramTilt",  label: "Hologram Tilt",     transform: true  },
  ];
  const FX_TRANSFORM = new Set(FX_LIBRARY.filter((f) => f.transform).map((f) => f.key));

  /* ---------------- PRESETS (public names, no private refs) ----------------
     fx: effect keys. patch: scene params. transform stays off unless the
     preset explicitly needs it (none of the defaults rotate/zoom). */
  const PRESETS = {
    "Signal System":       { fx: ["scanReveal","rgbOffset","hudOverlay","flickerBlocks","dataBreakup"], patch: { flicker: 38, rgbSplit: 32, scanline: 55, noise: 26 } },
    "Hardware Motion":     { fx: ["scanReveal","blurIn","hudOverlay","pulseGlow"], patch: { flicker: 26, scanline: 60, glow: 55, blur: 14 } },
    "Vector Scan":         { fx: ["scanReveal","radarSweep","hudOverlay","lineDraw"], patch: { flicker: 30, scanline: 75, glow: 45, noise: 16 } },
    "Signal Loss":         { fx: ["hardCut","dataBreakup","rgbOffset","flickerBlocks","scanReveal"], patch: { glitch: 60, flicker: 78, rgbSplit: 55, scanline: 62, noise: 55 } },
    "Data Pulse":          { fx: ["pulseGlow","rgbOffset","dataStream","hardCut"], patch: { glow: 70, rgbSplit: 40, scanline: 55, flicker: 30 } },
    "Clean Motion Poster": { fx: ["blurIn","pulseGlow"], patch: { flicker: 10, blur: 16, scanline: 14, noise: 6, glow: 45 } },
    "CRT Monitor":         { fx: ["scanReveal","dataBreakup","oscilloscope","pulseGlow"], patch: { flicker: 28, blur: 10, scanline: 95, noise: 34, glow: 40 } },
    "Interface Intro":     { fx: ["blurIn","lineDraw","hudOverlay","rgbOffset"], patch: { flicker: 26, scanline: 50, rgbSplit: 30, glow: 45 }, stagger: true },
    "Hardware Motion Intro":{ fx: ["blurIn","scanReveal","hudOverlay","coordBlink","trimPaths"], patch: { flicker: 24, scanline: 55, glow: 50, blur: 12 }, stagger: true },
  };

  /* ---------------- DOM ---------------- */
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const el = {
    dropzone: $("#dropzone"), fileInput: $("#fileInput"), exposeSubToggle: $("#exposeSubToggle"),
    assetList: $("#assetList"), assetCount: $("#assetCount"),
    presetGrid: $("#presetGrid"), applyAll: $("#applyAll"),
    layerStack: $("#layerStack"), layerCount: $("#layerCount"),
    stage: $("#stage"), artboardScaler: $("#artboardScaler"), artboard: $("#artboard"), artboardBg: $("#artboardBg"),
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
    // color
    colorEmpty: $("#colorEmpty"), colorBody: $("#colorBody"), colorNote: $("#colorNote"),
    fillColor: $("#fillColor"), fillHex: $("#fillHex"), strokeColor: $("#strokeColor"), strokeHex: $("#strokeHex"),
    colApplyFill: $("#colApplyFill"), colApplyStroke: $("#colApplyStroke"), colApplyAll: $("#colApplyAll"),
    colRestore: $("#colRestore"), colMono: $("#colMono"), colInvert: $("#colInvert"),
    // fx
    fxEmpty: $("#fxEmpty"), fxBody: $("#fxBody"), fxToggleGrid: $("#fxToggleGrid"), allowTransform: $("#allowTransform"),
    // audio
    audioBtn: $("#audioBtn"), audioInput: $("#audioInput"), levelFill: $("#levelFill"), audioName: $("#audioName"),
    audioReactiveToggle: $("#audioReactiveToggle"), beatMeter: $("#beatMeter"),
    // bg
    bgColor: $("#bgColor"), bgHex: $("#bgHex"),
    // timeline
    tlBody: $("#tlBody"), tlRuler: $("#tlRuler"), tlTracks: $("#tlTracks"), tlEmpty: $("#tlEmpty"), tlPlayhead: $("#tlPlayhead"), durSegTl: $("#durSegTl"),
    // export
    exportBtn: $("#exportBtn"), exportSheet: $("#exportSheet"), exportClose: $("#exportClose"),
    exportPng: $("#exportPng"), exportPngT: $("#exportPngT"), exportSeq: $("#exportSeq"), exportSeqT: $("#exportSeqT"),
    exportWebm: $("#exportWebm"), exportWebmA: $("#exportWebmA"), exportMp4: $("#exportMp4"),
    exportStatus: $("#exportStatus"), optTransparent: $("#optTransparent"), optAudio: $("#optAudio"),
    layerModeRow: $("#layerModeRow"),
    toast: $("#toast"),
  };

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
    });
    if (!ok) toast("No supported files (SVG, PNG, JPG, WebP)");
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
      const thumb = a.kind === "IMG" ? `<img class="asset-thumb" src="${a.dataUrl}" alt="">` : `<div class="asset-thumb">${svgThumb(a.node)}</div>`;
      card.innerHTML = `<span class="asset-kind">${a.kind}</span><button class="asset-del" title="Remove from library">\u00d7</button>` + thumb;
      card.addEventListener("click", (e) => { if (e.target.classList.contains("asset-del")) { removeAsset(a); e.stopPropagation(); } else { addLayerFromAsset(a); toast(`Layer added: ${a.name}`); } });
      el.assetList.appendChild(card);
    });
  }
  function svgThumb(node) { const c = node.cloneNode(true); c.setAttribute("width", "100%"); c.setAttribute("height", "100%"); return c.outerHTML; }
  function removeAsset(a) { const i = assets.indexOf(a); if (i >= 0) assets.splice(i, 1); renderAssetList(); }

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
    if (asset.kind === "SVG") { node = asset.node.cloneNode(true); splitTextNodes(node); }
    else { node = new Image(); node.src = asset.dataUrl; }
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
      fx: [], allowTransform: false,
      recipe: makeRecipe(id * 131),
      originalColors: null,
    };
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
    const asset = assets.find((a) => a.id === layer.assetId);
    if (!asset) { toast("Original asset not in library"); return; }
    addLayerFromAsset(asset);
    const dup = layers[layers.length - 1];
    dup.transform = { ...layer.transform, cx: layer.transform.cx + 4, cy: layer.transform.cy + 4 };
    dup.fx = layer.fx.slice(); dup.allowTransform = layer.allowTransform;
    dup.start = layer.start; dup.duration = layer.duration;
    renderLayers(); renderTimeline(); paintIfPaused();
  }
  function deleteLayer(layer) {
    const i = layers.indexOf(layer); if (i < 0) return;
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
  function renderInspector() {
    const has = !!selectedLayer;
    el.transformEmpty.hidden = has; el.transformBody.hidden = !has;
    el.fxEmpty.hidden = has; el.fxBody.hidden = !has;
    const isSvg = has && selectedLayer.kind === "SVG";
    el.colorEmpty.hidden = isSvg; el.colorBody.hidden = !isSvg;
    if (!has) return;
    const t = selectedLayer.transform;
    setSlider("x", t.cx); setSlider("y", t.cy); setSlider("scale", Math.round(t.wPct / initialWPct(selectedLayer) * 100));
    setSlider("w", Math.round(t.wPct)); setSlider("h", Math.round(t.hPct)); setSlider("rot", t.rot); setSlider("op", t.opacity);
    el.layerHide.textContent = selectedLayer.visible ? "Hide" : "Show";
    el.layerLock.textContent = selectedLayer.locked ? "Unlock" : "Lock";
    el.layerLock.classList.toggle("active", selectedLayer.locked);
    el.allowTransform.checked = selectedLayer.allowTransform;
    // fx toggles
    el.fxToggleGrid.innerHTML = "";
    FX_LIBRARY.forEach((fx) => {
      const isT = FX_TRANSFORM.has(fx.key);
      const b = document.createElement("button");
      b.className = "fx-toggle" + (selectedLayer.fx.includes(fx.key) ? " on" : "") + (isT ? " fx-transform" : "") + (isT && selectedLayer.allowTransform ? " enabled" : "");
      b.innerHTML = `<span class="fx-dot"></span>${fx.label}`;
      b.title = isT ? "Transform effect — needs 'Allow transform motion'" : "";
      b.addEventListener("click", () => {
        const i = selectedLayer.fx.indexOf(fx.key);
        if (i >= 0) selectedLayer.fx.splice(i, 1); else selectedLayer.fx.push(fx.key);
        b.classList.toggle("on"); if (selectedLayer.fx.length && !STATE.playing) startPlayback(); else if (!selectedLayer.fx.length) paintIfPaused();
      });
      el.fxToggleGrid.appendChild(b);
    });
    if (isSvg) { el.colorNote.hidden = !selectedLayer.complex; }
  }
  function initialWPct(layer) {
    const A = STATE.format, fit = Math.min(A.w / layer.natW, A.h / layer.natH);
    return (layer.natW * fit / A.w) * 100 || 1;
  }
  function setSlider(key, val) {
    const input = document.getElementById(`ctl-${key}`), out = document.getElementById(`val-${key}`);
    if (input) { input.value = val; const min = +input.min, max = +input.max; input.style.setProperty("--pct", ((val - min) / (max - min) * 100) + "%"); }
    if (out) out.textContent = Math.round(val);
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
  const TL = { pxPerSec: 0, dragClip: null, mode: null, startX: 0, orig: null };
  function renderTimeline() {
    const bodyW = el.tlTracks.clientWidth || el.tlBody.clientWidth || 600;
    TL.pxPerSec = bodyW / STATE.duration;
    el.tlRuler.innerHTML = "";
    for (let s = 0; s <= STATE.duration; s++) { const tick = document.createElement("div"); tick.className = "tl-tick"; tick.style.left = (s * TL.pxPerSec) + "px"; tick.textContent = s + "s"; el.tlRuler.appendChild(tick); }
    el.tlEmpty.style.display = layers.length ? "none" : "";
    el.tlTracks.querySelectorAll(".tl-track").forEach((n) => n.remove());
    [...layers].reverse().forEach((layer) => {
      const track = document.createElement("div"); track.className = "tl-track";
      const label = document.createElement("span"); label.className = "tl-track-label"; label.textContent = layer.name; track.appendChild(label);
      const clip = document.createElement("div"); clip.className = "tl-clip" + (layer === selectedLayer ? " selected" : "");
      clip.style.left = (layer.start * TL.pxPerSec) + "px"; clip.style.width = Math.max(14, layer.duration * TL.pxPerSec) + "px";
      const fxName = layer.fx.length ? layer.fx.length + " fx" : "no fx";
      clip.innerHTML = `<span class="tl-handle left"></span><span class="tl-clip-label">${layer.name} \u00b7 ${fxName}</span><span class="tl-handle right"></span>`;
      clip.addEventListener("mousedown", (e) => startClipDrag(e, layer, clip));
      clip.addEventListener("click", (e) => { e.stopPropagation(); selectLayer(layer); });
      track.appendChild(clip); el.tlTracks.appendChild(track);
    });
  }
  function startClipDrag(e, layer, clip) {
    e.preventDefault(); selectLayer(layer);
    const isLeft = e.target.classList.contains("left"), isRight = e.target.classList.contains("right");
    TL.dragClip = { layer, clip }; TL.mode = isLeft ? "trim-left" : isRight ? "trim-right" : "move";
    TL.startX = e.clientX; TL.orig = { start: layer.start, duration: layer.duration };
    clip.classList.add("dragging");
    document.addEventListener("mousemove", onClipDrag); document.addEventListener("mouseup", endClipDrag);
  }
  function onClipDrag(e) {
    if (!TL.dragClip) return;
    const dx = (e.clientX - TL.startX) / TL.pxPerSec, { layer } = TL.dragClip, o = TL.orig, D = STATE.duration;
    if (TL.mode === "move") layer.start = clamp(o.start + dx, 0, Math.max(0, D - layer.duration));
    else if (TL.mode === "trim-left") { const ns = clamp(o.start + dx, 0, o.start + o.duration - 0.2); layer.duration = o.duration - (ns - o.start); layer.start = ns; }
    else if (TL.mode === "trim-right") layer.duration = clamp(o.duration + dx, 0.2, D - layer.start);
    const c = TL.dragClip.clip; c.style.left = (layer.start * TL.pxPerSec) + "px"; c.style.width = Math.max(14, layer.duration * TL.pxPerSec) + "px";
  }
  function endClipDrag() { if (TL.dragClip) TL.dragClip.clip.classList.remove("dragging"); TL.dragClip = null; document.removeEventListener("mousemove", onClipDrag); document.removeEventListener("mouseup", endClipDrag); }
  function setDuration(sec) { STATE.duration = sec; layers.forEach((l) => { l.start = clamp(l.start, 0, sec); l.duration = clamp(l.duration, 0.2, sec - l.start); }); EXPORTOPTS.duration = sec; syncDurationUI(); renderTimeline(); }
  function syncDurationUI() { [el.durSegTl, document.getElementById("durSeg")].forEach((seg) => { if (!seg) return; seg.querySelectorAll("[data-dur]").forEach((b) => b.classList.toggle("active", b.dataset.dur == STATE.duration || (b.dataset.dur === "custom" && ![4, 8, 15].includes(STATE.duration)))); }); }

  /* ============================================================ AUDIO ============================================================ */
  const audio = { ctx: null, el: null, source: null, analyser: null, freqData: null, timeData: null, ready: false, lastBeat: 0, prevBass: 0, prevFlux: 0, env: { bass: 0, mid: 0, high: 0, level: 0 }, energyAvg: 0, destGain: null, streamDest: null };
  function initAudio(file) {
    try {
      if (audio.el) audio.el.pause();
      audio.el = new Audio(URL.createObjectURL(file)); audio.el.loop = STATE.loop;
      audio.ctx = audio.ctx || new (window.AudioContext || window.webkitAudioContext)();
      audio.source = audio.ctx.createMediaElementSource(audio.el);
      audio.analyser = audio.ctx.createAnalyser(); audio.analyser.fftSize = 2048; audio.analyser.smoothingTimeConstant = 0.75;
      audio.destGain = audio.ctx.createGain();
      audio.source.connect(audio.analyser); audio.source.connect(audio.destGain); audio.destGain.connect(audio.ctx.destination);
      audio.freqData = new Uint8Array(audio.analyser.frequencyBinCount); audio.timeData = new Uint8Array(audio.analyser.frequencyBinCount);
      audio.ready = true; el.audioName.textContent = file.name; toast("Audio loaded — reactions engaged");
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
    if (bass > beatGate && bass > audio.prevBass * (1.05 + (1 - sens) * 0.25) && now - audio.lastBeat > refractory) { STATE.beat = 1; audio.lastBeat = now; } else STATE.beat *= (0.80 + (1 - STATE.syncTightness / 100) * 0.15);
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

  /* ---------------- RENDER LOOP ---------------- */
  let rafStart = performance.now();
  let hudLayer = null, flashOverlay = null;
  function frame(now) {
    requestAnimationFrame(frame);
    analyzeAudio();
    if (!STATE.playing) { return; }
    const elapsed = (now - rafStart) / 1000;
    STATE.time = STATE.loop ? (elapsed % STATE.duration) : Math.min(elapsed, STATE.duration);
    const t = STATE.time, sig = audioSignal();
    let sceneScan = STATE.scanline / 100, sceneNoise = STATE.noise / 100, anyHud = false, hudFlicker = 1, anyFlash = null, flashA = 0;

    layers.forEach((layer) => {
      if (!layer.wrap) return;
      const active = layer.visible && t >= layer.start - 0.001 && t <= layer.start + layer.duration + 0.001;
      if (!active) { layer.wrap.style.opacity = "0"; return; }
      const lt = t - layer.start + layer.recipe.delay;
      const r = composeLayer(layer, lt, sig);
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

  function composeLayer(layer, t, sig) {
    const T = layer.transform;
    // static base transform (position/size/rotation set by user)
    let tx = 0, ty = 0, extraScale = 1, rot = 0, rotX = 0, rotY = 0, skew = 0;
    let opacity = T.opacity / 100, blur = 0, rgb = 0, glow = 0;
    let hud = false, hudFlicker = 1, flash = null, flashA = 0, scanBoost = 0, breakup = 0;
    let pathDraw = null, pathTrim = null;
    const allowT = layer.allowTransform;

    for (const key of layer.fx) {
      const mod = EFFECTS[key]; if (!mod) continue;
      const isT = FX_TRANSFORM.has(key);
      if (isT && !allowT) continue; // gate transform effects
      const d = mod(sig, t) || {};
      // appearance
      if (d.opacity !== undefined) opacity *= d.opacity;
      if (d.opacityWave !== undefined) opacity *= d.opacityWave;
      if (d.blur) blur += d.blur;
      if (d.rgb) rgb = Math.max(rgb, d.rgb);
      if (d.glow) glow = Math.max(glow, d.glow);
      if (d.hud) { hud = true; hudFlicker = d.hudFlicker; }
      if (d.flash) { flash = d.flash; flashA = d.flashA; }
      if (d.scanBoost) scanBoost = Math.max(scanBoost, d.scanBoost);
      if (d.breakup) breakup = Math.max(breakup, d.breakup);
      if (d.pathDraw !== undefined) pathDraw = d.pathDraw;
      if (d.pathTrim !== undefined) pathTrim = d.pathTrim;
      if (d.skew) { if (allowT) skew += d.skew; }
      // safe scale (blur-in 0.96->1) is allowed even without transform, it's tiny
      if (d.scaleSafe !== undefined) extraScale *= d.scaleSafe;
      // transform-only
      if (isT) { if (d.tx) tx += d.tx; if (d.ty) ty += d.ty; if (d.rot) rot += d.rot; if (d.rotX) rotX += d.rotX; if (d.rotY) rotY += d.rotY; }
    }
    blur += (STATE.blur / 100) * 2;

    // SVG stroke-dash animation for Line Draw / Trim Paths
    if (layer.kind === "SVG" && (pathDraw !== null || pathTrim !== null)) applyPathDash(layer, pathDraw, pathTrim);
    else if (layer.kind === "SVG" && layer._dashApplied) clearPathDash(layer);

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
    return { hud, hudFlicker, flash, flashA, scanBoost, breakup };
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
    // reset any sublayer transforms so grouped/exposed SVGs sit still
    if (layer.subLayers) layer.subLayers.forEach((n) => { n.style.transform = ""; n.style.opacity = ""; });
    if (layer.kind === "SVG" && layer._dashApplied) clearPathDash(layer);
  }

  // Render one static frame (no animation) — every visible layer at rest,
  // overlays cleared. Called on import, transform edits, format/zoom
  // changes, etc. while paused.
  function renderStaticFrame() {
    if (STATE.playing) return;
    layers.forEach((layer) => { if (!layer.wrap) return; if (!layer.visible) { layer.wrap.style.opacity = "0"; return; } placeLayerStatic(layer); });
    el.artboard.style.setProperty("--scanline-op", 0);
    el.artboard.style.setProperty("--noise-op", 0);
    if (hudLayer) hudLayer.style.display = "none";
    if (flashOverlay) flashOverlay.style.opacity = 0;
    if (selectedLayer) updateSelectionBox();
  }
  function paintIfPaused() { if (!STATE.playing) renderStaticFrame(); }

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
    layer.subLayers.forEach((node) => {
      const rc = node._recipe; if (!rc) return;
      const lt = t - rc.delay, band = rc.band === "bass" ? sig.bass : rc.band === "mid" ? sig.mid : sig.high;
      let op = 0.78 + 0.22 * Math.sin(lt * rc.freq * 1.3 + rc.phase);
      if (layer.fx.includes("flickerBlocks") && Math.random() < 0.03 * fl * rc.flickerBias) op *= 0.25;
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
  function updatePlayheads(t) { const pct = STATE.duration ? (t / STATE.duration) : 0; if (el.tlPlayhead) el.tlPlayhead.style.left = (pct * (el.tlTracks.clientWidth || 0)) + "px"; if (el.timecode) el.timecode.textContent = t.toFixed(1) + "s"; }
  function togglePlay() {
    STATE.playing = !STATE.playing;
    const show = (i, p) => { if (i) i.style.display = STATE.playing ? "none" : "block"; if (p) p.style.display = STATE.playing ? "block" : "none"; };
    show(el.playIcon, el.pauseIcon); show(el.topPlayIcon, el.topPauseIcon);
    if (STATE.playing) { rafStart = performance.now() - STATE.time * 1000; if (audio.ready) { if (audio.ctx.state === "suspended") audio.ctx.resume(); audio.el.play().catch(() => {}); } }
    else { if (audio.ready) audio.el.pause(); renderStaticFrame(); }
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
    Object.entries(p.patch).forEach(([k, v]) => { if (k in STATE) STATE[k] = v; });
    syncControls();
    const targets = (toAll || !selectedLayer) ? layers : [selectedLayer];
    if (!targets.length) { toast("Add a layer first"); return; }
    targets.forEach((layer, i) => {
      layer.fx = p.fx.slice();
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
  const AI_RULES = [
    { kw: ["cleaner", "clean", "minimal", "elegant"], apply: () => { set("glitch", 10); set("noise", 8); set("flicker", 14); bump("blur", -4); layerFxAll(["blurIn", "pulseGlow"]); }, say: "Cleaner" },
    { kw: ["more aggressive", "aggressive", "harder", "intense", "harsh"], apply: () => { bump("glitch", 25); bump("rgbSplit", 20); bump("bassReaction", 20); bump("motionIntensity", 15); layerFxAll(["hardCut", "rgbOffset", "flickerBlocks", "dataBreakup", "pulseGlow"]); }, say: "More aggressive" },
    { kw: ["synced to the beat", "more synced", "sync to the beat", "beat sync", "on beat"], apply: () => { bump("beatSensitivity", 25); bump("bassReaction", 25); bump("peakThreshold", -10); bump("syncTightness", 20); bump("motionIntensity", 15); STATE.audioReactive = true; if (el.audioReactiveToggle) el.audioReactiveToggle.checked = true; }, say: "Tighter beat sync" },
    { kw: ["1:1 post", "square", "1080 x 1080", "post"], apply: () => { setFormat(1080, 1080, "Post 1:1"); }, say: "Square 1:1 post" },
    { kw: ["ig reel", "instagram reel", "reel", "vertical", "9:16"], apply: () => { setFormat(1080, 1920, "Reel 9:16"); setDuration(8); }, say: "Reel-ready (1080\u00d71920)" },
    { kw: ["portrait", "4:5"], apply: () => { setFormat(1080, 1350, "Portrait 4:5"); }, say: "Portrait 4:5" },
    { kw: ["landscape", "16:9"], apply: () => { setFormat(1920, 1080, "Landscape 16:9"); }, say: "Landscape 16:9" },
    { kw: ["transparent png", "transparent", "alpha", "no background"], apply: () => { setBackground("transparent"); EXPORTOPTS.transparent = true; if (el.optTransparent) el.optTransparent.checked = true; }, say: "Transparent output armed" },
    { kw: ["export mp4", "mp4", "h.264", "h264"], apply: () => { openSheet(); }, say: "MP4 workflow — see Export" },
    { kw: ["every layer different", "each layer different", "vary layers", "layers different"], apply: () => { layers.forEach((l, i) => { l.recipe = makeRecipe((l.id * 131 + Math.floor(Math.random() * 99999))); l.start = Math.min(STATE.duration * 0.5, i * 0.3); }); renderTimeline(); }, say: "Every layer differs" },
    { kw: ["signal system", "interface motion", "hardware motion"], apply: () => applyPreset("Signal System", !selectedLayer), say: "Signal System" },
    { kw: ["vector scan", "radar", "scanner"], apply: () => applyPreset("Vector Scan", !selectedLayer), say: "Vector Scan" },
    { kw: ["signal loss"], apply: () => applyPreset("Signal Loss", !selectedLayer), say: "Signal Loss" },
    { kw: ["data pulse", "data breakup", "corrupt"], apply: () => { applyPreset("Data Pulse", !selectedLayer); }, say: "Data Pulse" },
    { kw: ["crt", "scanline", "scanlines"], apply: () => { bump("scanline", 30); applyPreset("CRT Monitor", !selectedLayer); }, say: "CRT scan" },
    { kw: ["hud", "overlay", "coordinates", "labels"], apply: () => layerFxAdd("hudOverlay"), say: "HUD overlay" },
    { kw: ["glow", "pulse"], apply: () => layerFxAdd("pulseGlow"), say: "Pulse glow" },
    { kw: ["hologram", "tilt", "3d"], apply: () => { if (selectedLayer) { selectedLayer.allowTransform = true; el.allowTransform.checked = true; } layerFxAdd("hologramTilt"); }, say: "Hologram tilt (transform on)" },
    { kw: ["shake"], apply: () => { if (selectedLayer) { selectedLayer.allowTransform = true; el.allowTransform.checked = true; } layerFxAdd("signalShake"); }, say: "Signal shake (transform on)" },
    { kw: ["allow transform", "enable transform", "allow motion", "rotation", "zoom", "scale motion"], apply: () => { (selectedLayer ? [selectedLayer] : layers).forEach((l) => l.allowTransform = true); if (el.allowTransform) el.allowTransform.checked = true; renderInspector(); }, say: "Transform motion enabled" },
    { kw: ["dark", "darker", "moody"], apply: () => { setBackground("custom", "#050506"); bump("scanline", 12); }, say: "Darker" },
    { kw: ["slow", "slower", "calm"], apply: () => { set("speed", 25); bump("flicker", -12); }, say: "Slower" },
    { kw: ["fast", "faster", "rapid"], apply: () => { set("speed", 82); bump("flicker", 12); }, say: "Faster" },
  ];
  const bump = (k, d) => (STATE[k] = clampP(STATE[k] + d));
  const set = (k, v) => (STATE[k] = clampP(v));
  const clampP = (v) => Math.max(0, Math.min(100, v));
  function layerFxAll(arr) { (selectedLayer ? [selectedLayer] : layers).forEach((l) => l.fx = arr.slice()); renderInspector(); }
  function layerFxAdd(fx) { (selectedLayer ? [selectedLayer] : layers).forEach((l) => { if (!l.fx.includes(fx)) l.fx.push(fx); }); renderInspector(); }
  function runAI() {
    const text = el.aiPrompt.value.toLowerCase().trim();
    if (!text) { el.aiEcho.textContent = "Type a direction first, like \u201cmake it more synced to the beat.\u201d"; return; }
    const hits = []; AI_RULES.forEach((r) => { if (r.kw.some((k) => text.includes(k))) { r.apply(); hits.push(r.say); } });
    syncControls(); startPlayback();
    el.aiEcho.textContent = hits.length ? hits.join(" \u00b7 ") : "No keywords matched. Try: cleaner, aggressive, synced to the beat, 1:1 post, IG reel, transparent PNG, every layer different, allow transform.";
  }

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
    el.artboardScaler.style.transform = `scale(${STATE.zoom})`;
    const label = STATE.zoomMode === "fit" ? "Fit" : Math.round(STATE.zoom * 100) + "%";
    el.zoomVal.textContent = label; el.readoutZoom.textContent = label;
    $$("#zoomPresets [data-zoom]").forEach((b) => b.classList.toggle("active", STATE.zoomMode === "manual" && Math.abs(STATE.zoom - +b.dataset.zoom) < 0.001));
  }

  /* ============================================================ EXPORT ============================================================ */
  const EXPORTOPTS = { transparent: false, duration: 8, fps: 30, includeAudio: true, quality: "high", bg: "selected", target: "comp", lmode: "canvas" };

  function openSheet() { el.exportSheet.hidden = false; syncExportUI(); setExportStatus("Ready", "info"); }
  function closeSheet() { el.exportSheet.hidden = true; }
  function qualScale() { return EXPORTOPTS.quality === "2x" ? 2 : EXPORTOPTS.quality === "ultra" ? 1.5 : 1; }

  function resolveExportBg(forVideo) {
    if (forVideo && EXPORTOPTS.bg !== "transparent") { if (EXPORTOPTS.bg === "black") return "#000000"; if (EXPORTOPTS.bg === "white") return "#FFFFFF"; return currentBgPaint(); }
    if (EXPORTOPTS.transparent || EXPORTOPTS.bg === "transparent") return null;
    if (EXPORTOPTS.bg === "black") return "#000000"; if (EXPORTOPTS.bg === "white") return "#FFFFFF"; return currentBgPaint();
  }
  function currentBgPaint() { if (STATE.bgMode === "transparent") return null; if (STATE.bgMode === "gradient") return { grad: [STATE.bgColor, STATE.bgColor2] }; if (STATE.bgMode === "white") return "#FFFFFF"; if (STATE.bgMode === "black") return "#000000"; return STATE.bgColor; }

  function layerToImage(layer) {
    return new Promise((resolve) => {
      if (layer.kind === "IMG") { resolve(layer.node); return; }
      const svgStr = new XMLSerializer().serializeToString(layer.node);
      const url = URL.createObjectURL(new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" }));
      const img = new Image(); img.onload = () => { URL.revokeObjectURL(url); resolve(img); }; img.onerror = () => { URL.revokeObjectURL(url); resolve(null); }; img.src = url;
    });
  }
  async function rasterizeAll() { const imgs = {}; for (const l of layers) imgs[l.id] = await layerToImage(l); return imgs; }

  // Which layers to draw: whole comp or just the selected layer.
  function exportLayers() { return (EXPORTOPTS.target === "layer" && selectedLayer) ? [selectedLayer] : layers; }

  // Draw one frame. If cropRect given (px in artboard space), the canvas
  // represents that crop region only.
  async function drawExportFrame(ctx, W, H, imgs, t, opts, cropRect) {
    const transparent = !opts.bg;
    ctx.clearRect(0, 0, W, H);
    if (!transparent) { if (typeof opts.bg === "object" && opts.bg.grad) { const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, opts.bg.grad[0]); g.addColorStop(1, opts.bg.grad[1]); ctx.fillStyle = g; } else ctx.fillStyle = opts.bg; ctx.fillRect(0, 0, W, H); }
    const A = STATE.format;
    // scale from artboard px to export px
    const sx = cropRect ? (W / cropRect.w) : (W / A.w), sy = cropRect ? (H / cropRect.h) : (H / A.h);
    const offX = cropRect ? cropRect.x : 0, offY = cropRect ? cropRect.y : 0;
    const sig = audioSignal();
    const drawList = exportLayers();

    drawList.forEach((layer) => {
      if (!layer.visible) return;
      if (t < layer.start - 0.001 || t > layer.start + layer.duration + 0.001) return;
      const img = imgs[layer.id]; if (!img) return;
      const T = layer.transform, lt = t - layer.start + layer.recipe.delay, allowT = layer.allowTransform;
      let op = T.opacity / 100, blur = 0, rgb = 0, glow = 0, extraScale = 1, rot = T.rot, tx = 0, ty = 0;
      for (const key of layer.fx) {
        const mod = EFFECTS[key]; if (!mod) continue; const isT = FX_TRANSFORM.has(key); if (isT && !allowT) continue;
        const d = mod(sig, lt) || {};
        if (d.opacity !== undefined) op *= d.opacity; if (d.opacityWave !== undefined) op *= d.opacityWave;
        if (d.blur) blur += d.blur; if (d.rgb) rgb = Math.max(rgb, d.rgb); if (d.glow) glow = Math.max(glow, d.glow);
        if (d.scaleSafe !== undefined) extraScale *= d.scaleSafe;
        if (isT) { if (d.tx) tx += d.tx; if (d.ty) ty += d.ty; if (d.rot) rot += d.rot; }
      }
      const wPx = (T.wPct / 100) * A.w * extraScale, hPx = (T.hPct / 100) * A.h * extraScale;
      const cxPx = (T.cx / 100) * A.w + (allowT ? (tx / 100) * A.w : 0), cyPx = (T.cy / 100) * A.h + (allowT ? (ty / 100) * A.h : 0);
      const centerX = (A.w / 2 + cxPx - offX) * sx, centerY = (A.h / 2 + cyPx - offY) * sy;
      const dw = wPx * sx, dh = hPx * sy;
      ctx.save(); ctx.globalAlpha = clamp01(op); ctx.translate(centerX, centerY); ctx.rotate((rot) * Math.PI / 180);
      if (glow) { ctx.shadowColor = "rgba(122,92,255,0.6)"; ctx.shadowBlur = glow * sx; }
      if (rgb > 0.3) { const off = rgb * sx; ctx.globalCompositeOperation = "screen"; const a = ctx.globalAlpha; ctx.globalAlpha = a * 0.5; ctx.drawImage(img, -dw / 2 + off, -dh / 2, dw, dh); ctx.drawImage(img, -dw / 2 - off, -dh / 2, dw, dh); ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = a; }
      ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
    });

    if (STATE.scanline > 0) { if (transparent) ctx.globalCompositeOperation = "source-atop"; ctx.fillStyle = `rgba(0,0,0,${(STATE.scanline / 100) * 0.5 * (1 + sig.high)})`; const step = 3 * sy; for (let y = 0; y < H; y += step) ctx.fillRect(0, y, W, Math.max(1, sy)); ctx.globalCompositeOperation = "source-over"; }
    if (STATE.noise > 0) { const n = ctx.getImageData(0, 0, W, H), amt = (STATE.noise / 100) * 40 * (1 + sig.high), d = n.data; for (let i = 0; i < d.length; i += 4) { if (transparent && d[i + 3] === 0) continue; if (Math.random() < 0.3) { const v = (Math.random() - 0.5) * amt; d[i] += v; d[i + 1] += v; d[i + 2] += v; } } ctx.putImageData(n, 0, 0); }
    if (!transparent) { const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.4)"); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); const flashing = drawList.some((l) => l.visible && l.fx.includes("hardCut")) && (sig.peak > 0.6 || sig.beat > 0.72); if (flashing) { ctx.fillStyle = Math.random() < 0.5 ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.5)"; ctx.fillRect(0, 0, W, H); } }
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
    const ctx = c.getContext("2d"), imgs = await rasterizeAll();
    await drawExportFrame(ctx, W, H, imgs, STATE.time, { bg: transparent ? null : resolveExportBg(false) }, crop);
    c.toBlob((b) => { downloadBlob(b, transparent ? baseName("transparent.png") : baseName("png")); setExportStatus("Done — PNG saved", "done"); closeSheet(); }, "image/png");
  }
  async function exportSequence(tOverride) {
    if (!layers.length) { toast("Add a layer first"); return; }
    const transparent = tOverride !== undefined ? tOverride : (EXPORTOPTS.transparent || EXPORTOPTS.bg === "transparent");
    const fps = EXPORTOPTS.fps, dur = EXPORTOPTS.duration, total = Math.round(fps * dur);
    setExportStatus(`Rendering ${total} frames (${dur}s @ ${fps}fps)…`, "work");
    const { W, H, crop } = exportDims(), c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d"), imgs = await rasterizeAll(), bg = transparent ? null : resolveExportBg(false);
    for (let f = 0; f < total; f++) { await drawExportFrame(ctx, W, H, imgs, f / fps, { bg }, crop); await new Promise((res) => c.toBlob((b) => { downloadBlob(b, `phaser-seq-${String(f).padStart(4, "0")}.png`); setTimeout(res, 55); }, "image/png")); if (f % 10 === 0) setExportStatus(`Rendering frame ${f + 1}/${total}…`, "work"); }
    setExportStatus("Done — sequence saved", "done"); closeSheet();
  }
  function pickWebmMime() { return ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm"; }
  async function exportWebM(alphaOverride) {
    if (!layers.length) { toast("Add a layer first"); return; }
    if (typeof MediaRecorder === "undefined") { setExportStatus("This browser can't record video — use PNG sequence", "error"); return; }
    const fps = EXPORTOPTS.fps, wantAlpha = alphaOverride !== undefined ? alphaOverride : (EXPORTOPTS.transparent && EXPORTOPTS.bg === "transparent");
    setExportStatus(`Recording WebM (${EXPORTOPTS.duration}s @ ${fps}fps)…`, "work");
    const { W, H, crop } = exportDims(), c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d"), imgs = await rasterizeAll();
    const vStream = c.captureStream(fps); let mixed = vStream;
    if (EXPORTOPTS.includeAudio && audio.ready && audio.ctx) { try { audio.streamDest = audio.streamDest || audio.ctx.createMediaStreamDestination(); audio.destGain.connect(audio.streamDest); const at = audio.streamDest.stream.getAudioTracks()[0]; if (at) mixed = new MediaStream([...vStream.getVideoTracks(), at]); if (audio.ctx.state === "suspended") await audio.ctx.resume(); audio.el.currentTime = 0; audio.el.play().catch(() => {}); } catch (e) {} }
    const bg = wantAlpha ? null : resolveExportBg(true);
    let rec; try { rec = new MediaRecorder(mixed, { mimeType: pickWebmMime(), videoBitsPerSecond: EXPORTOPTS.quality === "high" ? 12000000 : 16000000 }); } catch (e) { setExportStatus("Recording not supported here — use PNG sequence", "error"); return; }
    const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => { const blob = new Blob(chunks, { type: "video/webm" }); LAST_WEBM_BLOB = blob; downloadBlob(blob, wantAlpha ? baseName("alpha.webm") : baseName("webm")); setExportStatus("Done — WebM saved", "done"); closeSheet(); };
    const t0 = performance.now(); rec.start();
    (function rf(now) { const e2 = (now - t0) / 1000; drawExportFrame(ctx, W, H, imgs, e2 % STATE.duration, { bg }, crop); if (e2 < EXPORTOPTS.duration) requestAnimationFrame(rf); else { rec.stop(); if (audio.ready) audio.el.pause(); } })(performance.now());
  }

  /* MP4 (H.264) via ffmpeg.wasm — FFMPEG.WASM INTEGRATION POINT
     Record WebM then transcode. ffmpeg tags are commented out in
     index.html by default (~30MB). Without them: export WebM + message.
     The MP4 button never crashes the app. */
  let LAST_WEBM_BLOB = null, ffmpegInstance = null;
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
    setExportStatus("Preparing render…", "work");
    if (!LAST_WEBM_BLOB) { setExportStatus("Recording source video for MP4…", "work"); await recordWebMForMp4(); if (!LAST_WEBM_BLOB) { setExportStatus("Could not record source video", "error"); return; } }
    let ff = null; try { ff = await loadFFmpeg(); } catch (e) { ff = null; }
    if (!ff) { downloadBlob(LAST_WEBM_BLOB, baseName("webm")); setExportStatus("MP4 encoding requires ffmpeg.wasm. Export WebM or PNG sequence now. (Saved WebM; uncomment the ffmpeg tags in index.html to enable MP4.)", "error"); return; }
    try {
      setExportStatus("Encoding H.264 MP4…", "work");
      const inName = "in.webm", outName = baseName("mp4"), bytes = new Uint8Array(await LAST_WEBM_BLOB.arrayBuffer());
      const crf = EXPORTOPTS.quality === "ultra" || EXPORTOPTS.quality === "2x" ? "16" : "18";
      const args = ["-i", inName, "-c:v", "libx264", "-preset", "veryfast", "-crf", crf, "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-r", String(EXPORTOPTS.fps), "-c:a", "aac", "-b:a", "192k", outName];
      if (ff.api === "new") { await ff.ff.writeFile(inName, bytes); await ff.ff.exec(args); const out = await ff.ff.readFile(outName); downloadBlob(new Blob([out.buffer], { type: "video/mp4" }), outName); }
      else { ff.ff.FS("writeFile", inName, bytes); await ff.ff.run(...args); const out = ff.ff.FS("readFile", outName); downloadBlob(new Blob([out.buffer], { type: "video/mp4" }), outName); }
      setExportStatus("Done — " + outName + " saved", "done"); closeSheet();
    } catch (e) { downloadBlob(LAST_WEBM_BLOB, baseName("webm")); setExportStatus("MP4 encode failed — saved WebM as fallback", "error"); }
  }
  function recordWebMForMp4() {
    return new Promise(async (resolve) => {
      if (typeof MediaRecorder === "undefined") { resolve(); return; }
      const fps = EXPORTOPTS.fps, { W, H, crop } = exportDims(), c = document.createElement("canvas"); c.width = W; c.height = H;
      const ctx = c.getContext("2d"), imgs = await rasterizeAll();
      const vStream = c.captureStream(fps); let mixed = vStream;
      if (EXPORTOPTS.includeAudio && audio.ready && audio.ctx) { try { audio.streamDest = audio.streamDest || audio.ctx.createMediaStreamDestination(); audio.destGain.connect(audio.streamDest); const at = audio.streamDest.stream.getAudioTracks()[0]; if (at) mixed = new MediaStream([...vStream.getVideoTracks(), at]); if (audio.ctx.state === "suspended") await audio.ctx.resume(); audio.el.currentTime = 0; audio.el.play().catch(() => {}); } catch (e) {} }
      let rec; try { rec = new MediaRecorder(mixed, { mimeType: pickWebmMime(), videoBitsPerSecond: 12000000 }); } catch (e) { resolve(); return; }
      const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => { LAST_WEBM_BLOB = new Blob(chunks, { type: "video/webm" }); if (audio.ready) audio.el.pause(); resolve(); };
      const bg = resolveExportBg(true), t0 = performance.now(); rec.start();
      (function rf(now) { const e2 = (now - t0) / 1000; drawExportFrame(ctx, W, H, imgs, e2 % STATE.duration, { bg }, crop); if (e2 < EXPORTOPTS.duration) requestAnimationFrame(rf); else rec.stop(); })(performance.now());
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
    el.zoomIn.addEventListener("click", () => setZoom(STATE.zoom * 1.2));
    el.zoomOut.addEventListener("click", () => setZoom(STATE.zoom / 1.2));
    el.zoomFit.addEventListener("click", fitZoom);
    $$("#zoomPresets [data-zoom]").forEach((b) => b.addEventListener("click", () => setZoom(+b.dataset.zoom)));

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

    // resize -> refit + relayout timeline
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
    renderTimeline();
    wire();
    requestAnimationFrame(frame);
    // re-fit once layout has settled (fonts, flex sizing)
    requestAnimationFrame(() => fitZoom());
    setTimeout(() => { fitZoom(); renderTimeline(); }, 120);
  }
  document.addEventListener("DOMContentLoaded", init);
})();
