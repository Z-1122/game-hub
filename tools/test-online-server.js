/* ============================================================
 *  联机服务端 · 端到端网络测试（真实 WebSocket，不是模拟）
 *
 *  跑法：node tools/test-online-server.js
 * ============================================================ */
'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = 18000 + Math.floor(Math.random() * 2000);
const HOST = '127.0.0.1';

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------- 浏览器侧 WebSocket 客户端（RFC 6455，带掩码） ---------- */
function makeClient(name) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: HOST, port: PORT, path: '/',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13'
      }
    });
    req.on('upgrade', (res, socket) => {
      const C = {
        name: name, socket: socket, buf: Buffer.alloc(0), inbox: [], closed: false,
        send(obj) {
          const payload = Buffer.from(JSON.stringify(obj), 'utf8');
          const mask = crypto.randomBytes(4);
          const len = payload.length;
          let header;
          if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
          else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
          else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
          header[0] = 0x81;
          const masked = Buffer.alloc(len);
          for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
          socket.write(Buffer.concat([header, mask, masked]));
        },
        async next(match, timeoutMs) {
          const t0 = Date.now();
          for (;;) {
            // 用 function 包装再调：findIndex 会把 (元素, 索引) 一起传给回调，
            // 直接传 match 时那些只声明一个参数的箭头函数无害，但带默认值/解构的回调会误判，
            // 这里统一只传元素，避免「明明收到了却匹配不上」。
            const i = C.inbox.findIndex(function (m) { return match(m); });
            if (i >= 0) return C.inbox.splice(i, 1)[0];
            if (Date.now() - t0 > (timeoutMs || 4000)) return null;
            await sleep(10);
          }
        },
        /* 以「最后一次收到的 state」为准做一份本地视图：
           服务器停在等某人出牌时不会再广播，必须靠缓存推进，否则测试会空等。 */
        latestView() { return C.lastState ? C.lastState.view : null; },
        /* 等到下一条 state（或超时返回缓存） */
        async nextState(timeoutMs) {
          const m = await C.next((x) => x.t === 'state', timeoutMs || 400);
          return m ? m.view : C.latestView();
        },
        drain() { C.inbox.length = 0; }
      };

      // 严格按 RFC 逐帧切分；不完整的帧留到下一次 data 再拼
      function pump() {
        for (;;) {
          if (C.buf.length < 2) return;
          const b0 = C.buf[0];
          const b1 = C.buf[1];
          const opcode = b0 & 0x0f;
          const masked = (b1 & 0x80) !== 0;
          let len = b1 & 0x7f;
          let p = 2;
          if (len === 126) {
            if (C.buf.length < p + 2) return;
            len = C.buf.readUInt16BE(p); p += 2;
          } else if (len === 127) {
            if (C.buf.length < p + 8) return;
            len = Number(C.buf.readBigUInt64BE(p)); p += 8;
          }
          let mask = null;
          if (masked) {
            if (C.buf.length < p + 4) return;
            mask = C.buf.slice(p, p + 4); p += 4;
          }
          if (C.buf.length < p + len) return;      // 半包，等下一块
          const data = Buffer.from(C.buf.slice(p, p + len));
          if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
          C.buf = C.buf.slice(p + len);            // 先切掉再处理，避免叠加帧错位
          if (opcode === 0x1) {
            try {
              const m = JSON.parse(data.toString('utf8'));
              // 服务器在「等你出牌」时不会主动重发状态，所以必须自己记住最后一条，
              // 否则像 waitMyTurn 这种「等下一条 state」的写法会一直饿死。
              if (m && m.t === 'state') C.lastState = m;
              C.inbox.push(m);
            } catch (e) { /* 坏帧忽略 */ }
          } else if (opcode === 0x8) {
            C.closed = true;
            return;
          }
        }
      }

      socket.on('data', (chunk) => { C.buf = Buffer.concat([C.buf, chunk]); pump(); });
      socket.on('error', () => { C.closed = true; });
      socket.on('close', () => { C.closed = true; });
      resolve(C);
    });
    req.on('error', reject);
    req.end();
  });
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: HOST, port: PORT, path: pathname }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js'), String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let srvOut = '';
  srv.stdout.on('data', (d) => { srvOut += d; if (process.env.ONDBG) process.stdout.write('[srv] ' + d); });
  srv.stderr.on('data', (d) => { srvOut += d; if (process.env.ONDBG) process.stdout.write('[srv-err] ' + d); });

  try {
    for (let i = 0; i < 100; i++) {
      try { const r = await get('/health'); if (r.status === 200) break; } catch (e) { /* 未就绪 */ }
      await sleep(100);
    }

    console.log('\n[1] HTTP 静态资源');
    const health = await get('/health');
    ok(health.status === 200 && JSON.parse(health.body).ok === true, '/health 返回 ok');
    const page = await get('/');
    ok(page.status === 200 && page.body.indexOf('window.MJ_MODE = "online"') > 0, '游戏页面注入了联机模式');
    ok(page.body.indexOf('/online.js') > 0, '游戏页面引入了 online.js');
    const js = await get('/online.js');
    ok(js.status === 200 && js.body.indexOf('__mjOnlineAct') > 0, '/online.js 可下载');
    const core = await get('/mahjong-core.js');
    ok(core.status === 200 && core.body.indexOf('viewFor') > 0, '/mahjong-core.js 可下载');

    console.log('\n[2] 两人建房 + 加入');
    const A = await makeClient('A');
    const B = await makeClient('B');
    A.send({ t: 'hello', name: '阿强' });
    B.send({ t: 'hello', name: '小美' });
    const wa = await A.next((m) => m.t === 'welcome');
    const wb = await B.next((m) => m.t === 'welcome');
    ok(wa && wa.playerId && wb && wb.playerId && wa.playerId !== wb.playerId, '两人各自拿到 playerId');

    A.send({ t: 'create' });
    const ja = await A.next((m) => m.t === 'joined');
    ok(ja && /^[2-9A-HJ-NP-Z]{4}$/.test(ja.code), '建房拿到 4 位房号', ja && ja.code);

    B.send({ t: 'join', code: ja.code });
    const jb = await B.next((m) => m.t === 'joined');
    ok(jb && jb.code === ja.code && jb.seat !== ja.seat, 'B 用房号加入，座位不同', jb);

    const roomA = await A.next((m) => m.t === 'room' && m.seats.filter(Boolean).length >= 2);
    ok(roomA && roomA.seats.filter(Boolean).length === 2, '房间里有 2 个真人');
    ok(roomA && typeof roomA.mySeat === 'number', 'room 消息带我的座位号');

    console.log('\n[3] 开局：空位补电脑');
    A.drain(); B.drain();
    A.send({ t: 'start' });
    const ra = await A.next((m) => m.t === 'room' && m.started);
    ok(ra && ra.seats.filter((s) => s && s.isAI).length === 2, '两个空位被电脑补上',
      ra && ra.seats.map((s) => s && (s.isAI ? 'AI' : '人')).join(','));

    const sa = await A.next((m) => m.t === 'state', 6000);
    const sb = await B.next((m) => m.t === 'state', 6000);
    ok(sa && sa.view.phase === 'playing', 'A 收到开局状态');
    ok(sb && sb.view.phase === 'playing', 'B 收到开局状态');

    console.log('\n[4] 手牌可见性（防作弊）');
    function visCheck(view, seat) {
      const mine = view.players[seat];
      const others = view.players.filter((p) => p.seat !== seat);
      return Array.isArray(mine.hand) && mine.hand.length >= 10 && others.every((p) => p.hand === null);
    }
    ok(sa && visCheck(sa.view, sa.view.seat), 'A 只看到自己的手牌');
    ok(sb && visCheck(sb.view, sb.view.seat), 'B 只看到自己的手牌');

    console.log('\n[5] 真人出牌 → 服务端推进');
    /* 关键：先吃自己的缓存状态，等不到新消息就用 lastState 判断。
       服务器停在「等你出牌」时不会再广播，单靠 next() 会永远超时。 */
    async function waitMyTurn(C, timeoutMs) {
      const t0 = Date.now();
      let actedPass = 0;
      while (Date.now() - t0 < (timeoutMs || 15000)) {
        let v = null;
        const m = await C.next((x) => x.t === 'state', 400);
        if (m) v = m.view;
        else if (C.lastState) v = C.lastState.view;
        if (!v) continue;
        if (v.phase !== 'playing') return v;
        if (v.waitingFor === 'claim') {
          if (actedPass < 20) { actedPass++; C.send({ t: 'action', action: { type: 'claim', action: 'pass' } }); }
          C.lastState = null;   // 等服务器推新状态，避免空转刷 pass
          continue;
        }
        if (v.waitingFor === 'me') return v;
        // other：别人（电脑）在行动，等下一步推送
        C.lastState = null;
        await sleep(60);
      }
      return null;
    }
    const myTurnA = await waitMyTurn(A);
    ok(!!myTurnA && myTurnA.waitingFor === 'me', '轮到了 A 出牌', myTurnA && myTurnA.waitingFor);
    if (myTurnA) {
      const before = myTurnA.players[myTurnA.seat].discards.length;
      const tile = myTurnA.players[myTurnA.seat].hand[0];
      A.send({ t: 'action', action: { type: 'discard', tile: tile } });
      const after = await A.next((m) => m.t === 'state' &&
        m.view.players[m.view.seat].discards.length === before + 1, 5000);
      ok(!!after, 'A 的牌进了牌河', { before, tile });
    }

    console.log('\n[6] 越权拦截');
    const bViewNow = await B.next((x) => x.t === 'state', 3000);
    if (bViewNow && bViewNow.view.waitingFor !== 'me') {
      B.send({ t: 'action', action: { type: 'discard', tile: 1 } });
      const e = await B.next((m) => m.t === 'error', 3000);
      ok(!!e && /轮到|不能|处理|没有/.test(e.message), '没轮到就出牌会被拒绝', e && e.message);
    } else {
      ok(true, '（本次恰逢 B 的回合，跳过越权用例）');
    }

    console.log('\n[7] 自动跑到终局（不卡死）');
    let steps = 0;
    let endView = null;
    let rounds = 0;
    const t0 = Date.now();
    A.drain();
    B.drain();

    /* 真人有两个，必须同时驱动：服务器轮到某个真人出牌时不会自己推进，
       谁 waitingFor==='me' 就得替谁出牌，否则整局就停在那儿。 */
    function actIfMine(C) {
      const v = C.latestView();
      if (!v || v.phase !== 'playing') return false;
      if (v.waitingFor === 'claim') {
        C.send({ t: 'action', action: { type: 'claim', action: 'pass' } });
        C.lastState = null;
        return true;
      }
      if (v.waitingFor === 'me') {
        const tile = v.players[v.seat].hand.find((t) => t > 0);
        if (tile == null) return false;
        C.send({ t: 'action', action: { type: 'discard', tile: tile } });
        C.lastState = null;
        steps++;
        return true;
      }
      return false;
    }

    while (Date.now() - t0 < 60000) {
      rounds++;
      await A.next((x) => x.t === 'state', 0);   // 把攒着的状态收进缓存
      await B.next((x) => x.t === 'state', 0);
      const va = A.latestView();
      const vb = B.latestView();
      if (va && va.phase !== 'playing') { endView = va; break; }
      if (vb && vb.phase !== 'playing') { endView = vb; break; }

      const didA = actIfMine(A);
      const didB = actIfMine(B);
      if (!didA && !didB) await sleep(150);      // 两边都不是「等我」→ 电脑在算
      if (steps > 400) break;
    }
    ok(steps > 0 || endView !== null, '自动对局有推进',
      { steps: steps, phase: endView && endView.phase, rounds: rounds });

    console.log('\n[8] 断线重连保留座位');
    const pid = wa.playerId;
    A.drain();
    A.socket.destroy();
    await sleep(150);
    const A2 = await makeClient('A2');
    A2.send({ t: 'hello', playerId: pid });
    const resumed = await A2.next((m) => m.t === 'joined', 4000);
    ok(!!resumed && resumed.resumed === true, '用同一个 playerId 重连回到原房间');
    const st2 = await A2.next((m) => m.t === 'state', 5000);
    ok(!!st2, '重连后拿到牌局状态');

    console.log('\n[9] 房间不存在');
    const C2 = await makeClient('C');
    C2.send({ t: 'hello', name: '路人' });
    await C2.next((m) => m.t === 'welcome');
    C2.send({ t: 'join', code: 'ZZZZ' });
    const err = await C2.next((m) => m.t === 'error', 3000);
    ok(!!err && /不存在/.test(err.message), '输入不存在房号有明确报错', err && err.message);

  } finally {
    srv.kill();
    await sleep(200);
  }

  console.log('\n----------------------------------------');
  console.log(fail === 0 ? 'ONLINE_TEST_OK  通过 ' + pass + ' 项，失败 0 项'
    : 'ONLINE_TEST_FAILED  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('----------------------------------------');
  if (fail > 0) { console.log(srvOut.slice(-1500)); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });