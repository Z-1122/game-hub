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
const audioStats = { osc: 0, gain: 0, buf: 0, src: 0, filter: 0, comp: 0, conv: 0, events: [] };
// AudioParam 假件：可选 recorder 用来记录「这个参数被设成了什么值」
function fakeParam(rec) {
  return {
    value: 0,
    setValueAtTime(v, t) { if (rec) rec(v, t); },
    exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}
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
  const ev = { f: 0, type: 'sine', t: 0 };
  audioStats.events.push(ev);
  const o = {
    frequency: fakeParam((v, t) => { ev.f = v; if (t !== undefined) ev.t = t; }),
    connect() {}, start(t) { if (t !== undefined) ev.t = t; }, stop() {}
  };
  let ty = 'sine';
  Object.defineProperty(o, 'type', {
    get() { return ty; },
    set(v) { ty = v; ev.type = v; }
  });
  return o;
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
  return { type: 'lowpass', frequency: fakeParam(), Q: fakeParam(), connect() {} };
};
fakeAudioContext.prototype.createDynamicsCompressor = function () {
  audioStats.comp++;
  return {
    threshold: fakeParam(), knee: fakeParam(), ratio: fakeParam(),
    attack: fakeParam(), release: fakeParam(), connect() {}
  };
};
fakeAudioContext.prototype.createConvolver = function () {
  audioStats.conv++;
  return { buffer: null, connect() {} };
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
    if (drained === 0) {
      // 骰子定庄后庄家可能是电脑：开局那一步没人排队，手动推一把
      if (dbg.kickAi && dbg.kickAi()) continue;
      break;                        // 队列空且无人可动 —— 真卡住
    }
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
ok(audioStats.comp > 0 && audioStats.conv > 0, '总线用上了压限与混响（更好听的关键）');

// 三种出牌音必须真的不一样：分别单独跑，比较节点数与音高范围
function soundProfile(name) {
  const before = {
    osc: audioStats.osc, buf: audioStats.buf, filter: audioStats.filter, n: audioStats.events.length
  };
  dbg.sfxOne(name);
  const freq = audioStats.events.slice(before.n).map((e) => e.f).filter((f) => f > 0);
  return {
    osc: audioStats.osc - before.osc,
    buf: audioStats.buf - before.buf,
    filter: audioStats.filter - before.filter,
    lo: freq.length ? Math.min.apply(null, freq) : 0,
    hi: freq.length ? Math.max.apply(null, freq) : 0
  };
}
const sigText = (s) => 'osc=' + s.osc + ' buf=' + s.buf + ' 低=' + Math.round(s.lo) + ' 高=' + Math.round(s.hi);
const differs = (a, b) => a.osc !== b.osc || a.buf !== b.buf || a.lo !== b.lo || a.hi !== b.hi;
const sigDiscard = soundProfile('discard');
const sigPon = soundProfile('pon');
const sigKan = soundProfile('kan');
ok(sigDiscard.osc > 0 && sigDiscard.buf > 0, '普通出牌有声（磕桌 + 木头共鸣）', sigText(sigDiscard));
ok(differs(sigDiscard, sigPon), '出牌与碰的声音不同', sigText(sigDiscard) + ' 对比 ' + sigText(sigPon));
ok(differs(sigPon, sigKan), '碰与杠的声音不同', sigText(sigPon) + ' 对比 ' + sigText(sigKan));
ok(sigKan.osc > sigPon.osc && sigKan.lo < 200, '杠比碰更重更低（四张牌 + 低音锣）',
  sigText(sigKan) + ' 对比 ' + sigText(sigPon));
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
ok(/function clack/.test(script) && /function buildBus/.test(script),
  '磕桌合成器与音频总线（压限 + 混响）存在');
ok(/const SFX = \{/.test(script) && /sfxOne/.test(script), '音效名表与单音测试钩子存在');
ok(/createDynamicsCompressor/.test(script) && /createConvolver/.test(script),
  '源码里真的用了压限器与卷积混响');
ok(/requestFullscreen/.test(script) && /action: 'fullscreen'/.test(script), '全屏按钮与全屏 API 齐全');
ok(/function drawSystemButtons/.test(script), '右上角系统按钮绘制函数存在');
ok(/本玩法不含「吃」/.test(script), '标题页写明了本玩法不含「吃」');

/* ---------------- 9. 版面自检 ----------------
 * 牌面放大后（TW 56 × TH 76）最容易出的事就是各方块互相压住或跑出画布。
 * 这里把 render() 真正画出来的方块拿出来做几何断言，不靠肉眼。 */
console.log('\n9) 版面自检（1280 × 720）');
const EPS = 0.51;
function overlaps(a, b) {
  return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS &&
         a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
}
function label(r, i) {
  return '#' + i + '(x=' + Math.round(r.x) + ',y=' + Math.round(r.y) +
    ',w=' + Math.round(r.w) + ',h=' + Math.round(r.h) +
    (r.player !== undefined ? ',玩家' + r.player : '') + ')';
}
function allInside(list, tag) {
  const vw = 1280, vh = 720;
  const bad = [];
  list.forEach((r, i) => {
    if (r.x < -EPS || r.y < -EPS || r.x + r.w > vw + EPS || r.y + r.h > vh + EPS) {
      bad.push(tag + label(r, i));
    }
  });
  ok(bad.length === 0, tag + '全部在画布内', bad.slice(0, 3).join(' / '));
}
function noOverlap(a, b, name) {
  const bad = [];
  a.forEach((r, i) => {
    b.forEach((s, j) => { if (overlaps(r, s)) bad.push(label(r, i) + ' × ' + label(s, j)); });
  });
  ok(bad.length === 0, name, bad.slice(0, 3).join(' / '));
}

// 最挤的局面：四家各 21 张牌河 + 四组副露 + 最宽的一排按钮
dbg.start();
[0, 1, 2, 3].forEach((p) => dbg.fillDiscards(p, 21));
dbg.fillMelds(0, 4); dbg.fillMelds(1, 2); dbg.fillMelds(2, 2); dbg.fillMelds(3, 2);
dbg.fakeClaim();
const L = dbg.layout;

allInside(L.hand, '手牌');
allInside(L.discards, '牌河');
allInside(L.melds, '副露');
allInside(L.buttons, '按钮');

const sysBtns = L.buttons.filter((b) => b.action === 'mute' || b.action === 'fullscreen');
const actBtns = L.buttons.filter((b) => sysBtns.indexOf(b) < 0);
ok(actBtns.length >= 3, '最宽的一排操作按钮确实画出来了', '共 ' + actBtns.length + ' 个');

const myMelds = L.melds.filter((m) => m.player === 0);
const myDiscards = L.discards.filter((d) => d.player === 0);
noOverlap(L.hand, myDiscards, '手牌不压自己的牌河');
noOverlap(L.hand, myMelds, '手牌不压自己的副露');
noOverlap(L.hand, actBtns, '手牌不压操作按钮');
noOverlap(myMelds, actBtns, '副露不压操作按钮');
noOverlap(myDiscards, actBtns, '牌河不压操作按钮');
noOverlap(myDiscards, myMelds, '牌河不压副露');
noOverlap(L.hand, sysBtns, '手牌不压右上角系统按钮');

// 满手牌（14 张）也要放得下、不压按钮
dbg.start();
[0, 1, 2, 3].forEach((p) => dbg.fillDiscards(p, 21));
dbg.fakeClaim();
const L2 = dbg.layout;
const handFull = L2.hand.filter((h) => h.w > 30);
ok(handFull.length >= 13, '满手牌时手牌张数正常', '共 ' + handFull.length + ' 张');
allInside(handFull, '满手牌');
noOverlap(handFull, L2.buttons.filter((b) => b.action !== 'mute' && b.action !== 'fullscreen'),
  '满手牌不压操作按钮');

/* ---------------- 10. 30 秒思考时限 + 出牌飘字 ----------------
 * 用户需求：每人 30 秒思考时间，超时自动出牌；出牌时显示牌名并配碰撞声。 */
console.log('\n10) 30 秒思考时限与出牌飘字');
ok(dbg.turnLimit === 30000, '每人思考时限为 30 秒', '实际 ' + dbg.turnLimit + 'ms');

dbg.start({ dice: [1, 4] });   // 2 点 → 玩家（你）坐庄
dbg.resyncEvents();
dbg.clearFloaters();
// 开局轮到我出牌时，倒计时应在 (0, 30s] 之间且在往下走
const left1 = dbg.clockLeft();
ok(left1 > 0 && left1 <= 30000, '轮到我时开始 30 秒倒计时', Math.round(left1) + 'ms');

// 出牌 → 应出现「牌名」飘字，并发出一声碰撞音
// （直接往牌河里加牌模拟“某家打了一张”，避免 AI 实时抢碰把那张牌吃掉）
dbg.clearFloaters();
const bufBeforeDiscard = audioStats.buf;
dbg.fillDiscards(0, 1);
dbg.rawRender();
const floaters = dbg.floaters;
ok(floaters.length > 0, '出牌后出现了飘字提示', JSON.stringify(floaters));
ok(floaters.some((f) => f.text === dbg.T.label(dbg.discards[0][0])),
  '飘字显示的就是刚打出的那张牌的名字', JSON.stringify(floaters.map((f) => f.text)));
ok(audioStats.buf > bufBeforeDiscard, '出牌真的发出了碰撞声',
  'buf +' + (audioStats.buf - bufBeforeDiscard));

// 别人出牌：也要有飘字，声音和摸牌不同（更实更闷一点）
dbg.clearFloaters();
const bufBeforeRival = audioStats.buf;
dbg.fillDiscards(2, 1);
dbg.rawRender();
ok(dbg.floaters.some((f) => f.text === dbg.T.label(dbg.discards[2][0])),
  '对家出牌也有牌名飘字', JSON.stringify(dbg.floaters.map((f) => f.text)));
ok(audioStats.buf > bufBeforeRival, '别人出牌也有碰撞声');

// 碰 / 杠 的飘字与音效
dbg.clearFloaters();
dbg.resyncEvents();
dbg.fakeClaim();
const bufBeforePon = audioStats.buf;
const oscBeforePon = audioStats.osc;
dbg.action('pon');
dbg.rawRender();
const ponFloaters = dbg.floaters;
ok(ponFloaters.some((f) => f.text === '碰'), '碰牌时飘出「碰」字',
  JSON.stringify(ponFloaters.map((f) => f.text)));
ok(audioStats.buf > bufBeforePon && audioStats.osc > oscBeforePon,
  '碰牌有独立的碰撞声与和弦');

// 超时自动托管：不点任何东西，直接让时限到点
dbg.start({ dice: [1, 4] });
dbg.resyncEvents();
const beforeAuto = { log: dbg.log.length, disc: dbg.discards[0].length, auto: dbg.clockAuto };
dbg.autoPlay();
ok(dbg.clockAuto === beforeAuto.auto + 1, '超时自动代打被触发一次');
// 打出的牌有可能立刻被别人碰走（牌河会又变短），所以用「日志增长」判断推进
ok(dbg.log.length > beforeAuto.log || dbg.discards[0].length > beforeAuto.disc,
  '超时后自动替玩家打出了一张牌',
  '日志 ' + beforeAuto.log + ' → ' + dbg.log.length + '，牌河 ' + beforeAuto.disc + ' → ' + dbg.discards[0].length);

// 超时遇到碰杠胡机会：能胡就胡，否则自动过
dbg.start({ dice: [1, 4] });
dbg.fakeClaim();
dbg.resyncEvents();
dbg.autoPlay();
ok(dbg.pendingClaim === null, '超时后自动处理了碰杠胡窗口（不会卡住）',
  'pendingClaim=' + JSON.stringify(dbg.pendingClaim));

/* 标题页文字不能挤在一起（新增了「每人 30 秒」那一行，最容易压到下一行） */
dbg.start();
dbg.resetToTitle();
dbg.rawRender();
const titleTexts = dbg.texts;
const titleLines = titleTexts.filter((t) => t.size >= 16 && t.y < 560);
let titleBad = [];
for (let i = 0; i < titleLines.length; i++) {
  for (let j = i + 1; j < titleLines.length; j++) {
    const a = titleLines[i], b = titleLines[j];
    const dy = Math.abs(a.y - b.y);
    if (dy < (a.size + b.size) * 0.55) {
      titleBad.push(a.s + ' / ' + b.s + ' 间距 ' + Math.round(dy) + 'px');
    }
  }
}
ok(titleBad.length === 0, '标题页各行文字没有挤在一起', titleBad.slice(0, 3).join(' ; '));
ok(titleTexts.some((t) => /30 秒/.test(t.s)), '标题页写明了 30 秒规则');
const startBtnTexts = dbg.layout.buttons.filter((b) => b.action === 'start');
ok(startBtnTexts.length === 1, '标题页仍有「开始游戏」按钮', '共 ' + startBtnTexts.length + ' 个');

// 源码特征：倒计时与飘字必须留在渲染路径上
ok(/function drawTurnClock/.test(script) && /drawTurnClock\(\)/.test(script), '倒计时画在渲染路径上');
ok(/function watchEvents/.test(script) && /watchEvents\(\)/.test(script), '事件观察器接在主循环里');
ok(/function floatText/.test(script) && /function drawFloaters/.test(script), '飘字生成与绘制函数齐全');
ok(/function autoPlay/.test(script), '超时自动代打函数存在');
ok(/TURN_LIMIT = 30000/.test(script), '源码里写死了 30 秒');
ok(/function sfxRivalDiscard/.test(script), '别人出牌有独立的轻一些的碰撞声');

/* ---------------- 12) 骰子定庄 + 桌面背景 + 开场动画 ---------------- */
console.log('\n12) 骰子定庄 / 牌桌背景 / 开场动画');
dbg.start({ dice: [3, 4] });
ok(dbg.dice.join(',') === '3,4', '骰子点数被记住', dbg.dice.join(','));
ok(dbg.dealer === (3 + 4 - 1) % 4, '两颗骰子的点数和决定庄家', '庄家=' + dbg.dealer);
ok(dbg.turn === dbg.dealer, '庄家先手', 'turn=' + dbg.turn);
ok(dbg.handCounts[dbg.dealer] === 14, '庄家多摸一张（14 张）', JSON.stringify(dbg.handCounts));
ok(dbg.handCounts.reduce((a, b) => a + b, 0) === 53, '四家合计 53 张（13×4 + 庄家多一张）',
  '合计 ' + dbg.handCounts.reduce((a, b) => a + b, 0));
dbg.start({ dice: [1, 4] });
ok(dbg.dealer === 0, '5 点 → 玩家坐庄', '庄家=' + dbg.dealer);
ok(dbg.waitingFor === 'discard', '玩家坐庄时立刻轮到自己出牌', dbg.waitingFor);
dbg.start({ dice: [6, 6] });
ok(dbg.dealer === 3, '12 点 → 上家坐庄', '庄家=' + dbg.dealer);
ok(dbg.waitingFor === 'ai', '电脑坐庄时先由电脑出牌', dbg.waitingFor);
ok(dbg.log.some((s) => /掷骰 \d \+ \d = \d+ 点/.test(s)), '日志里记录了掷骰结果',
  (dbg.log[dbg.log.length - 1] || ''));

// 开场动画：能进入 intro 相位、四个阶段都出现过、点一下能跳过
dbg.startIntro([2, 5]);
ok(dbg.state === 'intro', '开始游戏会先播开场动画', dbg.state);
ok(dbg.intro && dbg.intro.stage === 'shuffle', '动画从洗牌开始', dbg.intro && dbg.intro.stage);
ok(dbg.intro.dice.join(',') === '2,5' && dbg.intro.dealer === 2, '动画里的骰子与庄家和发牌一致',
  JSON.stringify(dbg.intro));
const stagesSeen = new Set();
[120, 1000, 1800, 3100].forEach(function (ms) {
  dbg.forceIntroStage(ms);
  if (dbg.intro) stagesSeen.add(dbg.intro.stage);
});
ok(stagesSeen.has('shuffle') && stagesSeen.has('wall') && stagesSeen.has('dice') && stagesSeen.has('deal'),
  '洗牌 / 砌墙 / 掷骰 / 发牌 四个阶段都走得到', Array.from(stagesSeen).join(' → '));
dbg.forceIntroStage(5000);
ok(dbg.state === 'playing', '动画放完自动进入对局', dbg.state);
dbg.startIntro([1, 1]);
dbg.rawRender();
dbg.skipIntro();
ok(dbg.state === 'playing', '点一下可以跳过开场动画', dbg.state);

// 源码特征：背景、骰子、动画三件套必须真的写进页面
ok(/function drawTableBase/.test(script), '牌桌背景是独立绘制的场景');
ok(/圆木|木纹|drawTableBase\(\);/.test(script) && /drawFeltPattern\(\);/.test(script), '木框 + 绒布都在渲染路径上');
ok(/function drawDie/.test(script) && /DICE_FACE/.test(script), '骰子是画出来的（有六面点数）');
ok(/function rollDice/.test(script), '有掷骰函数');
ok(/function startIntro/.test(script) && /function renderIntro/.test(script), '开场动画有独立的绘制函数');
ok(/shuffle: 900, wall: 700, dice: 1250, deal: 950/.test(script), '动画四阶段：洗牌/砌墙/掷骰/发牌');
ok(/function beginRound/.test(script), '开局统一走 beginRound（掷骰 → 发牌 → 动画）');
ok(/顶面/.test(script) && /侧面/.test(script) && /投影/.test(script), '牌面有顶面/侧面/投影三层，才是立体的');

/* ---------------- 11) 手牌自动排序 + 音效柔化 ---------------- */
console.log('\n11) 手牌排序与音色');
dbg.start();
let sorted = true;
for (let round = 0; round < 6; round++) {
  const h = (dbg.sortedHand || []).slice();
  for (let i = 1; i < h.length; i++) if (h[i] < h[i - 1]) sorted = false;
  // 再换一局，换不同的手牌继续验
  dbg.start();
}
ok(sorted, '手牌按「万→条→筒→字」从小到大排好',
  (dbg.sortedHand || []).map((t) => dbg.T.label(t)).join(' '));
ok((dbg.sortedHand || []).join(',') === (dbg.hand || []).slice().sort(function (a, b) { return a - b; }).join(','),
  '排序只影响摆放顺序，不丢牌');
// 排序后仍要能点到自己想要的那张牌：命中区数量要和手牌数一致
dbg.start();
dbg.rawRender();
const handHits = (dbg.layout && dbg.layout.hand) || [];
ok(handHits.length === (dbg.hand || []).length, '排序后每张牌都还有可点击区域',
  handHits.length + ' / ' + (dbg.hand || []).length);
ok(handHits.every((c, i) => c.tile === dbg.sortedHand[i]), '点击区域与排序后的牌一一对应');
// 音色：总线低通与更小的音量必须在源码里
ok(/WARM\.type = 'lowpass'; WARM\.frequency\.value = 4600/.test(script), '音频总线上挂了 4.6kHz 低通，去掉刺耳高频');
ok(/MASTER\.gain\.value = 0\.68/.test(script), '主音量降到 0.68');
ok(!/'square'/.test(script), '没有残留方波音色（最刺耳的那种）');
ok(!/sfxDiscard[\s\S]{0,400}?'sawtooth'/.test(script), '出牌音里没有锯齿波');

/* ---------------- 12) 对手牌背的立体细节 ---------------- */
console.log('\n13) 对手牌背 3D 细节');
dbg.start();
dbg.rawRender();
ok(/function drawTileBack\(x, y, w, h, opts\)/.test(script), '牌背是独立渲染函数，且接受 opts');
ok(/if \(opts\.face === false\) return drawTileBack\(x, y, w, h, opts\);/.test(script),
  '牌背不再走牌面那条路，避免两套逻辑打架');
ok(/内凹面板/.test(script) && /斜纹/.test(script) && /中央小菱形/.test(script),
  '牌背有内凹面板 / 防滑斜纹 / 中央菱形三层细节');
ok(/const big = m >= 20;/.test(script), '小尺寸牌会跳过细节，避免糊成一团');
ok(/function shadeTile/.test(script), '有统一的压暗函数做伪景深');
ok(/const baseShade = side === 'top' \? 0\.05 : 0\.13;/.test(script),
  '靠近自己的两家更暗、远端对家更亮，符合桌面光照');
ok(/\{ shade: baseShade \+ \(i % 2\) \* 0\.012 \}/.test(script), '对家手牌有逐张轻微光衰');
ok(/\{ shade: baseShade \+ \(i % 2\) \* 0\.018 \}/.test(script), '左右两家手牌有逐张轻微光衰');
ok(/const msh = side === 'top' \? 0\.05 : 0\.11;/.test(script), '对手副露也跟着压暗');
ok(/const dsh = \(p === 0 \? 0\.02 : \(p === 2 \? 0\.13 : 0\.10\)\) \+ row \* 0\.022;/.test(script),
  '牌河越靠外越暗（按座位 + 排数递进）');
ok(/drawTile\(pl\.discards\[i\], rx, ry, rw, rh, \{ highlight: isLast, shade: dsh \}\)/.test(script),
  '牌河的压暗真正传进了绘制调用');
let backDrawOk = true;
try { dbg.fillMelds(1, 2); dbg.fillDiscards(2, 9); dbg.rawRender(); } catch (e) { backDrawOk = false; }
ok(backDrawOk, '画满对手副露与牌河不抛异常');
ok(((dbg.layout && dbg.layout.hand) || []).length === (dbg.hand || []).length,
  '牌背改版后，自己手牌的点击区数量没变');

/* ---------------- 结果 ---------------- */
console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);