// "Ski it yourself": a third-person skier on the real terrain, with timed runs and a ghost of your
// best descent per piste. Also a chairlift/gondola ride camera.

import * as THREE from 'three';
import { clamp, dist, polyLength, pointAt, closestOnPoly, escapeHtml } from './util.js';
import { LIFTS } from './catalog.js';
import { t } from './i18n.js';

const G = 9.81;

export class SkiMode {
  constructor(app) {
    this.app = app;
    this.s3 = app.s3;
    this.terrain = app.game.terrain;
    this.active = false;
    this.keys = {};
    this._onKey = e => this.onKey(e);
  }

  // start at the top of a piste (or a lift top / the camera target)
  start(target) {
    const g = this.app.game, w = g.world;
    let piste = null, sx, sz;
    if (target?.kind === 'lift') return this.ride(target);
    if (target?.kind === 'piste') piste = target;
    else {
      const c = this.s3.controls.target;
      let bd = Infinity;
      for (const p of w.pistes) { const d = dist(p.pts[0][0], p.pts[0][1], c.x, c.z); if (d < bd) { bd = d; piste = p; } }
    }
    if (piste) { sx = piste.pts[0][0]; sz = piste.pts[0][1]; }
    else { sx = this.s3.controls.target.x; sz = this.s3.controls.target.z; }
    this.piste = piste;
    this.pos = new THREE.Vector3(sx, this.terrain.heightAt(sx, sz), sz);
    const d = piste ? pointAt(piste.pts, 30) : [sx, sz + 10];
    this.heading = Math.atan2(d[0] - sx, d[1] - sz);
    this.vel = new THREE.Vector2(0, 0);
    this.time = 0; this.running = false; this.finished = false; this.crashT = 0;
    this.path = [];
    this.best = this.loadBest();
    this.ghostT = 0;
    this._begin();
    this.hudMsg(piste ? t('{p}: push off with W. A/D to carve, S to brake, Space to tuck. Esc to quit.', { p: piste.name }) : t('Free ride. W to go, A/D to steer, Esc to quit.'));
  }

  _begin() {
    this.active = true;
    this.app.skiActive = true;
    this.savedCam = { pos: this.s3.camera.position.clone(), target: this.s3.controls.target.clone() };
    this.s3.controls.enabled = false;
    window.addEventListener('keydown', this._onKey, true);
    window.addEventListener('keyup', this._onKey, true);
    if (!this.mesh) {
      const grp = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.9, 3, 8), new THREE.MeshLambertMaterial({ color: 0xe63946 }));
      body.position.y = 1.0;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 10, 8), new THREE.MeshLambertMaterial({ color: 0x1d3557 }));
      head.position.y = 1.75;
      const ski1 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 1.8), new THREE.MeshLambertMaterial({ color: 0x111111 }));
      ski1.position.set(-0.15, 0.05, 0);
      const ski2 = ski1.clone(); ski2.position.x = 0.15;
      grp.add(body, head, ski1, ski2);
      this.mesh = grp;
      const ghost = grp.clone();
      ghost.traverse(o => { if (o.material) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.35; } });
      this.ghost = ghost;
    }
    this.s3.scene.add(this.mesh);
    if (this.best) this.s3.scene.add(this.ghost);
    this.ui = document.createElement('div');
    this.ui.id = 'skihud';
    this.ui.innerHTML = `<div class="sk-speed"><b id="skSpd">0</b><span>km/h</span></div><div class="sk-time" id="skTime"></div><div class="sk-msg" id="skMsg"></div><button class="btn" id="skExit">✕ ${t('Exit')}</button>`;
    document.body.appendChild(this.ui);
    this.ui.querySelector('#skExit').onclick = () => this.stop();
    document.getElementById('hud').classList.add('ski');
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.app.skiActive = false;
    this.rideLift = null;
    window.removeEventListener('keydown', this._onKey, true);
    window.removeEventListener('keyup', this._onKey, true);
    this.s3.scene.remove(this.mesh); this.s3.scene.remove(this.ghost);
    this.ui?.remove();
    this.s3.controls.enabled = true;
    if (this.savedCam) { this.s3.camera.position.copy(this.savedCam.pos); this.s3.controls.target.copy(this.savedCam.target); this.s3.controls.update(); }
    document.getElementById('hud').classList.remove('ski');
    this.keys = {};
  }

  onKey(e) {
    if (!this.active) return;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Escape'].includes(e.code)) { e.preventDefault(); e.stopPropagation(); }
    const down = e.type === 'keydown';
    this.keys[e.code] = down;
    if (down && e.code === 'Escape') this.stop();
    if (down && e.code === 'KeyR' && this.piste) this.start(this.piste);
  }

  hudMsg(text) { const m = this.ui?.querySelector('#skMsg'); if (m) { m.textContent = text; m.style.opacity = 1; clearTimeout(this._mt); this._mt = setTimeout(() => { m.style.opacity = 0; }, 5000); } }

  bestKey() { return `snowline.best.${this.app.game.s.resortId}.${this.piste?.id}`; }
  loadBest() { if (!this.piste) return null; try { return JSON.parse(localStorage.getItem(this.bestKey()) || 'null'); } catch (e) { return null; } }
  saveBest(rec) { try { localStorage.setItem(this.bestKey(), JSON.stringify(rec)); } catch (e) { /* ignore */ } }

  // ---------- lift ride camera ----------
  ride(lift) {
    this.rideLift = lift;
    this.rideS = 0;
    this.piste = null;
    this.pos = new THREE.Vector3(lift.a[0], lift.ya, lift.a[1]);
    this._begin();
    this.s3.scene.remove(this.mesh);
    this.hudMsg(t('Riding {l}. Esc to get off.', { l: lift.name }));
  }

  update(dt) {
    if (!this.active) return;
    dt = Math.min(dt, 0.05);
    const T = this.terrain, cam = this.s3.camera;
    if (this.rideLift) {
      const l = this.rideLift;
      const c = l.cable;
      const speed = l.speed * 2.5;
      this.rideS += speed * dt;
      const f = clamp(this.rideS / l.length, 0, 1);
      const idx = f * (c.length - 1);
      const i0 = Math.floor(idx), i1 = Math.min(c.length - 1, i0 + 1), u = idx - i0;
      const p = new THREE.Vector3(c[i0][0] + (c[i1][0] - c[i0][0]) * u, c[i0][1] + (c[i1][1] - c[i0][1]) * u - 3, c[i0][2] + (c[i1][2] - c[i0][2]) * u);
      cam.position.lerp(p, 0.3);
      const ahead = new THREE.Vector3(l.b[0], l.yb + 40, l.b[1]);
      const look = ahead.clone().sub(p).normalize();
      look.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.sin(performance.now() / 4000) * 0.6);
      cam.lookAt(p.clone().add(look.multiplyScalar(100)));
      const spd = this.ui.querySelector('#skSpd'); spd.textContent = Math.round(l.speed * 3.6);
      this.ui.querySelector('#skTime').textContent = `${Math.round(f * 100)}% · ${Math.round(p.y)} m`;
      if (f >= 1) { const top = l; this.stop(); this.app.hud?.toast('info', t('You reached the top of {l}.', { l: escapeHtml(top.name) })); }
      return;
    }
    // ---- skiing physics
    const k = this.keys;
    const steer = (k.KeyA || k.ArrowLeft ? 1 : 0) - (k.KeyD || k.ArrowRight ? 1 : 0);
    const push = k.KeyW || k.ArrowUp;
    const brake = k.KeyS || k.ArrowDown;
    const tuck = k.Space;
    const speed = this.vel.length();
    this.heading += steer * dt * (1.9 - Math.min(1.1, speed / 30));
    const gr = T.gradientAt(this.pos.x, this.pos.z);
    // gravity along the slope (downhill = -gradient)
    const slope = Math.atan(gr.g);
    const ax = -gr.dx / (gr.g || 1) * G * Math.sin(slope);
    const az = -gr.dz / (gr.g || 1) * G * Math.sin(slope);
    this.vel.x += ax * dt; this.vel.y += az * dt;
    const hx = Math.sin(this.heading), hz = Math.cos(this.heading);
    if (push && speed < 6) { this.vel.x += hx * 3 * dt; this.vel.y += hz * 3 * dt; this.running = this.running || !!this.piste; }
    // carving: kill sideways velocity relative to the skis
    const along = this.vel.x * hx + this.vel.y * hz;
    const side = this.vel.x * hz - this.vel.y * hx;
    const grip = brake ? 2.5 : 5;
    const newSide = side * Math.exp(-grip * dt);
    let newAlong = along;
    // friction + air drag
    const drag = (tuck ? 0.0016 : 0.0034) * along * Math.abs(along);
    newAlong -= (0.04 * G * Math.cos(slope) * Math.sign(along) + drag) * dt;
    if (brake) newAlong *= Math.exp(-1.6 * dt);
    if (Math.abs(newAlong) < 0.05 && !push) newAlong = 0;
    this.vel.x = hx * newAlong + hz * newSide;
    this.vel.y = hz * newAlong - hx * newSide;
    if (along < -0.5) this.heading += Math.PI * dt * 0.5; // turned backwards: swing round
    this.pos.x += this.vel.x * dt; this.pos.z += this.vel.y * dt;
    if (!T.inBounds(this.pos.x, this.pos.z, 20)) { this.pos.x = clamp(this.pos.x, T.x0 + 20, -T.x0 - 20); this.pos.z = clamp(this.pos.z, T.z0 + 20, -T.z0 - 20); this.vel.set(0, 0); }
    this.pos.y = T.heightAt(this.pos.x, this.pos.z);
    // crash on cliffs
    if (T.slopeDeg(this.pos.x, this.pos.z) > 50 && speed > 8 && this.crashT <= 0) {
      this.crashT = 2; this.vel.multiplyScalar(0.1); this.hudMsg(t('Wipe-out! That was a cliff.'));
    }
    this.crashT -= dt;
    if (this.running && !this.finished) {
      this.time += dt;
      if (this.path.length === 0 || this.time - this.path[this.path.length - 1][0] > 0.1) this.path.push([this.time, Math.round(this.pos.x * 10) / 10, Math.round(this.pos.z * 10) / 10]);
      if (this.piste) {
        const end = this.piste.pts[this.piste.pts.length - 1];
        const c = closestOnPoly(this.piste.pts, this.pos.x, this.pos.z);
        if (c.d > this.piste.width * 2.5 && !this._warned) { this._warned = true; this.hudMsg(t('Missed a gate: you left the piste. Time not valid.')); this.dq = true; }
        if (dist(end[0], end[1], this.pos.x, this.pos.z) < 40) {
          this.finished = true;
          const best = this.best;
          const valid = !this.dq;
          if (valid && (!best || this.time < best.time)) { this.saveBest({ time: this.time, path: this.path }); this.hudMsg(t('Finish! {t} - new personal best!', { t: fmtT(this.time) })); }
          else this.hudMsg(valid ? t('Finish! {t} (best {b}). Press R to retry.', { t: fmtT(this.time), b: fmtT(best.time) }) : t('Finish, but disqualified. Press R to retry.'));
        }
      }
    }
    // ghost replay
    if (this.best && this.running) {
      const p = this.best.path;
      let i = p.findIndex(q => q[0] >= this.time);
      if (i < 0) i = p.length - 1;
      const q = p[Math.max(0, i)];
      this.ghost.position.set(q[1], T.heightAt(q[1], q[2]), q[2]);
      const q2 = p[Math.min(p.length - 1, i + 1)];
      this.ghost.rotation.y = Math.atan2(q2[1] - q[1], q2[2] - q[2]);
    }
    // skier mesh
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.set(0, this.heading, 0);
    this.mesh.rotateZ(-steer * Math.min(0.5, speed / 40));
    if (tuck) this.mesh.scale.set(1, 0.75, 1); else this.mesh.scale.set(1, 1, 1);
    // chase camera
    const back = new THREE.Vector3(this.pos.x - hx * 9, 0, this.pos.z - hz * 9);
    back.y = Math.max(T.heightAt(back.x, back.z) + 3.2, this.pos.y + 3.5);
    cam.position.lerp(back, 1 - Math.exp(-6 * dt));
    cam.lookAt(this.pos.x + hx * 6, this.pos.y + 1.2, this.pos.z + hz * 6);
    this.ui.querySelector('#skSpd').textContent = Math.round(this.vel.length() * 3.6);
    this.ui.querySelector('#skTime').textContent = this.piste ? `${fmtT(this.time)}${this.best ? ` · ${t('best')} ${fmtT(this.best.time)}` : ''} · ${Math.round(this.pos.y)} m` : `${Math.round(this.pos.y)} m`;
  }
}

function fmtT(s) { const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`; }
