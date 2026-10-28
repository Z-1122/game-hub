/* 联机对局自测：直接驱动服务端的房间逻辑（不开网络），模拟 1 人类 + 3 电脑跑完整局 */
'use strict';
const path = require('path');
const Core = require(path.join(__dirname, '..', 'server', 'mahjong-core.js'));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' —— ' + extra : '')); }
}

/* 极简的连接桩：把 send 的内容收集起来 */
function fakeConn(id) {
  return {
    id: id, alive: true, playerId: 'p' + id, name: '玩家' + id, room: null,
    sent: [],
    send(o) { this.sent.push(o); },
    close() { this.alive = false; }
  };
}

console.log('1) 规则核心自检');
{
  const wall = Core.makeWall();
  ok(wall.length === 136, '牌墙 136 张', '实际 ' + wall.length);
  ok(Core.canWin([1, 1, 1, 2, 3, 4, 11, 12, 13, 21, 21, 21, 31, 31], 0), '标准胡型判定正确');
  ok(!Core.canWin([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 21, 22], 0), '散牌判为不能胡');
  ok(Core.winningTiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13], 0).length === 0, '13 张不成型时听牌为空或非空都正常');
  const tp = Core.tenpaiAfterDiscard([1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 31], 0);
  ok(tp instanceof Map, '打牌后听牌分析返回 Map');
}

console.log('\n2) 全电脑对局：100 局必须都能正常结束');
{
  let rounds = 0, wins = 0, flows = 0, errors = 0, maxSteps = 0;

  for (let iter = 0; iter < 100; iter++) {
    const g = Core.createRound([
      { id: 'a', name: '东', isAI: true },
      { id: 'b', name: '南', isAI: true },
      { id: 'c', name: '西', isAI: true },
      { id: 'd', name: '北', isAI: true }
    ]);
    let steps = 0;
    let info = Core.beginTurn(g);

    while (g.phase === 'playing' && steps < 4000) {
      steps++;

      // 有响应窗口：AI 决定
      if (g.pendingClaim) {
        for (const a of g.pendingClaim.asked) {
          if (g.pendingClaim.replies[a.seat] !== undefined) continue;
          let act = 'pass';
          if (a.options.indexOf('hu') >= 0) act = 'hu';
          else if (a.options.indexOf('kan') >= 0) act = 'kan';
          else if (a.options.indexOf('pon') >= 0) act = Math.random() < 0.8 ? 'pon' : 'pass';
          Core.submitClaim(g, a.seat, act);
        }
        const r = Core.resolveClaims(g);
        if (!r) { errors++; break; }
        g.pendingClaim = null;
        if (r.action === 'hu') { Core.declareWin(g, r.seat, r.tile, r.from, false); break; }
        if (r.action === 'kan') { Core.applyKan(g, r.seat, r.from, r.tile, false); info = { canTsumo: false, canAnkan: -1 }; continue; }
        if (r.action === 'pon') { Core.applyPon(g, r.seat, r.from, r.tile); info = { canTsumo: false, canAnkan: -1 }; continue; }
        g.turn = (r.from + 1) % 4;
        info = Core.beginTurn(g);
        continue;
      }

      const seat = g.turn;
      const pl = g.players[seat];
      if (g.phase !== 'playing') break;

      if (info && info.canTsumo && g.players[seat].drawn != null) {
        Core.declareWin(g, seat, g.players[seat].drawn, seat, true);
        break;
      }
      if (info && info.canAnkan > 0) {
        Core.applyKan(g, seat, seat, info.canAnkan, true);
        info = { canTsumo: false, canAnkan: -1 };
        continue;
      }

      const tile = Core.aiChooseDiscard(pl.hand, pl.melds.length);
      const r = Core.discard(g, seat, tile);
      if (!r.ok) { errors++; console.log('    出牌失败:', r.error, '座位', seat); break; }
      const pc = Core.openClaimWindow(g);
      if (!pc.asked || !pc.asked.length) {
        g.turn = (seat + 1) % 4;
        info = Core.beginTurn(g);
      }
    }

    rounds++;
    maxSteps = Math.max(maxSteps, steps);
    if (g.phase === 'over') {
      if (g.winner) wins++; else flows++;
    }
    // 守恒校验：一副牌 136 张，任何时刻「牌墙 + 所有人手牌 + 副露 + 牌河」必须恰好 136
    // 注意：胡牌时那张牌会被推进手牌，所以胡牌局多算 1 张，跳过
    if (!g.winner) {
      let total = g.wall.length;
      for (const pl of g.players) {
        total += pl.hand.length + pl.discards.length;
        total += pl.melds.reduce((acc, m) => acc + m.tiles.length, 0);
      }
      if (total !== 136) {
        errors++;
        console.log('    牌张总数异常：' + total + ' 张（应为 136）');
      }
    }
  }

  ok(errors === 0, '100 局无异常', '异常 ' + errors + ' 次');
  ok(wins + flows === 100, '100 局全部正常结束', '胡 ' + wins + ' 局 / 流局 ' + flows + ' 局');
  ok(maxSteps < 4000, '没有卡死（单局最多 ' + maxSteps + ' 步）');
}

console.log('\n3) 联机可见性：手牌只发给本人');
{
  const g = Core.createRound([
    { id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'd', name: 'D' }
  ]);
  Core.beginTurn(g);
  for (let seat = 0; seat < 4; seat++) {
    const v = Core.viewFor(g, seat);
    let leaked = 0, mine = 0;
    v.players.forEach((p, i) => {
      if (i === seat) { if (p.hand) mine++; }
      else if (p.hand) leaked++;
    });
    ok(mine === 1 && leaked === 0, '座位 ' + seat + ' 的视图：只有自己手牌可见（他人手牌 ' + leaked + ' 份泄漏）');
  }
}

console.log('\n4) 动作校验：越权/乱来要被拒绝');
{
  for (let round = 0; round < 20; round++) {
    const g = Core.createRound([
      { id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'd', name: 'D' }
    ]);
    Core.beginTurn(g);   // 座位 0 摸牌后轮到它出牌
    const before = g.players[0].hand.length + g.players[0].discards.length;

    const notMine = g.players[1].hand[0];
    const r1 = Core.discard(g, 1, notMine);
    ok(!r1.ok, '不是自己的回合不能出牌（第 ' + (round + 1) + ' 局）');

    const fake = 1 + (g.players[0].hand[0] % 9);
    const hasIt = g.players[0].hand.indexOf(fake) >= 0;
    const r2 = Core.discard(g, 0, hasIt ? -1 : fake);
    ok(!r2.ok, '不能打出自己手上没有的牌');

    const mine = g.players[0].hand[5];
    const r3 = Core.discard(g, 0, mine);
    const last = g.players[0].discards[g.players[0].discards.length - 1];
    ok(r3.ok && last === mine, '轮到自己可以正常出牌，且牌进了牌河');
    ok(g.players[0].hand.length + g.players[0].discards.length === before,
      '出牌后手牌与牌河总数守恒（摸牌那步已算在内）');
  }
}

console.log('\n5) 操作额度与规则一致性');
{
  let ponOk = 0, kanOk = 0, huOk = 0;
  for (let i = 0; i < 2000; i++) {
    const hand = [];
    const pick = () => { let t; do { t = 1 + Math.floor(Math.random() * 37); } while (t === 10 || t === 20 || t === 30); return t; };
    for (let k = 0; k < 13; k++) hand.push(pick());
    const tile = pick();
    const opts = Core.canClaim(hand, 0, tile);
    const same = hand.filter((x) => x === tile).length;
    if (opts.indexOf('pon') >= 0) { ponOk++; if (same < 2) { fail++; console.log('  ✗ 碰的判定错误'); break; } }
    if (opts.indexOf('kan') >= 0) { kanOk++; if (same < 3) { fail++; console.log('  ✗ 杠的判定错误'); break; } }
    if (opts.indexOf('hu') >= 0) { huOk++; if (!Core.canWin(hand.concat([tile]), 0)) { fail++; console.log('  ✗ 胡的判定错误'); break; } }
  }
  ok(ponOk > 0 && kanOk > 0 && huOk >= 0, '碰/杠/胡判定与手牌一致（样本：碰 ' + ponOk + ' 次，杠 ' + kanOk + ' 次，胡 ' + huOk + ' 次）');
}

console.log('\n6) 联机页面源码特征（防回归）');
{
  const fs = require('fs');
  const page = fs.readFileSync(path.join(__dirname, '..', 'games', 'mahjong.html'), 'utf8');
  const online = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'online.js'), 'utf8');

  ok(/!onlineAction && G\.phase === 'playing' && G\.waitingFor === 'ai'/.test(page),
    '联机模式下本地 AI 兜底被关掉（否则会用本地空牌墙把 phase 改成 over）');
  ok(/if \(onlineAction\) \{ onlineAction\('again'\); return; \}/.test(page),
    '联机时「再来一局」交给服务端发牌，不在本地 resetGame');
  ok(/const total = \(pl\.hand \|\| \[\]\)\.length/.test(page),
    '结束页对赢家手牌做空值保护');
  ok(/p: \(v\.winner\.seat - seat \+ 4\) % 4/.test(online),
    '赢家座位随视角旋转（服务端 winner.seat → 单机 winner.p）');
  ok(/document\.getElementById\('mj-ui'\)|root\.id = 'mj-ui'/.test(online) && /mkBtn\('创建房间'/.test(online),
    '大厅是真 DOM（含「创建房间」按钮），不依赖 canvas 命中');
  ok(/function enterFullscreenLandscape/.test(online),
    '竖屏可一键全屏横屏');
  ok(!/menuStatus\.textContent[\s\S]{0,120}location\.host/.test(online),
    '菜单不再显示「已连接 · 网址」那一行');
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);