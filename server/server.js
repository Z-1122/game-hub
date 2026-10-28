/* ============================================================
 *  大众麻将 · 联机服务端（零依赖，只用 Node 内置模块）
 *
 *  - 手写 WebSocket 握手 + 帧编解码（不依赖 ws 包）
 *  - 房间制：房主建房得 4 位房号，其他人输房号入座
 *  - 四人座位，空位由电脑接管（人不够也能开）
 *  - 服务器权威：手牌只发给本人，动作全部在服务端校验
 *  - 断线可重连（按 playerId 认领原座位）
 *
 *  启动：node server/server.js [端口]
 *  默认端口 8787，监听 0.0.0.0（同一 WiFi 下手机可直连）
 * ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Core = require('./mahjong-core.js');

const PORT = parseInt(process.argv[2], 10) || 8787;
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ============================================================
 *  一、极简 WebSocket（RFC 6455，只做服务端需要的那一半）
 * ============================================================ */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

// 把要发的数据编码成帧（服务端发出的帧不加掩码）
function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;                 // FIN + text
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// 解开客户端发来的帧（客户端帧必须带掩码）
function decodeFrames(buf, onMessage) {
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;

    if (len === 126) {
      if (p + 2 > buf.length) break;
      len = buf.readUInt16BE(p); p += 2;
    } else if (len === 127) {
      if (p + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(p)); p += 8;
    }
    let mask = null;
    if (masked) {
      if (p + 4 > buf.length) break;
      mask = buf.slice(p, p + 4); p += 4;
    }
    if (p + len > buf.length) break;   // 还没收全，等下一块

    const data = Buffer.from(buf.slice(p, p + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];

    if (opcode === 0x8) return { consumed: p + len, closed: true };
    if (opcode === 0x1) onMessage(data.toString('utf8'));
    // 0x9 ping / 0xa pong / 0x0 continuation 忽略
    off = p + len;
  }
  return { consumed: off, closed: false };
}

/* ============================================================
 *  二、连接封装
 * ============================================================ */

let nextConnId = 1;

class Conn {
  constructor(socket) {
    this.id = nextConnId++;
    this.socket = socket;
    this.alive = true;
    this.playerId = null;
    this.room = null;
    this.buf = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      const res = decodeFrames(this.buf, (msg) => this.onMessage(msg));
      this.buf = this.buf.subarray(res.consumed);
      if (res.closed) this.close();
    });
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
  }

  send(obj) {
    if (!this.alive) return;
    try {
      this.socket.write(encodeFrame(JSON.stringify(obj)));
    } catch (e) {
      this.close();
    }
  }

  close() {
    if (!this.alive) return;
    this.alive = false;
    try { this.socket.destroy(); } catch (e) { /* ignore */ }
    if (this.room) this.room.onDisconnect(this);
    this.room = null;
  }

  onMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try {
      handleMessage(this, msg);
    } catch (e) {
      this.send({ t: 'error', message: '服务器开小差了：' + e.message });
      console.error('[msg]', e && e.stack || e);
    }
  }
}

/* ============================================================
 *  三、房间
 * ============================================================ */

const rooms = new Map();   // code -> Room
const ROOM_IDLE_MS = 1000 * 60 * 30;   // 30 分钟没人就回收
const TURN_MS = Number(process.env.TURN_MS) || 1000 * 30;   // 每人每个决定的思考时限：默认 30 秒（测试可调小）

function makeRoomCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   // 去掉容易看错的 0/O/1/I
  for (;;) {
    let s = '';
    for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
    if (!rooms.has(s)) return s;
  }
}

class Room {
  constructor(code, hostConn, hostName) {
    this.code = code;
    this.seats = [null, null, null, null];    // 每格：{playerId, name, conn, isAI, ready}
    this.started = false;
    this.game = null;
    this.log = [];
    this.createdAt = Date.now();
    this.lastActive = Date.now();
    this.seats[0] = { playerId: hostConn.playerId, name: hostName, conn: hostConn, isAI: false, ready: true };
    this.timer = null;
    this.tickQueued = false;
    this.lastStepAt = 0;
    this.pendingTurnInfo = null;
    // 思考时限：每个需要人类做决定的回合，30 秒不动手就自动帮他走
    this.turnSeq = 0;          // 每次进入新的人类等待就 +1，用来判断是不是同一回合
    this.turnDeadline = 0;     // 本回合截止的绝对时间（ms）
    this.deadlineTimer = null;
    this.deadlineSeq = -1;     // 已经为哪个 turnSeq 装过闹钟
  }

  touch() { this.lastActive = Date.now(); }

  /* 空座填 AI（只在开局时用） */
  fillWithAI() {
    const AI_NAMES = ['电脑·东', '电脑·南', '电脑·西', '电脑·北'];
    for (let i = 0; i < 4; i++) {
      if (!this.seats[i]) {
        this.seats[i] = { playerId: 'ai-' + i + '-' + this.code, name: AI_NAMES[i], conn: null, isAI: true, ready: true };
      }
    }
  }

  /* 广播公开的座位表（mySeat 是给本连接看的自己的座位） */
  broadcastRoom() {
    const seats = this.seats.map((s, i) => (s ? {
      seat: i,
      name: s.name,
      isAI: s.isAI,
      ready: !!s.ready,
      online: !!(s.conn && s.conn.alive)
    } : null));
    this.eachConn((c) => c.send({
      t: 'room',
      code: this.code,
      started: this.started,
      seats: seats,
      hostSeat: this.hostSeat(),
      mySeat: this.seatOf(c)
    }));
  }

  hostSeat() {
    for (let i = 0; i < 4; i++) {
      const s = this.seats[i];
      if (s && !s.isAI && s.conn && s.conn.alive) return i;
    }
    return -1;
  }

  eachConn(fn) {
    for (const s of this.seats) if (s && s.conn && s.conn.alive) fn(s.conn, s);
  }

  seatOf(conn) {
    for (let i = 0; i < 4; i++) {
      const s = this.seats[i];
      if (s && s.playerId === conn.playerId) return i;
    }
    return -1;
  }

  /* 开局：空位补电脑 */
  start(conn) {
    const seat = this.seatOf(conn);
    if (seat < 0) return { t: 'error', message: '你不在这个房间' };
    if (this.started) return { t: 'error', message: '已经开局了' };
    // 只允许第一个人（东位真人或最早的在线玩家）开局，防止抢开
    const host = this.hostSeat();
    if (host >= 0 && host !== seat) return { t: 'error', message: '让房主来开局' };
    this.fillWithAI();
    this.started = true;
    this.game = Core.createRound(this.seats.map((s, i) => ({
      id: s.playerId,
      name: s.name,
      isAI: s.isAI
    })));
    this.log = [];
    this.broadcastRoom();
    this.pushLog('开局！你是「' + Core.SEAT_NAMES[seat] + '」家');
    // 庄家（东位）先摸牌
    this.game.turn = 0;
    this.advanceTurn();
  }

  /* 再来一局：座位和房号不变，重新发牌 */
  again(conn) {
    const seat = this.seatOf(conn);
    if (seat < 0) return { t: 'error', message: '你不在这个房间' };
    if (!this.game) return { t: 'error', message: '还没开局' };
    if (this.game.phase !== 'over') return { t: 'error', message: '这一局还没结束' };
    this.game = Core.createRound(this.seats.map((s, i) => ({
      id: s ? s.playerId : 'ai' + i,
      name: s ? s.name : ('电脑·' + Core.SEAT_NAMES[i]),
      isAI: s ? s.isAI : true
    })));
    this.log = [];
    this.pushLog('新的一局开始');
    this.game.turn = 0;
    this.advanceTurn();
    return null;
  }

  pushLog(text) {
    this.log.push(text);
    if (this.log.length > 30) this.log.shift();
    this.eachConn((c) => c.send({ t: 'log', text: text }));
  }

  /* 广播每个座位各自可见的状态 */
  broadcastState() {
    if (!this.game) return;
    // 先装/清闹钟，再广播——否则第一帧的 turnLeft 永远是 0（客户端会以为已经超时）
    this.syncDeadline();
    for (let i = 0; i < 4; i++) {
      const s = this.seats[i];
      if (!s || !s.conn || !s.conn.alive) continue;
      const view = Core.viewFor(this.game, i);
      s.conn.send({
        t: 'state',
        view: view,
        serverSeat: i,                       // 服务端分配的座位（客户端用于旋转）
        clientSeat: this.seatOf(s.conn),     // 该连接自认为是第几个座位（正常等于 serverSeat）
        turnMs: TURN_MS,
        turnLeft: this.turnDeadline ? Math.max(0, this.turnDeadline - Date.now()) : 0,
        log: this.log.slice(-6)
      });
    }
    this.maybeAutoPlay();
  }

  /* 轮到电脑时自动行动；轮到人类则等回话 */
  maybeAutoPlay() {
    this.scheduleStep(260);
  }

  /* ---------------- 30 秒思考时限 ----------------
   * 每进入一个新的「人类要做决定」的回合就把 turnSeq +1 并重装一次闹钟；
   * 同一回合内反复广播不会重置时间（否则场上有人一直点按钮就能拖住别人）。 */
  bumpTurn() {
    this.turnSeq++;
    return this.turnSeq;
  }

  humanWait() {
    const g = this.game;
    if (!g || g.phase !== 'playing') return false;
    if (g.pendingClaim) {
      const pc = g.pendingClaim;
      return pc.asked.some((a) => {
        const s = this.seats[a.seat];
        return !!s && !s.isAI && pc.replies[a.seat] === undefined;
      });
    }
    const s = this.seats[g.turn];
    return !!s && !s.isAI;
  }

  clearDeadline() {
    if (this.deadlineTimer) { clearTimeout(this.deadlineTimer); this.deadlineTimer = null; }
    this.turnDeadline = 0;
  }

  syncDeadline() {
    if (!this.humanWait()) {
      this.clearDeadline();
      this.deadlineSeq = -1;
      return;
    }
    if (this.deadlineSeq === this.turnSeq) return;   // 这一回合已经装过闹钟
    this.pendingTurnInfo = this.pendingTurnInfo || null;
    this.deadlineSeq = this.turnSeq;
    this.clearDeadline();
    this.turnDeadline = Date.now() + TURN_MS;
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = null;
      this.onTimeout();
    }, TURN_MS);
    if (this.deadlineTimer.unref) this.deadlineTimer.unref();
  }

  /* 超时：能胡就替他胡，否则按电脑的打法替他走一步 */
  onTimeout() {
    const g = this.game;
    if (!g || g.phase !== 'playing') return;
    this.touch();

    if (g.pendingClaim) {
      const pc = g.pendingClaim;
      let auto = 0;
      for (const a of pc.asked) {
        if (pc.replies[a.seat] !== undefined) continue;
        const s = this.seats[a.seat];
        if (!s || s.isAI) continue;
        pc.replies[a.seat] = a.options.indexOf('hu') >= 0 ? 'hu' : 'pass';
        auto++;
      }
      if (auto) {
        this.pushLog('超时 ' + TURN_MS / 1000 + ' 秒，自动' + (auto > 1 ? '处理' : '过牌'));
        this.bumpTurn();
        this.scheduleStep(60);
        this.broadcastState();
      }
      return;
    }

    const seat = g.turn;
    const s = this.seats[seat];
    if (!s || s.isAI) return;
    this.pushLog(s.name + ' 超时，替 TA 自动出牌');
    this.bumpTurn();
    this.aiAct(seat);
  }

  /* 电脑（或超时的人类）走一步：自摸 / 暗杠 / 出牌 */
  aiAct(seat) {
    const g = this.game;
    if (!g || g.phase !== 'playing') return;
    const s = this.seats[seat];
    const t = this.pendingTurnInfo;
    if (t && t.seat === seat && t.canTsumo) {
      Core.declareWin(g, seat, g.players[seat].drawn, seat, true);
      this.pushLog((s ? s.name : '玩家') + ' 自摸');
      this.broadcastState();
      return;
    }
    if (t && t.seat === seat && t.canAnkan > 0) {
      Core.applyKan(g, seat, seat, t.canAnkan, true);
      this.pushLog((s ? s.name : '玩家') + ' 暗杠');
      this.beginCurrentTurn();
      this.broadcastState();
      return;
    }
    const pl = g.players[seat];
    const tile = Core.aiChooseDiscard(pl.hand, pl.melds.length);
    this.doDiscard(seat, tile);
  }

  /* 把 step 排进定时器。延迟按「距上次 step 多久」算，人类下手快时不至于拖沓 */
  scheduleStep(delay) {
    if (this.timer) return;
    const since = Date.now() - (this.lastStepAt || 0);
    const wait = Math.max(40, (delay || 260) - since);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.step();
    }, wait);
  }

  /* 推进一次：处理响应窗口 / 当前座位行动 */
  step() {
    const g = this.game;
    if (!g || g.phase !== 'playing') return;
    this.lastStepAt = Date.now();
    this.tickQueued = false;

    // 1) 有响应窗口 → 等待 / 由 AI 决策
    if (g.pendingClaim) {
      const pc = g.pendingClaim;
      let allDone = true;
      for (const a of pc.asked) {
        if (pc.replies[a.seat] !== undefined) continue;
        const s = this.seats[a.seat];
        if (s && s.isAI) {
          // AI 决策：能胡就胡，能杠就杠，能碰就碰（80% 概率），否则过
          let act = 'pass';
          if (a.options.indexOf('hu') >= 0) act = 'hu';
          else if (a.options.indexOf('kan') >= 0) act = 'kan';
          else if (a.options.indexOf('pon') >= 0) act = Math.random() < 0.8 ? 'pon' : 'pass';
          pc.replies[a.seat] = act;
        } else {
          allDone = false;
        }
      }
      if (!allDone) return;    // 等人类回话

      const r = Core.resolveClaims(g);
      if (!r) return;
      g.pendingClaim = null;
      if (r.action === 'hu') {
        Core.declareWin(g, r.seat, r.tile, r.from, false);
        this.pushLog(this.seats[r.seat].name + ' 胡牌！');
      } else if (r.action === 'kan') {
        Core.applyKan(g, r.seat, r.from, r.tile, false);
        this.pushLog(this.seats[r.seat].name + ' 杠牌');
        this.beginCurrentTurn();          // 杠完要补一张
      } else if (r.action === 'pon') {
        Core.applyPon(g, r.seat, r.from, r.tile);
        this.pushLog(this.seats[r.seat].name + ' 碰牌');
        this.bumpTurn();                  // 碰完轮到这家出牌：新的一回合时限
      } else {
        // 都过了：下一家摸牌
        g.turn = (r.from + 1) % 4;
        this.beginCurrentTurn();
      }
      this.broadcastState();
      return;
    }

    // 2) 轮到某家行动
    const seat = g.turn;
    const s = this.seats[seat];
    if (s && s.isAI) {
      this.aiAct(seat);
      return;
    }
    // 人类：什么都不做，等客户端发动作（30 秒闹钟见 syncDeadline）
  }

  /* 开局/换人时给当前座位摸牌 */
  beginCurrentTurn() {
    const g = this.game;
    if (!g || g.phase !== 'playing') return;
    const info = Core.beginTurn(g);
    if (g.phase !== 'playing') { this.broadcastState(); return; }
    this.pendingTurnInfo = info;
    this.bumpTurn();           // 新的回合：重置 30 秒思考时限
    this.broadcastState();
  }

  advanceTurn() {
    this.beginCurrentTurn();
  }

  /* 统一的出牌流程：出牌 → 开响应窗口 → 广播 */
  doDiscard(seat, tile) {
    const g = this.game;
    const r = Core.discard(g, seat, tile);
    if (!r.ok) return r;
    this.pendingTurnInfo = null;
    const pc = Core.openClaimWindow(g);
    if (!pc.asked || !pc.asked.length) {
      // 没人能要，直接下一家
      g.turn = (seat + 1) % 4;
      this.beginCurrentTurn();
    } else {
      this.bumpTurn();         // 新的碰杠窗口：重置 30 秒思考时限
      this.broadcastState();
    }
    return r;
  }

  /* 玩家动作入口 */
  onPlayerAction(seat, action) {
    const g = this.game;
    if (!g || g.phase !== 'playing') return { t: 'error', message: '现在不能操作' };

    if (action.type === 'discard') {
      if (g.pendingClaim) return { t: 'error', message: '请先处理别人打出的牌' };
      if (g.turn !== seat) return { t: 'error', message: '还没轮到你' };
      return this.doDiscard(seat, action.tile);
    }

    if (action.type === 'claim') {
      if (!g.pendingClaim) return { t: 'error', message: '现在没有可响应的牌' };
      const r = Core.submitClaim(g, seat, action.action);
      if (!r.ok) return { t: 'error', message: r.error };
      const pc = g.pendingClaim;
      const allDone = pc.asked.every((a) => pc.replies[a.seat] !== undefined);
      if (allDone) this.scheduleStep(60);
      this.broadcastState();
      return { ok: true };
    }

    if (action.type === 'tsumo') {
      if (g.turn !== seat) return { t: 'error', message: '还没轮到你' };
      const pl = g.players[seat];
      if (!Core.canWin(pl.hand, pl.melds.length)) return { t: 'error', message: '这张牌不能胡' };
      Core.declareWin(g, seat, pl.drawn, seat, true);
      this.broadcastState();
      return { ok: true };
    }

    if (action.type === 'ankan') {
      if (g.turn !== seat) return { t: 'error', message: '还没轮到你' };
      const pl = g.players[seat];
      const n = pl.hand.filter((x) => x === action.tile).length;
      if (n !== 4) return { t: 'error', message: '你没有四张同样的牌' };
      Core.applyKan(g, seat, seat, action.tile, true);
      this.broadcastState();
      return { ok: true };
    }

    return { t: 'error', message: '未知动作' };
  }

  onDisconnect(conn) {
    this.touch();
    this.broadcastRoom();
  }
}

/* 定时清理空闲房间 */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyOnline = room.seats.some((s) => s && s.conn && s.conn.alive);
    if (!anyOnline && now - room.lastActive > ROOM_IDLE_MS) {
      rooms.delete(code);
      console.log('[room] 回收空闲房间', code);
    }
  }
}, 60000).unref();

/* ============================================================
 *  四、消息处理
 * ============================================================ */

function handleMessage(conn, msg) {
  // 没认证前，只允许 hello
  if (msg.t === 'hello') {
    conn.playerId = String(msg.playerId || '').slice(0, 64) || ('p' + conn.id + crypto.randomBytes(4).toString('hex'));
    conn.name = String(msg.name || '').slice(0, 16) || ('玩家' + conn.id);
    conn.send({ t: 'welcome', playerId: conn.playerId, name: conn.name });
    // 断线重连：自动回到原房间
    for (const room of rooms.values()) {
      const seat = room.seats.findIndex((s) => s && s.playerId === conn.playerId);
      if (seat >= 0) {
        conn.room = room;
        room.seats[seat].conn = conn;
        room.touch();
        conn.send({ t: 'joined', code: room.code, seat: seat, resumed: true });
        room.broadcastRoom();
        if (room.game) {
          conn.send({ t: 'state', view: Core.viewFor(room.game, seat), log: room.log.slice(-6) });
        }
        return;
      }
    }
    return;
  }

  if (!conn.playerId) {
    conn.send({ t: 'error', message: '请先握手（hello）' });
    return;
  }

  if (msg.t === 'create') {
    if (conn.room) return conn.send({ t: 'error', message: '你已经在房间里了' });
    const code = makeRoomCode();
    const room = new Room(code, conn, conn.name);
    conn.room = room;
    rooms.set(code, room);
    conn.send({ t: 'joined', code: code, seat: 0 });
    room.broadcastRoom();
    return;
  }

  if (msg.t === 'join') {
    if (conn.room) return conn.send({ t: 'error', message: '你已经在房间里了' });
    const code = String(msg.code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return conn.send({ t: 'error', message: '房间不存在：' + code });
    if (room.started) {
      // 已经开局：只允许原玩家重连（上面已处理），否则拒绝
      return conn.send({ t: 'error', message: '这局已经开始了' });
    }
    const seat = room.seats.findIndex((s) => !s);
    if (seat < 0) return conn.send({ t: 'error', message: '房间满了' });
    room.seats[seat] = { playerId: conn.playerId, name: conn.name, conn: conn, isAI: false, ready: true };
    conn.room = room;
    room.touch();
    conn.send({ t: 'joined', code: code, seat: seat });
    room.broadcastRoom();
    return;
  }

  const room = conn.room;
  if (!room) return conn.send({ t: 'error', message: '你不在房间里' });
  room.touch();
  const seat = room.seatOf(conn);
  // 有玩家动了，立刻推一次（否则 AI 只能等定时器，白等 260ms）
  if (room.game && room.game.phase === 'playing') room.scheduleStep();

  if (msg.t === 'start') {
    const r = room.start(conn);
    if (r && r.t === 'error') conn.send(r);
    return;
  }

  if (msg.t === 'again') {
    const r = room.again(conn);
    if (r && r.t === 'error') conn.send(r);
    return;
  }

  if (msg.t === 'action') {
    const r = room.onPlayerAction(seat, msg.action || {});
    if (r && r.t === 'error') conn.send(r);
    return;
  }

  if (msg.t === 'leave') {
    if (seat >= 0) room.seats[seat] = null;
    conn.room = null;
    if (room.started && room.game) {
      // 开局后离开：座位交给电脑接管，别把牌局弄坏
      room.fillWithAI();
      room.broadcastState();
    }
    room.broadcastRoom();
    conn.send({ t: 'left' });
    return;
  }

  if (msg.t === 'chat') {
    const text = String(msg.text || '').slice(0, 60);
    if (text) room.pushLog(conn.name + '：' + text);
    return;
  }
}

/* ============================================================
 *  五、HTTP 静态服务（同一个端口给页面，省得跨域/证书麻烦）
 * ============================================================ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// 每次启动把页面里的 online.js 引用打上时间戳，避免手机浏览器拿缓存里的旧脚本
const BUILD_TAG = Date.now().toString(36);

function buildPage(mode) {
  // 单机版游戏页面：注入 window.MJ_MODE = 'online'
  const file = path.join(__dirname, '..', 'games', 'mahjong.html');
  let html = fs.readFileSync(file, 'utf8');
  // 在游戏脚本之前声明联机模式，并在单机脚本结束后加载联机客户端
  html = html.replace('<script>', '<script>window.MJ_MODE = ' + JSON.stringify(mode) + ';</script>\n<script>');
  if (mode === 'online') {
    // 带上构建时间戳：手机上换了新 online.js 时，URL 变了就不会用到缓存里的旧脚本
    html = html.replace('</body>', '<script src="/online.js?b=' + BUILD_TAG + '"></script>\n</body>');
  }
  return html;
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);

  // 给浏览器判断服务是否活着
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: process.uptime() }));
    return;
  }

  // 游戏页面：注入联机模式
  if (url === '/' || url === '/index.html' || url === '/mahjong.html') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buildPage('online'));
    } catch (e) {
      // 注意：出错时响应头可能已经发出去了（例如页面文件缺失导致 readFileSync 抛错，
      // 但 writeHead 已经执行过），此时再 writeHead 会抛 ERR_HTTP_HEADERS_SENT，
      // 把整个进程带走。必须先判断 headersSent。
      console.error('[静态] 读取游戏页面失败：', e.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('读取游戏页面失败：' + e.message);
      } else {
        res.end();
      }
    }
    return;
  }

  // 规则核心（浏览器也用同一份）
  if (url === '/mahjong-core.js') {
    const f = path.join(__dirname, 'mahjong-core.js');
    fs.readFile(f, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  // public 目录里的静态资源
  const safe = path.normalize(url).replace(/^(\.\.[\/\\])+/, '');
  const file = path.join(PUBLIC_DIR, safe === '/' ? 'index.html' : safe);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = wsAccept(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  new Conn(socket);
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  const ips = [];
  for (const k of Object.keys(nets)) {
    for (const n of nets[k]) if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
  }
  console.log('麻将联机服务器已启动');
  console.log('  本机： http://localhost:' + PORT + '/');
  ips.forEach((ip) => console.log('  局域网： http://' + ip + ':' + PORT + '/   （同一 WiFi 下的手机用这个）'));
  console.log('  端口 ' + PORT + '，Ctrl+C 停止');
});

/* 测试用导出 */
module.exports = { server: server, rooms: rooms, encodeFrame: encodeFrame, decodeFrames: decodeFrames };