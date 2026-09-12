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

  // Lighting
  scene.add(new T.HemisphereLight(0xb8d7ff, 0x050a14, 0.45));
  const sunlight = new T.PointLight(0xfff4df, 60, 0, 0.9);
  scene.add(sunlight);

  // Groups
  const asteroidBelt = new T.Group(); asteroidBelt.name = 'Asteroid Belt'; scene.add(asteroidBelt);
  const orbitGuidesGroup = new T.Group(); orbitGuidesGroup.name = 'Orbit Guides'; scene.add(orbitGuidesGroup);
  const climateZonesGroup = new T.Group(); climateZonesGroup.name = 'Climate Zones'; scene.add(climateZonesGroup);
  const effects = [];

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

  // Rings & Geometry
  const sphereGeo = new T.SphereGeometry(1, 64, 40);
  const selectionRing = new T.Mesh(new T.RingGeometry(1.18, 1.25, 96), new T.MeshBasicMaterial({ color: 0x38bdf8, side: T.DoubleSide, transparent: true, opacity: 0.85 }));
  scene.add(selectionRing);

  const placementRing = new T.Mesh(new T.RingGeometry(1.2, 1.28, 96), new T.MeshBasicMaterial({ color: 0x34d399, side: T.DoubleSide, transparent: true, opacity: 0.9, blending: T.AdditiveBlending }));
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
    const c = document.createElement('canvas'); c.width = 512; c.height = 256;
    const x = c.getContext('2d');
    const r = rng(spec.id * 1013 + 37);

    if (spec.type === 'hotPlanet' || spec.isLavaWorld) {
      // Hot Volcanic Molten Lava World
      x.fillStyle = '#1c1917'; x.fillRect(0, 0, 512, 256);
      x.lineWidth = 3;
      for (let i = 0; i < 40; i++) {
        x.strokeStyle = r() > 0.5 ? '#dc2626' : '#f97316';
        x.beginPath();
        let px = r() * 512, py = r() * 256;
        x.moveTo(px, py);
        for (let seg = 0; seg < 6; seg++) {
          px += (r() - 0.5) * 60; py += (r() - 0.5) * 40;
          x.lineTo(px, py);
        }
        x.stroke();
      }
      for (let i = 0; i < 60; i++) {
        x.fillStyle = r() > 0.4 ? '#fef08a' : '#f97316';
        x.beginPath(); x.arc(r() * 512, r() * 256, r() * 12 + 2, 0, Math.PI * 2); x.fill();
      }
    } else if (spec.type === 'gas' || spec.type === 'gasGiant') {
      // Banded Gas Giant
      const count = spec.bandCount || 10;
      const palette = spec.bandColors || ['#d7ad7d', '#c89d6d', '#e2cbb0', '#9c7b58'];
      for (let y = 0; y < 256; y++) {
        const idx = Math.floor((y / 256) * count) % palette.length;
        x.fillStyle = palette[idx];
        x.fillRect(0, y, 512, 1);
      }
      // Great Storm
      if (spec.showGreatStorm !== false) {
        x.fillStyle = spec.stormColor || '#f43f5e';
        x.beginPath(); x.ellipse(280, 150, 42, 22, 0.1, 0, Math.PI * 2); x.fill();
      }
    } else {
      // Terrestrial Rocky World with Water & Continents
      const water = spec.waterCoverage ?? spec.water ?? 65;
      x.fillStyle = water > 0 ? (spec.oceanColor || '#1d4ed8') : (spec.color || '#8b8c86');
      x.fillRect(0, 0, 512, 256);

      const landShare = 1 - water / 100;
      x.fillStyle = spec.landColor || '#15803d';
      for (let i = 0; i < 140 * landShare; i++) {
        const px = r() * 512, py = 25 + r() * 206, w = 10 + r() * 45, h = 5 + r() * 22;
        x.beginPath(); x.ellipse(px, py, w, h, r() * 3, 0, Math.PI * 2); x.fill();
      }
      const ice = spec.iceCapCoverage ?? spec.ice ?? 12;
      if (ice > 0) {
        x.fillStyle = '#f8fafc';
        const h = Math.max(3, ice * 0.5);
        x.fillRect(0, 0, 512, h);
        x.fillRect(0, 256 - h, 512, h);
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

    // Material
    const isStar = b.type === 'star';
    const isHole = b.isBlackHole;
    b.textureMap = (isStar || isHole) ? null : generateProceduralTexture(b);

    b.material = new T.MeshStandardMaterial({
      map: b.textureMap,
      color: (isStar || isHole) ? '#000000' : (b.textureMap ? '#ffffff' : b.color),
      roughness: isStar ? 0.2 : 0.82,
      metalness: 0
    });

    if (isStar) {
      b.material.emissive = new T.Color(b.color);
      b.material.emissiveIntensity = 2.8;
    }

    b.mesh = new T.Mesh(sphereGeo, b.material);
    b.mesh.userData.body = b;
    b.mesh.scale.setScalar(b.radius);
    b.mesh.rotation.z = T.MathUtils.degToRad(b.tilt);
    scene.add(b.mesh);

    // Atmosphere Mesh
    b.atmosphere = new T.Mesh(sphereGeo, new T.ShaderMaterial({
      transparent: true,
      side: T.BackSide,
      depthWrite: false,
      uniforms: {
        tint: { value: new T.Color(b.atmoColor) },
        strength: { value: Math.min(1.4, b.atmo * 0.35) }
      },
      vertexShader: `
        varying vec3 n; varying vec3 v;
        void main() {
          vec4 p = modelViewMatrix * vec4(position, 1.0);
          n = normalize(normalMatrix * normal);
          v = normalize(-p.xyz);
          gl_Position = projectionMatrix * p;
        }
      `,
      fragmentShader: `
        uniform vec3 tint; uniform float strength;
        varying vec3 n; varying vec3 v;
        void main() {
          float rim = pow(1.0 - abs(dot(normalize(n), normalize(v))), 2.8);
          gl_FragColor = vec4(tint, rim * strength);
        }
      `
    }));
    b.atmosphere.scale.setScalar(b.radius * 1.05);
    b.atmosphere.visible = !isStar && !isHole && b.atmo > 0;
    scene.add(b.atmosphere);

    // Magnetosphere Loops
    b.field = new T.Group();
    for (let q = 0; q < 3; q++) {
      const loop = new T.Mesh(
        new T.TorusGeometry(1.3 + q * 0.25, 0.008, 8, 72),
        new T.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.2 - q * 0.04, blending: T.AdditiveBlending, depthWrite: false })
      );
      loop.rotation.set(Math.PI / 2, q * 0.42, q * 0.63);
      b.field.add(loop);
    }
    b.field.scale.setScalar(b.radius * 1.2);
    b.field.visible = b.magnetic > 0;
    scene.add(b.field);

    // Stellar Glow or Black Hole Rings
    if (isStar) {
      b.glow = new T.Sprite(new T.SpriteMaterial({ map: starGlowMap, color: b.color, blending: T.AdditiveBlending, transparent: true, depthWrite: false }));
      b.glow.scale.setScalar(b.radius * 9.5);
      scene.add(b.glow);
    }

    if (b.ring || isHole) {
      createRingsMesh(b);
    }

    // Orbit Guide LineLoop
    b.orbitLine = new T.LineLoop(
      new T.BufferGeometry(),
      new T.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.4, blending: T.AdditiveBlending, depthWrite: false })
    );
    b.orbitLine.visible = false;
    orbitGuidesGroup.add(b.orbitLine);

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
    for (const key of ['mesh', 'atmosphere', 'glow', 'ringMesh', 'field']) {
      if (b[key]) scene.remove(b[key]);
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

    bodies = bodies.filter(x => x !== b);
    bodies.forEach(x => { if (x.parentId === b.id) x.parentId = null; });

    if (selected === b) selectBody(null);
    updateTargetSelectors();
  }

  function clearAllBodies() {
    for (const b of [...bodies]) destroyBody(b);
    bodies = [];
    selected = null;
    following = false;
    simYears = 0;
    selectBody(null);
    showToast("Universe cleared • Add objects or select a preset");
  }

  // 6. ASTROBIOLOGY & LIFE LIKELIHOOD GUESSER
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
    if (invA <= 1e-6) return null; // Escape trajectory
    const a = 1 / invA;

    // Eccentricity vector e = (v x h)/mu - r/|r|
    const vxh_x = (vy * hz - vz * hy) / mu;
    const vxh_y = (vz * hx - vx * hz) / mu;
    const vxh_z = (vx * hy - vy * hx) / mu;
    const ex = vxh_x - rx / r;
    const ey = vxh_y - ry / r;
    const ez = vxh_z - rz / r;
    const e = Math.hypot(ex, ey, ez);
    if (e >= 0.98) return null;

    const b = a * Math.sqrt(Math.max(0, 1 - e * e));

    // Perifocal basis vectors
    let px, py, pz;
    if (e > 1e-5) {
      px = ex / e; py = ey / e; pz = ez / e;
    } else {
      px = rx / r; py = ry / r; pz = rz / r;
    }
    const wx = hx / h, wy = hy / h, wz = hz / h;
    const qx = wy * pz - wz * py;
    const qy = wz * px - wx * pz;
    const qz = wx * py - wy * px;

    const points = [];
    for (let i = 0; i < segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const xRel = a * (cosT - e) * px + b * sinT * qx;
      const yRel = a * (cosT - e) * py + b * sinT * qy;
      const zRel = a * (cosT - e) * pz + b * sinT * qz;
      points.push(new T.Vector3(
        (parent.p[0] + xRel) * AU,
        (parent.p[1] + yRel) * AU,
        (parent.p[2] + zRel) * AU
      ));
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

      const points = computeKeplerPoints(body, parent);
      if (!points || points.length === 0) {
        body.orbitLine.visible = false;
        continue;
      }

      body.orbitLine.geometry.setFromPoints(points);
      const isHighlighted = body === selected || parent === selected;
      body.orbitLine.material.color.set(isHighlighted ? 0x38bdf8 : (body.isMoon ? 0x64748b : 0x0284c7));
      body.orbitLine.material.opacity = isHighlighted ? 0.9 : (body.isMoon ? 0.35 : 0.55);
      body.orbitLine.visible = true;
    }
  }

  // 8. ORBIT PLACEMENT PREVIEW & CLICK-TO-SPAWN
  function findDominantStar(targetId = null) {
    if (targetId) {
      const b = bodies.find(x => x.id === targetId);
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
      // Solar System with complete moon systems and realistic scaled visual clearance
      const sun = createBody({ name: 'Sun', type: 'star', scienceType: 'star', mass: 1.0, radius: 1.6, color: '#fff0cb', temp: 5778, atmo: 0, magnetic: 1.0 });

      const planetsData = [
        { name: 'Mercury', dist: 0.39, mass: 0.055, radius: 0.20, color: '#9e9389', type: 'rock', atmo: 0, temp: 440, inc: 0.12 },
        { name: 'Venus', dist: 0.72, mass: 0.815, radius: 0.34, color: '#d7c6a5', type: 'rock', atmo: 92, atmoColor: '#fcd34d', gasType: 'carbonDioxide', temp: 737, inc: 0.05 },
        { name: 'Earth', dist: 1.00, mass: 1.000, radius: 0.36, color: '#4f9cff', type: 'rock', atmo: 1.0, atmoColor: '#76bfff', gasType: 'earthAir', water: 71, ice: 15, temp: 288, inc: 0.02 },
        { name: 'Mars', dist: 1.52, mass: 0.107, radius: 0.26, color: '#b87453', type: 'rock', atmo: 0.01, atmoColor: '#f87171', water: 2, ice: 20, temp: 210, inc: 0.03 },
        { name: 'Jupiter', dist: 5.20, mass: 317.8, radius: 0.94, color: '#c8b399', type: 'gas', atmo: 3.0, bandCount: 12, bandColors: ['#d7ad7d', '#c89d6d', '#e2cbb0', '#9c7b58'], temp: 165, inc: 0.02 },
        { name: 'Saturn', dist: 9.58, mass: 95.2, radius: 0.80, color: '#d3c39b', type: 'gas', atmo: 2.5, ring: true, ringScale: 2.4, ringColor: '#c7b997', temp: 134, inc: 0.04 },
        { name: 'Uranus', dist: 19.20, mass: 14.5, radius: 0.60, color: '#98cbd0', type: 'gas', atmo: 2.0, ring: true, ringScale: 1.9, ringColor: '#93c5fd', tilt: 98, temp: 76, inc: 0.01 },
        { name: 'Neptune', dist: 30.05, mass: 17.1, radius: 0.58, color: '#739cc4', type: 'gas', atmo: 2.0, ring: true, ringScale: 1.7, temp: 72, inc: 0.03 }
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
        const addMoon = (parent, name, massE, rad, distAU, angle, inc = 0.04) => {
          spawnOrbiter(parent, {
            name,
            type: 'moon',
            mass: massE / EARTHS_PER_SUN,
            radius: rad,
            color: '#c2c0b6',
            atmo: 0,
            water: 2,
            ice: 15,
            magnetic: 0.02,
            gravityScale: 6.5,
            isMoon: true
          }, distAU, angle, inc);
        };

        addMoon(pMap['Earth'], 'Moon', 0.0123, 0.10, 0.085, 0.4);
        addMoon(pMap['Mars'], 'Phobos', 1.8e-9, 0.05, 0.055, 1.2);
        addMoon(pMap['Mars'], 'Deimos', 2.5e-10, 0.04, 0.078, 3.8);
        addMoon(pMap['Jupiter'], 'Io', 0.015, 0.07, 0.15, 0.6);
        addMoon(pMap['Jupiter'], 'Europa', 0.008, 0.065, 0.21, 1.7);
        addMoon(pMap['Jupiter'], 'Ganymede', 0.025, 0.085, 0.29, 2.9);
        addMoon(pMap['Jupiter'], 'Callisto', 0.018, 0.08, 0.38, 4.3);
        addMoon(pMap['Saturn'], 'Titan', 0.0225, 0.085, 0.28, 1.4);
        addMoon(pMap['Uranus'], 'Titania', 0.0006, 0.055, 0.18, 2.1);
        addMoon(pMap['Neptune'], 'Triton', 0.0036, 0.065, 0.18, 4.2);
      }

      buildAsteroidBelt();
      selectBody(pMap['Earth']);
      camera.position.set(26, 32, 65);
      controls.target.set(0, 0, 0);
      showToast("Solar System preset loaded • 8 Planets & Major Moons");

    } else if (presetKey === 'earthMoon') {
      const earth = createBody({ name: 'Earth', type: 'rock', mass: 1.0 / EARTHS_PER_SUN, radius: 1.2, color: '#4f9cff', atmo: 1.0, water: 71, ice: 15, temp: 288 });
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
        const colDist = (a.radius + b.radius) / AU * 0.55;

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
    for (let i = 0; i < 220; i++) {
      const v = new T.Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize().multiplyScalar(0.8 + r() * 1.2);
      verts.push(v.x, v.y, v.z);
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(verts, 3));
    const cloud = new T.Points(geo, new T.PointsMaterial({ color: 0xffa33a, size: 0.12, transparent: true, opacity: 0.95, blending: T.AdditiveBlending, depthWrite: false }));
    cloud.position.copy(star.mesh.position);
    scene.add(cloud);
    effects.push({ mesh: cloud, age: 0, r: star.radius * 1.5 });

    // Auroras and heating on surrounding worlds
    for (const b of bodies) {
      if (b === star) continue;
      const d = Math.max(0.1, Math.hypot(b.p[0] - star.p[0], b.p[1] - star.p[1], b.p[2] - star.p[2]));
      b.temp += Math.min(800, 120 / d);
      if (b.magnetic <= 0 && b.atmo > 0) b.atmo = Math.max(0, b.atmo - 0.05 / d); // Atmospheric stripping
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
    star.material.color.set('#000000');
    star.material.emissive.set('#000000');
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
      selectionRing.visible = false;
      return;
    }

    inspector.hidden = false;
    selectionRing.visible = true;
    selectionRing.position.copy(b.mesh.position);

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
    $('bodyRingColor').value = b.ringColor || '#d7bd7d';

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
    sel.innerHTML = '';
    for (const b of bodies) {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = `${b.name} (${b.type})`;
      sel.appendChild(opt);
    }
    if (cur && bodies.some(b => String(b.id) === cur)) sel.value = cur;
    else if (selected) sel.value = selected.id;
  }

  function showToast(msg) {
    const el = $('message');
    if (!el) return;
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el.fadeTimer);
    el.fadeTimer = setTimeout(() => { el.style.opacity = '0'; }, 4000);
  }

  // 13. EVENT WIRING & INTERACTION
  function bindEvents() {
    // Top Bar
    $('loadPreset')?.addEventListener('click', () => loadPreset($('presetSelect').value));
    $('presetSelect')?.addEventListener('change', () => loadPreset($('presetSelect').value));
    $('newPlanetTop')?.addEventListener('click', () => { $('creator').hidden = !$('creator').hidden; });
    $('toggleMoonsBtn')?.addEventListener('click', () => toggleMoons());
    $('audioToggleBtn')?.addEventListener('click', () => {
      const muted = SoundEngine.toggleMute();
      $('audioToggleBtn').textContent = muted ? '🔇' : '🔊';
    });

    $('zoomInBtn')?.addEventListener('click', () => { camera.position.multiplyScalar(0.8); });
    $('zoomOutBtn')?.addEventListener('click', () => { camera.position.multiplyScalar(1.25); });
    $('fitViewTopBtn')?.addEventListener('click', fitOverview);
    $('fitView')?.addEventListener('click', fitOverview);

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

    // Inspector
    $('closeInspector')?.addEventListener('click', () => selectBody(null));
    $('focus')?.addEventListener('click', () => {
      if (!selected) return;
      following = true;
      controls.target.copy(selected.mesh.position);
      followOffset.set(selected.radius * 4, selected.radius * 2.5, selected.radius * 6);
      camera.position.copy(selected.mesh.position).add(followOffset);
      showToast(`Camera locked to ${selected.name}`);
    });

    $('flare')?.addEventListener('click', triggerSolarFlare);
    $('supernova')?.addEventListener('click', triggerSupernova);
    $('blackhole')?.addEventListener('click', () => {
      if (!selected) return;
      selected.type = 'blackhole';
      selected.isBlackHole = true;
      selected.color = '#000000';
      selected.material.map = null;
      selected.material.color.set('#000000');
      selected.material.emissive.set('#000000');
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

    // Inspector Tabs
    ['Water', 'Bands', 'Atmo', 'Rings'].forEach(tab => {
      $(`tab${tab}Btn`)?.addEventListener('click', () => {
        ['Water', 'Bands', 'Atmo', 'Rings'].forEach(t => {
          $(`tab${t}Btn`).classList.toggle('active', t === tab);
          $(`tab${t}Content`).hidden = (t !== tab);
        });
      });
    });

    // Inspector Inputs Live Binding
    $('name')?.addEventListener('input', (e) => { if (selected) { selected.name = e.target.value; $('title').textContent = e.target.value; } });
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
    $('water')?.addEventListener('input', (e) => {
      if (selected) {
        selected.water = parseFloat(e.target.value);
        $('waterValue').textContent = `${Math.round(selected.water)}%`;
        refreshBodyTexture(selected);
      }
    });

    // New Planet Studio
    $('closeCreator')?.addEventListener('click', () => { $('creator').hidden = true; });
    document.querySelectorAll('input[name="spawnType"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        document.querySelectorAll('.archetype-card').forEach(c => c.classList.toggle('active', c.contains(e.target)));
        $('starTypeBox').hidden = (e.target.value !== 'star');
        $('customPlanetStudioFields').hidden = (e.target.value !== 'customPlanet');
      });
    });

    $('eccentricity')?.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value) / 100;
      $('eccentricityValue').textContent = val === 0 ? "0.00 (Circle)" : `${val.toFixed(2)} (Elliptical)`;
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

    window.addEventListener('pointerdown', (e) => {
      if (e.target.closest('#commandBar') || e.target.closest('#inspector') || e.target.closest('#creator') || e.target.closest('footer')) return;

      mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);

      // Check Body Click Selection
      const intersects = raycaster.intersectObjects(bodies.map(b => b.mesh));
      if (intersects.length > 0) {
        const hitBody = intersects[0].object.userData.body;
        selectBody(hitBody);
        SoundEngine.playChime(640);
        return;
      }

      // Check Spawn Placement
      if (!$('creator').hidden) {
        const hit = new T.Vector3();
        if (raycaster.ray.intersectPlane(plane, hit)) {
          spawnPlacedObject(hit);
        }
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
    const parent = findDominantStar(Number($('customTarget')?.value));
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

    const b = createBody({
      name: spawnType === 'customPlanet' ? ($('customName')?.value || 'Custom World') : `Placed ${spawnType}`,
      type: spawnType,
      mass: (spawnType === 'star' ? 1.0 : spawnType === 'gasGiant' ? 100 : 1.0) / EARTHS_PER_SUN,
      radius: spawnType === 'star' ? 1.4 : spawnType === 'gasGiant' ? 0.85 : 0.38,
      color: spawnType === 'hotPlanet' ? '#ef4444' : '#38bdf8',
      p: pWorld,
      v: [vx, 0, vz],
      parentId: parent?.id || null,
      ring: $('customRings')?.checked || false
    });

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
  let lastTime = performance.now();
  function animate(now) {
    requestAnimationFrame(animate);
    const deltaSec = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    if (playing && bodies.length > 0) {
      const warpMult = parseFloat($('timeScale')?.value || '49');
      // Warp range: 0.001 to 2.5 years per second
      const dtPerSec = Math.pow(warpMult / 100, 2.5) * 2.5 + 0.001;
      const requestedDt = deltaSec * dtPerSec;

      // Adaptive substeps for symplectic stability
      const substeps = clamp(Math.ceil(requestedDt / 0.005), 1, 30);
      const dt = requestedDt / substeps;

      for (let s = 0; s < substeps; s++) {
        step(bodies, dt);
        resolveCollisions();
      }
      simYears += requestedDt;
    }

    // Visual Mesh Sync & Rotation
    for (const b of bodies) {
      b.mesh.position.set(b.p[0] * AU, b.p[1] * AU, b.p[2] * AU);
      if (playing) b.mesh.rotation.y += deltaSec * (24 / Math.max(1, b.dayLength)) * 0.1;

      if (b.atmosphere) b.atmosphere.position.copy(b.mesh.position);
      if (b.field) b.field.position.copy(b.mesh.position);
      if (b.glow) b.glow.position.copy(b.mesh.position);
      if (b.ringMesh) b.ringMesh.position.copy(b.mesh.position);
    }

    // Asteroid Belt Slow Rotation
    asteroidBelt.rotation.y += deltaSec * 0.004;

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
      selectionRing.position.copy(selected.mesh.position);
      selectionRing.quaternion.copy(camera.quaternion);
      selectionRing.scale.setScalar(selected.radius * 1.15);
    }

    updateOrbitLines();

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
