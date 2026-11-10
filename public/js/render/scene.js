// three.js scene: real-terrain mesh with a custom snow/rock/forest shader, sky, sun, fog, weather
// particles and an RTS-style camera.

import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { clamp, smoothstep } from '../util.js';
import { sunPosition } from '../weather.js';
import { valueNoise } from '../biome.js';

const TERRAIN_VS = /* glsl */`
  attribute float aForest;
  attribute float aNoise;
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying float vForest;
  varying float vNoise;
  varying float vFogDepth;
  void main() {
    vNormal = normal;
    vForest = aForest;
    vNoise = aNoise;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vec4 mv = viewMatrix * wp;
    vFogDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const TERRAIN_FS = /* glsl */`
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform vec3 uGroundColor;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uSnowline;
  uniform float uSnowAmount;
  uniform vec3 uRockColor;
  uniform float uSummer;
  uniform int uOverlay;
  uniform float uContours;
  uniform float uMinH;
  uniform float uMaxH;
  uniform float uTreeline;
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying float vForest;
  varying float vNoise;
  varying float vFogDepth;

  void main() {
    vec3 n = normalize(vNormal);
    float h = vWorld.y;
    float steep = 1.0 - n.y;               // 0 flat .. 1 vertical
    float rock = smoothstep(0.13, 0.27, steep + (vNoise - 0.5) * 0.08);
    vec3 meadowW = mix(vec3(0.33, 0.31, 0.21), vec3(0.27, 0.30, 0.18), vNoise);
    vec3 meadowS = mix(vec3(0.30, 0.44, 0.17), vec3(0.36, 0.48, 0.20), vNoise);
    vec3 meadow = mix(meadowW, meadowS, uSummer);
    vec3 forest = mix(vec3(0.07, 0.13, 0.08), vec3(0.08, 0.19, 0.09), uSummer);
    vec3 base = mix(meadow, forest, smoothstep(0.25, 0.7, vForest));
    vec3 rockC = uRockColor * (0.85 + vNoise * 0.3);
    base = mix(base, rockC, rock);
    // high bare ground above the treeline
    base = mix(base, mix(vec3(0.42, 0.40, 0.35), rockC, 0.5), smoothstep(0.0, 1.0, (1.0 - vForest) * smoothstep(0.06, 0.16, steep)) * 0.6 * smoothstep(uTreeline - 150.0, uTreeline + 250.0, h + (vNoise - 0.5) * 200.0));
    // snow cover
    float sl = uSnowline + (vNoise - 0.5) * 260.0;
    float cover = smoothstep(sl - 90.0, sl + 160.0, h) * uSnowAmount;
    cover *= 1.0 - smoothstep(0.22, 0.38, steep);
    float onForest = mix(1.0, 0.45, smoothstep(0.3, 0.8, vForest));
    vec3 snowC = vec3(0.93, 0.95, 0.99);
    vec3 col = mix(base, snowC, cover * onForest);
    // overlays
    if (uOverlay == 1) {
      float g = tan(acos(clamp(n.y, 0.0, 1.0)));
      vec3 oc = g < 0.14 ? vec3(0.18,0.68,0.31) : g < 0.27 ? vec3(0.16,0.44,0.86) : g < 0.42 ? vec3(0.84,0.2,0.18) : g < 0.75 ? vec3(0.08,0.08,0.1) : g < 1.0 ? vec3(0.55,0.1,0.55) : vec3(0.95,0.85,0.2);
      col = mix(col, oc, 0.55);
    } else if (uOverlay == 2) {
      float t = clamp((h - uMinH) / max(1.0, uMaxH - uMinH), 0.0, 1.0);
      vec3 oc = mix(mix(vec3(0.1,0.45,0.25), vec3(0.85,0.75,0.35), smoothstep(0.0,0.5,t)), vec3(0.95,0.95,1.0), smoothstep(0.5,1.0,t));
      col = mix(col, oc, 0.6);
    } else if (uOverlay == 3) {
      float deg = degrees(acos(clamp(n.y, 0.0, 1.0)));
      float a = smoothstep(27.0, 32.0, deg) * (1.0 - smoothstep(48.0, 55.0, deg));
      col = mix(col, vec3(0.95, 0.25, 0.1), a * 0.65 * smoothstep(sl - 200.0, sl + 100.0, h));
    }
    // lighting
    float diff = max(dot(n, uSunDir), 0.0);
    float hemi = n.y * 0.5 + 0.5;
    vec3 amb = mix(uGroundColor, uSkyColor, hemi);
    vec3 lit = col * (amb * 0.42 + uSunColor * diff * 1.05);
    // snow sparkle / specular
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 H = normalize(uSunDir + V);
    lit += uSunColor * pow(max(dot(n, H), 0.0), 60.0) * 0.12 * cover;
    // contour lines every 100 m
    if (uContours > 0.0) {
      float c = abs(fract(h / 100.0 + 0.5) - 0.5) / fwidth(h / 100.0);
      float line = 1.0 - smoothstep(0.0, 1.2, c);
      float major = abs(fract(h / 500.0 + 0.5) - 0.5) / fwidth(h / 500.0);
      line = max(line * 0.5, (1.0 - smoothstep(0.0, 1.4, major)) * 0.9);
      lit = mix(lit, lit * 0.55, line * uContours);
    }
    float fog = smoothstep(uFogNear, uFogFar, vFogDepth);
    gl_FragColor = vec4(mix(lit, uFogColor, fog), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const SKY_VS = `varying vec3 vDir; void main(){ vDir = normalize((modelMatrix * vec4(position,1.0)).xyz - cameraPosition); gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w; }`;
const SKY_FS = `uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform vec3 uSunColor; uniform float uStars; varying vec3 vDir;
  float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
  void main(){ vec3 d = normalize(vDir); float t = clamp(d.y, 0.0, 1.0);
    vec3 c = mix(uHorizon, uTop, pow(t, 0.55));
    float s = max(dot(d, uSunDir), 0.0);
    c += uSunColor * (pow(s, 600.0) * 3.0 + pow(s, 12.0) * 0.25);
    if (uStars > 0.0 && d.y > 0.0) { vec3 q = floor(d * 400.0); float st = step(0.9975, hash(q)); c += vec3(st) * uStars * t; }
    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
  }`;

export class Scene3D {
  constructor(container, terrain, biome, opts = {}) {
    this.container = container;
    this.terrain = terrain;
    this.biome = biome;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: false, preserveDrawingBuffer: !!opts.preserve });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.pixelRatio || 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.98;
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 8, 160000);
    this.controls = new MapControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = false;
    this.controls.maxPolarAngle = 1.42;
    this.controls.minDistance = 120;
    this.controls.maxDistance = Math.max(terrain.width, terrain.depth) * 1.6;
    this.controls.zoomSpeed = 1.4;
    this.controls.zoomToCursor = true;
    this.sunDir = new THREE.Vector3(0.4, 0.7, 0.3).normalize();
    this.overlay = 0;
    this.contours = 0;
    this.keys = {};
    this.lat = terrain.def.lat;
    this._buildSky();
    this._buildTerrain(opts.rockColor);
    this._buildParticles();
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.hemi = new THREE.HemisphereLight(0xcfe6ff, 0x5d5a52, 1.1);
    this.scene.add(this.sun, this.hemi);
    this.scene.fog = new THREE.Fog(0xcfe0ee, 20000, 90000);
    this._winListeners = {
      resize: () => this.resize(),
      keydown: e => { if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) this.keys[e.code] = true; },
      keyup: e => { this.keys[e.code] = false; },
      blur: () => { this.keys = {}; },
    };
    for (const [ev, fn] of Object.entries(this._winListeners)) window.addEventListener(ev, fn);
    this.flight = null;
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _buildSky() {
    this.skyUniforms = {
      uTop: { value: new THREE.Color(0x3a78c8) }, uHorizon: { value: new THREE.Color(0xcfe3f5) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color(0xffffff) }, uStars: { value: 0 },
    };
    const sky = new THREE.Mesh(new THREE.SphereGeometry(140000, 32, 16), new THREE.ShaderMaterial({ uniforms: this.skyUniforms, vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, fog: false }));
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    this.sky = sky;
    this.scene.add(sky);
  }

  _buildTerrain(rockColor) {
    const T = this.terrain;
    const step = Math.max(1, Math.ceil(Math.max(T.nx, T.nz) / 520));
    T.meshStep = step;
    const nx = Math.floor((T.nx - 1) / step) + 1, nz = Math.floor((T.nz - 1) / step) + 1;
    const pos = new Float32Array(nx * nz * 3), nor = new Float32Array(nx * nz * 3), forest = new Float32Array(nx * nz), noise = new Float32Array(nx * nz);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = T.x0 + i * step * T.cell, z = T.z0 + j * step * T.cell;
      const y = T.h[(j * step) * T.nx + i * step];
      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      const g = T.gradientAt(x, z);
      const nl = Math.hypot(g.dx, 1, g.dz);
      nor[k * 3] = -g.dx / nl; nor[k * 3 + 1] = 1 / nl; nor[k * 3 + 2] = -g.dz / nl;
      forest[k] = this.biome ? this.biome.forest(x, z) : 0;
      noise[k] = valueNoise(x, z, 180, 5) * 0.6 + valueNoise(x, z, 45, 11) * 0.4;
    }
    const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
    let p = 0;
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[p++] = a; idx[p++] = c; idx[p++] = b; idx[p++] = b; idx[p++] = c; idx[p++] = d;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('aForest', new THREE.BufferAttribute(forest, 1));
    geo.setAttribute('aNoise', new THREE.BufferAttribute(noise, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    this.terrainUniforms = {
      uSunDir: { value: this.sunDir }, uSunColor: { value: new THREE.Color(1, 0.97, 0.9) },
      uSkyColor: { value: new THREE.Color(0.75, 0.85, 1.0) }, uGroundColor: { value: new THREE.Color(0.45, 0.42, 0.38) },
      uFogColor: { value: new THREE.Color(0xcfe0ee) }, uFogNear: { value: 15000 }, uFogFar: { value: 90000 },
      uSnowline: { value: 1200 }, uSnowAmount: { value: 1 }, uRockColor: { value: new THREE.Color(rockColor || 0x9a948a) },
      uSummer: { value: 0 }, uOverlay: { value: 0 }, uContours: { value: 0 }, uMinH: { value: T.minH }, uMaxH: { value: T.maxH }, uTreeline: { value: this.biome ? this.biome.treeline : 2000 },
    };
    const mat = new THREE.ShaderMaterial({ uniforms: this.terrainUniforms, vertexShader: TERRAIN_VS, fragmentShader: TERRAIN_FS });
    this.terrainMesh = new THREE.Mesh(geo, mat);
    this.scene.add(this.terrainMesh);
    // skirt: dark base so the map edge looks like a cut block
    const skirtMat = new THREE.MeshLambertMaterial({ color: 0x4a443c });
    const edges = [];
    const addEdge = (pts) => {
      const g = new THREE.BufferGeometry();
      const v = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, y1, z1] = pts[i], [x2, y2, z2] = pts[i + 1];
        const yb = T.minH - 300;
        v.push(x1, y1, z1, x1, yb, z1, x2, y2, z2, x2, y2, z2, x1, yb, z1, x2, yb, z2);
      }
      g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, skirtMat);
      m.material.side = THREE.DoubleSide;
      edges.push(m);
      this.scene.add(m);
    };
    const row = j => Array.from({ length: nx }, (_, i) => [pos[(j * nx + i) * 3], pos[(j * nx + i) * 3 + 1], pos[(j * nx + i) * 3 + 2]]);
    const col = i => Array.from({ length: nz }, (_, j) => [pos[(j * nx + i) * 3], pos[(j * nx + i) * 3 + 1], pos[(j * nx + i) * 3 + 2]]);
    addEdge(row(0)); addEdge(row(nz - 1)); addEdge(col(0)); addEdge(col(nx - 1));
    // ground plane far below for the horizon
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400000, 400000), new THREE.MeshBasicMaterial({ color: 0x8c96a0 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = T.minH - 320;
    this.ground = ground;
    this.scene.add(ground);
  }

  _buildParticles() {
    const N = 6000;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { pos[i * 3] = (Math.random() - 0.5) * 1600; pos[i * 3 + 1] = Math.random() * 900; pos[i * 3 + 2] = (Math.random() - 0.5) * 1600; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const dot = document.createElement('canvas'); dot.width = dot.height = 32;
    const dg = dot.getContext('2d'), grad = dg.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.45, 'rgba(255,255,255,0.85)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    dg.fillStyle = grad; dg.fillRect(0, 0, 32, 32);
    const dotTex = new THREE.CanvasTexture(dot);
    this.particleMat = new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0.85, depthWrite: false, map: dotTex, alphaTest: 0.02 });
    this.particles = new THREE.Points(g, this.particleMat);
    this.particles.frustumCulled = false;
    this.particles.visible = false;
    this.scene.add(this.particles);
  }

  // ---------- environment from game state ----------
  setEnvironment({ day, minute, weather, snowline, snowAmount = 1, summer = 0 }) {
    const { alt, az } = sunPosition(this.lat, day, minute);
    // azimuth: 0 north (-z), PI/2 east (+x)
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
    const altDeg = alt * 180 / Math.PI;
    const dayF = smoothstep(-6, 8, altDeg);
    const low = 1 - smoothstep(2, 22, altDeg);
    const state = weather?.state || 'sunny';
    const overcast = { sunny: 0, partly: 0.25, cloudy: 0.75, fog: 0.95, snow: 0.85, heavysnow: 0.95, blizzard: 1, rain: 0.9 }[state] ?? 0;
    const lightDir = altDeg > -2 ? dir.clone() : new THREE.Vector3(0.3, 0.5, 0.2).normalize();
    this.sunDir.copy(lightDir.y < 0.05 ? lightDir.setY(0.05).normalize() : lightDir);
    const sunCol = new THREE.Color().setRGB(1, 0.94 - low * 0.35, 0.86 - low * 0.55);
    const night = new THREE.Color(0.18, 0.22, 0.36);
    const sunInt = dayF * (1 - overcast * 0.75);
    const sc = sunCol.clone().multiplyScalar(sunInt * 1.08).lerp(night.clone().multiplyScalar(0.25), 1 - dayF);
    this.terrainUniforms.uSunColor.value.copy(sc);
    const skyAmb = new THREE.Color(0.62, 0.74, 0.95).lerp(new THREE.Color(0.75, 0.77, 0.8), overcast).multiplyScalar(0.35 + 0.75 * dayF).lerp(new THREE.Color(0.08, 0.1, 0.2), 1 - dayF);
    this.terrainUniforms.uSkyColor.value.copy(skyAmb);
    this.terrainUniforms.uGroundColor.value.copy(skyAmb.clone().multiplyScalar(0.55));
    // sky gradient
    const top = new THREE.Color(0x2d6fd0).lerp(new THREE.Color(0x8c96a3), overcast).lerp(new THREE.Color(0x060a18), 1 - dayF);
    let hor = new THREE.Color(0xd6e6f5).lerp(new THREE.Color(0xb9c0c8), overcast).lerp(new THREE.Color(0x1a2238), 1 - dayF);
    hor.lerp(new THREE.Color(0xf2a36b), low * dayF * (1 - overcast) * 0.8);
    this.skyUniforms.uTop.value.copy(top);
    this.skyUniforms.uHorizon.value.copy(hor);
    this.skyUniforms.uSunDir.value.copy(dir);
    this.skyUniforms.uSunColor.value.copy(sunCol).multiplyScalar(dayF * (1 - overcast));
    this.skyUniforms.uStars.value = (1 - dayF) * (1 - overcast);
    // fog distance by weather
    const vis = weather?.vis ?? 1;
    const far = state === 'fog' ? 3500 : 15000 + 75000 * vis * (1 - overcast * 0.45);
    this.terrainUniforms.uFogNear.value = far * 0.12;
    this.terrainUniforms.uFogFar.value = far;
    this.terrainUniforms.uFogColor.value.copy(hor);
    this.scene.fog.color.copy(hor); this.scene.fog.near = far * 0.12; this.scene.fog.far = far;
    this.terrainUniforms.uSnowline.value = snowline;
    this.terrainUniforms.uSnowAmount.value = snowAmount;
    this.terrainUniforms.uSummer.value = summer;
    this.sun.position.copy(this.sunDir).multiplyScalar(10000);
    this.sun.color.copy(sc); this.sun.intensity = 2.2;
    this.hemi.color.copy(skyAmb); this.hemi.groundColor.copy(skyAmb.clone().multiplyScalar(0.5)); this.hemi.intensity = 1.6;
    this.dayFactor = dayF;
    // precipitation particles
    const precip = ['snow', 'heavysnow', 'blizzard', 'rain'].includes(state);
    this.particles.visible = precip;
    this.precipKind = state;
    this.particleMat.color.set(state === 'rain' ? 0x9fb3c8 : 0xffffff);
    this.particleMat.size = state === 'rain' ? 1.5 : state === 'blizzard' ? 2.8 : 2.2;
    this.ground.material.color.copy(hor).multiplyScalar(0.8);
  }

  setOverlay(n) { this.overlay = n; this.terrainUniforms.uOverlay.value = n; }
  setContours(on) { this.contours = on ? 1 : 0; this.terrainUniforms.uContours.value = this.contours; }

  // ---------- camera ----------
  lookAt(x, z, distance = 6000, opts = {}) {
    const y = this.terrain.heightAt(x, z);
    const az = opts.azimuth ?? Math.PI * 0.15;
    const pol = opts.polar ?? 0.95;
    this.controls.target.set(x, y, z);
    this.camera.position.set(x + Math.sin(az) * Math.sin(pol) * distance, y + Math.cos(pol) * distance, z + Math.cos(az) * Math.sin(pol) * distance);
    this.controls.update();
  }
  flyTo(x, z, distance) {
    const from = this.controls.target.clone();
    const fromOff = this.camera.position.clone().sub(from);
    const toY = this.terrain.heightAt(x, z);
    const d = distance ?? Math.min(fromOff.length(), 3500);
    this.flight = { t: 0, from, fromOff, to: new THREE.Vector3(x, toY, z), toOff: fromOff.clone().setLength(d) };
  }

  update(dt) {
    const c = this.controls;
    if (!c.enabled) { this._updateParticles(dt); return; }
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt * 1.6);
      const e = f.t < 0.5 ? 2 * f.t * f.t : 1 - Math.pow(-2 * f.t + 2, 2) / 2;
      c.target.lerpVectors(f.from, f.to, e);
      const off = f.fromOff.clone().lerp(f.toOff, e);
      this.camera.position.copy(c.target).add(off);
      if (f.t >= 1) this.flight = null;
    }
    // keyboard panning / rotation
    const k = this.keys;
    const dist = this.camera.position.distanceTo(c.target);
    const sp = dist * 0.9 * dt;
    const fwd = new THREE.Vector3().subVectors(c.target, this.camera.position).setY(0).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    const move = new THREE.Vector3();
    if (k.KeyW || k.ArrowUp) move.add(fwd);
    if (k.KeyS || k.ArrowDown) move.sub(fwd);
    if (k.KeyD || k.ArrowRight) move.add(right);
    if (k.KeyA || k.ArrowLeft) move.sub(right);
    if (move.lengthSq() > 0) { move.setLength(sp); c.target.add(move); this.camera.position.add(move); }
    if (k.KeyQ || k.KeyE) {
      const ang = (k.KeyQ ? 1 : -1) * dt * 1.2;
      const off = this.camera.position.clone().sub(c.target);
      off.applyAxisAngle(new THREE.Vector3(0, 1, 0), ang);
      this.camera.position.copy(c.target).add(off);
    }
    // keep target on the ground and inside the map
    const T = this.terrain;
    const tx = clamp(c.target.x, T.x0, -T.x0), tz = clamp(c.target.z, T.z0, -T.z0);
    const dxT = tx - c.target.x, dzT = tz - c.target.z;
    if (dxT || dzT) { c.target.x = tx; c.target.z = tz; this.camera.position.x += dxT; this.camera.position.z += dzT; }
    const gy = T.heightAt(c.target.x, c.target.z);
    const dy = gy - c.target.y;
    c.target.y += dy * Math.min(1, dt * 6);
    this.camera.position.y += dy * Math.min(1, dt * 6);
    c.update();
    // camera never below terrain
    const camG = T.heightAt(this.camera.position.x, this.camera.position.z) + 25;
    if (this.camera.position.y < camG) this.camera.position.y = camG;
    this._updateParticles(dt);
  }

  _updateParticles(dt) {
    const c = this.controls;
    const dist = this.camera.position.distanceTo(c.target);
    // precipitation follows the camera
    if (this.particles.visible) {
      const p = this.particles.geometry.attributes.position;
      const fall = (this.precipKind === 'rain' ? 380 : this.precipKind === 'blizzard' ? 120 : 55) * dt;
      const wind = this.precipKind === 'blizzard' ? 90 * dt : 10 * dt;
      const ctr = this.camera.position.clone().lerp(c.target, 0.15);
      const R = Math.min(1600, dist * 0.8 + 200);
      this.particles.position.set(ctr.x, ctr.y - 450, ctr.z);
      this.particles.scale.setScalar(R / 1600);
      for (let i = 0; i < p.count; i++) {
        let y = p.getY(i) - fall * (0.7 + (i % 5) * 0.1);
        let x = p.getX(i) + wind;
        if (y < 0) y += 900;
        if (x > 800) x -= 1600;
        p.setY(i, y); p.setX(i, x);
      }
      p.needsUpdate = true;
    }
  }

  cameraDistance() { return this.camera.position.distanceTo(this.controls.target); }

  // screen -> ground point
  pickGround(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    const o = rc.ray.origin, d = rc.ray.direction;
    return this.terrain.raycast(o.x, o.y, o.z, d.x, d.y, d.z);
  }
  project(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: (v.x + 1) / 2 * rect.width, y: (1 - v.y) / 2 * rect.height, behind: v.z > 1 };
  }

  render() { this.renderer.render(this.scene, this.camera); }

  dispose() {
    for (const [ev, fn] of Object.entries(this._winListeners)) window.removeEventListener(ev, fn);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

export { THREE };
