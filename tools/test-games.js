// 验证注入导航栏后，游戏本身仍能正常运行（复用之前的 DOM 桩思路）
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function makeCtx() {
  const noop = () => {};
  return {
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '',
    textAlign: 'left', textBaseline: 'alphabetic', shadowColor: '', shadowBlur: 0,
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    setTransform: noop, clip: noop, beginPath: noop, closePath: noop, moveTo: noop,
    lineTo: noop, arc: noop, arcTo: noop, rect: noop, fill: noop, stroke: noop,
    fillRect: noop, strokeRect: noop, clearRect: noop, fillText: noop, strokeText: noop,
    drawImage: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    measureText: () => ({ width: 10 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: noop
  };
}
function makeCanvas(w, h) {
  const el = { width: w || 300, height: h || 150, style: {}, addEventListener: noop0, getContext: () => el._c };
  function noop0() {}
  el._c = makeCtx(); el._c.canvas = el;
  return el;
}

const rafQ = [];
let now = 0;
const listeners = {};

// 通用的 DOM 元素桩，够 2048 这类操作 DOM 的游戏使用
function makeEl(id) {
  const el = {
    id, style: { setProperty() {}, removeProperty() {} },
    className: '', innerHTML: '', textContent: '', value: '0',
    children: [], dataset: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, f) { if (f === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else { f ? this._s.add(c) : this._s.delete(c); } },
      contains(c) { return this._s.has(c); }
    },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    append(...c) { c.forEach((x) => this.children.push(x)); },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }),
    focus() {}, blur() {}, click() {}, remove() {}
  };
  return el;
}

function run(file, label) {
  rafQ.length = 0; now = 0;
  for (const k in listeners) delete listeners[k];

  const gameCanvas = makeCanvas(960, 600);
  const els = {};
  const documentStub = {
    createElement: (t) => (t === 'canvas' ? makeCanvas() : makeEl('el-' + t)),
    getElementById: (id) => {
      if (id === 'game') return gameCanvas;
      if (!els[id]) els[id] = makeEl(id);
      return els[id];
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    querySelectorAllRaw: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    hidden: false,
    body: makeEl('body'),
    documentElement: makeEl('html')
  };

  function FakeAC() {
    this.currentTime = 0; this.sampleRate = 44100; this.state = 'running'; this.destination = {};
    this.resume = () => {};
    this.createGain = () => ({ gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} });
    this.createOscillator = () => ({ type: 'sine', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() {}, stop() {} });
    this.createBuffer = (c, l) => ({ getChannelData: () => new Float32Array(l) });
    this.createBufferSource = () => ({ buffer: null, connect() {}, start() {}, stop() {} });
    this.createBiquadFilter = () => ({ type: 'lowpass', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} });
  }

  const sandbox = {
    document: documentStub,
    window: {
      devicePixelRatio: 1,
      addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
      removeEventListener() {},
      localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); } },
      AudioContext: FakeAC
    },
    performance: { now: () => now },
    requestAnimationFrame: (fn) => rafQ.push(fn),
    setTimeout, clearTimeout, setInterval, clearInterval,
    console, Math, Date, JSON, Set, Map, Array, Object, String, Number, Boolean, Error, Promise,
    parseInt, parseFloat, isNaN, isFinite, Float32Array, Uint8ClampedArray
  };
  sandbox.globalThis = sandbox;
  // 浏览器里 localStorage 是全局的，桩里也要暴露到全局作用域
  sandbox.localStorage = sandbox.window.localStorage;
  sandbox.alert = () => {};
  sandbox.confirm = () => true;
  // 触屏检测会读 navigator，这里模拟一台桌面设备（非触屏）
  sandbox.navigator = { maxTouchPoints: 0, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
  sandbox.sessionStorage = { getItem: () => null, setItem: () => {} };
  sandbox.PointerEvent = function () {};

  const html = fs.readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

  try {
    const ctx = vm.createContext(sandbox);
    for (const s of scripts) vm.runInContext(s, ctx, { filename: path.basename(file) });
  } catch (e) {
    console.error(`  ${label}: LOAD_ERROR ${e.message}`);
    return false;
  }

  // 跑 20 秒模拟
  const key = (code, type) => (listeners[type || 'keydown'] || []).forEach((fn) => fn({ code, repeat: false, preventDefault() {} }));
  try {
    key('Space');
    for (let i = 0; i < 20 * 60; i++) {
      now += 1000 / 60;
      if (i % 90 === 0) key('Space');
      if (i % 300 === 0) key('ArrowLeft');
      if (i % 300 === 150) key('ArrowUp');
      const fn = rafQ.shift();
      if (!fn) { console.log(`  ${label}: 无需 raf（可能是非 Canvas 游戏），已跳过运行时模拟`); return true; }
      fn(now);
    }
    console.log(`  ${label}: 运行 20 秒无异常 ✓`);
    return true;
  } catch (e) {
    console.error(`  ${label}: RUNTIME_ERROR ${e.message}`);
    return false;
  }
}

const base = 'E:\\LeStoreDownload\\game-hub\\games';
console.log('验证注入导航栏后游戏是否仍正常：');
let ok = true;
ok = run(path.join(base, 'echo.html'), '回声·ECHO') && ok;
ok = run(path.join(base, '2048.html'), '2048') && ok;
console.log(ok ? '\nGAMES_OK' : '\nGAMES_FAIL');
process.exit(ok ? 0 : 1);