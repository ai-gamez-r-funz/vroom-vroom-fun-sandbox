// Sky, sun, day/night cycle and dynamic weather (rain, snow, fog, storms).
import * as THREE from 'three';
import { clamp, lerp, damp, smoothstep } from './util.js';

export const WEATHERS = {
  clear: { name: 'Clear', fog: 0.0011, clouds: 0.1, rain: 0, wet: 0, wind: 0 },
  cloudy: { name: 'Overcast', fog: 0.0017, clouds: 0.7, rain: 0, wet: 0, wind: 0.2 },
  rain: { name: 'Rain', fog: 0.0028, clouds: 0.9, rain: 0.7, wet: 1, wind: 0.3 },
  storm: { name: 'Thunderstorm', fog: 0.0036, clouds: 1, rain: 1, wet: 1, wind: 1 },
  fog: { name: 'Fog', fog: 0.0085, clouds: 0.6, rain: 0, wet: 0.3, wind: 0 },
  snow: { name: 'Snowfall', fog: 0.0032, clouds: 0.85, rain: 0.8, wet: 0, wind: 0.3, snow: true },
};
const CYCLE = ['clear', 'clear', 'cloudy', 'rain', 'clear', 'fog', 'cloudy', 'storm', 'clear', 'snow'];

export class Environment {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.time = 10.5; // hours
    this.daySpeed = 24 / (16 * 60); // a full day in 16 real minutes
    this.weatherId = 'clear';
    this.autoWeather = true;
    this.weatherTimer = 0;
    this.cur = { ...WEATHERS.clear };
    this.wetness = 0;
    this.snowiness = 0;
    this.lightning = 0;
    this.windDir = new THREE.Vector2(1, 0.3).normalize();
    this.dayCount = 0;

    scene.fog = new THREE.FogExp2(0xbcd4e6, 0.0011);
    this.hemi = new THREE.HemisphereLight(0xcfe6ff, 0x5a5040, 1.1);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 400;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.05;
    scene.add(this.sun, this.sun.target);

    // Sky dome
    this.skyUniforms = {
      top: { value: new THREE.Color(0x3d7cc9) },
      bottom: { value: new THREE.Color(0xbcd4e6) },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunColor: { value: new THREE.Color(0xfff2c0) },
      sunVis: { value: 1 },
    };
    const skyMat = new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`,
      fragmentShader: `uniform vec3 top; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunColor; uniform float sunVis; varying vec3 vDir;
        void main(){ float h = clamp(vDir.y*1.4+0.1,0.0,1.0); vec3 c = mix(bottom, top, pow(h,0.8));
        float d = max(dot(normalize(vDir), sunDir),0.0); c += sunColor * (pow(d, 900.0)*3.0 + pow(d,12.0)*0.25) * sunVis;
        gl_FragColor = vec4(c,1.0); }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(3000, 32, 16), skyMat);
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    // Stars
    const sg = new THREE.BufferGeometry();
    const sp = [];
    for (let i = 0; i < 1500; i++) {
      const v = new THREE.Vector3().randomDirection();
      if (v.y < 0.05) v.y = Math.abs(v.y) + 0.05;
      v.normalize().multiplyScalar(2800);
      sp.push(v.x, v.y, v.z);
    }
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    this.starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.frustumCulled = false;
    scene.add(this.stars);

    // Precipitation: rain as line segments, snow as points; both follow the camera.
    const RN = 5000;
    const rp = new Float32Array(RN * 6);
    this.rainSeeds = new Float32Array(RN * 3);
    for (let i = 0; i < RN; i++) {
      this.rainSeeds[i * 3] = Math.random() * 80 - 40;
      this.rainSeeds[i * 3 + 1] = Math.random() * 40;
      this.rainSeeds[i * 3 + 2] = Math.random() * 80 - 40;
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xaaccee, transparent: true, opacity: 0.45 }));
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    scene.add(this.rain);
    const SN = 4000;
    const snp = new Float32Array(SN * 3);
    const sng = new THREE.BufferGeometry();
    sng.setAttribute('position', new THREE.BufferAttribute(snp, 3));
    this.snow = new THREE.Points(sng, new THREE.PointsMaterial({ color: 0xffffff, size: 0.18, transparent: true, opacity: 0.9 }));
    this.snow.frustumCulled = false;
    this.snow.visible = false;
    scene.add(this.snow);
    this.precipT = 0;

    this.dayColors = {
      top: new THREE.Color(0x3d7cc9), bottom: new THREE.Color(0xbcd4e6),
      nightTop: new THREE.Color(0x02040c), nightBottom: new THREE.Color(0x0b1424),
      duskBottom: new THREE.Color(0xf08a4b), storm: new THREE.Color(0x5d6670),
    };
  }

  setWeather(id, auto = this.autoWeather) {
    this.weatherId = id;
    this.autoWeather = auto;
    this.weatherTimer = 0;
  }

  get nightFactor() {
    const sunH = Math.sin(((this.time - 6) / 24) * Math.PI * 2);
    return 1 - smoothstep(-0.12, 0.15, sunH);
  }

  update(dt, focus, camera, regionSnow) {
    const prevT = this.time;
    this.time = (this.time + dt * this.daySpeed) % 24;
    if (this.time < prevT) this.dayCount++;

    if (this.autoWeather) {
      this.weatherTimer += dt;
      if (this.weatherTimer > 150) {
        const i = (CYCLE.indexOf(this.weatherId) + 1) % CYCLE.length;
        this.setWeather(CYCLE[i], true);
      }
    }
    // blend weather params
    const tgt = WEATHERS[this.weatherId];
    const c = this.cur;
    for (const k of ['fog', 'clouds', 'rain', 'wet', 'wind']) c[k] = damp(c[k], tgt[k], 0.4, dt);
    // rain turns to snow in the snowy north, or snow weather everywhere
    const snowTarget = tgt.snow ? 1 : (c.rain > 0.05 ? regionSnow : 0);
    this.snowMix = damp(this.snowMix || 0, snowTarget, 1, dt);
    this.wetness = damp(this.wetness, tgt.wet * (1 - this.snowMix), 0.15, dt);
    this.snowiness = Math.max(regionSnow * 0.6, damp(this.snowiness, tgt.snow ? 1 : 0, 0.1, dt));

    // sun position
    const ang = ((this.time - 6) / 24) * Math.PI * 2;
    const sunDir = new THREE.Vector3(Math.cos(ang) * 0.8, Math.sin(ang), 0.45).normalize();
    const sunUp = Math.max(0, sunDir.y);
    const night = this.nightFactor;
    const dusk = clamp(1 - Math.abs(sunDir.y) * 4, 0, 1) * (1 - night * 0.5);
    this.sun.position.copy(focus).addScaledVector(sunDir.y > -0.05 ? sunDir : sunDir.clone().negate(), 200);
    this.sun.target.position.copy(focus);
    const cloud = c.clouds;
    // night: the "sun" becomes a dim bluish moon light from the opposite direction
    this.sun.color.setRGB(lerp(1, 0.55, night), lerp(lerp(0.96, 0.7, dusk), 0.62, night), lerp(lerp(0.9, 0.5, dusk), 0.9, night));
    this.sun.intensity = lerp(lerp(2.0, 0.3, night), 0.35, cloud * 0.8) + (night > 0.9 ? 0 : 0);
    this.hemi.intensity = lerp(lerp(0.9, 0.3, night), 0.8 * (1 - night * 0.65), cloud * 0.5);
    this.lightning = Math.max(0, this.lightning - dt * 3);
    if (this.weatherId === 'storm' && Math.random() < dt * 0.12) { this.lightning = 1; this.onThunder?.(); }
    this.hemi.intensity += this.lightning * 2.5;

    const U = this.skyUniforms;
    const D = this.dayColors;
    U.top.value.copy(D.top).lerp(D.storm, cloud * 0.7).lerp(D.nightTop, night);
    U.bottom.value.copy(D.bottom).lerp(D.duskBottom, dusk * (1 - cloud)).lerp(D.storm, cloud * 0.6).lerp(D.nightBottom, night);
    if (this.lightning > 0) { U.top.value.lerp(new THREE.Color(0xdde4ff), this.lightning * 0.6); U.bottom.value.lerp(new THREE.Color(0xdde4ff), this.lightning * 0.6); }
    U.sunDir.value.copy(sunDir);
    U.sunVis.value = (1 - cloud) * (1 - night);
    this.sky.position.copy(camera.position);
    this.stars.position.copy(camera.position);
    this.starMat.opacity = night * (1 - cloud);
    this.scene.fog.color.copy(U.bottom.value);
    // fog thickens with snow region, weather and at night a bit
    this.scene.fog.density = c.fog * (1 + this.snowMix * 0.6);
    this.renderer.toneMappingExposure = lerp(1.0, 0.85, night);

    // precipitation particles
    const amt = c.rain;
    this.precipT += dt;
    const cp = camera.position;
    const rainAmt = amt * (1 - this.snowMix), snowAmt = amt * this.snowMix;
    this.rain.visible = rainAmt > 0.02;
    this.snow.visible = snowAmt > 0.02;
    const wind = c.wind;
    if (this.rain.visible) {
      const pos = this.rain.geometry.attributes.position.array;
      const n = Math.floor((pos.length / 6) * rainAmt);
      const s = this.rainSeeds;
      for (let i = 0; i < pos.length / 6; i++) {
        if (i >= n) { pos[i * 6 + 1] = pos[i * 6 + 4] = -9999; continue; }
        const y = ((s[i * 3 + 1] - this.precipT * 28) % 40 + 40) % 40;
        const x = ((s[i * 3] - cp.x + 4000) % 80 + 80) % 80 - 40 + cp.x;
        const z = ((s[i * 3 + 2] - cp.z + 4000) % 80 + 80) % 80 - 40 + cp.z;
        const yy = cp.y - 15 + y;
        pos[i * 6] = x; pos[i * 6 + 1] = yy; pos[i * 6 + 2] = z;
        pos[i * 6 + 3] = x + wind * 0.4; pos[i * 6 + 4] = yy + 0.9; pos[i * 6 + 5] = z;
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
    }
    if (this.snow.visible) {
      const pos = this.snow.geometry.attributes.position.array;
      const n = Math.floor((pos.length / 3) * snowAmt);
      const s = this.rainSeeds;
      for (let i = 0; i < pos.length / 3; i++) {
        if (i >= n) { pos[i * 3 + 1] = -9999; continue; }
        const y = ((s[i * 3 + 1] - this.precipT * 3) % 40 + 40) % 40;
        const sway = Math.sin(this.precipT + i) * 0.8;
        pos[i * 3] = ((s[i * 3] + sway + this.precipT * wind * 3 - cp.x + 4000) % 80 + 80) % 80 - 40 + cp.x;
        pos[i * 3 + 1] = cp.y - 15 + y;
        pos[i * 3 + 2] = ((s[i * 3 + 2] - cp.z + 4000) % 80 + 80) % 80 - 40 + cp.z;
      }
      this.snow.geometry.attributes.position.needsUpdate = true;
    }
  }

  get windForce() {
    return this.cur.wind;
  }

  timeString() {
    const h = Math.floor(this.time), m = Math.floor((this.time - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
