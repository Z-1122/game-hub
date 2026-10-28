/* ============================================================
 *  联机 30 秒思考时限：端到端测试
 *
 *  需求（用户）：每人 30 秒思考时间，过了 30 秒自动出牌。
 *  做法：起一个 TURN_MS 很小的服务端（默认 900ms），两个真人坐着不动，
 *        看服务端会不会自己替他们出牌、并把「超时」写进日志。
 * ============================================================ */
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

const PORT = Number(process.env.ONLINE_PORT || 8791);
const HOST = '127.0.0.1';
const TURN_MS = Number(process.env.TURN_MS || 900);

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: HOST, port: PORT, path: pathname }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}

/* 极简 WebSocket 客户端（和 test-online-server.js 同一套握手，帧解析已验证） */
function makeClient(name) {
  return new Promise((resolve, reject) => {
    const key = Buffer.from(Math.random().toString(36) + Date.now()).toString('base64').slice(0, 24);
    const req = http.request({
      host: HOST, port: PORT, path: '/ws',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': 13
      }
    });
    req.on('upgrade', (res, socket) => {
      const C = { name, socket, buf: Buffer.alloc(0), inbox: [], lastState: null, closed: false };
      C.send = (obj) => {
        const data = Buffer.from(JSON.stringify(obj), 'utf8');
        const mask = Buffer.from([1, 2, 3, 4]);
        const masked = Buffer.alloc(data.length);
        for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
        let head;
        if (data.length < 126) head = Buffer.from([0x81, 0x80 | data.length]);
        else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0xfe; head.writeUInt16BE(data.length, 2); }
        try { socket.write(Buffer.concat([head, mask, masked])); } catch (e) { /* 忽略 */ }
      };
      C.next = async (pred, timeoutMs) => {
        const t0 = Date.now();
        while (Date.now() - t0 < (timeoutMs || 5000)) {
          for (let i = 0; i < C.inbox.length; i++) {
            if (pred(C.inbox[i])) return C.inbox.splice(i, 1)[0];
          }
          await sleep(30);
        }
        return null;
      };
      C.drain = () => { C.inbox.length = 0; };

      function pump() {
        for (;;) {
          if (C.buf.length < 2) return;
          const b0 = C.buf[0], b1 = C.buf[1];
          const opcode = b0 & 0x0f;
          const masked = (b1 & 0x80) !== 0;
          let len = b1 & 0x7f;
          let p = 2;
          if (len === 126) { if (C.buf.length < 4) return; len = C.buf.readUInt16BE(2); p = 4; }
          else if (len === 127) { if (C.buf.length < 10) return; len = Number(C.buf.readBigUInt64BE(2)); p = 10; }
          let mask = null;
          if (masked) { if (C.buf.length < p + 4) return; mask = C.buf.slice(p, p + 4); p += 4; }
          if (C.buf.length < p + len) return;
          const data = Buffer.from(C.buf.slice(p, p + len));
          if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
          C.buf = C.buf.slice(p + len);
          if (opcode === 0x1) {
            try {
              const m = JSON.parse(data.toString('utf8'));
              if (m && m.t === 'state') C.lastState = m;
              C.inbox.push(m);
            } catch (e) { /* 坏帧忽略 */ }
          } else if (opcode === 0x8) { C.closed = true; return; }
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

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js'), String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { TURN_MS: String(TURN_MS) })
  });
  let srvOut = '';
  srv.stdout.on('data', (d) => { srvOut += d; if (process.env.ONDBG) process.stdout.write('[srv] ' + d); });
  srv.stderr.on('data', (d) => { srvOut += d; if (process.env.ONDBG) process.stdout.write('[srv-err] ' + d); });

  try {
    for (let i = 0; i < 100; i++) {
      try { const r = await get('/health'); if (r.status === 200) break; } catch (e) { /* 未就绪 */ }
      await sleep(100);
    }

    console.log('\n[1] 状态里带上了时限与剩余时间');
    const A = await makeClient('A');
    const B = await makeClient('B');
    A.send({ t: 'hello', name: '阿强' });
    B.send({ t: 'hello', name: '小美' });
    await A.next((m) => m.t === 'welcome');
    await B.next((m) => m.t === 'welcome');
    A.send({ t: 'create' });
    const ja = await A.next((m) => m.t === 'joined');
    ok(!!ja, '建房成功', ja && ja.code);
    B.send({ t: 'join', code: ja.code });
    await B.next((m) => m.t === 'joined');
    A.drain(); B.drain();
    A.send({ t: 'start' });
    const st = await A.next((m) => m.t === 'state', 6000);
    ok(!!st && st.view.phase === 'playing', '开局成功');
    ok(st && st.turnMs === TURN_MS, '状态里带 turnMs（服务端规定的时限）', st && st.turnMs);
    ok(st && typeof st.turnLeft === 'number' && st.turnLeft > 0 && st.turnLeft <= TURN_MS,
      '状态里带 turnLeft（这一刻还剩多少）', st && Math.round(st.turnLeft));

    console.log('\n[2] 两个真人都不动 → 到点自动出牌');
    // 记录开局时两家的牌河数量；保持完全不动，等超时
    const before = { A: 0, B: 0 };
    let autoLog = null;
    let discardsGrew = false;
    const t0 = Date.now();
    while (Date.now() - t0 < TURN_MS * 6 + 4000) {
      const ma = await A.next((m) => m.t === 'state' || m.t === 'log', 300);
      if (ma && ma.t === 'state') {
        const seatA = ma.view.seat;
        const me = ma.view.players.find((p) => p.seat === seatA);
        if (me && me.discards.length > before.A) { before.A = me.discards.length; discardsGrew = true; }
      }
      // 服务端把「超时」写进 state.log 里带过来
      if (ma && ma.t === 'state' && Array.isArray(ma.log)) {
        const hit = ma.log.find((l) => /超时/.test(l));
        if (hit) autoLog = hit;
      }
      if (autoLog && discardsGrew) break;
      await sleep(20);
    }
    ok(discardsGrew, '没人操作也会自动出牌（牌河变长了）');
    ok(!!autoLog, '日志里写明了「超时」自动处理', autoLog);

    console.log('\n[3] 超过一回合仍能继续（不会卡死）');
    let states = 0;
    const t1 = Date.now();
    while (Date.now() - t1 < TURN_MS * 5) {
      const m = await A.next((x) => x.t === 'state', 300);
      if (m) states++;
      await sleep(10);
    }
    ok(states >= 3, '超时后服务器继续推进对局', '收到 ' + states + ' 次状态更新');

    console.log('\n[4] 源码特征');
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
    ok(/TURN_MS = Number\(process\.env\.TURN_MS\) \|\| 1000 \* 30/.test(src), '默认每人 30 秒，可用环境变量缩小');
    ok(/syncDeadline\s*\(/.test(src) && /onTimeout\s*\(/.test(src), '存在时限调度与超时处理');
    ok(/bumpTurn\s*\(\s*\)\s*\{/.test(src) && /this\.bumpTurn\(\)/.test(src), '换手时重置计时');
    ok(/超时.*自动/.test(src), '超时会写进房间日志');
  } finally {
    try { srv.kill(); } catch (e) { /* 忽略 */ }
    await sleep(200);
  }

  console.log('\n----------------------------------------');
  console.log((fail === 0 ? 'TIMEOUT_TEST_OK' : 'TIMEOUT_TEST_FAIL') + '  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('----------------------------------------');
  if (fail !== 0 && srvOut) console.log(srvOut);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });