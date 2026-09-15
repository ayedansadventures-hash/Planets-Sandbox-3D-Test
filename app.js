import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { G, EARTHS_PER_SUN, KM_PER_AU, AU_YEAR_TO_KM_S, step, computeAccelerations, rocheLimit, computeTidalStress } from './physics.mjs?v=20260912';

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const AU = 10; // 1 AU = 10 Three.js world units
  const clamp = (val, min, max) => Math.min(max, Math.max(min, val));
  const formatNumber = (num, decimals = 2) => Number(num || 0).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

  // 1. RENDERER & SCENE SETUP
  const canvas = $('universe');
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;

  const scene = new T.Scene();
  scene.background = new T.Color('#030712');

  const camera = new T.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.05, 10000);
  camera.position.set(30, 42, 75);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 0.5;
  controls.maxDistance = 2500;
  controls.target.set(0, 0, 0);

  // Lighting & Realism
  const ambientLight = new T.AmbientLight(0x8ba2c4, 1.4);
  scene.add(ambientLight);
  const hemiLight = new T.HemisphereLight(0xffffff, 0x1e293b, 1.0);
  scene.add(hemiLight);
  const sunlight = new T.PointLight(0xfff7e6, 85, 0, 0.2);
  scene.add(sunlight);

  // Camera Fill Light (ensures night side of planets is softly visible and never black silhouettes)
  const cameraFillLight = new T.DirectionalLight(0xdbeafe, 0.65);
  camera.add(cameraFillLight);
  scene.add(camera);

  // 360° Seamless Equirectangular Solar Photosphere Generator
  // Eliminates flat telescope photo golf-ball artifact with seamless spherical plasma noise
  function generateSeamlessSunTexture() {
    const w = 1024, h = 512;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(w, h);
    const data = imgData.data;

    for (let y = 0; y < h; y++) {
      const v = y / h;
      const phi = v * Math.PI;
      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);

      for (let x = 0; x < w; x++) {
        const u = x / w;
        const theta = u * Math.PI * 2;
        const nx = sinPhi * Math.cos(theta);
        const ny = cosPhi;
        const nz = sinPhi * Math.sin(theta);

        // Convective granulation & turbulent filaments (seamless 3D spherical harmonics)
        const n1 = Math.sin(nx * 20 + Math.cos(ny * 20)) * Math.cos(nz * 20 + Math.sin(nx * 20));
        const n2 = Math.sin(nx * 42 + nz * 42) * Math.sin(ny * 42);
        const n3 = Math.cos(nx * 84 - ny * 84) * Math.sin(nz * 84);
        const gran = (n1 * 0.45 + n2 * 0.35 + n3 * 0.2 + 1) * 0.5;

        // Differential solar rotation and convective loops
        const band = Math.sin(ny * 9 + Math.sin(nx * 14 + nz * 14) * 1.2);
        const flux = Math.max(0, Math.sin(nx * 6 + ny * 6 + nz * 6) * 0.35 + band * 0.25);

        // Radiant heat distribution: incandescent white-gold core to fiery solar amber
        const heat = Math.min(1, Math.max(0, 0.52 + gran * 0.36 + flux * 0.22));
        const r = Math.floor(238 + heat * 17);
        const g = Math.floor(165 + heat * 85);
        const b = Math.floor(35 + heat * 95);

        const idx = (y * w + x) * 4;
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);

    const tex = new T.CanvasTexture(canvas);
    tex.wrapS = T.RepeatWrapping;
    tex.wrapT = T.ClampToEdgeWrapping;
    tex.colorSpace = T.SRGBColorSpace;
    return tex;
  }

  // Texture Loader & NASA Atlas Cache
  const textureLoader = new T.TextureLoader();
  const nasaTextures = {
    sun: generateSeamlessSunTexture(),
    mercury: textureLoader.load('assets/mercury.jpg'),
    venus: textureLoader.load('assets/venus.jpg'),
    earth: textureLoader.load('assets/earth.jpg'),
    mars: textureLoader.load('assets/mars.jpg'),
    jupiter: textureLoader.load('assets/jupiter.jpg'),
    saturn: textureLoader.load('assets/saturn.jpg'),
    uranus: textureLoader.load('assets/uranus.jpg'),
    neptune: textureLoader.load('assets/neptune.jpg'),
  };
  Object.values(nasaTextures).forEach(t => {
    t.colorSpace = T.SRGBColorSpace;
  });

  // Groups & Helpers
  const asteroidBelt = new T.Group(); asteroidBelt.name = 'Asteroid Belt'; scene.add(asteroidBelt);
  const orbitGuidesGroup = new T.Group(); orbitGuidesGroup.name = 'Orbit Guides'; scene.add(orbitGuidesGroup);
  const climateZonesGroup = new T.Group(); climateZonesGroup.name = 'Climate Zones'; scene.add(climateZonesGroup);
  const effects = [];

  const gridHelper = new T.GridHelper(200, 40, 0x334155, 0x1e293b);
  gridHelper.position.y = -0.05;
  gridHelper.visible = false;
  scene.add(gridHelper);

  const axesHelper = new T.AxesHelper(15);
  axesHelper.visible = false;
  scene.add(axesHelper);

  // Procedural Starfield
  const starGeo = new T.BufferGeometry(), starPos = [], starColors = [];
  const rng = (seed) => { let s = seed; return () => ((s = s * 16807 % 2147483647) - 1) / 2147483646; };
  const rStar = rng(777);
  for (let i = 0; i < 7500; i++) {
    const angle = rStar() * Math.PI * 2;
    const z = i < 5000 ? (rStar() + rStar() + rStar() - 1.5) * 0.3 : rStar() * 2 - 1;
    const rr = Math.sqrt(Math.max(0, 1 - z * z)), dist = 700 + rStar() * 800;
    starPos.push(Math.cos(angle) * rr * dist, z * dist, Math.sin(angle) * rr * dist);
    const c = new T.Color(rStar() < 0.22 ? '#ffe2b8' : rStar() < 0.45 ? '#bbd8ff' : '#ffffff');
    c.multiplyScalar(0.3 + rStar() * 0.7);
    starColors.push(c.r, c.g, c.b);
  }
  starGeo.setAttribute('position', new T.Float32BufferAttribute(starPos, 3));
  starGeo.setAttribute('color', new T.Float32BufferAttribute(starColors, 3));
  scene.add(new T.Points(starGeo, new T.PointsMaterial({ size: 1.15, vertexColors: true, transparent: true, opacity: 0.85, sizeAttenuation: true })));

  // Sphere Geometry & Target Reticle
  const sphereGeo = new T.SphereGeometry(1, 64, 40);
  const selectionReticle = new T.Group();
  const reticleRing = new T.Mesh(
    new T.RingGeometry(1.22, 1.28, 72),
    new T.MeshBasicMaterial({ color: 0x38bdf8, side: T.DoubleSide, transparent: true, opacity: 0.65, depthWrite: false })
  );
  reticleRing.rotation.x = -Math.PI / 2;
  selectionReticle.add(reticleRing);
  selectionReticle.visible = false;
  scene.add(selectionReticle);

  const placementRing = new T.Mesh(new T.RingGeometry(1.15, 1.25, 96), new T.MeshBasicMaterial({ color: 0x34d399, side: T.DoubleSide, transparent: true, opacity: 0.9, blending: T.AdditiveBlending, depthWrite: false }));
  placementRing.rotation.x = -Math.PI / 2; placementRing.visible = false; scene.add(placementRing);

  // 2. WEB AUDIO PROCEDURAL SOUND ENGINE
  const SoundEngine = (() => {
    let ctx = null, masterGain = null, droneGain = null, muted = false, initialized = false;
    function init() {
      if (initialized) return;
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        ctx = new AudioCtx();
        masterGain = ctx.createGain();
        masterGain.gain.setValueAtTime(0.3, ctx.currentTime);
        masterGain.connect(ctx.destination);

        // Ambient deep space drone
        const osc1 = ctx.createOscillator(); osc1.type = "sine"; osc1.frequency.setValueAtTime(45.0, ctx.currentTime);
        const osc2 = ctx.createOscillator(); osc2.type = "triangle"; osc2.frequency.setValueAtTime(45.4, ctx.currentTime);
        const filter = ctx.createBiquadFilter(); filter.type = "lowpass"; filter.frequency.setValueAtTime(120, ctx.currentTime);
        droneGain = ctx.createGain(); droneGain.gain.setValueAtTime(0.08, ctx.currentTime);
        osc1.connect(filter); osc2.connect(filter); filter.connect(droneGain); droneGain.connect(masterGain);
        osc1.start(); osc2.start();
        initialized = true;
      } catch (e) {}
    }
    function playChime(freq = 520, duration = 0.4) {
      if (!ctx || muted) return;
      try {
        const osc = ctx.createOscillator(); const g = ctx.createGain();
        osc.type = "sine"; osc.frequency.setValueAtTime(freq, ctx.currentTime);
        g.gain.setValueAtTime(0.18, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
        osc.connect(g); g.connect(masterGain);
        osc.start(); osc.stop(ctx.currentTime + duration);
      } catch (e) {}
    }
    function playImpact(strength = 1.0) {
      if (!ctx || muted) return;
      try {
        const osc = ctx.createOscillator(); const g = ctx.createGain();
        osc.type = "sawtooth"; osc.frequency.setValueAtTime(80, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(25, ctx.currentTime + 0.6);
        g.gain.setValueAtTime(Math.min(0.4, 0.15 * strength), ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
        osc.connect(g); g.connect(masterGain);
        osc.start(); osc.stop(ctx.currentTime + 0.6);
      } catch (e) {}
    }
    function playFlare() {
      if (!ctx || muted) return;
      try {
        const osc = ctx.createOscillator(); const g = ctx.createGain();
        osc.type = "triangle"; osc.frequency.setValueAtTime(140, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(260, ctx.currentTime + 0.5);
        osc.frequency.exponentialRampToValueAtTime(50, ctx.currentTime + 1.2);
        g.gain.setValueAtTime(0.2, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.2);
        osc.connect(g); g.connect(masterGain);
        osc.start(); osc.stop(ctx.currentTime + 1.2);
      } catch (e) {}
    }
    function playSupernova() {
      if (!ctx || muted) return;
      try {
        const osc = ctx.createOscillator(); const g = ctx.createGain();
        osc.type = "sawtooth"; osc.frequency.setValueAtTime(180, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(15, ctx.currentTime + 2.2);
        g.gain.setValueAtTime(0.5, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.2);
        osc.connect(g); g.connect(masterGain);
        osc.start(); osc.stop(ctx.currentTime + 2.2);
      } catch (e) {}
    }
    function toggleMute() {
      if (!initialized) init();
      muted = !muted;
      if (masterGain && ctx) masterGain.gain.setTargetAtTime(muted ? 0 : 0.3, ctx.currentTime, 0.05);
      return muted;
    }
    return { init, playChime, playImpact, playFlare, playSupernova, toggleMute };
  })();

  // 3. SIMULATION STATE
  let bodies = [];
  let selected = null;
  let following = false;
  let playing = true;
  let simYears = 0;
  let bodyIdCounter = 0;
  let placeSpec = null;
  let moveMode = false;
  let movingBody = null;
  let moonsEngaged = true;
  let activePreset = 'solar';
  let evolutionIndex = 0;
  let evolutionTimer = null;
  const followOffset = new T.Vector3();

  // 4. PROCEDURAL TEXTURES & MATERIALS
  function createHaloTexture(color) {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d'); const g = x.createRadialGradient(64, 64, 2, 64, 64, 64);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.18, color); g.addColorStop(0.45, color + '55'); g.addColorStop(1, color + '00');
    x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    return new T.CanvasTexture(c);
  }
  const starGlowMap = createHaloTexture('#ffd5a0');

  function generateProceduralTexture(spec) {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 512;
    const x = c.getContext('2d');
    const r = rng(spec.id * 1013 + (spec.name ? spec.name.charCodeAt(0) * 31 : 37));

    const name = (spec.name || '').toLowerCase();
    const isGas = spec.type === 'gas' || spec.type === 'gasGiant';

    if (spec.type === 'hotPlanet' || spec.isLavaWorld) {
      // Hot Volcanic Molten Lava World
      x.fillStyle = '#1c1917'; x.fillRect(0, 0, 1024, 512);
      x.lineWidth = 4;
      for (let i = 0; i < 70; i++) {
        x.strokeStyle = r() > 0.5 ? '#dc2626' : '#f97316';
        x.beginPath();
        let px = r() * 1024, py = r() * 512;
        x.moveTo(px, py);
        for (let seg = 0; seg < 6; seg++) {
          px += (r() - 0.5) * 80; py += (r() - 0.5) * 60;
          x.lineTo(px, py);
        }
        x.stroke();
      }
      for (let i = 0; i < 90; i++) {
        x.fillStyle = r() > 0.4 ? '#fef08a' : '#f97316';
        x.beginPath(); x.arc(r() * 1024, r() * 512, r() * 16 + 3, 0, Math.PI * 2); x.fill();
      }
    } else if (name === 'phobos') {
      // Mars Moon Phobos: Dark Carbonaceous Asteroid with Grooves & Giant Stickney Crater
      x.fillStyle = '#3a3532'; x.fillRect(0, 0, 1024, 512);
      // Surface grain & mottled asteroid regolith
      for (let i = 0; i < 40; i++) {
        x.fillStyle = r() > 0.5 ? '#292523' : '#4a4440';
        x.beginPath();
        x.ellipse(r() * 1024, r() * 512, 50 + r() * 80, 30 + r() * 50, r() * Math.PI, 0, Math.PI * 2);
        x.fill();
      }
      // Characteristic parallel linear fracture grooves / striations
      x.strokeStyle = 'rgba(25, 23, 22, 0.75)';
      x.lineWidth = 3;
      for (let i = 0; i < 16; i++) {
        const startY = 60 + i * 26 + (r() - 0.5) * 15;
        x.beginPath();
        x.moveTo(0, startY);
        x.bezierCurveTo(340, startY + 25, 680, startY - 20, 1024, startY + 15);
        x.stroke();
      }
      // Craters
      for (let i = 0; i < 110; i++) {
        const cx = r() * 1024, cy = r() * 512, rad = 3 + r() * 18;
        x.fillStyle = '#1e1b19'; x.beginPath(); x.arc(cx, cy, rad, 0, Math.PI * 2); x.fill();
        x.strokeStyle = '#57514c'; x.lineWidth = 1.2; x.beginPath(); x.arc(cx, cy, rad, 0, Math.PI * 2); x.stroke();
      }
      // Giant Stickney Impact Crater (takes up nearly half the hemisphere)
      const stX = 380, stY = 250, stR = 95;
      x.fillStyle = '#181614'; x.beginPath(); x.arc(stX, stY, stR, 0, Math.PI * 2); x.fill();
      x.strokeStyle = '#d6d3d1'; x.lineWidth = 4; x.beginPath(); x.arc(stX, stY, stR, 0, Math.PI * 2); x.stroke();
      // Bright Stickney ejecta rays
      x.strokeStyle = 'rgba(214, 211, 209, 0.4)';
      x.lineWidth = 2;
      for (let a = 0; a < Math.PI * 2; a += 0.3) {
        x.beginPath();
        x.moveTo(stX + Math.cos(a) * stR, stY + Math.sin(a) * stR);
        x.lineTo(stX + Math.cos(a) * (stR + 60 + r() * 80), stY + Math.sin(a) * (stR + 60 + r() * 80));
        x.stroke();
      }
    } else if (name === 'deimos') {
      // Mars Moon Deimos: Smoother, Dusty Reddish-Grey Regolith with Filled Talus Depressions
      x.fillStyle = '#524b46'; x.fillRect(0, 0, 1024, 512);
      // Soft dusty regolith blanket
      for (let i = 0; i < 35; i++) {
        x.fillStyle = r() > 0.5 ? '#615953' : '#453e39';
        x.beginPath();
        x.ellipse(r() * 1024, r() * 512, 80 + r() * 120, 50 + r() * 70, r() * Math.PI, 0, Math.PI * 2);
        x.fill();
      }
      // Soft bright dust deposits and smoothed talus slopes
      for (let i = 0; i < 20; i++) {
        x.fillStyle = 'rgba(168, 162, 158, 0.35)';
        x.beginPath();
        x.ellipse(r() * 1024, r() * 512, 40 + r() * 70, 20 + r() * 40, r() * Math.PI, 0, Math.PI * 2);
        x.fill();
      }
      // Subdued, filled impact craters
      for (let i = 0; i < 70; i++) {
        const cx = r() * 1024, cy = r() * 512, rad = 3 + r() * 14;
        x.fillStyle = '#3a3430'; x.beginPath(); x.arc(cx, cy, rad, 0, Math.PI * 2); x.fill();
        x.strokeStyle = '#78716c'; x.lineWidth = 1.0; x.beginPath(); x.arc(cx, cy, rad, 0, Math.PI * 2); x.stroke();
      }
    } else if (name === 'io') {
      // Jupiter Moon Io: Volcanic Sulfur Inferno (Yellow, Orange, Caldoras, NO craters)
      const grad = x.createLinearGradient(0, 0, 0, 512);
      grad.addColorStop(0, '#fef08a');
      grad.addColorStop(0.35, '#eab308');
      grad.addColorStop(0.7, '#ca8a04');
      grad.addColorStop(1, '#fef08a');
      x.fillStyle = grad; x.fillRect(0, 0, 1024, 512);
      // Sulfur & silicate lava flow fields
      for (let i = 0; i < 50; i++) {
        x.fillStyle = r() > 0.5 ? '#f97316' : '#84cc16';
        x.beginPath();
        x.ellipse(r() * 1024, r() * 512, 50 + r() * 100, 25 + r() * 50, r() * Math.PI, 0, Math.PI * 2);
        x.fill();
      }
      // Volcanic Calderas / Paterae (Loki Patera, Pele, Prometheus)
      for (let i = 0; i < 45; i++) {
        const cx = r() * 1024, cy = r() * 512, rad = 6 + r() * 22;
        // White sulfur dioxide frost halo
        x.strokeStyle = '#ffffff'; x.lineWidth = 3;
        x.beginPath(); x.arc(cx, cy, rad + 8, 0, Math.PI * 2); x.stroke();
        // Red sulfur ring
        x.fillStyle = '#dc2626'; x.beginPath(); x.arc(cx, cy, rad + 4, 0, Math.PI * 2); x.fill();
        // Pitch black volcanic magma caldera floor
        x.fillStyle = '#18181b'; x.beginPath(); x.arc(cx, cy, rad, 0, Math.PI * 2); x.fill();
      }
    } else if (name === 'europa') {
      // Jupiter Moon Europa: Smooth Ice Shell with Dense Reddish Linear Fractures (Lineae)
      x.fillStyle = '#f8fafc'; x.fillRect(0, 0, 1024, 512);
      // Subtle icy mottling
      for (let i = 0; i < 30; i++) {
        x.fillStyle = 'rgba(226, 232, 240, 0.7)';
        x.beginPath();
        x.ellipse(r() * 1024, r() * 512, 60 + r() * 120, 30 + r() * 70, r() * Math.PI, 0, Math.PI * 2);
        x.fill();
      }
      // Chaotic raft terrain
      for (let i = 0; i < 20; i++) {
        x.fillStyle = 'rgba(161, 98, 7, 0.28)';
        x.beginPath();
        x.ellipse(r() * 1024, r() * 512, 40 + r() * 80, 20 + r() * 45, r() * Math.PI, 0, Math.PI * 2);
        x.fill();
      }
      // Intersecting Reddish-Brown Linear Fractures (Lineae & Double Ridges)
      x.lineWidth = 2.5;
      for (let i = 0; i < 55; i++) {
        x.strokeStyle = r() > 0.4 ? '#991b1b' : '#7c2d12';
        x.beginPath();
        let px = r() * 1024, py = r() * 512;
        x.moveTo(px, py);
        for (let seg = 0; seg < 5; seg++) {
          px += (r() - 0.5) * 220; py += (r() - 0.5) * 160;
          x.lineTo(px, py);
        }
        x.stroke();
      }
    } else if (name === 'ganymede') {
      // Jupiter Moon Ganymede: Dual Terrain - Ancient Dark Polygon Plates & Bright Grooved Terrain
      x.fillStyle = '#334155'; x.fillRect(0, 0, 1024, 512);
      // Bright grooved terrain bands (sulci)
      x.fillStyle = '#94a3b8';
      for (let i = 0; i < 28; i++) {
        x.beginPath();
        x.ellipse(r() * 1024, r() * 512, 80 + r() * 160, 20 + r() * 40, r() * Math.PI, 0, Math.PI * 2);
        x.fill();
      }
      // Grooved striations inside bright terrain
      x.strokeStyle = 'rgba(241, 245, 249, 0.45)';
      x.lineWidth = 1.5;
      for (let i = 0; i < 40; i++) {
        const y = r() * 512;
        x.beginPath(); x.moveTo(0, y); x.lineTo(1024, y + (r() - 0.5) * 40); x.stroke();
      }
      // Craters with bright icy rays
      for (let i = 0; i < 90; i++) {
        const cx = r() * 1024, cy = r() * 512, rad = 3 + r() * 16;
        x.fillStyle = '#1e293b'; x.beginPath(); x.arc(cx, cy, rad, 0, Math.PI * 2); x.fill();
        x.strokeStyle = '#f8fafc'; x.lineWidth = 1.2; x.beginPath(); x.arc(cx, cy, rad, 0, Math.PI * 2); x.stroke();
      }
    } else if (name === 'callisto') {
      // Jupiter Moon Callisto: Dark Saturated Silicate Ice with Millions of Frosty Impact Scars
      x.fillStyle = '#1e293b'; x.fillRect(0, 0, 1024, 512);
      // Dark silicate patches
      for (let i = 0; i < 35; i++) {
        x.fillStyle = '#0f172a';
        x.beginPath();
        x.ellipse(r() * 1024, r() * 512, 60 + r() * 100, 30 + r() * 60, r() * Math.PI, 0, Math.PI * 2);
        x.fill();
      }
      // Giant Valhalla Multi-Ring Impact Basin (concentric frosty ripples)
      const vX = 600, vY = 240;
      for (let ring = 1; ring <= 8; ring++) {
        x.strokeStyle = `rgba(241, 245, 249, ${0.45 - ring * 0.04})`;
        x.lineWidth = 2.5;
        x.beginPath(); x.arc(vX, vY, ring * 22, 0, Math.PI * 2); x.stroke();
      }
      // Heavily saturated white icy impact craters
      for (let i = 0; i < 260; i++) {
        const cx = r() * 1024, cy = r() * 512, rad = 2 + r() * 14;
        x.fillStyle = '#f8fafc'; x.beginPath(); x.arc(cx, cy, rad, 0, Math.PI * 2); x.fill();
        x.strokeStyle = '#94a3b8'; x.lineWidth = 1; x.beginPath(); x.arc(cx, cy, rad, 0, Math.PI * 2); x.stroke();
      }
    } else if (name === 'titan') {
      // Saturn Moon Titan: Golden-Amber Photochemical Smog with Dark Equatorial Dune Fields
      const grad = x.createLinearGradient(0, 0, 0, 512);
      grad.addColorStop(0, '#d97706');
      grad.addColorStop(0.2, '#f59e0b');
      grad.addColorStop(0.5, '#fbbf24');
      grad.addColorStop(0.8, '#f59e0b');
      grad.addColorStop(1, '#b45309');
      x.fillStyle = grad; x.fillRect(0, 0, 1024, 512);
      // Dark equatorial hydrocarbon dunes (Shangri-La)
      x.fillStyle = 'rgba(69, 26, 3, 0.55)';
      for (let i = 0; i < 20; i++) {
        x.beginPath();
        x.ellipse(r() * 1024, 256 + (r() - 0.5) * 90, 80 + r() * 150, 15 + r() * 25, 0, 0, Math.PI * 2);
        x.fill();
      }
      // Polar methane lake clusters (Kraken Mare)
      x.fillStyle = '#0f172a';
      for (let i = 0; i < 8; i++) {
        x.beginPath();
        x.ellipse(300 + r() * 400, 35 + r() * 40, 25 + r() * 45, 12 + r() * 20, 0, 0, Math.PI * 2);
        x.fill();
      }
    } else if (name === 'titania') {
      // Uranus Moon Titania: Silvery Ice-Rock Crust Slashed by Giant Fault Canyons
      x.fillStyle = '#94a3b8'; x.fillRect(0, 0, 1024, 512);
      // Ancient darker terrain
      for (let i = 0; i < 30; i++) {
        x.fillStyle = '#64748b';
        x.beginPath();
        x.ellipse(r() * 1024, r() * 512, 60 + r() * 100, 30 + r() * 50, r() * Math.PI, 0, Math.PI * 2);
        x.fill();
      }
      // Giant fault canyon grabens (Messina Chasma)
      x.strokeStyle = '#334155'; x.lineWidth = 5;
      x.beginPath(); x.moveTo(120, 180); x.bezierCurveTo(400, 240, 700, 280, 950, 360); x.stroke();
      x.strokeStyle = '#f8fafc'; x.lineWidth = 1.5;
      x.beginPath(); x.moveTo(120, 178); x.bezierCurveTo(400, 238, 700, 278, 950, 358); x.stroke();
      // Bright impact craters
      for (let i = 0; i < 90; i++) {
        const cx = r() * 1024, cy = r() * 512, rad = 3 + r() * 15;
        x.fillStyle = '#f8fafc'; x.beginPath(); x.arc(cx, cy, rad, 0, Math.PI * 2); x.fill();
      }
    } else if (name === 'triton') {
      // Neptune Moon Triton: Pinkish Nitrogen Frost, Cantaloupe Dimpled Terrain & Geyser Plumes
      x.fillStyle = '#99f6e4'; x.fillRect(0, 0, 1024, 512);
      // Southern pink nitrogen ice cap
      const pinkGrad = x.createLinearGradient(0, 300, 0, 512);
      pinkGrad.addColorStop(0, 'rgba(244, 114, 182, 0.0)');
      pinkGrad.addColorStop(0.3, 'rgba(244, 114, 182, 0.7)');
      pinkGrad.addColorStop(1, '#f472b6');
      x.fillStyle = pinkGrad; x.fillRect(0, 300, 1024, 212);
      // Dimpled cantaloupe terrain (crisscrossing circular depressions)
      x.strokeStyle = 'rgba(15, 118, 110, 0.45)'; x.lineWidth = 2;
      for (let i = 0; i < 90; i++) {
        x.beginPath();
        x.arc(r() * 1024, 50 + r() * 260, 12 + r() * 18, 0, Math.PI * 2);
        x.stroke();
      }
      // Cryovolcanic geyser vent streaks (dark nitrogen plumes blown by thin winds)
      x.fillStyle = '#0f172a';
      for (let i = 0; i < 15; i++) {
        const gx = 200 + r() * 600, gy = 350 + r() * 120;
        x.beginPath(); x.arc(gx, gy, 3, 0, Math.PI * 2); x.fill();
        x.strokeStyle = 'rgba(15, 23, 42, 0.6)'; x.lineWidth = 2;
        x.beginPath(); x.moveTo(gx, gy); x.lineTo(gx + 30 + r() * 35, gy - 15 - r() * 20); x.stroke();
      }
    } else if (name === 'moon') {
      // Earth's Moon: Silvery-Grey Highlands & Dark Basaltic Maria Seas with Tycho Crater Rays
      x.fillStyle = '#9ca3af'; x.fillRect(0, 0, 1024, 512);
      // Major lunar maria (Sea of Tranquility, Ocean of Storms)
      const mariaColors = ['#475569', '#334155', '#1e293b'];
      for (let i = 0; i < 30; i++) {
        x.fillStyle = mariaColors[Math.floor(r() * mariaColors.length)];
        x.beginPath();
        x.ellipse(r() * 1024, r() * 512, 60 + r() * 140, 40 + r() * 95, r() * Math.PI, 0, Math.PI * 2);
        x.fill();
      }
      // Impact craters
      for (let i = 0; i < 160; i++) {
        const cx = r() * 1024, cy = r() * 512, rad = 3 + r() * 20;
        x.fillStyle = '#1e293b'; x.beginPath(); x.arc(cx, cy, rad, 0, Math.PI * 2); x.fill();
        x.strokeStyle = '#d1d5db'; x.lineWidth = 1.3; x.beginPath(); x.arc(cx, cy, rad, 0, Math.PI * 2); x.stroke();
      }
      // Tycho Rayed Crater
      const tX = 520, tY = 380, tR = 14;
      x.fillStyle = '#f8fafc'; x.beginPath(); x.arc(tX, tY, tR, 0, Math.PI * 2); x.fill();
      x.strokeStyle = 'rgba(248, 250, 252, 0.55)'; x.lineWidth = 1.5;
      for (let a = 0; a < Math.PI * 2; a += 0.25) {
        x.beginPath();
        x.moveTo(tX, tY);
        x.lineTo(tX + Math.cos(a) * (140 + r() * 160), tY + Math.sin(a) * (140 + r() * 160));
        x.stroke();
      }
    } else if (name === 'mercury' || (spec.type === 'rock' && (spec.water || 0) === 0 && (spec.atmo || 0) === 0 && spec.color === '#9e9389')) {
      // Mercury: Cratered Highlands, Caloris Basin & Silvery Impact Basins
      x.fillStyle = '#6b7280'; x.fillRect(0, 0, 1024, 512);
      for (let i = 0; i < 28; i++) {
        x.fillStyle = '#4b5563';
        x.beginPath();
        x.ellipse(r() * 1024, r() * 512, 45 + r() * 110, 30 + r() * 75, r() * Math.PI, 0, Math.PI * 2);
        x.fill();
      }
      // Caloris Basin
      const cbX = 350, cbY = 250;
      for (let ring = 1; ring <= 5; ring++) {
        x.strokeStyle = `rgba(156, 163, 175, ${0.5 - ring * 0.08})`;
        x.lineWidth = 2.5;
        x.beginPath(); x.arc(cbX, cbY, ring * 24, 0, Math.PI * 2); x.stroke();
      }
      for (let i = 0; i < 180; i++) {
        const cx = r() * 1024, cy = r() * 512, rad = 3 + r() * 22;
        x.fillStyle = '#374151'; x.beginPath(); x.arc(cx, cy, rad, 0, Math.PI * 2); x.fill();
        x.strokeStyle = '#d1d5db'; x.lineWidth = 1.2; x.beginPath(); x.arc(cx, cy, rad, 0, Math.PI * 2); x.stroke();
      }
    } else if (name === 'venus') {
      // Venus: Dense Swirling Creamy-Gold Sulfuric Cloud Deck (Photorealistic Venusian Atmosphere)
      const grad = x.createLinearGradient(0, 0, 0, 512);
      grad.addColorStop(0, '#fef9c3'); // Polar pale cream
      grad.addColorStop(0.2, '#fef08a');
      grad.addColorStop(0.5, '#fde047'); // Equatorial soft golden cloud deck
      grad.addColorStop(0.8, '#fef08a');
      grad.addColorStop(1, '#fef9c3');
      x.fillStyle = grad; x.fillRect(0, 0, 1024, 512);

      // Subtle zonal cloud bands
      for (let y = 0; y < 512; y += 4) {
        const bandAlpha = 0.08 + Math.sin(y * 0.04) * 0.06;
        x.fillStyle = `rgba(217, 119, 6, ${bandAlpha})`;
        x.fillRect(0, y, 1024, 3);
      }

      // Swirling planetary chevron cloud features
      for (let i = 0; i < 75; i++) {
        const py = 60 + r() * 392;
        const px = r() * 1024;
        const rw = 120 + r() * 220;
        const rh = 20 + r() * 45;
        x.fillStyle = r() > 0.4 ? 'rgba(254, 240, 138, 0.45)' : 'rgba(245, 158, 11, 0.22)';
        x.beginPath();
        x.ellipse(px, py, rw, rh, 0.05, 0, Math.PI * 2);
        x.fill();
      }

      // Fine turbulent cloud streamers & swirls
      x.lineWidth = 2.5;
      for (let i = 0; i < 45; i++) {
        x.strokeStyle = r() > 0.5 ? 'rgba(255, 255, 255, 0.45)' : 'rgba(202, 138, 4, 0.2)';
        x.beginPath();
        let cx = r() * 1024, cy = 40 + r() * 432;
        x.moveTo(cx, cy);
        for (let seg = 0; seg < 4; seg++) {
          cx += (r() - 0.5) * 140; cy += (r() - 0.5) * 35;
          x.lineTo(cx, cy);
        }
        x.stroke();
      }
    } else if (name === 'mars') {
      // Mars: Vibrant Rust-Red Crust, Dark Syrtis Major Volcanoes, Valles Marineris Canyon, & Polar Ice Caps
      x.fillStyle = '#c2410c'; x.fillRect(0, 0, 1024, 512);
      // Dunes & color variation
      for (let i = 0; i < 35; i++) {
        x.fillStyle = '#ea580c';
        x.beginPath();
        x.ellipse(r() * 1024, r() * 512, 100 + r() * 160, 40 + r() * 80, 0, 0, Math.PI * 2);
        x.fill();
      }
      // Dark Volcanic Basalt Highlands (Syrtis Major, Acidalia Planitia, Tharsis)
      const darkPlains = ['#7c2d12', '#451a03', '#3b1207'];
      for (let i = 0; i < 35; i++) {
        x.fillStyle = darkPlains[Math.floor(r() * darkPlains.length)];
        x.beginPath();
        x.ellipse(r() * 1024, 100 + r() * 312, 70 + r() * 140, 35 + r() * 70, r() * Math.PI, 0, Math.PI * 2);
        x.fill();
      }
      // Giant Valles Marineris Canyon Rift (slashing 400px across the equator)
      x.strokeStyle = '#260701'; x.lineWidth = 7;
      x.beginPath();
      x.moveTo(320, 260);
      x.bezierCurveTo(450, 275, 580, 255, 720, 270);
      x.stroke();
      x.lineWidth = 3;
      x.beginPath();
      x.moveTo(420, 270); x.lineTo(460, 305);
      x.moveTo(540, 260); x.lineTo(590, 235);
      x.stroke();
      // Olympus Mons Caldera
      x.fillStyle = '#451a03'; x.beginPath(); x.arc(260, 210, 38, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#260701'; x.beginPath(); x.arc(260, 210, 14, 0, Math.PI * 2); x.fill();
      // Gleaming North & South Polar Ice Caps
      x.fillStyle = '#ffffff';
      x.beginPath(); x.ellipse(512, 22, 180, 26, 0, 0, Math.PI * 2); x.fill();
      x.beginPath(); x.ellipse(512, 490, 160, 24, 0, 0, Math.PI * 2); x.fill();
      // Polar frost fringe
      x.fillStyle = 'rgba(224, 242, 254, 0.55)';
      x.beginPath(); x.ellipse(512, 32, 220, 32, 0, 0, Math.PI * 2); x.fill();
      x.beginPath(); x.ellipse(512, 480, 200, 30, 0, 0, Math.PI * 2); x.fill();
    } else if (isGas || name === 'jupiter' || name === 'saturn' || name === 'uranus' || name === 'neptune') {
      // Banded Gas Giants
      let palette;
      if (name === 'jupiter') {
        palette = ['#e2cbb0', '#c89d6d', '#d7ad7d', '#9c7b58', '#f1d6b8', '#855b38', '#dfcfbf'];
      } else if (name === 'saturn') {
        palette = ['#e5d5b5', '#d4be8d', '#c2ab79', '#eedebd', '#bfa776'];
      } else if (name === 'uranus') {
        palette = ['#a5f3fc', '#67e8f9', '#38bdf8', '#7dd3fc'];
      } else if (name === 'neptune') {
        palette = ['#1e40af', '#2563eb', '#1d4ed8', '#3b82f6', '#172554'];
      } else {
        palette = spec.bandColors || ['#d7ad7d', '#c89d6d', '#e2cbb0', '#9c7b58'];
      }

      const count = spec.bandCount || (name === 'jupiter' ? 14 : 10);
      for (let y = 0; y < 512; y++) {
        const idx = Math.floor((y / 512) * count) % palette.length;
        x.fillStyle = palette[idx];
        x.fillRect(0, y, 1024, 1);
      }
      for (let i = 0; i < 40; i++) {
        x.fillStyle = palette[Math.floor(r() * palette.length)];
        x.beginPath();
        x.ellipse(r() * 1024, r() * 512, 50 + r() * 120, 6 + r() * 14, 0, 0, Math.PI * 2);
        x.fill();
      }
      if (name === 'jupiter' || spec.showGreatStorm) {
        x.fillStyle = '#b91c1c';
        x.beginPath(); x.ellipse(620, 310, 65, 36, 0.05, 0, Math.PI * 2); x.fill();
        x.fillStyle = '#ea580c';
        x.beginPath(); x.ellipse(620, 310, 48, 24, 0.05, 0, Math.PI * 2); x.fill();
        x.fillStyle = '#fef08a';
        x.beginPath(); x.ellipse(620, 310, 20, 10, 0.05, 0, Math.PI * 2); x.fill();
      }
      if (name === 'neptune') {
        x.fillStyle = '#0f172a';
        x.beginPath(); x.ellipse(450, 280, 50, 25, 0.1, 0, Math.PI * 2); x.fill();
        x.fillStyle = 'rgba(255, 255, 255, 0.65)';
        x.fillRect(380, 255, 120, 3);
      }
    } else {
      // Terrestrial Rocky World (Earth & custom worlds)
      const water = spec.waterCoverage ?? spec.water ?? 70;
      const oceanCol = spec.oceanColor || (water > 0 ? '#1d4ed8' : (spec.color || '#6b7280'));
      const landCol = spec.landColor || '#15803d';

      x.fillStyle = oceanCol;
      x.fillRect(0, 0, 1024, 512);

      const landShare = 1 - water / 100;
      if (landShare > 0.02) {
        x.fillStyle = landCol;
        const numBlobs = Math.floor(220 * landShare);
        for (let i = 0; i < numBlobs; i++) {
          const px = r() * 1024, py = 50 + r() * 412;
          const rw = 20 + r() * 100 * landShare;
          const rh = 15 + r() * 65 * landShare;
          x.beginPath();
          x.ellipse(px, py, rw, rh, r() * Math.PI, 0, Math.PI * 2);
          x.fill();
        }
        // Deserts & Mountain Ridges
        x.fillStyle = '#d97706';
        for (let i = 0; i < numBlobs * 0.3; i++) {
          const px = r() * 1024, py = 160 + r() * 190;
          x.beginPath();
          x.ellipse(px, py, 15 + r() * 45, 10 + r() * 25, 0, 0, Math.PI * 2);
          x.fill();
        }
        x.fillStyle = '#78350f';
        for (let i = 0; i < numBlobs * 0.35; i++) {
          const px = r() * 1024, py = 70 + r() * 372;
          x.beginPath();
          x.ellipse(px, py, 10 + r() * 35, 6 + r() * 20, r() * Math.PI, 0, Math.PI * 2);
          x.fill();
        }
      }

      // Swirling atmospheric weather clouds
      if ((spec.atmo || 0) > 0.05) {
        x.fillStyle = 'rgba(255, 255, 255, 0.55)';
        for (let i = 0; i < 50; i++) {
          const cy = 40 + r() * 432;
          x.beginPath();
          x.ellipse(r() * 1024, cy, 70 + r() * 190, 8 + r() * 24, 0.06, 0, Math.PI * 2);
          x.fill();
        }
      }

      // Polar Ice Caps
      const ice = spec.iceCapCoverage ?? spec.ice ?? 12;
      if (ice > 0) {
        x.fillStyle = '#ffffff';
        const h = Math.max(12, ice * 1.4);
        x.fillRect(0, 0, 1024, h);
        x.fillRect(0, 512 - h, 1024, h);
        x.fillStyle = 'rgba(224, 242, 254, 0.6)';
        x.fillRect(0, h, 1024, 10);
        x.fillRect(0, 512 - h - 10, 1024, 10);
      }
    }

    const t = new T.CanvasTexture(c);
    t.colorSpace = T.SRGBColorSpace;
    return t;
  }

  // 5. BODY CREATION & MANAGEMENT
  function createBody(spec) {
    const b = {
      id: ++bodyIdCounter,
      name: spec.name || 'World ' + bodyIdCounter,
      type: spec.type || 'rock',
      scienceType: spec.scienceType || spec.type || 'planet',
      mass: spec.mass || (1 / EARTHS_PER_SUN),
      radius: spec.radius || 0.36,
      color: spec.color || '#4f9cff',
      p: spec.p ? [...spec.p] : [0, 0, 0],
      v: spec.v ? [...spec.v] : [0, 0, 0],
      tilt: spec.tilt ?? 23,
      dayLength: spec.dayLength ?? 24,
      atmo: spec.atmo ?? (spec.type === 'gas' ? 2.5 : 1.0),
      atmoPressure: spec.atmoPressure ?? spec.atmo ?? 1.0,
      atmoColor: spec.atmoColor || '#76bfff',
      gasType: spec.gasType || 'earthAir',
      gasMix: spec.gasMix || { n2: 78, o2: 21, co2: 1, ch4: 0 },
      magnetic: spec.magnetic ?? 1.0,
      magneticScale: spec.magneticScale ?? spec.magnetic ?? 1.0,
      gravity: spec.gravity ?? 1.0,
      gravityScale: spec.gravityScale ?? spec.gravity ?? 1.0,
      water: spec.water ?? 70,
      waterCoverage: spec.waterCoverage ?? spec.water ?? 70,
      ice: spec.ice ?? 12,
      iceCapCoverage: spec.iceCapCoverage ?? spec.ice ?? 12,
      oceanColor: spec.oceanColor || '#1d4ed8',
      landColor: spec.landColor || '#15803d',
      temp: spec.temp ?? (spec.type === 'star' ? 5778 : 288),
      ring: Boolean(spec.ring),
      ringScale: spec.ringScale ?? 2.2,
      ringColor: spec.ringColor || '#d7bd7d',
      parentId: spec.parentId ?? null,
      isMoon: Boolean(spec.isMoon || spec.type === 'moon'),
      isBlackHole: Boolean(spec.type === 'blackhole' || spec.isBlackHole),
      bandCount: spec.bandCount ?? 8,
      bandColors: spec.bandColors ?? null,
      trail: [],
      hotspots: [],
      ...spec
    };

    // Material & NASA Texture Integration
    const isStar = b.type === 'star';
    const isHole = b.isBlackHole;

    if (isStar) {
      b.textureMap = generateSeamlessSunTexture();
    } else if (isHole) {
      b.textureMap = null;
    } else {
      b.textureMap = generateProceduralTexture(b);
    }

    if (isStar) {
      b.material = new T.MeshStandardMaterial({
        map: b.textureMap,
        emissiveMap: b.textureMap,
        emissive: new T.Color(b.color || '#fff0cb'),
        emissiveIntensity: 1.6,
        roughness: 0.35,
        metalness: 0.05
      });
      b.mesh = new T.Mesh(sphereGeo, b.material);
      b.mesh.userData.body = b;
      b.mesh.scale.setScalar(b.radius);
      b.mesh.rotation.z = T.MathUtils.degToRad(b.tilt);
      scene.add(b.mesh);
    } else if (isHole) {
      b.material = new T.MeshBasicMaterial({ color: 0x000000 });
      b.mesh = new T.Mesh(sphereGeo, b.material);
      b.mesh.userData.body = b;
      b.mesh.scale.setScalar(b.radius);
      scene.add(b.mesh);
    } else {
      // Photorealistic 3D solid textured planet globe with lighting, day/night shading, and axial tilt
      const isVenus = (b.name || '').toLowerCase() === 'venus';
      b.material = new T.MeshStandardMaterial({
        map: b.textureMap,
        roughness: b.type === 'gas' ? 0.82 : (isVenus ? 0.58 : 0.65),
        metalness: 0.02,
        emissiveMap: b.textureMap,
        emissive: new T.Color(0xffffff),
        emissiveIntensity: isVenus ? 0.42 : 0.28, // Guarantees solid, fully filled 3D globe with visible clouds & continents from every angle
        color: 0xffffff
      });
      b.mesh = new T.Mesh(sphereGeo, b.material);
      b.mesh.userData.body = b;
      b.mesh.scale.setScalar(b.radius);
      b.mesh.rotation.z = T.MathUtils.degToRad(b.tilt);
      scene.add(b.mesh);
    }

    b.atmosphere = null;
    b.field = null;

    // Stellar Glow or Black Hole Rings (scaled down so Mercury at 0.39 AU is distinctly visible)
    if (isStar) {
      b.glow = new T.Sprite(new T.SpriteMaterial({ map: starGlowMap, color: b.color, blending: T.AdditiveBlending, transparent: true, depthWrite: false }));
      b.glow.scale.setScalar(b.radius * 2.8);
      scene.add(b.glow);
    }

    if (b.ring || isHole) {
      createRingsMesh(b);
    }

    // Orbit Guide LineLoop (Keplerian analytical orbit)
    b.orbitLine = new T.LineLoop(
      new T.BufferGeometry(),
      new T.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.45, blending: T.AdditiveBlending, depthWrite: false })
    );
    b.orbitLine.visible = !isStar && !isHole;
    orbitGuidesGroup.add(b.orbitLine);

    // Motion Ribbon Trail (Dynamic historical path through space)
    b.trailHistory = [];
    b.trailLine = new T.Line(
      new T.BufferGeometry(),
      new T.LineBasicMaterial({
        color: new T.Color(b.color || '#38bdf8'),
        transparent: true,
        opacity: 0.4,
        blending: T.AdditiveBlending,
        depthWrite: false
      })
    );
    b.trailLine.visible = Boolean($('showTrails')?.checked);
    scene.add(b.trailLine);

    bodies.push(b);
    updateTargetSelectors();
    return b;
  }

  function createRingsMesh(b) {
    if (b.ringMesh) {
      scene.remove(b.ringMesh);
      b.ringMesh.geometry.dispose();
      b.ringMesh.material.dispose();
      b.ringMesh = null;
    }
    const inner = b.isBlackHole ? 1.4 : 1.35;
    const outer = b.isBlackHole ? 2.6 : (b.ringScale || 2.2);
    const ringGeo = new T.RingGeometry(inner, outer, 128, 4);
    b.ringMesh = new T.Mesh(ringGeo, new T.MeshBasicMaterial({
      color: b.isBlackHole ? 0xff9933 : new T.Color(b.ringColor || '#d7bd7d'),
      side: T.DoubleSide,
      transparent: true,
      opacity: b.isBlackHole ? 0.85 : 0.65,
      blending: b.isBlackHole ? T.AdditiveBlending : T.NormalBlending
    }));
    b.ringMesh.rotation.x = Math.PI / 2.3;
    b.ringMesh.scale.setScalar(b.radius);
    scene.add(b.ringMesh);
  }

  function destroyBody(b) {
    if (!b) return;
    for (const key of ['mesh', 'atmosphere', 'glow', 'ringMesh', 'field', 'trailLine']) {
      if (b[key]) scene.remove(b[key]);
    }
    if (b.trailLine) {
      b.trailLine.geometry.dispose();
      b.trailLine.material.dispose();
      b.trailLine = null;
    }
    if (b.orbitLine) {
      orbitGuidesGroup.remove(b.orbitLine);
      b.orbitLine.geometry.dispose();
      b.orbitLine.material.dispose();
    }
    if (b.textureMap) b.textureMap.dispose();
    if (b.material) b.material.dispose();
    if (b.atmosphere?.material) b.atmosphere.material.dispose();
    if (b.ringMesh) { b.ringMesh.geometry.dispose(); b.ringMesh.material.dispose(); }
    if (b.field) { b.field.children.forEach(c => { c.geometry.dispose(); c.material.dispose(); }); }

    const labelEl = bodyLabelMap.get(b.id);
    if (labelEl) {
      labelEl.remove();
      bodyLabelMap.delete(b.id);
    }

    bodies = bodies.filter(x => x !== b);
    bodies.forEach(x => { if (x.parentId === b.id) x.parentId = null; });

    if (selected === b) selectBody(null);
    updateTargetSelectors();
  }

  function clearAllBodies() {
    for (const b of [...bodies]) destroyBody(b);
    bodyLabelMap.forEach(el => el.remove());
    bodyLabelMap.clear();
    bodies = [];
    selected = null;
    following = false;
    simYears = 0;
    selectBody(null);
    showToast("Universe cleared • Add objects or select a preset");
  }

  // 6. ASTROBIOLOGY & LIFE LIKELIHOOD GUESSER
  function getHabitableZone(star, spec = null) {
    if (!star) return null;
    const lum = star.isBlackHole ? 0.002 : clamp(Math.pow(star.mass, 3.5), 0.005, 50000);
    const sqrtL = Math.sqrt(lum);
    const gasType = spec?.gasType || "earthAir";
    let ghFactor = 1.0;
    if (gasType === "carbonDioxide") ghFactor = 2.4;
    else if (gasType === "methane") ghFactor = 1.8;
    else if (gasType === "ammonia") ghFactor = 1.9;
    else if (gasType === "none") ghFactor = 0.65;
    return {
      innerAU: 0.95 * sqrtL * ghFactor,
      outerAU: 1.45 * sqrtL * ghFactor,
      lum
    };
  }

  function updateHabitableZones3D() {
    const showZones = $('showZones')?.checked || !$('creator')?.hidden;
    if (!showZones || bodies.length === 0) {
      climateZonesGroup.visible = false;
      return;
    }

    // Determine host star
    let host = null;
    const targetSelect = $('customTarget');
    if (targetSelect && targetSelect.value && targetSelect.value !== 'auto') {
      host = bodies.find(b => String(b.id) === String(targetSelect.value));
    }
    if (!host && selected && (selected.type === 'star' || selected.isBlackHole)) {
      host = selected;
    }
    if (!host) {
      host = bodies.find(b => b.type === 'star') || bodies.find(b => b.isBlackHole) || bodies[0];
    }
    if (!host) {
      climateZonesGroup.visible = false;
      return;
    }

    climateZonesGroup.visible = true;
    climateZonesGroup.position.set(host.p[0] * AU, host.p[1] * AU, host.p[2] * AU);

    // Rebuild geometry if host changed or needs fresh rendering
    if (climateZonesGroup.userData.hostId !== host.id) {
      while (climateZonesGroup.children.length > 0) {
        const c = climateZonesGroup.children.pop();
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
      }

      const hz = getHabitableZone(host);
      const rocheDistAU = rocheLimit(host, 1 / EARTHS_PER_SUN, 0.000042);
      const rRoche = Math.max(host.radius * 1.5, rocheDistAU * AU);
      const rInner = Math.max(rRoche * 1.08, (hz ? hz.innerAU : 0.95) * AU);
      const rOuter = Math.max(rInner * 1.15, (hz ? hz.outerAU : 1.45) * AU);
      const rCold = rOuter * 2.1;

      // 1. Tidal Shredding Void (Pitch Black)
      const tidalMesh = new T.Mesh(
        new T.RingGeometry(0.1, rRoche, 64),
        new T.MeshBasicMaterial({ color: 0x000000, side: T.DoubleSide, transparent: false, depthWrite: false })
      );
      tidalMesh.rotation.x = Math.PI / 2;
      climateZonesGroup.add(tidalMesh);

      // Roche Warning Ring Border
      const rocheLine = new T.LineLoop(
        new T.BufferGeometry().setFromPoints(Array.from({ length: 64 }, (_, i) => {
          const a = (i / 64) * Math.PI * 2;
          return new T.Vector3(Math.cos(a) * rRoche, 0, Math.sin(a) * rRoche);
        })),
        new T.LineBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.85 })
      );
      climateZonesGroup.add(rocheLine);

      // 2. Scorch Zone (Fiery Red)
      const scorchMesh = new T.Mesh(
        new T.RingGeometry(rRoche, rInner, 64),
        new T.MeshBasicMaterial({ color: 0xef4444, side: T.DoubleSide, transparent: true, opacity: 0.28, blending: T.AdditiveBlending, depthWrite: false })
      );
      scorchMesh.rotation.x = Math.PI / 2;
      climateZonesGroup.add(scorchMesh);

      // 3. FULLY FILLED GREEN HABITABLE ZONE RING
      const hzMesh = new T.Mesh(
        new T.RingGeometry(rInner, rOuter, 64),
        new T.MeshBasicMaterial({ color: 0x10b981, side: T.DoubleSide, transparent: true, opacity: 0.38, blending: T.AdditiveBlending, depthWrite: false })
      );
      hzMesh.rotation.x = Math.PI / 2;
      climateZonesGroup.add(hzMesh);

      // Habitable Zone Inner & Outer Guide Rings
      const innerLine = new T.LineLoop(
        new T.BufferGeometry().setFromPoints(Array.from({ length: 64 }, (_, i) => {
          const a = (i / 64) * Math.PI * 2;
          return new T.Vector3(Math.cos(a) * rInner, 0, Math.sin(a) * rInner);
        })),
        new T.LineBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.9 })
      );
      climateZonesGroup.add(innerLine);

      const outerLine = new T.LineLoop(
        new T.BufferGeometry().setFromPoints(Array.from({ length: 64 }, (_, i) => {
          const a = (i / 64) * Math.PI * 2;
          return new T.Vector3(Math.cos(a) * rOuter, 0, Math.sin(a) * rOuter);
        })),
        new T.LineBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.9 })
      );
      climateZonesGroup.add(outerLine);

      // 4. Cold Zone Ring (Sapphire Blue Fading Outward)
      const coldMesh = new T.Mesh(
        new T.RingGeometry(rOuter, rCold, 64),
        new T.MeshBasicMaterial({ color: 0x3b82f6, side: T.DoubleSide, transparent: true, opacity: 0.18, blending: T.AdditiveBlending, depthWrite: false })
      );
      coldMesh.rotation.x = Math.PI / 2;
      climateZonesGroup.add(coldMesh);

      climateZonesGroup.userData.hostId = host.id;
    }
  }

  function computeLifeLikelihood(primary, worldX, worldY, worldZ, spec) {
    if (!primary) {
      return { score: 0, zone: "Deep Space", tempC: -270, verdict: "Freezing vacuum of interstellar space. No stellar energy for metabolism." };
    }

    const distAU = Math.max(0.001, Math.hypot(worldX - primary.p[0], worldY - primary.p[1], worldZ - primary.p[2]));
    const lum = primary.isBlackHole ? 0.002 : clamp(Math.pow(primary.mass, 3.5), 0.005, 50000);
    const sqrtL = Math.sqrt(lum);

    // Dynamic Greenhouse
    const gasType = spec?.gasType || "earthAir";
    const pressure = spec?.atmoPressure ?? 1.0;
    let ghFactor = 1.0;
    let ghAdd = 0;

    if (gasType === "carbonDioxide") { ghFactor = 2.4; ghAdd = Math.min(480, 75 + pressure * 14); }
    else if (gasType === "methane") { ghFactor = 1.8; ghAdd = Math.min(130, 25 + pressure * 9); }
    else if (gasType === "ammonia") { ghFactor = 1.9; ghAdd = Math.min(140, 30 + pressure * 9); }
    else if (gasType === "earthAir") { ghFactor = 1.0; ghAdd = 33 * Math.min(3, Math.pow(Math.max(0.05, pressure), 0.35)); }
    else if (gasType === "none") { ghFactor = 0.65; ghAdd = 0; }

    const innerAU = 0.95 * sqrtL * ghFactor;
    const outerAU = 1.45 * sqrtL * ghFactor;
    const rLimit = rocheLimit(primary, (spec?.mass || 1) / EARTHS_PER_SUN, (spec?.radius || 0.36) / 10);

    const baseTempK = 278 * Math.pow(lum, 0.25) / Math.sqrt(Math.max(distAU, 0.005));
    const tempK = Math.round(baseTempK + ghAdd);
    const tempC = tempK - 273;

    let zone = "Habitable Zone", score = 0, verdict = "";

    if (distAU <= rLimit) {
      zone = "Tidal Shredding Zone";
      score = 0;
      verdict = "💥 Crushed by tidal shear forces inside the Roche limit. Body will be torn into planetary rings.";
    } else if (distAU < innerAU) {
      zone = "Scorch Zone";
      if (tempK > 450) {
        score = 0;
        verdict = `☀️ Scorching molten inferno (${tempC}°C). Surface rock is melted into incandescent lava; oceans boiled away.`;
      } else {
        score = Math.max(5, Math.round(25 * (1 - (tempC - 45) / 120)));
        verdict = `☀️ Runaway greenhouse superheating (${tempC}°C). Unstable for persistent liquid water.`;
      }
    } else if (distAU > outerAU) {
      zone = "Cold Zone";
      if (tempK < 200) {
        score = 0;
        verdict = `❄️ Cryogenic deep freeze (${tempC}°C). Volatiles freeze into solid glaciers; biochemical reactions halted.`;
      } else {
        score = Math.max(5, Math.round(28 * (1 - (273 - tempK) / 90)));
        verdict = `❄️ Frigid sub-zero climate (${tempC}°C). Potential for sub-surface liquid oceans under thick ice shells.`;
      }
    } else {
      zone = "Habitable Zone";
      const water = spec?.waterCoverage ?? spec?.water ?? 70;
      let bioScore = 75;
      if (tempC >= 5 && tempC <= 35) bioScore += 18;
      if (water >= 25 && water <= 85) bioScore += 7;
      score = clamp(bioScore, 65, 100);
      verdict = `🌿 Prime Habitable Zone (${tempC}°C). Stellar irradiance permits stable liquid water oceans and thriving biospheres!`;
    }

    return { score, zone, tempC, tempK, verdict };
  }

  // 7. REALISTIC 3D KEPLERIAN ORBIT CALCULATION
  function computeKeplerPoints(body, parent, segments = 128) {
    if (!parent) return null;
    const mu = G * (parent.mass + body.mass);
    const rx = body.p[0] - parent.p[0];
    const ry = body.p[1] - parent.p[1];
    const rz = body.p[2] - parent.p[2];
    const vx = body.v[0] - parent.v[0];
    const vy = body.v[1] - parent.v[1];
    const vz = body.v[2] - parent.v[2];

    const r = Math.hypot(rx, ry, rz);
    const v2 = vx * vx + vy * vy + vz * vz;
    if (r <= 1e-6) return null;

    // Specific angular momentum h = r x v
    const hx = ry * vz - rz * vy;
    const hy = rz * vx - rx * vz;
    const hz = rx * vy - ry * vx;
    const h = Math.hypot(hx, hy, hz);
    if (h < 1e-7) return null;

    // Semi-major axis
    const invA = 2 / r - v2 / mu;
    let rawA;
    if (invA <= 1e-6) {
      rawA = Math.min(300, Math.max(0.1, r * 1.5));
    } else {
      rawA = Math.min(600, Math.max(0.01, 1 / invA));
    }

    // Eccentricity vector e = (v x h)/mu - r/|r|
    const vxh_x = (vy * hz - vz * hy) / mu;
    const vxh_y = (vz * hx - vx * hz) / mu;
    const vxh_z = (vx * hy - vy * hx) / mu;
    const ex = vxh_x - rx / r;
    const ey = vxh_y - ry / r;
    const ez = vxh_z - rz / r;
    let rawE = Math.min(0.96, Math.hypot(ex, ey, ez) || 0);
    if (body.name === 'Mercury' || rawE < 0.035) {
      rawE = Math.min(0.015, rawE);
    }

    // Orbital normal vector
    const wx = hx / h, wy = hy / h, wz = hz / h;

    // In-plane basis vectors
    let px, py, pz, qx, qy, qz;
    if (rawE > 1e-3) {
      px = ex / (Math.hypot(ex, ey, ez) || 1);
      py = ey / (Math.hypot(ex, ey, ez) || 1);
      pz = ez / (Math.hypot(ex, ey, ez) || 1);
      qx = wy * pz - wz * py;
      qy = wz * px - wx * pz;
      qz = wx * py - wy * px;
    } else {
      px = rx / r; py = ry / r; pz = rz / r;
      qx = wy * pz - wz * py;
      qy = wz * px - wx * pz;
      qz = wx * py - wy * px;
    }

    // Temporal smoothing to eliminate micro-jitter from N-body perturbations
    if (!body.displayOrbit) {
      body.displayOrbit = { a: rawA, e: rawE, px, py, pz, qx, qy, qz };
    } else {
      const rate = 0.12;
      body.displayOrbit.a += (rawA - body.displayOrbit.a) * rate;
      body.displayOrbit.e += (rawE - body.displayOrbit.e) * rate;
      body.displayOrbit.px += (px - body.displayOrbit.px) * rate;
      body.displayOrbit.py += (py - body.displayOrbit.py) * rate;
      body.displayOrbit.pz += (pz - body.displayOrbit.pz) * rate;
      const pLen = Math.hypot(body.displayOrbit.px, body.displayOrbit.py, body.displayOrbit.pz) || 1;
      body.displayOrbit.px /= pLen;
      body.displayOrbit.py /= pLen;
      body.displayOrbit.pz /= pLen;
      body.displayOrbit.qx += (qx - body.displayOrbit.qx) * rate;
      body.displayOrbit.qy += (qy - body.displayOrbit.qy) * rate;
      body.displayOrbit.qz += (qz - body.displayOrbit.qz) * rate;
      const qLen = Math.hypot(body.displayOrbit.qx, body.displayOrbit.qy, body.displayOrbit.qz) || 1;
      body.displayOrbit.qx /= qLen;
      body.displayOrbit.qy /= qLen;
      body.displayOrbit.qz /= qLen;
    }

    const d = body.displayOrbit;
    const a = d.a;
    const e = clamp(d.e, 0, 0.96);
    const b = a * Math.sqrt(Math.max(0.01, 1 - e * e));

    const points = [];
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const xRel = (a * (cosT - e)) * d.px + (b * sinT) * d.qx;
      const yRel = (a * (cosT - e)) * d.py + (b * sinT) * d.qy;
      const zRel = (a * (cosT - e)) * d.pz + (b * sinT) * d.qz;
      points.push(new T.Vector3(xRel * AU, yRel * AU, zRel * AU));
    }
    return points;
  }

  function updateOrbitLines() {
    const showOrbits = $('showOrbits')?.checked ?? true;
    for (const body of bodies) {
      if (!body.orbitLine) continue;
      if (!showOrbits || !body.parentId || body.type === 'star') {
        body.orbitLine.visible = false;
        continue;
      }
      const parent = bodies.find(b => b.id === body.parentId);
      if (!parent) {
        body.orbitLine.visible = false;
        continue;
      }

      body.orbitLine.position.copy(parent.mesh.position);

      const points = computeKeplerPoints(body, parent);
      if (!points || points.length === 0) {
        body.orbitLine.visible = false;
        continue;
      }

      body.orbitLine.geometry.setFromPoints(points);
      const isHighlighted = body === selected || parent === selected;
      body.orbitLine.material.color.set(isHighlighted ? 0x38bdf8 : (body.isMoon ? 0x94a3b8 : 0x0ea5e9));
      body.orbitLine.material.opacity = isHighlighted ? 0.95 : (body.isMoon ? 0.45 : 0.65);
      body.orbitLine.visible = true;
    }
  }

  // 8. ORBIT PLACEMENT PREVIEW & CLICK-TO-SPAWN
  function findDominantStar(targetId = null) {
    if (targetId && targetId !== 'auto') {
      const b = bodies.find(x => String(x.id) === String(targetId));
      if (b) return b;
    }
    const targetSelect = $('customTarget');
    if (targetSelect && targetSelect.value && targetSelect.value !== 'auto') {
      const b = bodies.find(x => String(x.id) === String(targetSelect.value));
      if (b) return b;
    }
    if (selected) return selected;
    return bodies.find(b => b.type === 'star') || bodies.find(b => b.isBlackHole) || bodies[0] || null;
  }

  function spawnOrbiter(parent, spec, distanceAU, angle = Math.random() * Math.PI * 2, inc = 0.02, ecc = 0) {
    if (!parent) return null;
    const parentMass = parent.mass || 1.0;
    const childMass = spec.mass || (1 / EARTHS_PER_SUN);
    const speed = Math.sqrt(G * (parentMass + childMass) / distanceAU) * Math.sqrt(1 + ecc);

    const cosA = Math.cos(angle), sinA = Math.sin(angle);
    const p = [
      parent.p[0] + cosA * distanceAU,
      parent.p[1] + sinA * distanceAU * Math.sin(inc),
      parent.p[2] + sinA * distanceAU * Math.cos(inc)
    ];
    const v = [
      parent.v[0] - sinA * speed,
      parent.v[1] + cosA * speed * Math.sin(inc),
      parent.v[2] + cosA * speed * Math.cos(inc)
    ];

    return createBody({ ...spec, p, v, parentId: parent.id });
  }

  // 9. SIMULATION PRESETS
  function loadPreset(presetKey) {
    clearAllBodies();
    activePreset = presetKey;
    $('presetSelect').value = presetKey;
    $('evolutionTimeline').hidden = (presetKey !== 'evolution');

    if (presetKey === 'solar') {
      // Solar System with complete moon systems and authentic NASA textures
      const sun = createBody({ name: 'Sun', type: 'star', scienceType: 'star', mass: 1.0, radius: 1.6, color: '#fff0cb', textureKey: 'sun', temp: 5778, atmo: 0, magnetic: 0 });

      const planetsData = [
        { name: 'Mercury', dist: 0.39, mass: 0.055, radius: 0.22, color: '#9e9389', type: 'rock', atmo: 0, temp: 440, inc: 0.0 },
        { name: 'Venus', dist: 0.72, mass: 0.815, radius: 0.34, color: '#fef08a', type: 'rock', atmo: 92, atmoColor: '#fef08a', gasType: 'carbonDioxide', temp: 737, inc: 0.02 },
        { name: 'Earth', dist: 1.00, mass: 1.000, radius: 0.36, color: '#4f9cff', type: 'rock', atmo: 1.0, atmoColor: '#76bfff', gasType: 'earthAir', water: 71, ice: 15, temp: 288, inc: 0.0 },
        { name: 'Mars', dist: 1.52, mass: 0.107, radius: 0.26, color: '#c2410c', type: 'rock', atmo: 0.01, atmoColor: '#f87171', water: 2, ice: 20, temp: 210, inc: 0.02 },
        { name: 'Jupiter', dist: 5.20, mass: 317.8, radius: 0.94, color: '#c8b399', type: 'gas', atmo: 3.0, bandCount: 14, bandColors: ['#e2cbb0', '#c89d6d', '#d7ad7d', '#9c7b58', '#f1d6b8'], temp: 165, inc: 0.01 },
        { name: 'Saturn', dist: 9.58, mass: 95.2, radius: 0.80, color: '#d3c39b', type: 'gas', atmo: 2.5, ring: true, ringScale: 2.4, ringColor: '#c7b997', temp: 134, inc: 0.02 },
        { name: 'Uranus', dist: 19.20, mass: 14.5, radius: 0.60, color: '#98cbd0', type: 'gas', atmo: 2.0, ring: true, ringScale: 1.9, ringColor: '#93c5fd', tilt: 98, temp: 76, inc: 0.01 },
        { name: 'Neptune', dist: 30.05, mass: 17.1, radius: 0.58, color: '#2563eb', type: 'gas', atmo: 2.0, ring: true, ringScale: 1.7, temp: 72, inc: 0.02 }
      ];

      const pMap = {};
      planetsData.forEach((pd, idx) => {
        const pl = spawnOrbiter(sun, {
          name: pd.name,
          mass: pd.mass / EARTHS_PER_SUN,
          radius: pd.radius,
          color: pd.color,
          type: pd.type,
          atmo: pd.atmo,
          atmoColor: pd.atmoColor,
          gasType: pd.gasType,
          water: pd.water,
          ice: pd.ice,
          ring: pd.ring,
          ringScale: pd.ringScale,
          ringColor: pd.ringColor,
          tilt: pd.tilt,
          temp: pd.temp,
          bandCount: pd.bandCount,
          bandColors: pd.bandColors
        }, pd.dist, idx * 0.82 + 0.3, pd.inc);
        pMap[pd.name] = pl;
      });

      // Moons with realistic visual clearance & local gravity coupling
      if (moonsEngaged) {
        const addMoon = (parent, name, massE, rad, distAU, angle, inc = 0.02, color = '#c2c0b6') => {
          spawnOrbiter(parent, {
            name,
            type: 'moon',
            mass: massE / EARTHS_PER_SUN,
            radius: rad,
            color,
            atmo: 0,
            water: 2,
            ice: 15,
            magnetic: 0.02,
            gravityScale: 1.0,
            tidalImmune: true,
            isMoon: true
          }, distAU, angle, inc);
        };

        addMoon(pMap['Earth'], 'Moon', 0.0123, 0.10, 0.085, 0.4, 0.03, '#c2c0b6');
        addMoon(pMap['Mars'], 'Phobos', 1.8e-9, 0.06, 0.055, 1.2, 0.01, '#4a4542');
        addMoon(pMap['Mars'], 'Deimos', 2.5e-10, 0.05, 0.078, 3.8, 0.02, '#5c534b');
        addMoon(pMap['Jupiter'], 'Io', 0.015, 0.08, 0.15, 0.6, 0.01, '#eab308');
        addMoon(pMap['Jupiter'], 'Europa', 0.008, 0.075, 0.21, 1.7, 0.02, '#f8fafc');
        addMoon(pMap['Jupiter'], 'Ganymede', 0.025, 0.09, 0.29, 2.9, 0.01, '#94a3b8');
        addMoon(pMap['Jupiter'], 'Callisto', 0.018, 0.085, 0.38, 4.3, 0.01, '#475569');
        addMoon(pMap['Saturn'], 'Titan', 0.0225, 0.09, 0.28, 1.4, 0.02, '#f59e0b');
        addMoon(pMap['Uranus'], 'Titania', 0.0006, 0.065, 0.18, 2.1, 0.01, '#cbd5e1');
        addMoon(pMap['Neptune'], 'Triton', 0.0036, 0.07, 0.18, 4.2, 0.02, '#99f6e4');
      }

      buildAsteroidBelt();
      selectBody(pMap['Earth']);
      camera.position.set(26, 32, 65);
      controls.target.set(0, 0, 0);
      showToast("Solar System preset loaded • 8 Planets & Major Moons");

    } else if (presetKey === 'earthMoon') {
      const earth = createBody({ name: 'Earth', type: 'rock', textureKey: 'earth', mass: 1.0 / EARTHS_PER_SUN, radius: 1.2, color: '#4f9cff', atmo: 1.0, water: 71, ice: 15, temp: 288 });
      spawnOrbiter(earth, { name: 'Moon', type: 'moon', mass: 0.0123 / EARTHS_PER_SUN, radius: 0.32, color: '#c2c0b6', isMoon: true, gravityScale: 1.0 }, 0.42, 0.2);
      selectBody(earth);
      camera.position.set(3, 4, 8);
      controls.target.copy(earth.mesh.position);
      showToast("Earth & Moon close encounter loaded");

    } else if (presetKey === 'binary') {
      const d = 1.4;
      const speed = Math.sqrt(G * 0.7 / (2 * d));
      const s1 = createBody({ name: 'Aurelia', type: 'star', mass: 0.7, radius: 1.3, color: '#f59e0b', temp: 5200, p: [-d, 0, 0], v: [0, 0, -speed] });
      const s2 = createBody({ name: 'Cyanis', type: 'star', mass: 0.7, radius: 1.3, color: '#38bdf8', temp: 7800, p: [d, 0, 0], v: [0, 0, speed] });
      // Circumbinary world
      const pDist = 5.2;
      const pSpeed = Math.sqrt(G * 1.4 / pDist);
      createBody({ name: 'Drifter', type: 'rock', mass: 3 / EARTHS_PER_SUN, radius: 0.45, color: '#34d399', atmo: 1.2, water: 80, p: [0, 0, pDist], v: [pSpeed, 0, 0], parentId: s1.id });
      selectBody(s1);
      camera.position.set(16, 24, 40);
      controls.target.set(0, 0, 0);
      showToast("Binary Star System loaded • Aurelia & Cyanis");

    } else if (presetKey === 'chaos') {
      const count = 5;
      const r = 3.5;
      for (let i = 0; i < count; i++) {
        const theta = (i / count) * Math.PI * 2;
        const vTang = Math.sqrt(G * 0.5 / r) * 0.75;
        createBody({
          name: 'Wanderer ' + (i + 1),
          type: 'rock',
          mass: 0.4,
          radius: 0.65,
          color: ['#f87171', '#fbbf24', '#34d399', '#38bdf8', '#c084fc'][i],
          p: [Math.cos(theta) * r, 0, Math.sin(theta) * r],
          v: [-Math.sin(theta) * vTang, 0, Math.cos(theta) * vTang]
        });
      }
      selectBody(bodies[0]);
      camera.position.set(12, 18, 30);
      controls.target.set(0, 0, 0);
      showToast("Five-Body Chaos N-body choreography loaded");

    } else if (presetKey === 'evolution') {
      loadEvolutionStage(0);
      showToast("Evolution of the Solar System • Timeline initialized");

    } else if (presetKey === 'blackHole') {
      const bh = createBody({ name: 'Gargantua', type: 'blackhole', isBlackHole: true, mass: 2.5, radius: 1.5, color: '#000000', temp: 0 });
      const compSpeed = Math.sqrt(G * 2.5 / 6.5);
      createBody({ name: 'Companion Blue Giant', type: 'star', mass: 1.2, radius: 1.8, color: '#93c5fd', temp: 22000, p: [6.5, 0, 0], v: [0, 0, compSpeed], parentId: bh.id });
      const mSpeed = Math.sqrt(G * 2.5 / 2.8);
      createBody({ name: "Miller's Planet", type: 'rock', mass: 1.5 / EARTHS_PER_SUN, radius: 0.38, color: '#0284c7', water: 100, atmo: 1.5, p: [0, 0, 2.8], v: [mSpeed, 0, 0], parentId: bh.id });
      selectBody(bh);
      camera.position.set(14, 20, 36);
      controls.target.set(0, 0, 0);
      showToast("Gargantua Black Hole & Accretion Disk loaded");
    }
  }

  const evolutionStages = [
    { title: "1. 4.567 Ga: The Solar Nebula Collapse", time: "4.57 Billion Years Ago", desc: "A dense molecular cloud core collapses under gravity, forming the proto-Sun surrounded by an accretion disk." },
    { title: "2. 4.510 Ga: The Giant Impact (Theia & Earth)", time: "4.51 Billion Years Ago", desc: "Mars-sized protoplanet Theia collides with young Earth at 9 km/s, expelling a dense debris ring that coalesces into the Moon." },
    { title: "3. 4.400 Ga: Ancient Habitable Venus & Wet Mars", time: "4.40 Billion Years Ago", desc: "Venus possesses global oceans and a temperate climate, while Mars hosts rivers, lakes, and a robust magnetic field." },
    { title: "4. 4.000 Ga: The Five Giant Planets System", time: "4.00 Billion Years Ago", desc: "A fifth gas giant orbits between Saturn and Uranus, maintaining orbital resonance before gravitational instability." },
    { title: "5. 3.900 Ga: Nice Model Instability & Late Heavy Bombardment", time: "3.90 Billion Years Ago", desc: "Planetary migration scatters the Kuiper belt, violently ejecting the fifth giant into interstellar space and cratering inner worlds." },
    { title: "6. 2.400 Ga: The Great Oxidation Event", time: "2.40 Billion Years Ago", desc: "Cyanobacteria produce photosynthetic oxygen, transforming Earth's atmosphere into blue skies and precipitating a snowball Earth." },
    { title: "7. Present Day: The Modern Solar System", time: "Modern Era", desc: "The balanced 8-planet architecture, stable orbits, asteroid belts, and Earth's diverse technological civilization." },
    { title: "8. +5.000 Ga: Red Giant Expansion & Engulfment", time: "5.00 Billion Years in Future", desc: "The Sun exhausts core hydrogen, expanding into a swollen Red Giant that engulfs Mercury and Venus, scorching the Earth." }
  ];

  function loadEvolutionStage(idx) {
    evolutionIndex = clamp(idx, 0, evolutionStages.length - 1);
    const stage = evolutionStages[evolutionIndex];
    $('eraTitle').textContent = stage.title;
    $('eraDescription').textContent = stage.desc;
    $('eraTimeAgo').textContent = stage.time;
    $('eraStepIndicator').textContent = `Era ${evolutionIndex + 1} of ${evolutionStages.length}`;

    clearAllBodies();
    if (evolutionIndex === 0) {
      // Nebula
      const pSun = createBody({ name: 'Proto-Sun', type: 'star', mass: 0.75, radius: 2.2, color: '#f59e0b', temp: 3400 });
      for (let i = 0; i < 8; i++) {
        const d = 1.0 + i * 1.6;
        spawnOrbiter(pSun, { name: 'Protoplanet ' + (i + 1), type: 'rock', mass: (0.2 + i * 0.15) / EARTHS_PER_SUN, radius: 0.25 + i * 0.04, color: '#a8a29e' }, d, i * 0.9);
      }
    } else if (evolutionIndex === 1) {
      // Theia Impact
      const protoEarth = createBody({ name: 'Proto-Earth', type: 'rock', mass: 0.9 / EARTHS_PER_SUN, radius: 0.8, color: '#3b82f6', p: [0, 0, 0], v: [0, 0, 0] });
      createBody({ name: 'Theia', type: 'rock', mass: 0.1 / EARTHS_PER_SUN, radius: 0.42, color: '#ef4444', p: [1.8, 0, 0], v: [-Math.sqrt(G * 0.9 / 1.8) * 0.9, 0, 0.4] });
    } else {
      loadPreset('solar');
    }
  }

  function buildAsteroidBelt() {
    asteroidBelt.clear();
    const pos = [], r = rng(9991);
    for (let i = 0; i < 650; i++) {
      const angle = r() * Math.PI * 2;
      const distance = 21.0 + r() * 11.0;
      const y = (r() - 0.5) * (0.3 + r() * 0.8);
      pos.push(Math.cos(angle) * distance, y, Math.sin(angle) * distance);
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    asteroidBelt.add(new T.Points(geo, new T.PointsMaterial({ color: 0xa8a29e, size: 0.1, transparent: true, opacity: 0.75, sizeAttenuation: true, depthWrite: false })));
  }

  function toggleMoons(engage = !moonsEngaged) {
    moonsEngaged = engage;
    const btn = $('toggleMoonsBtn');
    if (btn) {
      btn.classList.toggle('active', moonsEngaged);
      btn.setAttribute('aria-pressed', moonsEngaged);
      btn.innerHTML = `<span>🌙</span> Moons: ${moonsEngaged ? 'ON' : 'OFF'}`;
    }

    if (!moonsEngaged) {
      const toRemove = bodies.filter(b => b.isMoon || b.type === 'moon');
      toRemove.forEach(destroyBody);
      showToast("Moons disengaged • Debris & natural satellites purged");
    } else {
      if (activePreset === 'solar') loadPreset('solar');
      showToast("Moons engaged • Natural satellites restored");
    }
  }

  // 10. COLLISION & TIDAL PHYSICS
  function resolveCollisions() {
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        let a = bodies[i], b = bodies[j];
        const dx = b.p[0] - a.p[0], dy = b.p[1] - a.p[1], dz = b.p[2] - a.p[2];
        const dist = Math.hypot(dx, dy, dz);
        // Realistic collision boundary: avoid false merges between host planet and bound moon
        const isParentChild = (a.parentId === b.id || b.parentId === a.id);
        const colMultiplier = isParentChild ? 0.35 : 0.50;
        const colDist = (a.radius + b.radius) / AU * colMultiplier;

        if (dist >= colDist) continue;

        // Inelastic merge
        if (b.mass > a.mass) { const tmp = a; a = b; b = tmp; }
        const am = a.mass, bm = b.mass, m = am + bm;
        const dv = Math.hypot(a.v[0] - b.v[0], a.v[1] - b.v[1], a.v[2] - b.v[2]);

        a.v[0] = (a.v[0] * am + b.v[0] * bm) / m;
        a.v[1] = (a.v[1] * am + b.v[1] * bm) / m;
        a.v[2] = (a.v[2] * am + b.v[2] * bm) / m;
        a.mass = m;
        a.radius = Math.cbrt(a.radius ** 3 + b.radius ** 3);
        a.mesh.scale.setScalar(a.radius);
        a.temp = Math.min(18000, a.temp + dv * 350);

        // Sound & shockwave
        SoundEngine.playImpact(dv);
        const wave = new T.Mesh(new T.SphereGeometry(1, 24, 16), new T.MeshBasicMaterial({ color: 0xffa45d, wireframe: true, transparent: true, opacity: 0.85, blending: T.AdditiveBlending, depthWrite: false }));
        wave.position.copy(a.mesh.position);
        scene.add(wave);
        effects.push({ mesh: wave, age: 0, r: a.radius });

        destroyBody(b);
        showToast(`Impact on ${a.name} • Conserved momentum and combined mass`);
        return;
      }
    }
  }

  // 11. COSMIC TRIGGERS: SOLAR FLARES & SUPERNOVA
  function triggerSolarFlare() {
    const star = selected?.type === 'star' ? selected : bodies.find(b => b.type === 'star');
    if (!star) { showToast("Select a star to trigger a Solar Flare"); return; }

    SoundEngine.playFlare();
    const verts = [], r = rng(Date.now() % 99991);
    for (let i = 0; i < 320; i++) {
      const v = new T.Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize().multiplyScalar(0.8 + r() * 1.5);
      verts.push(v.x, v.y, v.z);
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(verts, 3));
    const cloud = new T.Points(geo, new T.PointsMaterial({ color: 0xff7700, size: 0.16, transparent: true, opacity: 0.95, blending: T.AdditiveBlending, depthWrite: false }));
    cloud.position.copy(star.mesh.position);
    scene.add(cloud);
    effects.push({ mesh: cloud, age: 0, r: star.radius * 2.2 });

    const toDestroy = [];
    // Magnetic shielding deterioration, immediate scorching without shield, and mass evaporation
    for (const b of bodies) {
      if (b === star || b.type === 'star' || b.isBlackHole) continue;
      const d = Math.max(0.15, Math.hypot(b.p[0] - star.p[0], b.p[1] - star.p[1], b.p[2] - star.p[2]));

      if (b.magnetic > 0.05) {
        // Shielded world: magnetic field deteriorates gradually
        const erosion = 0.35 / d;
        b.magnetic = Math.max(0, b.magnetic - erosion);
        b.temp += Math.min(250, 45 / d);
        if (b.magnetic <= 0.05) {
          b.magnetic = 0;
          showToast(`⚠️ MAGNETOSPHERE STRIPPED: Solar flare eroded ${b.name}'s magnetic shield!`);
        }
      } else {
        // Unshielded world: SCORCH IMMEDIATELY and EVAPORATE!
        b.isLavaWorld = true;
        b.scorchLevel = 1.0;
        b.water = 0; // Oceans vaporized immediately
        b.atmo = Math.max(0, (b.atmo || 1.0) - 0.35 / d);
        b.temp = Math.max(b.temp || 288, 1450 + 350 / d);
        b.color = '#ff3b00';
        if (b.material.color) b.material.color.set('#ff3b00');
        if (b.material.emissive) b.material.emissive.set('#ff2200');
        if (b.outlineMesh) b.outlineMesh.material.color.set('#ff3b00');

        // Sustained mass evaporation
        if (b.initialMass === undefined) b.initialMass = b.mass;
        if (b.initialRadius === undefined) b.initialRadius = b.radius;
        const massLoss = Math.max(0.00003, b.mass * (0.32 / d));
        b.mass = Math.max(0, b.mass - massLoss);

        const massRatio = Math.max(0.001, b.mass / (b.initialMass || 1));
        const sizeScale = Math.cbrt(massRatio);
        b.radius = Math.max(0.05, b.initialRadius * sizeScale);
        b.mesh.scale.set(b.radius, b.radius, b.radius);

        // Complete Vaporization
        if (b.mass <= 0.00015 / EARTHS_PER_SUN || b.radius <= 0.07) {
          toDestroy.push(b);
        }
      }
    }

    for (const b of toDestroy) {
      const blast = new T.Mesh(
        new T.SphereGeometry(1, 24, 18),
        new T.MeshBasicMaterial({ color: 0xff5500, wireframe: true, transparent: true, opacity: 0.95, blending: T.AdditiveBlending })
      );
      blast.position.copy(b.mesh.position);
      scene.add(blast);
      effects.push({ mesh: blast, age: 0, r: b.radius * 4.0 });

      SoundEngine.playImpact();
      showToast(`💥 PLANET VAPORIZED: ${b.name} has completely evaporated under the extreme stellar flare!`);
      destroyBody(b);
      const idx = bodies.indexOf(b);
      if (idx !== -1) bodies.splice(idx, 1);
      if (selected === b) selectBody(null);
    }

    showToast(`☀️ Solar Flare erupted from ${star.name} • Coronal Mass Ejection travelling outward`);
  }

  function triggerSupernova() {
    const star = selected?.type === 'star' ? selected : bodies.find(b => b.type === 'star');
    if (!star) { showToast("Select a star to trigger a Supernova"); return; }

    SoundEngine.playSupernova();
    const blast = new T.Mesh(new T.SphereGeometry(1, 32, 24), new T.MeshBasicMaterial({ color: 0x93c5fd, wireframe: true, transparent: true, opacity: 0.95, blending: T.AdditiveBlending, depthWrite: false }));
    blast.position.copy(star.mesh.position);
    scene.add(blast);
    effects.push({ mesh: blast, age: 0, r: star.radius * 3.5 });

    // Collapse remnant into a black hole
    star.type = 'blackhole';
    star.isBlackHole = true;
    star.color = '#000000';
    star.mass = Math.max(3.0, star.mass * 0.4);
    star.radius = 0.8;
    star.atmo = 0;
    if (star.glow) { scene.remove(star.glow); star.glow = null; }
    star.material.map = null;
    if (star.material.color) star.material.color.set('#000000');
    if (star.material.emissive) star.material.emissive.set('#000000');
    if (star.outlineMesh) star.outlineMesh.material.color.set('#555555');
    createRingsMesh(star);

    selectBody(star);
    showToast(`💥 Supernova detonation! Core collapsed into a stellar black hole`);
  }

  // 12. SELECTION & UI SYNC
  function selectBody(b) {
    selected = b;
    following = false;
    const inspector = $('inspector');

    if (!b) {
      inspector.hidden = true;
      selectionReticle.visible = false;
      return;
    }

    inspector.hidden = false;
    selectionReticle.visible = true;
    selectionReticle.position.copy(b.mesh.position);
    selectionReticle.scale.setScalar(b.radius * 1.35);
    reticleRing.material.color.set(b.type === 'star' ? 0xf59e0b : 0x38bdf8);

    $('title').textContent = b.name;
    $('classification').textContent = b.isBlackHole ? 'Black Hole' : b.type === 'star' ? 'Stellar Body' : b.type === 'gas' ? 'Gas Giant' : b.isMoon ? 'Natural Satellite' : 'Terrestrial Planet';
    $('classificationSummary').textContent = b.isBlackHole ? 'Superdense relativistic mass' : b.type === 'star' ? 'Thermonuclear fusion plasma' : 'Editable physical world';

    $('name').value = b.name;
    $('mass').value = formatNumber(b.mass * EARTHS_PER_SUN, 4);
    $('color').value = b.color;
    $('radius').value = b.radius;
    $('radiusValue').textContent = `${b.radius.toFixed(2)}×`;
    $('tilt').value = b.tilt;
    $('tiltValue').textContent = `${b.tilt}°`;
    $('dayLength').value = b.dayLength;
    $('dayValue').textContent = `${Math.round(b.dayLength)} h`;
    $('gravity').value = b.gravity;
    $('gravityValue').textContent = `${b.gravity.toFixed(2)}×`;

    $('vx').value = b.v[0].toFixed(2);
    $('vy').value = b.v[1].toFixed(2);
    $('vz').value = b.v[2].toFixed(2);

    $('water').value = b.water;
    $('waterValue').textContent = `${Math.round(b.water)}%`;
    $('ice').value = b.ice;
    $('iceValue').textContent = `${Math.round(b.ice)}%`;
    $('ocean').value = b.oceanColor;
    $('land').value = b.landColor;

    $('atmo').value = b.atmo;
    $('atmoValue').textContent = `${b.atmo.toFixed(2)} atm`;
    $('atmoColor').value = b.atmoColor;
    $('gasTypeSelect').value = b.gasType || 'earthAir';

    $('magnetic').value = b.magnetic;
    $('magneticValue').textContent = `${b.magnetic.toFixed(1)}× Earth`;
    $('bodyMagneticMeter').style.width = `${Math.min(100, b.magnetic * 10)}%`;

    $('bodyHasRing').checked = Boolean(b.ring);
    $('bodyRingScale').value = b.ringScale || 2.2;
    if ($('bodyRingScaleVal')) $('bodyRingScaleVal').textContent = `${parseFloat(b.ringScale || 2.2).toFixed(1)}× Planet`;
    $('bodyRingColor').value = b.ringColor || '#d7bd7d';
    if ($('composition')) {
      $('composition').textContent = b.isBlackHole ? 'Singularity & spacetime curvature' : b.type === 'star' ? 'Hydrogen & Helium plasma fusion' : b.type === 'gas' ? 'Hydrogen, Helium & metallic mantle' : 'Silicate crust, mantle & metallic core';
    }

    // Diagnostics & Astrobiology
    const star = findDominantStar();
    const life = computeLifeLikelihood(star, b.p[0], b.p[1], b.p[2], b);
    $('bodyHabitability').textContent = `${life.score}% (${life.zone})`;
    $('bodyHabitability').className = life.score > 70 ? 'text-life' : life.score > 35 ? '' : 'btn-danger';
    $('temp').textContent = `${life.tempC} °C (${life.tempK} K)`;

    const speedKmS = Math.hypot(...b.v) * AU_YEAR_TO_KM_S;
    $('velocity').textContent = `${formatNumber(speedKmS, 1)} km/s`;
    $('radiusSummary').textContent = `${Math.round(b.radius * 6371).toLocaleString()} km`;
    $('gravitySummary').textContent = `${formatNumber(b.gravity * (b.mass * EARTHS_PER_SUN) / Math.max(0.01, b.radius ** 2), 2)} g`;
    $('escapeVelocity').textContent = `${formatNumber(11.2 * Math.sqrt((b.mass * EARTHS_PER_SUN) / Math.max(0.01, b.radius)), 1)} km/s`;
    $('atmosphereSummary').textContent = `${b.atmo.toFixed(2)} atm · ${b.gasType}`;

    // Hero Orb style
    const orb = $('bodyOrb');
    orb.style.background = b.isBlackHole ? '#000000' : `radial-gradient(circle at 35% 30%, #ffffff88, #00000000 35%), ${b.color}`;
    orb.style.boxShadow = `0 0 20px ${b.color}66`;
  }

  function updateTargetSelectors() {
    const sel = $('customTarget');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="auto">Auto-Detect Dominant Star/Planet</option>';
    for (const b of [...bodies].sort((x, y) => y.mass - x.mass)) {
      const opt = document.createElement('option');
      opt.value = b.id;
      const typeLabel = b.type === 'star' ? '⭐ Star' : b.type === 'gas' ? '🪐 Gas Giant' : b.isMoon ? '🌙 Moon' : '🌍 Planet';
      opt.textContent = `${b.name} (${typeLabel})`;
      sel.appendChild(opt);
    }
    if (cur && (cur === 'auto' || bodies.some(b => String(b.id) === cur))) sel.value = cur;
    else if (selected) sel.value = String(selected.id);
    else sel.value = 'auto';
  }

  function showToast(msg) {
    const el = $('message');
    if (!el) return;
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el.fadeTimer);
    el.fadeTimer = setTimeout(() => { el.style.opacity = '0'; }, 4000);
  }

  // 12. INTERACTIVE DRAGGABLE & SCALABLE MENU SYSTEM
  function makeDraggableAndScalable(panelEl) {
    if (!panelEl) return;
    let currentScale = 0.82;
    panelEl.style.setProperty('--panel-scale', currentScale);

    // Zoom buttons
    const downBtn = panelEl.querySelector('.btn-scale[data-action="scale-down"]');
    const upBtn = panelEl.querySelector('.btn-scale[data-action="scale-up"]');

    function setScale(s) {
      currentScale = Math.min(1.6, Math.max(0.6, Math.round(s * 100) / 100));
      panelEl.style.setProperty('--panel-scale', currentScale);
    }

    downBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      setScale(currentScale - 0.1);
      showToast(`Panel scale: ${Math.round(currentScale * 100)}%`);
    });

    upBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      setScale(currentScale + 0.1);
      showToast(`Panel scale: ${Math.round(currentScale * 100)}%`);
    });

    // Corner resize grip
    const grip = panelEl.querySelector('.panel-resize-grip');
    if (grip) {
      let isResizing = false;
      let startX = 0, startScale = 1.0;

      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        isResizing = true;
        startX = e.clientX;
        startScale = currentScale;
        grip.setPointerCapture(e.pointerId);
      });

      grip.addEventListener('pointermove', (e) => {
        if (!isResizing) return;
        const dx = e.clientX - startX;
        const deltaScale = dx / 220;
        setScale(startScale + deltaScale);
      });

      const endResize = (e) => {
        if (isResizing) {
          isResizing = false;
          try { grip.releasePointerCapture(e.pointerId); } catch (_) {}
        }
      };
      grip.addEventListener('pointerup', endResize);
      grip.addEventListener('pointercancel', endResize);
    }

    // Dragging Header
    const header = panelEl.querySelector('.panel-header-drag') || panelEl.querySelector('.panel-header');
    if (header) {
      let isDragging = false;
      let startMouseX = 0, startMouseY = 0;
      let startLeft = 0, startTop = 0;

      header.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button') || e.target.closest('input') || e.target.closest('select')) return;
        e.preventDefault();
        isDragging = true;
        startMouseX = e.clientX;
        startMouseY = e.clientY;

        const rect = panelEl.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;

        panelEl.style.left = `${startLeft}px`;
        panelEl.style.top = `${startTop}px`;
        panelEl.style.right = 'auto';
        panelEl.style.bottom = 'auto';

        header.setPointerCapture(e.pointerId);
      });

      header.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startMouseX;
        const dy = e.clientY - startMouseY;

        let newLeft = startLeft + dx;
        let newTop = startTop + dy;

        const pad = 10;
        newLeft = Math.max(pad, Math.min(window.innerWidth - 60, newLeft));
        newTop = Math.max(pad, Math.min(window.innerHeight - 60, newTop));

        panelEl.style.left = `${newLeft}px`;
        panelEl.style.top = `${newTop}px`;
      });

      const endDrag = (e) => {
        if (isDragging) {
          isDragging = false;
          try { header.releasePointerCapture(e.pointerId); } catch (_) {}
        }
      };
      header.addEventListener('pointerup', endDrag);
      header.addEventListener('pointercancel', endDrag);
    }
  }

  // 13. EVENT WIRING & INTERACTION
  function bindEvents() {
    makeDraggableAndScalable($('inspector'));
    makeDraggableAndScalable($('creator'));

    // UI Visibility Toggle (Clean Space Mode)
    const toggleUI = () => {
      const isHidden = document.body.classList.toggle('ui-hidden');
      if ($('showUIPill')) $('showUIPill').hidden = !isHidden;
      showToast(isHidden ? "Clean Space View • Press H or click 'Show HUD' to restore" : "HUD restored");
    };

    $('toggleUIBtn')?.addEventListener('click', toggleUI);
    $('showUIPill')?.addEventListener('click', toggleUI);

    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === 'h' || e.key === 'H') {
        toggleUI();
      }
    });

    // Top Bar
    $('loadPreset')?.addEventListener('click', () => loadPreset($('presetSelect').value));
    $('presetSelect')?.addEventListener('change', () => loadPreset($('presetSelect').value));
    $('newPlanetTop')?.addEventListener('click', () => {
      $('creator').hidden = !$('creator').hidden;
      climateZonesGroup.userData.hostId = null;
      updateHabitableZones3D();
    });
    $('closeCreator')?.addEventListener('click', () => {
      $('creator').hidden = true;
      climateZonesGroup.userData.hostId = null;
      updateHabitableZones3D();
    });
    $('toggleMoonsBtn')?.addEventListener('click', () => toggleMoons());
    $('audioToggleBtn')?.addEventListener('click', () => {
      const muted = SoundEngine.toggleMute();
      $('audioToggleBtn').textContent = muted ? '🔇' : '🔊';
    });

    $('zoomInBtn')?.addEventListener('click', () => { camera.position.multiplyScalar(0.8); });
    $('zoomOutBtn')?.addEventListener('click', () => { camera.position.multiplyScalar(1.25); });
    $('fitViewTopBtn')?.addEventListener('click', fitOverview);
    $('fitView')?.addEventListener('click', fitOverview);

    $('customTarget')?.addEventListener('change', () => {
      climateZonesGroup.userData.hostId = null;
      updateHabitableZones3D();
    });
    $('showZones')?.addEventListener('change', () => {
      climateZonesGroup.userData.hostId = null;
      updateHabitableZones3D();
    });

    // Bottom Dock
    $('playPause')?.addEventListener('click', () => {
      playing = !playing;
      $('playPause').textContent = playing ? 'Ⅱ' : '▶';
      $('runStatus').textContent = playing ? 'RUNNING' : 'PAUSED';
      $('runStatus').className = `status-pill ${playing ? 'running' : 'paused'}`;
    });

    $('moveBodyMode')?.addEventListener('click', () => {
      moveMode = !moveMode;
      $('moveBodyMode').classList.toggle('active', moveMode);
      showToast(moveMode ? "✥ Move mode ON • Drag planets across space" : "Move mode OFF • Camera navigation restored");
    });

    $('resetSimulation')?.addEventListener('click', () => loadPreset(activePreset));
    $('clearSimulation')?.addEventListener('click', clearAllBodies);

    // Snapshot Persistence (Save & Load Universe)
    $('saveUniverse')?.addEventListener('click', () => {
      try {
        const snap = bodies.map(b => ({
          name: b.name,
          type: b.type,
          scienceType: b.scienceType,
          mass: b.mass,
          radius: b.radius,
          color: b.color,
          p: b.p,
          v: b.v,
          tilt: b.tilt,
          dayLength: b.dayLength,
          atmo: b.atmo,
          atmoColor: b.atmoColor,
          gasType: b.gasType,
          water: b.water,
          ice: b.ice,
          ring: b.ring,
          ringScale: b.ringScale,
          ringColor: b.ringColor,
          isMoon: b.isMoon,
          isBlackHole: b.isBlackHole,
          textureKey: b.textureKey
        }));
        localStorage.setItem('ps3d_universe_save', JSON.stringify(snap));
        showToast(`💾 Universe snapshot saved (${bodies.length} bodies)`);
      } catch (e) {
        showToast("Failed to save universe snapshot");
      }
    });

    $('loadUniverse')?.addEventListener('click', () => {
      try {
        const raw = localStorage.getItem('ps3d_universe_save');
        if (!raw) {
          showToast("No saved universe snapshot found");
          return;
        }
        const snap = JSON.parse(raw);
        clearAllBodies();
        snap.forEach(spec => createBody(spec));
        fitOverview();
        showToast(`📂 Universe snapshot restored (${snap.length} bodies)`);
      } catch (e) {
        showToast("Failed to restore universe snapshot");
      }
    });

    // Evolution Bar
    $('prevEraBtn')?.addEventListener('click', () => loadEvolutionStage(evolutionIndex - 1));
    $('nextEraBtn')?.addEventListener('click', () => loadEvolutionStage(evolutionIndex + 1));
    $('playEraBtn')?.addEventListener('click', () => {
      if (evolutionTimer) {
        clearInterval(evolutionTimer); evolutionTimer = null;
        $('playEraBtn').textContent = '▶ Auto-Play Evolution';
      } else {
        $('playEraBtn').textContent = 'Ⅱ Pause Auto-Play';
        evolutionTimer = setInterval(() => {
          if (evolutionIndex < evolutionStages.length - 1) loadEvolutionStage(evolutionIndex + 1);
          else { clearInterval(evolutionTimer); evolutionTimer = null; $('playEraBtn').textContent = '▶ Auto-Play Evolution'; }
        }, 5000);
      }
    });

    // Inspector Close & Focus
    $('closeInspector')?.addEventListener('click', () => selectBody(null));
    $('focus')?.addEventListener('click', () => {
      if (!selected) return;
      following = true;
      controls.target.copy(selected.mesh.position);
      followOffset.set(selected.radius * 4, selected.radius * 2.5, selected.radius * 6);
      camera.position.copy(selected.mesh.position).add(followOffset);
      showToast(`Camera locked to ${selected.name}`);
    });

    // Tactical Cosmic Actions
    $('flare')?.addEventListener('click', triggerSolarFlare);
    $('supernova')?.addEventListener('click', triggerSupernova);
    $('blackhole')?.addEventListener('click', () => {
      if (!selected) return;
      selected.type = 'blackhole';
      selected.isBlackHole = true;
      selected.color = '#000000';
      selected.material.map = null;
      if (selected.material.color) selected.material.color.set('#000000');
      if (selected.material.emissive) selected.material.emissive.set('#000000');
      if (selected.outlineMesh) selected.outlineMesh.material.color.set('#444444');
      createRingsMesh(selected);
      selectBody(selected);
      showToast(`${selected.name} collapsed into a black hole`);
    });

    $('rings')?.addEventListener('click', () => {
      if (!selected) return;
      selected.ring = !selected.ring;
      if (selected.ring) createRingsMesh(selected);
      else if (selected.ringMesh) { scene.remove(selected.ringMesh); selected.ringMesh = null; }
      $('bodyHasRing').checked = selected.ring;
      showToast(`${selected.ring ? 'Rings generated on' : 'Rings removed from'} ${selected.name}`);
    });

    $('impact')?.addEventListener('click', () => {
      if (!selected) return;
      const t = selected;
      const off = t.radius * 3.5 / AU;
      createBody({
        name: 'Impactor',
        type: 'moon',
        mass: 0.05 / EARTHS_PER_SUN,
        radius: 0.12,
        color: '#78716c',
        p: [t.p[0] + off, t.p[1] + off * 0.2, t.p[2]],
        v: [t.v[0] - 12, t.v[1] - 3, t.v[2]]
      });
      showToast(`Hypervelocity impactor launched toward ${t.name}`);
    });

    $('remove')?.addEventListener('click', () => {
      if (selected) {
        const name = selected.name;
        destroyBody(selected);
        showToast(`${name} removed`);
      }
    });

    // Stabilize Orbit Button
    $('recalculateOrbitBtn')?.addEventListener('click', () => {
      if (!selected) {
        showToast("Select a body first to stabilize its orbit");
        return;
      }
      const parent = bodies.find(b => b.id === selected.parentId) || findDominantStar() || bodies[0];
      if (!parent || parent === selected) {
        showToast("No parent body found to orbit");
        return;
      }
      const dx = selected.p[0] - parent.p[0];
      const dz = selected.p[2] - parent.p[2];
      const distAU = Math.max(0.01, Math.hypot(dx, dz));
      const speed = Math.sqrt(G * (parent.mass + selected.mass) / distAU);
      const angle = Math.atan2(dz, dx);
      // Project into parent's orbital plane and apply pure circular tangential velocity
      selected.p[1] = parent.p[1];
      selected.v[0] = parent.v[0] - Math.sin(angle) * speed;
      selected.v[1] = parent.v[1];
      selected.v[2] = parent.v[2] + Math.cos(angle) * speed;
      selectBody(selected);
      SoundEngine.playChime(660);
      showToast(`Stabilized circular Keplerian orbit for ${selected.name} (${(speed * AU_YEAR_TO_KM_S).toFixed(1)} km/s)`);
    });

    // Display Toggles (Grid, Axes, Orbits, Trails, Velocity, Labels)
    $('showGrid')?.addEventListener('change', (e) => {
      gridHelper.visible = e.target.checked;
      showToast(gridHelper.visible ? "Orbital reference grid ON" : "Orbital grid OFF");
    });
    $('showAxes')?.addEventListener('change', (e) => {
      axesHelper.visible = e.target.checked;
      showToast(axesHelper.visible ? "Cartesian axes ON" : "Axes OFF");
    });
    $('showOrbits')?.addEventListener('change', (e) => {
      updateOrbitLines();
      showToast(e.target.checked ? "Keplerian orbit lines ON" : "Orbit lines OFF");
    });
    $('showTrails')?.addEventListener('change', (e) => {
      const show = e.target.checked;
      bodies.forEach(b => {
        if (b.trailLine) b.trailLine.visible = show;
      });
      showToast(show ? "Motion ribbon trails ON" : "Motion trails OFF");
    });
    $('showLabels')?.addEventListener('change', (e) => {
      showToast(e.target.checked ? "Planet telemetry labels ON" : "Planet labels OFF");
    });
    $('showVelocity')?.addEventListener('change', (e) => {
      showToast(e.target.checked ? "Velocity vectors ON" : "Velocity vectors OFF");
    });

    $('timeScale')?.addEventListener('input', (e) => {
      const days = parseFloat(e.target.value);
      if ($('timeScaleValue')) $('timeScaleValue').textContent = `${days.toFixed(1)} d/s`;
    });

    // Inspector Tabs
    ['Water', 'Bands', 'Atmo', 'Rings'].forEach(tab => {
      $(`tab${tab}Btn`)?.addEventListener('click', () => {
        ['Water', 'Bands', 'Atmo', 'Rings'].forEach(t => {
          $(`tab${t}Btn`).classList.toggle('active', t === tab);
          $(`tab${t}Content`).hidden = (t !== tab);
        });
      });
    });

    // Inspector Ring Scale
    $('bodyRingScale')?.addEventListener('input', (e) => {
      if (selected) {
        selected.ringScale = parseFloat(e.target.value);
        if ($('bodyRingScaleVal')) $('bodyRingScaleVal').textContent = `${selected.ringScale.toFixed(1)}× Planet`;
        if (selected.ring) createRingsMesh(selected);
      }
    });

    // Inspector Gas Bands Controls
    $('bandCount')?.addEventListener('input', (e) => {
      if ($('bandCountVal')) $('bandCountVal').textContent = e.target.value;
      if (selected && selected.type === 'gas') {
        selected.bandCount = parseInt(e.target.value);
        refreshBodyTexture(selected);
      }
    });
    $('bandTurbulence')?.addEventListener('input', (e) => {
      if ($('bandTurbulenceVal')) $('bandTurbulenceVal').textContent = `${e.target.value}%`;
      if (selected && selected.type === 'gas') {
        selected.bandTurbulence = parseInt(e.target.value);
        refreshBodyTexture(selected);
      }
    });
    $('bandPaletteSelect')?.addEventListener('change', (e) => {
      const palettes = {
        jupiter: ['#d7ad7d', '#c89d6d', '#e2cbb0'],
        saturn: ['#e2d5b8', '#d0bc90', '#bfa776'],
        neptune: ['#38bdf8', '#0284c7', '#1e40af'],
        crimson: ['#ef4444', '#991b1b', '#fca5a5'],
        alien: ['#a855f7', '#06b6d4', '#10b981']
      };
      const pal = palettes[e.target.value] || palettes.jupiter;
      if ($('bandColor1')) $('bandColor1').value = pal[0];
      if ($('bandColor2')) $('bandColor2').value = pal[1];
      if ($('bandColor3')) $('bandColor3').value = pal[2];
      if (selected && selected.type === 'gas') {
        selected.bandColors = pal;
        refreshBodyTexture(selected);
      }
    });
    ['bandColor1', 'bandColor2', 'bandColor3'].forEach((id, idx) => {
      $(id)?.addEventListener('input', (e) => {
        if (selected && selected.type === 'gas') {
          if (!selected.bandColors) selected.bandColors = ['#d7ad7d', '#c89d6d', '#e2cbb0'];
          selected.bandColors[idx] = e.target.value;
          refreshBodyTexture(selected);
        }
      });
    });
    $('showGreatStorm')?.addEventListener('change', (e) => {
      if (selected && selected.type === 'gas') {
        selected.showGreatStorm = e.target.checked;
        refreshBodyTexture(selected);
      }
    });
    $('stormColor')?.addEventListener('input', (e) => {
      if (selected && selected.type === 'gas') {
        selected.stormColor = e.target.value;
        refreshBodyTexture(selected);
      }
    });

    // Inspector Inputs Live Binding
    $('name')?.addEventListener('input', (e) => {
      if (selected) {
        selected.name = e.target.value;
        $('title').textContent = e.target.value;
        syncBodyLabels();
      }
    });
    $('mass')?.addEventListener('change', (e) => {
      if (selected) {
        selected.mass = Math.max(1e-9, parseFloat(e.target.value) / EARTHS_PER_SUN);
        selectBody(selected);
      }
    });
    $('radius')?.addEventListener('input', (e) => {
      if (selected) {
        selected.radius = parseFloat(e.target.value);
        selected.mesh.scale.setScalar(selected.radius);
        if (selected.atmosphere) selected.atmosphere.scale.setScalar(selected.radius * 1.035);
        if (selected.ringMesh) selected.ringMesh.scale.setScalar(selected.radius);
        $('radiusValue').textContent = `${selected.radius.toFixed(2)}×`;
      }
    });
    $('color')?.addEventListener('input', (e) => {
      if (selected) {
        selected.color = e.target.value;
        selected.material.color.set(e.target.value);
        $('bodyOrb').style.boxShadow = `0 0 20px ${selected.color}66`;
      }
    });
    $('tilt')?.addEventListener('input', (e) => {
      if (selected) {
        selected.tilt = parseFloat(e.target.value);
        if ($('tiltValue')) $('tiltValue').textContent = `${selected.tilt}°`;
        selected.mesh.rotation.z = T.MathUtils.degToRad(selected.tilt);
        if (selected.ringMesh) selected.ringMesh.rotation.z = T.MathUtils.degToRad(selected.tilt);
      }
    });
    $('dayLength')?.addEventListener('input', (e) => {
      if (selected) {
        selected.dayLength = parseFloat(e.target.value);
        if ($('dayValue')) $('dayValue').textContent = `${Math.round(selected.dayLength)} h`;
      }
    });
    $('gravity')?.addEventListener('input', (e) => {
      if (selected) {
        selected.gravity = parseFloat(e.target.value);
        selected.gravityScale = selected.gravity;
        if ($('gravityValue')) $('gravityValue').textContent = `${selected.gravity.toFixed(2)}×`;
        if ($('gravitySummary')) {
          $('gravitySummary').textContent = `${formatNumber(selected.gravity * (selected.mass * EARTHS_PER_SUN) / Math.max(0.01, selected.radius ** 2), 2)} g`;
        }
      }
    });
    $('magnetic')?.addEventListener('input', (e) => {
      if (selected) {
        selected.magnetic = parseFloat(e.target.value);
        selected.magneticScale = selected.magnetic;
        if ($('magneticValue')) $('magneticValue').textContent = `${selected.magnetic.toFixed(1)}× Earth`;
        if ($('bodyMagneticMeter')) $('bodyMagneticMeter').style.width = `${Math.min(100, (selected.magnetic / 2) * 100)}%`;
        if (selected.field) selected.field.visible = selected.magnetic > 0;
      }
    });
    $('atmo')?.addEventListener('input', (e) => {
      if (selected) {
        selected.atmo = parseFloat(e.target.value);
        selected.atmoPressure = selected.atmo;
        if ($('atmoValue')) $('atmoValue').textContent = `${selected.atmo.toFixed(2)} atm`;
        if ($('atmosphereSummary')) $('atmosphereSummary').textContent = `${selected.atmo.toFixed(2)} atm · ${selected.gasType}`;
        if (selected.atmosphere?.material?.uniforms?.strength) {
          selected.atmosphere.material.uniforms.strength.value = Math.min(1.5, selected.atmo * 0.35);
          selected.atmosphere.visible = selected.atmo > 0.05 && selected.type !== 'star' && !selected.isBlackHole;
        }
      }
    });
    $('atmoColor')?.addEventListener('input', (e) => {
      if (selected) {
        selected.atmoColor = e.target.value;
        if (selected.atmosphere?.material?.uniforms?.tint) {
          selected.atmosphere.material.uniforms.tint.value.set(selected.atmoColor);
        }
      }
    });
    $('gasTypeSelect')?.addEventListener('change', (e) => {
      if (selected) {
        selected.gasType = e.target.value;
        if ($('atmosphereSummary')) $('atmosphereSummary').textContent = `${selected.atmo.toFixed(2)} atm · ${selected.gasType}`;
      }
    });
    $('water')?.addEventListener('input', (e) => {
      if (selected) {
        selected.water = parseFloat(e.target.value);
        selected.waterCoverage = selected.water;
        $('waterValue').textContent = `${Math.round(selected.water)}%`;
        refreshBodyTexture(selected);
      }
    });
    $('ice')?.addEventListener('input', (e) => {
      if (selected) {
        selected.ice = parseFloat(e.target.value);
        selected.iceCapCoverage = selected.ice;
        if ($('iceValue')) $('iceValue').textContent = `${Math.round(selected.ice)}%`;
        refreshBodyTexture(selected);
      }
    });
    $('ocean')?.addEventListener('input', (e) => {
      if (selected) {
        selected.oceanColor = e.target.value;
        refreshBodyTexture(selected);
      }
    });
    $('land')?.addEventListener('input', (e) => {
      if (selected) {
        selected.landColor = e.target.value;
        refreshBodyTexture(selected);
      }
    });
    $('bodyHasRing')?.addEventListener('change', (e) => {
      if (selected) {
        selected.ring = e.target.checked;
        createRingsMesh(selected);
      }
    });
    $('bodyRingScale')?.addEventListener('input', (e) => {
      if (selected) {
        selected.ringScale = parseFloat(e.target.value);
        if ($('bodyRingScaleVal')) $('bodyRingScaleVal').textContent = `${selected.ringScale.toFixed(1)}× Planet`;
        if (selected.ring) createRingsMesh(selected);
      }
    });
    $('bodyRingColor')?.addEventListener('input', (e) => {
      if (selected) {
        selected.ringColor = e.target.value;
        if (selected.ring) createRingsMesh(selected);
      }
    });
    ['vx', 'vy', 'vz'].forEach((axis, idx) => {
      $(axis)?.addEventListener('change', (e) => {
        if (selected) {
          selected.v[idx] = parseFloat(e.target.value) || 0;
        }
      });
    });

    // New Planet Studio
    document.querySelectorAll('input[name="spawnType"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        document.querySelectorAll('.archetype-card').forEach(c => c.classList.toggle('active', c.contains(e.target)));
        $('starTypeBox').hidden = (e.target.value !== 'star');
        $('customPlanetStudioFields').hidden = (e.target.value !== 'customPlanet');
      });
    });

    $('launchCustomGas')?.addEventListener('change', (e) => {
      if ($('customGasBreakdown')) $('customGasBreakdown').hidden = (e.target.value !== 'customMix');
    });

    ['N2', 'O2', 'CO2', 'CH4'].forEach(gas => {
      $(`customGas${gas}`)?.addEventListener('input', (e) => {
        if ($(`customGas${gas}Val`)) $(`customGas${gas}Val`).textContent = `${e.target.value}%`;
      });
    });

    $('eccentricity')?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value) / 100;
      $('eccentricityValue').textContent = val === 0 ? "0.00 (Circle)" : `${val.toFixed(2)} (Elliptical)`;
    });

    // Spawn Planet Button in New Planet Studio
    $('placeCustom')?.addEventListener('click', () => {
      const parent = findDominantStar($('customTarget')?.value);
      const angle = Math.random() * Math.PI * 2;
      const dist = (parent ? Math.max(2.5, parent.radius * 2.8) : 8.0) + Math.random() * 3.5;
      const hit = placementRing.visible ? placementRing.position : new T.Vector3(
        (parent ? parent.mesh.position.x : 0) + Math.cos(angle) * dist,
        0,
        (parent ? parent.mesh.position.z : 0) + Math.sin(angle) * dist
      );
      spawnPlacedObject(hit);
      $('creator').hidden = true;
      climateZonesGroup.userData.hostId = null;
      updateHabitableZones3D();
    });

    // Raycasting & Click Placement
    const raycaster = new T.Raycaster();
    const mouse = new T.Vector2();
    const plane = new T.Plane(new T.Vector3(0, 1, 0), 0);

    window.addEventListener('pointermove', (e) => {
      mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);

      if (!$('creator').hidden) {
        const hit = new T.Vector3();
        if (raycaster.ray.intersectPlane(plane, hit)) {
          placementRing.visible = true;
          placementRing.position.copy(hit);

          // Update Life Guesser
          const star = findDominantStar(Number($('customTarget').value));
          const life = computeLifeLikelihood(star, hit.x / AU, hit.y / AU, hit.z / AU, {
            gasType: $('launchCustomGas')?.value || 'earthAir',
            atmoPressure: parseFloat($('launchCustomPressure')?.value || '1.0'),
            waterCoverage: parseFloat($('customWater')?.value || '55')
          });
          $('launcherLifeScore').textContent = `${life.score}%`;
          $('launcherLifeBar').style.width = `${life.score}%`;
          $('launcherLifeZone').textContent = life.zone;
          $('launcherLifeTemp').textContent = `${life.tempC} °C`;
          $('launcherLifeVerdict').textContent = life.verdict;
        }
      } else {
        placementRing.visible = false;
      }
    });

    let pointerDownPos = { x: 0, y: 0 };
    let isPointerDown = false;

    function handleBodySelectionClick(clickX, clickY) {
      mouse.x = (clickX / window.innerWidth) * 2 - 1;
      mouse.y = -(clickY / window.innerHeight) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);

      // 1. Direct 3D Mesh Raycasting
      const meshes = bodies.map(b => b.mesh).filter(Boolean);
      const intersects = raycaster.intersectObjects(meshes, false);
      if (intersects.length > 0) {
        const hitBody = intersects[0].object.userData.body;
        if (hitBody) {
          selectBody(hitBody);
          SoundEngine.playChime(640);
          return;
        }
      }

      // 2. High-Precision Screen-Space Proximity Snapping
      let bestBody = null;
      let bestScore = Infinity;
      const projV = new T.Vector3();
      const fovRad = (camera.fov * Math.PI) / 180;
      const projScale = window.innerHeight / (2 * Math.tan(fovRad / 2));

      for (const b of bodies) {
        projV.copy(b.mesh.position).project(camera);
        if (projV.z < 1.0) { // In front of camera
          const sx = (projV.x * 0.5 + 0.5) * window.innerWidth;
          const sy = (-(projV.y * 0.5) + 0.5) * window.innerHeight;
          const distPx = Math.hypot(clickX - sx, clickY - sy);

          const camDist = Math.max(0.1, camera.position.distanceTo(b.mesh.position));
          const screenRadPx = (b.radius / camDist) * projScale;
          const hitThresholdPx = Math.max(32, screenRadPx * 1.4);

          if (distPx <= hitThresholdPx) {
            const score = distPx / hitThresholdPx;
            if (score < bestScore) {
              bestScore = score;
              bestBody = b;
            }
          }
        }
      }

      if (bestBody) {
        selectBody(bestBody);
        SoundEngine.playChime(640);
        return;
      }

      // 3. Spawn Placement Click
      if (!$('creator').hidden) {
        const hit = new T.Vector3();
        if (raycaster.ray.intersectPlane(plane, hit)) {
          spawnPlacedObject(hit);
        } else {
          raycaster.ray.at(30, hit);
          hit.y = 0;
          spawnPlacedObject(hit);
        }
      }
    }

    window.addEventListener('pointerdown', (e) => {
      if (e.target.closest('#commandBar') || e.target.closest('#inspector') || e.target.closest('#creator') || e.target.closest('footer') || e.target.closest('.planet-label')) return;
      isPointerDown = true;
      pointerDownPos.x = e.clientX;
      pointerDownPos.y = e.clientY;
    });

    window.addEventListener('pointermove', (e) => {
      if (!isPointerDown) return;
      // When following a planet, dragging the pointer outside its area releases camera tracking
      if (following && selected) {
        const projV = new T.Vector3().copy(selected.mesh.position).project(camera);
        if (projV.z < 1.0) {
          const sx = (projV.x * 0.5 + 0.5) * window.innerWidth;
          const sy = (-(projV.y * 0.5) + 0.5) * window.innerHeight;
          const distFromPlanetPx = Math.hypot(e.clientX - sx, e.clientY - sy);
          const camDist = Math.max(0.1, camera.position.distanceTo(selected.mesh.position));
          const fovRad = (camera.fov * Math.PI) / 180;
          const projScale = window.innerHeight / (2 * Math.tan(fovRad / 2));
          const screenRadPx = (selected.radius / camDist) * projScale;
          const allowedAreaPx = Math.max(50, screenRadPx * 2.2);

          if (distFromPlanetPx > allowedAreaPx) {
            following = false;
            showToast(`Camera unlocked from ${selected.name}`);
          }
        }
      }
    });

    window.addEventListener('pointerup', (e) => {
      isPointerDown = false;
      if (e.target.closest('#commandBar') || e.target.closest('#inspector') || e.target.closest('#creator') || e.target.closest('footer') || e.target.closest('.planet-label')) return;

      const moveDist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
      if (moveDist <= 7) {
        handleBodySelectionClick(e.clientX, e.clientY);
      }
    });

    window.addEventListener('dblclick', (e) => {
      if (e.target.closest('#commandBar') || e.target.closest('#inspector') || e.target.closest('#creator') || e.target.closest('footer')) return;
      if (selected) {
        following = true;
        controls.target.copy(selected.mesh.position);
        followOffset.set(selected.radius * 3.5, selected.radius * 2, selected.radius * 5);
        camera.position.copy(selected.mesh.position).add(followOffset);
        showToast(`Camera focused on ${selected.name}`);
      }
    });

    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  function refreshBodyTexture(b) {
    if (b.type === 'star' || b.isBlackHole) return;
    if (b.textureMap) b.textureMap.dispose();
    b.textureMap = generateProceduralTexture(b);
    b.material.map = b.textureMap;
    b.material.needsUpdate = true;
  }

  function spawnPlacedObject(worldPos) {
    const parent = findDominantStar($('customTarget')?.value);
    const pWorld = [worldPos.x / AU, worldPos.y / AU, worldPos.z / AU];
    const spawnType = document.querySelector('input[name="spawnType"]:checked')?.value || 'planet';
    const ecc = parseFloat($('eccentricity')?.value || '0') / 100;
    const prograde = $('orbitDirection')?.value !== 'retrograde';

    let distAU = 1.0;
    let speed = 0;
    if (parent) {
      const dx = pWorld[0] - parent.p[0], dy = pWorld[1] - parent.p[1], dz = pWorld[2] - parent.p[2];
      distAU = Math.max(0.15, Math.hypot(dx, dy, dz));
      speed = Math.sqrt(G * (parent.mass + (1 / EARTHS_PER_SUN)) / distAU) * Math.sqrt(1 + ecc) * (prograde ? 1 : -1);
    }

    const angle = Math.atan2(pWorld[2] - (parent?.p[2] || 0), pWorld[0] - (parent?.p[0] || 0));
    const vx = (parent?.v[0] || 0) - Math.sin(angle) * speed;
    const vz = (parent?.v[2] || 0) + Math.cos(angle) * speed;

    let bodySpec = {
      name: spawnType === 'customPlanet' ? ($('customName')?.value || 'Custom World') : `Placed ${spawnType}`,
      type: spawnType === 'customPlanet' ? 'rock' : spawnType,
      mass: 1.0 / EARTHS_PER_SUN,
      radius: 0.38,
      color: '#38bdf8',
      p: pWorld,
      v: [vx, 0, vz],
      parentId: parent?.id || null,
      ring: Boolean($('customRings')?.checked)
    };

    if (spawnType === 'customPlanet') {
      bodySpec.color = $('customColor')?.value || '#38bdf8';
      bodySpec.oceanColor = $('customOcean')?.value || '#1d4ed8';
      bodySpec.landColor = $('customLand')?.value || '#15803d';
      bodySpec.atmoColor = $('customAtmo')?.value || '#8ad8ff';
      bodySpec.atmo = parseFloat($('launchCustomPressure')?.value || '1.0');
      bodySpec.water = parseFloat($('customWater')?.value || '55');
      bodySpec.gasType = $('launchCustomGas')?.value || 'earthAir';
      bodySpec.ring = Boolean($('customRings')?.checked);
    } else if (spawnType === 'moon') {
      bodySpec.mass = 0.012 / EARTHS_PER_SUN;
      bodySpec.radius = 0.20;
      bodySpec.color = '#94a3b8';
      bodySpec.isMoon = true;
      bodySpec.type = 'moon';
    } else if (spawnType === 'gasGiant') {
      bodySpec.mass = 120 / EARTHS_PER_SUN;
      bodySpec.radius = 0.88;
      bodySpec.color = '#d7ad7d';
      bodySpec.bandCount = parseInt($('bandCount')?.value || '10');
      bodySpec.bandColors = [$('bandColor1')?.value || '#d7ad7d', $('bandColor2')?.value || '#c89d6d', $('bandColor3')?.value || '#e2cbb0'];
      bodySpec.showGreatStorm = $('showGreatStorm')?.checked !== false;
      bodySpec.stormColor = $('stormColor')?.value || '#f43f5e';
      bodySpec.ring = Boolean($('customRings')?.checked);
    } else if (spawnType === 'star') {
      const sType = $('starType')?.value || 'yellowDwarf';
      bodySpec.mass = 1.0;
      bodySpec.radius = 1.4;
      bodySpec.color = '#fff0cb';
      bodySpec.temp = 5778;
      if (sType === 'redGiant') { bodySpec.radius = 2.6; bodySpec.color = '#f97316'; bodySpec.temp = 3600; bodySpec.mass = 1.8; }
      else if (sType === 'blueSupergiant') { bodySpec.radius = 2.2; bodySpec.color = '#60a5fa'; bodySpec.temp = 18000; bodySpec.mass = 8.0; }
      else if (sType === 'whiteDwarf') { bodySpec.radius = 0.5; bodySpec.color = '#e0f2fe'; bodySpec.temp = 25000; bodySpec.mass = 0.8; }
      else if (sType === 'neutronStar') { bodySpec.radius = 0.25; bodySpec.color = '#a855f7'; bodySpec.temp = 100000; bodySpec.mass = 1.4; }
    } else if (spawnType === 'hotPlanet') {
      bodySpec.color = '#ef4444';
      bodySpec.temp = 1550;
      bodySpec.isLavaWorld = true;
    }

    const b = createBody(bodySpec);

    SoundEngine.playChime(780);
    selectBody(b);
    showToast(`✦ ${b.name} placed into Keplerian orbit around ${parent?.name || 'Deep Space'}`);
  }

  function fitOverview() {
    following = false;
    controls.target.set(0, 0, 0);
    const extent = Math.max(15, ...bodies.map(b => Math.hypot(...b.p) * AU));
    camera.position.set(extent * 0.4, extent * 0.8, extent * 1.5);
  }

  // 14. MAIN ANIMATION & INTEGRATION LOOP
  const labelsOverlay = $('labelsOverlay');
  const bodyLabelMap = new Map();

  function syncBodyLabels() {
    if (!labelsOverlay) return;
    const showLabels = $('showLabels')?.checked ?? true;
    if (!showLabels) {
      bodyLabelMap.forEach(el => { el.style.display = 'none'; });
      return;
    }

    const tempV = new T.Vector3();
    const w = window.innerWidth;
    const h = window.innerHeight;

    // 1. Calculate camera distance to each body to determine closest body and proximity
    let nearestBody = null;
    let minCamDist = Infinity;
    const distMap = new Map();

    for (const b of bodies) {
      const d = camera.position.distanceTo(b.mesh.position);
      distMap.set(b.id, d);
      if (d < minCamDist) {
        minCamDist = d;
        nearestBody = b;
      }
    }

    for (const b of bodies) {
      let el = bodyLabelMap.get(b.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'planet-label';
        el.textContent = b.name;
        el.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          selectBody(b);
          SoundEngine.playChime(640);
        });
        labelsOverlay.appendChild(el);
        bodyLabelMap.set(b.id, el);
      }

      if (el.textContent !== b.name) el.textContent = b.name;
      el.classList.toggle('selected-label', b === selected);

      tempV.copy(b.mesh.position).project(camera);
      const inFront = tempV.z < 1.0 && tempV.x >= -1.1 && tempV.x <= 1.1 && tempV.y >= -1.1 && tempV.y <= 1.1;

      // Proximity condition:
      // Show label if:
      // 1. Planet is selected
      // 2. Planet is the nearest body to the camera
      // 3. Camera is within proximity neighborhood of the planet
      const dist = distMap.get(b.id) || Infinity;
      const proximityThreshold = Math.max(20, b.radius * AU * 3.2);
      const isClose = (b === selected) || (b === nearestBody) || (dist < proximityThreshold);

      if (inFront && isClose) {
        const x = (tempV.x * 0.5 + 0.5) * w;
        const y = (-(tempV.y * 0.5) + 0.5) * h;
        el.style.left = `${Math.round(x)}px`;
        el.style.top = `${Math.round(y)}px`;
        el.style.display = 'block';
      } else {
        el.style.display = 'none';
      }
    }

    // Clean up removed bodies
    const currentIds = new Set(bodies.map(b => b.id));
    for (const [id, el] of bodyLabelMap.entries()) {
      if (!currentIds.has(id)) {
        el.remove();
        bodyLabelMap.delete(id);
      }
    }
  }

  let lastTime = performance.now();
  function animate(now) {
    requestAnimationFrame(animate);
    const deltaSec = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    let requestedDt = 0;
    if (playing && bodies.length > 0) {
      const warpMult = parseFloat($('timeScale')?.value || '49');
      // Warp range: 0.001 to 2.5 years per second
      const dtPerSec = Math.pow(warpMult / 100, 2.5) * 2.5 + 0.001;
      requestedDt = deltaSec * dtPerSec;

      // Adaptive substeps for symplectic stability
      const substeps = clamp(Math.ceil(requestedDt / 0.005), 1, 30);
      const dt = requestedDt / substeps;

      for (let s = 0; s < substeps; s++) {
        step(bodies, dt);
        resolveCollisions();
      }
      simYears += requestedDt;

      // Dynamic Thermodynamic & Habitable Zone Biogenesis Loop
      const dominantStar = bodies.find(b => b.type === 'star') || bodies[0];
      if (dominantStar) {
        const hz = getHabitableZone(dominantStar);
        const lum = hz ? hz.lum : 1.0;
        const thermalRate = Math.min(1.0, 0.65 * requestedDt * 365.25);

        for (const b of bodies) {
          if (b === dominantStar || b.type === 'star' || b.isBlackHole) continue;
          const distAU = Math.max(0.01, Math.hypot(b.p[0] - dominantStar.p[0], b.p[1] - dominantStar.p[1], b.p[2] - dominantStar.p[2]));
          const targetTemp = Math.round(278 * Math.pow(lum, 0.25) / Math.sqrt(distAU));
          b.temp = (b.temp || 288) + (targetTemp - (b.temp || 288)) * thermalRate;

          // Habitability & cooling
          if (b.temp < 600) {
            b.isLavaWorld = false;
          }
          if (hz && distAU >= hz.innerAU && distAU <= hz.outerAU) {
            if (b.temp <= 320) {
              b.water = Math.min(71, (b.water || 0) + 20 * thermalRate);
              if (b.isLavaWorld || b.type === 'hotPlanet' || b.color === '#ff3b00') {
                b.isLavaWorld = false;
                b.type = 'rock';
                b.color = '#38bdf8';
                if (b.material.color) b.material.color.set('#38bdf8');
                if (b.material.emissive) b.material.emissive.set('#000000');
                if (!b.cooledNotified) {
                  b.cooledNotified = true;
                  showToast(`🌱 BIOGENESIS: ${b.name} cooled down in the Habitable Zone! Crust solidified and oceans formed!`);
                }
              }
            }
          }
        }
      }
    }

    // Visual Mesh Sync & Rotation
    const dominantStar = bodies.find(b => b.type === 'star');
    if (dominantStar) {
      sunlight.position.set(dominantStar.p[0] * AU, dominantStar.p[1] * AU, dominantStar.p[2] * AU);
    }

    for (const b of bodies) {
      b.mesh.position.set(b.p[0] * AU, b.p[1] * AU, b.p[2] * AU);
      if (playing) b.mesh.rotation.y += deltaSec * (24 / Math.max(0.1, b.dayLength)) * 1.2;

      if (b.atmosphere) b.atmosphere.position.copy(b.mesh.position);
      if (b.field) b.field.position.copy(b.mesh.position);
      if (b.glow) b.glow.position.copy(b.mesh.position);
      if (b.ringMesh) b.ringMesh.position.copy(b.mesh.position);
    }

    syncBodyLabels();

    // Motion Ribbon Trails Update (historical flight path)
    const showTrails = $('showTrails')?.checked ?? true;
    for (const b of bodies) {
      if (b.trailLine) {
        if (!showTrails || b.type === 'star') {
          b.trailLine.visible = false;
        } else {
          b.trailLine.visible = true;
          if (playing) {
            b.trailHistory.push(b.mesh.position.clone());
            if (b.trailHistory.length > 70) b.trailHistory.shift();
            b.trailLine.geometry.setFromPoints(b.trailHistory);
          }
        }
      }
    }

    // Asteroid Belt Rotation locked to simulation time (slows down or stops with sim!)
    if (playing) {
      asteroidBelt.rotation.y += requestedDt * 0.15;
    }

    // Effects Lifecycle
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      e.age += deltaSec;
      e.mesh.scale.setScalar(e.r * (1 + e.age * 3.5));
      e.mesh.material.opacity = Math.max(0, 0.9 - e.age * 0.45);
      if (e.age > 2.0) {
        scene.remove(e.mesh);
        e.mesh.geometry.dispose();
        e.mesh.material.dispose();
        effects.splice(i, 1);
      }
    }

    // Camera Tracking
    if (following && selected) {
      controls.target.lerp(selected.mesh.position, 0.12);
      camera.position.copy(selected.mesh.position).add(followOffset);
    }

    if (selected) {
      selectionReticle.position.copy(selected.mesh.position);
      selectionReticle.scale.setScalar(selected.radius * 1.35);
      reticleRing.material.color.set(selected.type === 'star' ? 0xf59e0b : 0x38bdf8);
      selectionReticle.visible = true;
    } else {
      selectionReticle.visible = false;
    }

    updateOrbitLines();
    updateHabitableZones3D();

    // Telemetry Update
    $('simulationTime').textContent = simYears < 1 ? `${(simYears * 365.25).toFixed(1)} days` : `${simYears.toFixed(2)} yrs`;
    $('bodyCount').textContent = bodies.length;
    $('zoomValue').textContent = `${Math.round(100 / (camera.position.length() / 60))}%`;

    controls.update();
    renderer.render(scene, camera);
  }

  // 15. INITIALIZATION
  bindEvents();
  loadPreset('solar');
  requestAnimationFrame(animate);

})();
