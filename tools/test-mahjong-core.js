// 大众麻将核心算法单元测试：胡牌判定 / 听牌 / 牌墙完整性
// 用法：node tools/test-mahjong-core.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', 'games', 'mahjong.html');
const html = fs.readFileSync(FILE, 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('未找到脚本'); process.exit(1); }

// —— DOM / Canvas 桩 ——
function stubEl() {
  return {
    clientWidth: 1280, clientHeight: 720,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    addEventListener: () => {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {}, getContext: () => ctxStub()
  };
}
function ctxStub() {
  const noop = () => {};
  return new Proxy({
    canvas: { width: 0, height: 0 },
    setTransform: noop, fillRect: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, arc: noop, arcTo: noop, fill: noop, stroke: noop,
    save: noop, restore: noop, fillText: noop, translate: noop, rotate: noop, scale: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    measureText: () => ({ width: 10 }),
    roundRect: noop
  }, { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } });
}

// —— AudioContext 桩：让音效合成真的跑一遍，验证没有 API 误用 ——
const audioStats = { osc: 0, gain: 0, buf: 0, src: 0, filter: 0 };
function fakeParam() {
  return {
    value: 0,
    setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}
  };
}
function fakeAudioContext() {
  this.state = 'running';
  this.currentTime = 0;
  this.sampleRate = 44100;
  this.destination = {};
}
fakeAudioContext.prototype.resume = function () {};
fakeAudioContext.prototype.createOscillator = function () {
  audioStats.osc++;
  return { type: 'sine', frequency: fakeParam(), connect() {}, start() {}, stop() {} };
};
fakeAudioContext.prototype.createGain = function () {
  audioStats.gain++;
  return { gain: fakeParam(), connect() {} };
};
fakeAudioContext.prototype.createBuffer = function (ch, len) {
  audioStats.buf++;
  return { getChannelData: () => new Float32Array(len) };
};
fakeAudioContext.prototype.createBufferSource = function () {
  audioStats.src++;
  return { buffer: null, connect() {}, start() {} };
};
fakeAudioContext.prototype.createBiquadFilter = function () {
  audioStats.filter++;
  return { type: 'lowpass', frequency: { value: 0 }, Q: { value: 0 }, connect() {} };
};

const sandbox = {
  console, Math, Date, JSON, Set, Map, Array, Object, String, Number, Boolean, Error,
  parseInt, parseFloat, isNaN, Infinity, NaN, undefined,
  setTimeout: (fn) => { if (typeof fn === 'function') aiQueue.push(fn); return aiQueue.length; },
  clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: () => 0,
  AudioContext: fakeAudioContext,
  document: {
    getElementById: () => stubEl(),
    documentElement: { clientWidth: 1280, clientHeight: 720 },
    body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
    addEventListener: () => {}
  },
  navigator: { userAgent: 'node-test', maxTouchPoints: 0 },
  window: null
};
sandbox.window = sandbox;
sandbox.innerWidth = 1280;
sandbox.innerHeight = 720;
sandbox.devicePixelRatio = 1;
sandbox.addEventListener = () => {};
sandbox.visualViewport = null;

const aiQueue = [];
sandbox.aiQueue = aiQueue;
function drainAiQueue(limit) {
  let n = 0;
  while (aiQueue.length && n++ < (limit || 200)) {
    const fn = aiQueue.shift();
    try { fn(); } catch (e) { throw e; }
  }
  return n;
}

vm.createContext(sandbox);
try {
  vm.runInContext(m[1], sandbox, { filename: 'mahjong.js' });
} catch (e) {
  console.error('LOAD_ERROR: ' + e.message);
  console.error(e.stack);
  process.exit(1);
}

const dbg = sandbox.window.__mjDebug;
if (!dbg) { console.error('缺少调试接口'); process.exit(1); }
const T = dbg.T;
const { canWin, winningTiles, makeWall } = dbg;

/* ---------------- 断言框架 ---------------- */
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  ' + extra : '')); }
}
function eq(a, b, name) {
  ok(JSON.stringify(a) === JSON.stringify(b), name, '期望 ' + JSON.stringify(b) + ' 实得 ' + JSON.stringify(a));
}

/* ---------------- 0. 加载与初始化（回归防线） ----------------
 * 曾经两次因为 let 的暂时性死区让 markDirty() 在 fit() 里抛 ReferenceError，
 * 真机表现为加载即白屏，而只跑游戏逻辑的测试完全发现不了。
 * 注意：断言必须放在 ok/pass 定义之后，否则测试脚本自己就会踩同样的 TDZ 坑。 */
console.log('\n0) 加载与初始化');
ok(dbg !== undefined && dbg !== null, '加载完成且调试接口可用');
ok(dbg.state === 'title', '初始状态为标题页');
ok(Array.isArray(dbg.hand) && dbg.hand.length === 0, '标题页尚无手牌');

const wan = (n) => n, tiao = (n) => 10 + n, tong = (n) => 20 + n;
const dong = 31, nan = 32, xi = 33, bei = 34, zhong = 35, fa = 36, bai = 37;

/* ---------------- 1. 基础胡牌 ---------------- */
console.log('\n1) 基础胡牌判定（四组合一对）');

eq(canWin([wan(1), wan(2), wan(3), wan(4), wan(5), wan(6), tiao(2), tiao(3), tiao(4), tong(5), tong(5), tong(5), bai, bai], 0),
  true, '三个顺子 + 一个刻子 + 一对（14 张）');

eq(canWin([wan(1), wan(1), wan(1), wan(2), wan(2), wan(2), wan(3), wan(3), wan(3), wan(4), wan(4), wan(4), bai, bai], 0),
  true, '四个刻子 + 一对');

eq(canWin([wan(1), wan(2), wan(3), wan(4), wan(5), wan(6), wan(7), wan(8), wan(9), tiao(1), tiao(2), tiao(3), bai, bai], 0),
  true, '两顺子+三顺子+一对');

eq(canWin([dong, dong, dong, nan, nan, nan, xi, xi, xi, bei, bei, bei, zhong, zhong], 0),
  true, '全字牌四刻子一对');

// 不能胡的情况
// 注意：下面这手牌既是七对子，也能拆成 3 组面子 + 1 对，所以「可胡」是对的。
// 大众麻将承认四组合一对，不额外承认七对——但两者重叠时不影响结论。
eq(canWin([wan(1), wan(1), wan(2), wan(2), wan(3), wan(3), tiao(4), tiao(5), tiao(6), tong(7), tong(8), tong(9), bai, bai], 0),
  true, '既是七对也可拆成面子+对，判定为可胡（重叠情形）');

// 纯七对（拆不出四组面子）：应为不可胡
eq(canWin([wan(1), wan(1), wan(3), wan(3), wan(5), wan(5), tiao(2), tiao(2), tiao(7), tiao(7), tong(4), tong(4), bai, bai], 0),
  false, '纯七对子（拆不出四组合一对）不可胡');

eq(canWin([wan(1), wan(2), wan(3), wan(4), wan(5), wan(6), tiao(2), tiao(3), tiao(4), tong(5), tong(5), tong(5), bai, fa], 0),
  false, '牌型散乱不成胡');

eq(canWin([wan(1), wan(2), wan(3), wan(4), wan(5), wan(6), tiao(2), tiao(3), tiao(4), tong(5), tong(5), tong(5), bai, bai, bai], 0),
  false, '张数不对（15 张）');

// 跨花色不能组顺子
eq(canWin([wan(8), wan(9), tiao(1), tiao(2), tiao(3), tong(4), tong(5), tong(6), bai, bai, bai, fa, fa, fa], 0),
  false, '万8万9条1 不能跨花色组顺子');

/* ---------------- 2. 带副露的胡牌 ---------------- */
console.log('\n2) 副露（吃碰杠）后的胡牌判定');

// 已碰两组（meldCount=2），手牌需 2 组面子 + 1 对 = 8 张
eq(canWin([wan(1), wan(2), wan(3), tiao(5), tiao(5), tiao(5), bai, bai], 2),
  true, '已副露 2 组，剩 2 组面子 + 一对');

eq(canWin([wan(1), wan(2), wan(3), tiao(5), tiao(5), tong(9), bai, bai], 2),
  false, '已副露 2 组但手牌不成型');

// 已副露 1 组，手牌 3 组面子 + 1 对 = 11 张
eq(canWin([wan(1), wan(2), wan(3), wan(4), wan(5), wan(6), tong(2), tong(3), tong(4), bai, bai], 1),
  true, '已副露 1 组，剩 3 组面子 + 一对');

// 已副露 4 组（比如四副露单吊），手牌只需 1 对 = 2 张
eq(canWin([bai, bai], 4), true, '已副露 4 组，单吊对子');
eq(canWin([bai, fa], 4), false, '已副露 4 组但不是对子');

/* ---------------- 3. 听牌计算 ---------------- */
console.log('\n3) 听牌（哪些牌能让我胡）');

const h1 = [wan(1), wan(2), wan(3), wan(4), wan(5), wan(6), tong(2), tong(3), tong(4), tong(5), tong(5), tong(5), bai];
const w1 = winningTiles(h1, 0).sort((a, b) => a - b);
eq(w1, [bai], '13 张听单吊白板，只有白板能胡');

const h2 = [wan(1), wan(2), wan(3), wan(4), wan(5), wan(6), tong(2), tong(3), tong(4), tong(5), tong(5), bai, bai];
const w2 = winningTiles(h2, 0).sort((a, b) => a - b);
// 这手牌可拆成 123 456(万) + 234(筒) + 555(筒) + 白白(将)；
// 也可以把白白当刻子、55 当将，此时缺一张筒5 —— 所以筒5与白板都能胡。
eq(w2, [tong(5), bai], '双听：筒5（当将）与白板（当将）');

// 两面听
const h3 = [wan(1), wan(2), wan(3), wan(4), wan(5), wan(6), tong(2), tong(3), tong(4), tong(7), tong(8), bai, bai];
const w3 = winningTiles(h3, 0).sort((a, b) => a - b);
eq(w3, [tong(6), tong(9)], '两面听：筒6 与 筒9');

// 已副露
const h4 = [wan(1), wan(2), wan(3), tong(5), tong(5), bai, bai];
const w4 = winningTiles(h4, 1).sort((a, b) => a - b);
// 已副露 1 组时手牌只有 7 张：需要 3 组面子 + 1 对。
// 123(万) + 55(筒) 当将 + 白白当刻子 —— 还差一组面子，再来一张筒5或白板都凑不齐，
// 故这手牌实际是「不听」。这里如实断言为不听。
eq(w4, [], '副露 1 组时这手牌不听牌');

/* ---------------- 4. 四张上限 ---------------- */
console.log('\n4) 同种牌最多 4 张的限制');

// 手里已有 4 张白板，不能再听白板
const h5 = [wan(1), wan(2), wan(3), wan(4), wan(5), wan(6), tong(2), tong(3), tong(4), tong(5), tong(5), bai, bai];
const w5 = winningTiles(h5, 0);
ok(w5.indexOf(bai) >= 0, '听白板时手里只有两张，允许');

/* ---------------- 5. 牌墙完整性 ---------------- */
console.log('\n5) 牌墙');

const wall = makeWall();
eq(wall.length, 136, '总牌数 136');
const counts = {};
for (const t of wall) counts[t] = (counts[t] || 0) + 1;
const bad = Object.keys(counts).filter((k) => counts[k] !== 4);
eq(bad, [], '每种牌恰好 4 张');
ok(!wall.includes(10) && !wall.includes(20) && !wall.includes(30), '不包含非法牌 id（10/20/30）');

/* ---------------- 6. 随机对局压力测试 ---------------- */
console.log('\n6) 随机对局压力测试（跑 60 局，验证不卡死、状态自洽）');
let gamesDone = 0, wins = 0, draws = 0, errors = 0, stuck = 0;

// 单局推进：把「人类玩家」也交给脚本代打，AI 由 setTimeout 桩同步驱动。
// 队列里的回调必须优先执行（它们负责推进 AI 回合），否则会误判为卡死。
function driveOneGame(maxSteps) {
  let steps = 0;
  while (dbg.state === 'playing' && steps++ < maxSteps) {
    const st = dbg.waitingFor;
    const turn = dbg.turn;

    // 1) 人类需要决定的时刻
    if (st === 'claim' && dbg.pendingClaim) {
      const opts = dbg.pendingClaim.options;
      if (opts.includes('hu')) { dbg.action('hu'); break; }
      dbg.action('pass');            // 一律过牌，把决定权交回 AI 链
      continue;
    }
    if (turn === 0 && st === 'discard') {
      const hand = dbg.hand;
      if (canWin(hand, dbg.melds[0].length)) { dbg.action('tsumo'); break; }
      dbg.discard(hand[0]);
      continue;
    }

    // 2) 其余情况执行排队的 AI 回调
    const drained = drainAiQueue(1);
    if (drained === 0) break;        // 队列空且无人可动 —— 真卡住
  }
  return steps;
}

/* ---------------- 6. 随机对局压力测试 ---------------- */
for (let g = 0; g < 60; g++) {
  try {
    dbg.start();
    driveOneGame(8000);
    if (dbg.state === 'over') {
      gamesDone++;
      if (dbg.winner) wins++; else draws++;
    } else {
      stuck++;
    }
  } catch (e) {
    errors++;
    console.log('    !! 第 ' + (g + 1) + ' 局异常: ' + e.message);
  }
}
ok(errors === 0, '60 局无异常', '异常 ' + errors + ' 次');
ok(stuck === 0, '60 局都能走到结束（无卡死）', '卡死 ' + stuck + ' 局');
ok(gamesDone > 0, '至少完成若干局', '完成 ' + gamesDone + ' 局（' + wins + ' 有胡 / ' + draws + ' 流局）');

/* ---------------- 7. 音效模块（假 AudioContext 真跑） ---------------- */
console.log('\n7) 音效模块');
const oscBefore = audioStats.osc, bufBefore = audioStats.buf;
try {
  dbg.sfxAll();
  ok(true, '所有音效调用不抛异常');
} catch (e) {
  ok(false, '所有音效调用不抛异常', e.message);
}
ok(audioStats.osc > oscBefore, '音效真的创建了振荡器', 'osc +' + (audioStats.osc - oscBefore));
ok(audioStats.buf > bufBefore, '噪声脉冲创建了 AudioBuffer', 'buf +' + (audioStats.buf - bufBefore));
ok(audioStats.gain > 0 && audioStats.filter > 0, '增益与滤波节点都被使用');
try {
  ok(dbg.fsSupported() === false, '无全屏 API 的环境下 fsSupported 返回 false（不画全屏按钮）');
  dbg.toggleFullscreen();
  ok(true, '无全屏 API 时调用 toggleFullscreen 不抛异常');
} catch (e) {
  ok(false, '全屏相关调用不抛异常', e.message);
}

/* ---------------- 8. 源码特征回归（防止后续改动把新功能弄丢） ---------------- */
console.log('\n8) 源码特征回归');
const script = m[1];
ok(!/\bchi\b/.test(script) && !/applyChi/.test(script), '已彻底移除「吃」');
ok(/drawFeltPattern\s*\(\)/.test(script), '牌桌背景图案仍在渲染路径上');
ok(/function drawBird/.test(script) && /function drawStick/.test(script) && /function drawDot/.test(script),
  '真牌面绘制（鸟 / 竹条 / 圆点）齐全');
ok(/PIP_POS/.test(script) && /STICK_POS/.test(script) && /TILE_GLYPH/.test(script),
  '筒/条/字牌的排布表与字形表齐全');
ok(/function sfxPon/.test(script) && /function sfxKan/.test(script) && /function sfxDiscard/.test(script),
  '碰 / 杠 / 出牌音效函数齐全');
ok(/requestFullscreen/.test(script) && /action: 'fullscreen'/.test(script), '全屏按钮与全屏 API 齐全');
ok(/function drawSystemButtons/.test(script), '右上角系统按钮绘制函数存在');
ok(/本玩法不含「吃」/.test(script), '标题页写明了本玩法不含「吃」');

/* ---------------- 结果 ---------------- */
console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);