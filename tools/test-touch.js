// 触屏逻辑单元测试：直接在无头环境里调用游戏内部函数，验证摇杆与按钮行为
// 做法：把 echo 的脚本跑在 DOM 桩里，然后通过派发 PointerEvent 驱动
const fs = require('fs');
const vm = require('vm');

const FILE = 'E:\\LeStoreDownload\\game-hub\\games\\echo.html';

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
  const handlers = {};
  const el = {
    width: w || 960, height: h || 600, style: {},
    addEventListener: (t, fn) => { (handlers[t] = handlers[t] || []).push(fn); },
    removeEventListener: () => {},
    dispatch: (t, ev) => (handlers[t] || []).forEach((fn) => fn(ev)),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: (w || 960), height: (h || 600), right: w, bottom: h }),
    setPointerCapture: () => {},
    getContext: () => el._c
  };
  el._c = makeCtx(); el._c.canvas = el;
  return el;
}

const rafQ = [];
let now = 0;
const winListeners = {};
const gameCanvas = makeCanvas(960, 600);

const documentStub = {
  createElement: (t) => (t === 'canvas' ? makeCanvas() : { style: {}, addEventListener: () => {} }),
  getElementById: (id) => (id === 'game' ? gameCanvas : null),
  querySelectorAll: () => [], querySelector: () => null,
  addEventListener: () => {}, hidden: false,
  body: { appendChild: () => {} }
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

// 模拟触屏设备
const windowStub = {
  devicePixelRatio: 1,
  PointerEvent: function () {},
  addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); },
  removeEventListener: () => {},
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); } },
  AudioContext: FakeAC
};

const navigatorStub = { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile' };

const sandbox = {
  document: documentStub, window: windowStub, navigator: navigatorStub,
  performance: { now: () => now },
  requestAnimationFrame: (fn) => rafQ.push(fn),
  console, Math, Date, JSON, Set, Map, Array, Object, String, Number, Boolean, Error, Promise,
  parseInt, parseFloat, isNaN, isFinite, Float32Array, Uint8ClampedArray
};
sandbox.globalThis = sandbox;
sandbox.localStorage = windowStub.localStorage;

const html = fs.readFileSync(FILE, 'utf8');
const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

const ctxObj = vm.createContext(sandbox);
try {
  vm.runInContext(code, ctxObj, { filename: 'echo.js' });
} catch (e) {
  console.error('LOAD_ERROR:', e.stack || e);
  process.exit(1);
}

function step(n) {
  for (let i = 0; i < n; i++) {
    now += 1000 / 60;
    const fn = rafQ.shift();
    if (!fn) throw new Error('raf 队列空了');
    fn(now);
  }
}

function dispatch(type, x, y, id) {
  gameCanvas.dispatch(type, {
    clientX: x, clientY: y, pointerId: id,
    preventDefault() {}, bubbles: true, cancelable: true, pointerType: 'touch'
  });
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? '  -> ' + extra : ''}`); fail++; }
}
const dbg = () => sandbox.window.__echoDebug;

console.log('触屏功能测试（模拟 iPhone UA + maxTouchPoints=5）\n');

// --- 1. 标题页 ---
step(5);
console.log('1) 标题页');
check('触屏检测生效（isTouch=true）', dbg().isTouch === true);
check('初始状态为 title', dbg().state === 'title', dbg().state);

// --- 2. 点击开始 ---
console.log('\n2) 轻触屏幕开始游戏');
dispatch('pointerdown', 480, 300, 1);
dispatch('pointerup', 480, 300, 1);
step(10);
check('进入 playing 状态', dbg().state === 'playing', dbg().state);

// --- 3. 摇杆拖动应产生真实位移 ---
console.log('\n3) 拖动摇杆 → 验证玩家真的移动');
step(30);
const beforeX = dbg().player.x;
const beforeY = dbg().player.y;

// 在左下角按下并向右上拖
dispatch('pointerdown', 150, 480, 2);
step(2);
check('摇杆进入激活态', dbg().touch.active === true);
check('刚按下未拖动时 mag 为 0（符合预期，不产生误走位）', dbg().touch.mag === 0,
  'mag=' + dbg().touch.mag.toFixed(2));

dispatch('pointermove', 150 + 70, 480 - 70, 2);   // 向右上推满
step(2);
const t = dbg().touch;
check('方向朝右上（dx>0, dy<0）', t.dx > 0.3 && t.dy < -0.3,
  `dx=${t.dx.toFixed(2)} dy=${t.dy.toFixed(2)}`);

step(40);   // 让它移动约 0.66 秒
const afterX = dbg().player.x;
const afterY = dbg().player.y;
check('玩家向右移动了', afterX > beforeX + 20, `x: ${beforeX.toFixed(0)} -> ${afterX.toFixed(0)}`);
check('玩家向上移动了', afterY < beforeY - 20, `y: ${beforeY.toFixed(0)} -> ${afterY.toFixed(0)}`);

dispatch('pointerup', 150 + 70, 480 - 70, 2);
step(3);
check('松手后摇杆复位', dbg().touch.active === false && dbg().touch.mag === 0);

// --- 4. 点「回声」按钮 ---
console.log('\n4) 点击右下「回声」按钮');
let chargeBefore = dbg().charge;
let echoBefore = dbg().echoes;
dispatch('pointerdown', 864, 504, 3);
dispatch('pointerup', 864, 504, 3);
step(5);
check('召唤出回声（数量+1）', dbg().echoes === echoBefore + 1,
  `${echoBefore} -> ${dbg().echoes}`);
check('能量被扣除', dbg().charge < chargeBefore,
  `${chargeBefore.toFixed(0)} -> ${dbg().charge.toFixed(0)}`);

// --- 5. 点「冲刺」按钮 ---
console.log('\n5) 点击「冲刺」按钮');
dispatch('pointerdown', 764, 538, 4);
dispatch('pointerup', 764, 538, 4);
step(5);
check('冲刺进入冷却', dbg().player.dashCD > 0, 'cd=' + dbg().player.dashCD.toFixed(2));

// --- 6. 能量不足时不应召唤 ---
console.log('\n6) 能量不足时点击「回声」按钮');
let guard = 0;
while (dbg().charge >= 28 && guard++ < 600) {
  dispatch('pointerdown', 864, 504, 20);
  dispatch('pointerup', 864, 504, 20);
  step(6);
}
const eBefore2 = dbg().echoes;
dispatch('pointerdown', 864, 504, 21);
dispatch('pointerup', 864, 504, 21);
step(5);
check('能量不足时不会召唤', dbg().echoes === eBefore2,
  `echoes=${dbg().echoes} charge=${dbg().charge.toFixed(0)}`);

// --- 7. 长时间运行压力测试 ---
console.log('\n7) 长时间运行（模拟 30 秒连续操作）');
try {
  for (let i = 0; i < 30 * 60; i++) {
    if (i % 120 === 0) {
      dispatch('pointerdown', 120, 480, 10);
      dispatch('pointermove', 160 + (i % 80), 430, 10);
    }
    if (i % 120 === 60) dispatch('pointerup', 160, 430, 10);
    if (i % 200 === 0) { dispatch('pointerdown', 864, 504, 11); dispatch('pointerup', 864, 504, 11); }
    if (i % 350 === 0) { dispatch('pointerdown', 764, 538, 12); dispatch('pointerup', 764, 538, 12); }
    step(1);
  }
  check('30 秒连续触屏操作无异常', true);
} catch (e) {
  check('30 秒连续触屏操作无异常', false, e.message);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);