/* 对公网服务器做一次「30 秒时限」验收：建房 → 看 state 里有没有 turnMs / turnLeft，
 * 再确认超时后服务端会自己替玩家出牌（公网默认就是 30 秒，这里只等一小会儿看日志）。 */
const http = require('http');
const HOST = process.env.MJ_HOST || '121.196.175.181';
const PORT = Number(process.env.MJ_PORT || 8787);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(c, name, extra) {
  if (c) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); }
}

function makeClient(name) {
  return new Promise((resolve, reject) => {
    const key = Buffer.from(Math.random().toString(36) + Date.now()).toString('base64').slice(0, 24);
    const req = http.request({
      host: HOST, port: PORT, path: '/ws',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': 13 }
    });
    req.on('upgrade', (res, socket) => {
      const C = { name, socket, buf: Buffer.alloc(0), inbox: [], lastState: null };
      C.send = (obj) => {
        const data = Buffer.from(JSON.stringify(obj), 'utf8');
        const mask = Buffer.from([9, 8, 7, 6]);
        const masked = Buffer.alloc(data.length);
        for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
        let head;
        if (data.length < 126) head = Buffer.from([0x81, 0x80 | data.length]);
        else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0xfe; head.writeUInt16BE(data.length, 2); }
        try { socket.write(Buffer.concat([head, mask, masked])); } catch (e) {}
      };
      C.next = async (pred, timeoutMs) => {
        const t0 = Date.now();
        while (Date.now() - t0 < (timeoutMs || 6000)) {
          for (let i = 0; i < C.inbox.length; i++) if (pred(C.inbox[i])) return C.inbox.splice(i, 1)[0];
          await sleep(30);
        }
        return null;
      };
      function pump() {
        for (;;) {
          if (C.buf.length < 2) return;
          const opcode = C.buf[0] & 0x0f, masked = (C.buf[1] & 0x80) !== 0;
          let len = C.buf[1] & 0x7f, p = 2;
          if (len === 126) { if (C.buf.length < 4) return; len = C.buf.readUInt16BE(2); p = 4; }
          else if (len === 127) { if (C.buf.length < 10) return; len = Number(C.buf.readBigUInt64BE(2)); p = 10; }
          let mask = null;
          if (masked) { if (C.buf.length < p + 4) return; mask = C.buf.slice(p, p + 4); p += 4; }
          if (C.buf.length < p + len) return;
          const data = Buffer.from(C.buf.slice(p, p + len));
          if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
          C.buf = C.buf.slice(p + len);
          if (opcode === 0x1) {
            try { const m = JSON.parse(data.toString('utf8')); if (m.t === 'state') C.lastState = m; C.inbox.push(m); } catch (e) {}
          } else if (opcode === 0x8) return;
        }
      }
      socket.on('data', (c) => { C.buf = Buffer.concat([C.buf, c]); pump(); });
      socket.on('error', () => {});
      resolve(C);
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  console.log('\n[1] 公网建房与联机');
  const A = await makeClient('A');
  A.send({ t: 'hello', name: '公网测试' });
  const w = await A.next((m) => m.t === 'welcome');
  ok(!!w && !!w.playerId, '连上公网服务器');
  A.send({ t: 'create' });
  const j = await A.next((m) => m.t === 'joined');
  ok(!!j, '建房成功', j && j.code);
  A.send({ t: 'start' });
  const st = await A.next((m) => m.t === 'state', 8000);
  ok(!!st && st.view.phase === 'playing', '开局成功');
  ok(st && st.turnMs === 30000, '服务端宣布每人 30 秒', st && st.turnMs);
  ok(st && typeof st.turnLeft === 'number' && st.turnLeft > 0, '状态里带剩余思考时间',
    st && Math.round(st.turnLeft) + 'ms');

  console.log('\n[2] 30 秒到点自动出牌（真人全程不动）');
  const before = st.view.players[st.view.seat].discards.length;
  let grew = false, autoLog = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    const m = await A.next((x) => x.t === 'state' || x.t === 'log', 400);
    if (!m) continue;
    if (m.t === 'state') {
      const me = m.view.players[m.view.seat];
      if (me.discards.length > before) grew = true;
      if (Array.isArray(m.log)) {
        const hit = m.log.find((l) => /超时/.test(l));
        if (hit) autoLog = hit;
      }
    }
    if (grew && autoLog) break;
  }
  ok(grew, '30 秒到点后自动替玩家出了牌');
  ok(!!autoLog, '日志写明了自动处理', autoLog);

  console.log('\n----------------------------------------');
  console.log((fail === 0 ? 'PUBLIC_OK' : 'PUBLIC_FAIL') + '  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('----------------------------------------');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });