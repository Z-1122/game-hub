/* ============================================================
 *  大众麻将 · 同构规则核心（零依赖，服务端与浏览器共用）
 *
 *  职责：牌模型 / 判胡 / 听牌 / 动作校验 / AI 决策 / 权威状态机
 *  不做：渲染、音效、定时器、网络——这些由调用方负责
 *
 *  用法：
 *    服务端  const Core = require('./mahjong-core.js');
 *    浏览器  <script src="mahjong-core.js"></script>  → window.MahjongCore
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MahjongCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------- 一、牌的数据模型 ----------------
   * 万 1-9   → 1..9
   * 条 1-9   → 11..19
   * 筒 1-9   → 21..29
   * 字 东..白 → 31..37
   */
  const SUITS = ['wan', 'tiao', 'tong'];
  const HONORS = ['dong', 'nan', 'xi', 'bei', 'zhong', 'fa', 'bai'];
  const HONOR_CN = { dong: '东', nan: '南', xi: '西', bei: '北', zhong: '中', fa: '发', bai: '白' };
  const NUM_CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

  const T = {
    suitOf: (t) => (t <= 9 ? 'wan' : t <= 19 ? 'tiao' : t <= 29 ? 'tong' : 'honor'),
    numOf: (t) => (t <= 9 ? t : t <= 19 ? t - 10 : t <= 29 ? t - 20 : 0),
    isHonor: (t) => t >= 31,
    label: (t) => {
      if (t <= 9) return NUM_CN[t] + '万';
      if (t <= 19) return NUM_CN[t - 10] + '条';
      if (t <= 29) return NUM_CN[t - 20] + '筒';
      return HONOR_CN[HONORS[t - 31]];
    },
    short: (t) => {
      if (t <= 9) return String(t) + '万';
      if (t <= 19) return String(t - 10) + '条';
      if (t <= 29) return String(t - 20) + '筒';
      return HONOR_CN[HONORS[t - 31]];
    }
  };

  const VALID_TILES = (function () {
    const a = [];
    for (let t = 1; t <= 37; t++) if (t !== 10 && t !== 20 && t !== 30) a.push(t);
    return a;
  })();

  /* ---------------- 二、牌墙与洗牌 ---------------- */

  function makeWall() {
    const w = [];
    for (const s of SUITS) {
      for (let n = 1; n <= 9; n++) {
        const t = s === 'wan' ? n : s === 'tiao' ? 10 + n : 20 + n;
        for (let k = 0; k < 4; k++) w.push(t);
      }
    }
    for (let i = 0; i < 7; i++) for (let k = 0; k < 4; k++) w.push(31 + i);
    return w;
  }

  function shuffle(a, rnd) {
    const r = rnd || Math.random;
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function sortHand(h) { h.sort((a, b) => a - b); return h; }

  /* ---------------- 三、胡牌判定 ----------------
   * 目标牌型：4 组面子 + 1 对将
   * 副露已凑满的面子数用 meldCount 计入，手牌里再拆 (4-meldCount) 组面子 + 1 对将
   */

  function canFormSets(counts, needSets) {
    if (needSets === 0) return true;
    let i = 0;
    while (i < 38 && counts[i] === 0) i++;
    if (i >= 38) return false;

    // 刻子
    if (counts[i] >= 3) {
      counts[i] -= 3;
      const ok = canFormSets(counts, needSets - 1);
      counts[i] += 3;
      if (ok) return true;
    }

    // 顺子（只能数牌，且不超过 7，保证 i+2 同花色）
    const suit = T.suitOf(i);
    const num = T.numOf(i);
    if (suit !== 'honor' && num <= 7 && needSets > 0 && counts[i + 1] > 0 && counts[i + 2] > 0) {
      counts[i]--; counts[i + 1]--; counts[i + 2]--;
      const ok = canFormSets(counts, needSets - 1);
      counts[i]++; counts[i + 1]++; counts[i + 2]++;
      if (ok) return true;
    }

    return false;
  }

  function canWin(hand, meldCount) {
    const need = 4 - (meldCount || 0);
    const counts = new Array(38).fill(0);
    for (const t of hand) counts[t]++;

    if (hand.length !== need * 3 + 2) return false;

    for (let p = 1; p <= 37; p++) {
      if (counts[p] >= 2) {
        counts[p] -= 2;
        const ok = canFormSets(counts, need);
        counts[p] += 2;
        if (ok) return true;
      }
    }
    return false;
  }

  // 列出所有可胡的牌
  function winningTiles(hand, meldCount) {
    const res = [];
    for (const t of VALID_TILES) {
      const used = hand.filter((x) => x === t).length;
      if (used >= 4) continue;
      if (canWin(hand.concat([t]), meldCount)) res.push(t);
    }
    return res;
  }

  // 打掉某张后是否听牌 → Map(tile → 听牌数组)
  function tenpaiAfterDiscard(hand, meldCount) {
    const out = new Map();
    const seen = new Set();
    for (const d of hand) {
      if (seen.has(d)) continue;
      seen.add(d);
      const rest = hand.slice();
      rest.splice(rest.indexOf(d), 1);
      const w = winningTiles(rest, meldCount);
      if (w.length) out.set(d, w);
    }
    return out;
  }

  /* ---------------- 四、AI 策略 ---------------- */

  function tileValue(hand, tile) {
    const counts = new Array(38).fill(0);
    for (const t of hand) counts[t]++;
    const c = counts[tile];
    let v = 0;
    if (c >= 3) v += 100;
    if (c === 2) v += 40;
    if (T.isHonor(tile)) {
      v += c > 1 ? 20 : 0;
      return v;
    }
    const n = T.numOf(tile), base = tile - n;
    for (let d = -2; d <= 2; d++) {
      if (d === 0) continue;
      const nn = n + d;
      if (nn >= 1 && nn <= 9 && counts[base + nn] > 0) v += Math.abs(d) === 1 ? 12 : 6;
    }
    if (n >= 3 && n <= 7) v += 6;
    return v;
  }

  // 电脑选一张打出去：优先听牌，其次打最没用的
  function aiChooseDiscard(hand, meldCount) {
    const tp = tenpaiAfterDiscard(hand, meldCount);
    if (tp.size) {
      let best = null, bestN = -1;
      for (const [d, w] of tp) {
        if (w.length > bestN) { bestN = w.length; best = d; }
      }
      if (best != null) return best;
    }
    const uniq = Array.from(new Set(hand));
    let worst = uniq[0], worstV = Infinity;
    for (const t of uniq) {
      const v = tileValue(hand, t);
      if (v < worstV) { worstV = v; worst = t; }
    }
    return worst;
  }

  /* ---------------- 五、权威对局状态机 ----------------
   * 所有方法都不涉及渲染与定时器；需要“稍后再做”的地方用返回值 / 回调交给宿主
   */

  const SEAT_NAMES = ['东', '南', '西', '北'];

  function canClaim(hand, meldCount, tile) {
    const same = hand.filter((x) => x === tile).length;
    const opts = [];
    if (same >= 2) opts.push('pon');
    if (same >= 3) opts.push('kan');
    if (canWin(hand.concat([tile]), meldCount)) opts.push('hu');
    return opts;
  }

  /* 创建一局。seats: [{ id, name, isAI }...] 长度必须为 4 */
  function createRound(playerMeta, rnd) {
    const wall = shuffle(makeWall(), rnd);
    const players = playerMeta.map((m, i) => ({
      seat: i,
      id: m.id,
      name: m.name || SEAT_NAMES[i],
      isAI: !!m.isAI,
      hand: [],
      melds: [],
      discards: [],
      drawn: null
    }));

    // 发牌：每人 13 张
    for (let r = 0; r < 13; r++) {
      for (let p = 0; p < 4; p++) players[p].hand.push(wall.shift());
    }
    for (const p of players) sortHand(p.hand);

    // 掷骰定庄：两颗骰子的点数和决定庄家（和 1/5/9 是自己，2/6/10 是下家…）
    const R = typeof rnd === 'function' ? rnd : Math.random;
    const dice = [1 + Math.floor(R() * 6), 1 + Math.floor(R() * 6)];
    const dealer = (dice[0] + dice[1] - 1) % 4;

    return {
      wall: wall,
      players: players,
      dice: dice,
      dealer: dealer,
      turn: dealer,
      phase: 'playing',        // playing | over
      lastDiscard: null,       // { tile, from }
      pendingClaim: null,      // { from, tile, options:[seat...], asked:[...] }
      winner: null,
      log: [],
      roundNo: 1,
      events: []               // 供宿主播声音/动画的事件流
    };
  }

  function pushLog(g, s) {
    g.log.push(s);
    if (g.log.length > 40) g.log.shift();
  }

  function pushEvent(g, type, data) {
    g.events.push(Object.assign({ type: type }, data || {}));
  }

  function drawTile(g, p) {
    if (g.wall.length === 0) {
      endRound(g, null, '流局：牌摸完了');
      return null;
    }
    const t = g.wall.shift();
    const pl = g.players[p];
    pl.hand.push(t);
    pl.drawn = t;
    pushEvent(g, 'draw', { seat: p });
    return t;
  }

  function endRound(g, winner, reason) {
    g.phase = 'over';
    g.winner = winner;
    pushLog(g, reason || '本局结束');
    pushEvent(g, 'over', { winner: winner, reason: reason });
  }

  /* 出牌。返回 {ok:true} 或 {ok:false,error} */
  function discard(g, p, tile) {
    if (g.phase !== 'playing') return { ok: false, error: '本局已结束' };
    if (g.turn !== p) return { ok: false, error: '还没轮到你' };
    const pl = g.players[p];
    const idx = pl.hand.indexOf(tile);
    if (idx < 0) return { ok: false, error: '你手上没有这张牌' };

    pl.hand.splice(idx, 1);
    sortHand(pl.hand);
    pl.discards.push(tile);
    pl.drawn = null;
    g.lastDiscard = { tile: tile, from: p };
    pushEvent(g, 'discard', { seat: p, tile: tile });
    g.turn = (p + 1) % 4;
    return { ok: true };
  }

  /* 某家对刚打出的牌能做什么（只算能碰/杠/胡，本玩法不含吃） */
  function claimFor(g, seat, tile) {
    const pl = g.players[seat];
    return canClaim(pl.hand, pl.melds.length, tile);
  }

  /* 出牌后，算出哪些座位可以响应（胡 > 杠 > 碰 的优先级由 resolveClaims 决定） */
  function openClaimWindow(g) {
    if (!g.lastDiscard) return { asked: [] };
    const from = g.lastDiscard.from, tile = g.lastDiscard.tile;
    const asked = [];
    for (let k = 1; k <= 3; k++) {
      const s = (from + k) % 4;
      const opts = claimFor(g, s, tile);
      if (opts.length) asked.push({ seat: s, options: opts });
    }
    g.pendingClaim = asked.length ? { from: from, tile: tile, asked: asked, replies: {} } : null;
    pushEvent(g, 'claimWindow', { from: from, tile: tile, asked: asked });
    return g.pendingClaim || { asked: [] };
  }

  function applyPon(g, p, from, tile) {
    const pl = g.players[p];
    for (let k = 0; k < 2; k++) {
      const i = pl.hand.indexOf(tile);
      if (i < 0) return false;
      pl.hand.splice(i, 1);
    }
    pl.melds.push({ type: 'pon', tiles: [tile, tile, tile], from: from });
    g.players[from].discards.pop();
    g.lastDiscard = null;
    pl.drawn = null;
    g.turn = p;
    pushLog(g, pl.name + ' 碰了 ' + T.short(tile));
    pushEvent(g, 'pon', { seat: p, tile: tile, from: from });
    return true;
  }

  function applyKan(g, p, from, tile, concealed) {
    const pl = g.players[p];
    if (concealed) {
      for (let k = 0; k < 4; k++) {
        const i = pl.hand.indexOf(tile);
        if (i < 0) return false;
        pl.hand.splice(i, 1);
      }
      pl.melds.push({ type: 'kan', tiles: [tile, tile, tile, tile], from: p, concealed: true });
      pushLog(g, pl.name + ' 暗杠 ' + T.short(tile));
    } else {
      for (let k = 0; k < 3; k++) {
        const i = pl.hand.indexOf(tile);
        if (i < 0) return false;
        pl.hand.splice(i, 1);
      }
      pl.melds.push({ type: 'kan', tiles: [tile, tile, tile, tile], from: from });
      g.players[from].discards.pop();
      g.lastDiscard = null;
      pl.drawn = null;
      pushLog(g, pl.name + ' 杠了 ' + T.short(tile));
    }
    g.turn = p;
    pushEvent(g, 'kan', { seat: p, tile: tile, from: from, concealed: !!concealed });
    // 杠后补一张
    const t = drawTile(g, p);
    return t;
  }

  function declareWin(g, p, tile, from, selfDraw) {
    const pl = g.players[p];
    if (!selfDraw && tile != null) pl.hand.push(tile);
    sortHand(pl.hand);
    g.phase = 'over';
    g.winner = { seat: p, tile: tile, from: from, selfDraw: !!selfDraw };
    g.pendingClaim = null;
    pushLog(g, pl.name + (selfDraw ? ' 自摸！' : ' 胡了 ' + T.short(tile) + '！'));
    pushEvent(g, 'win', { seat: p, tile: tile, selfDraw: !!selfDraw, from: from });
  }

  /* 提交一次响应。返回后续动作指令，宿主据此继续推进 */
  function submitClaim(g, seat, action) {
    const pc = g.pendingClaim;
    if (!pc) return { ok: false, error: '现在没有可响应的牌' };
    const me = pc.asked.find((a) => a.seat === seat);
    if (!me) return { ok: false, error: '你不能响应这张牌' };
    if (action !== 'pass' && me.options.indexOf(action) < 0) {
      return { ok: false, error: '你不能这么做' };
    }
    pc.replies[seat] = action === 'pass' ? 'pass' : action;
    return { ok: true };
  }

  /* 判定所有已响应者的结果：胡 > 杠 > 碰 > 都过
   * 返回 { action, seat } 或 null（还有人在等） */
  function resolveClaims(g) {
    const pc = g.pendingClaim;
    if (!pc) return { action: 'none' };
    const pending = pc.asked.filter((a) => pc.replies[a.seat] === undefined);
    if (pending.length) return null;                 // 还在等人回话

    const pick = (name) => {
      for (const a of pc.asked) if (pc.replies[a.seat] === name) return a.seat;
      return -1;
    };
    // 优先级：胡（离出牌者最近的下家优先）> 杠 > 碰
    for (const kind of ['hu', 'kan', 'pon']) {
      const seat = pick(kind);
      if (seat >= 0) return { action: kind, seat: seat, from: pc.from, tile: pc.tile };
    }
    return { action: 'pass', from: pc.from, tile: pc.tile };
  }

  /* 一次回合推进：给当前行动者摸牌，并判断自摸/暗杠
   * 返回 { needDiscard: seat } 表示轮到这家出牌（宿主让其决策） */
  function beginTurn(g) {
    if (g.phase !== 'playing') return { done: true };
    const p = g.turn;
    const pl = g.players[p];
    const t = drawTile(g, p);
    if (g.phase !== 'playing') return { over: true };

    const selfWin = canWin(pl.hand, pl.melds.length);
    const counts = new Array(38).fill(0);
    for (const x of pl.hand) counts[x]++;
    let ankan = -1;
    for (let x = 1; x <= 37; x++) if (counts[x] === 4) { ankan = x; break; }

    return {
      seat: p,
      drawn: t,
      canTsumo: selfWin,
      canAnkan: ankan,
      needDiscard: true
    };
  }

  /* 只给某一座位看的公开状态（手牌只含自己的） */
  function viewFor(g, seat) {
    const me = g.players[seat];
    const pc = g.pendingClaim;
    let claim = null;
    if (pc && seat !== pc.from) {
      const mine = pc.asked.find((a) => a.seat === seat);
      if (mine && pc.replies[seat] === undefined) {
        claim = { tile: pc.tile, from: pc.from, options: mine.options };
      }
    }
    return {
      seat: seat,
      phase: g.phase,
      turn: g.turn,
      dice: g.dice,
      dealer: g.dealer,
      roundNo: g.roundNo,
      waitingFor: g.phase === 'playing' ? (claim ? 'claim' : (g.turn === seat ? 'me' : 'other')) : 'none',
      wallLeft: g.wall.length,
      lastDiscard: g.lastDiscard,
      claim: claim,
      winner: g.winner,
      log: g.log.slice(-6),
      players: g.players.map((pl, i) => {
        const mine2 = i === seat;
        // 牌局结束后亮出赢家的手牌（其他家仍然隐藏）
        const reveal = mine2 || (g.phase === 'over' && g.winner && g.winner.seat === i);
        return {
          seat: i,
          name: pl.name,
          isAI: pl.isAI,
          handCount: pl.hand.length,
          melds: pl.melds,
          discards: pl.discards,
          hand: reveal ? pl.hand.slice() : null,
          drawn: mine2 ? pl.drawn : null
        };
      })
    };
  }

  return {
    T: T,
    SUITS: SUITS,
    HONORS: HONORS,
    SEAT_NAMES: SEAT_NAMES,
    VALID_TILES: VALID_TILES,
    makeWall: makeWall,
    shuffle: shuffle,
    sortHand: sortHand,
    canWin: canWin,
    winningTiles: winningTiles,
    tenpaiAfterDiscard: tenpaiAfterDiscard,
    tileValue: tileValue,
    aiChooseDiscard: aiChooseDiscard,
    canClaim: canClaim,
    createRound: createRound,
    beginTurn: beginTurn,
    discard: discard,
    openClaimWindow: openClaimWindow,
    submitClaim: submitClaim,
    resolveClaims: resolveClaims,
    applyPon: applyPon,
    applyKan: applyKan,
    declareWin: declareWin,
    endRound: endRound,
    viewFor: viewFor,
    pushLog: pushLog,
    pushEvent: pushEvent
  };
});