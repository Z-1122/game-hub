/* ============================================================
 *  大众麻将 · 联机客户端（注入单机游戏页面，共用同一套绘制）
 *
 *  工作方式：
 *   单机版页面把 G 当成「唯一的游戏状态」来画。联机时我们让 G 始终等于
 *   服务端发来的本人视角（view），于是单机版的绘制代码原封不动就能用；
 *   所有动作（出牌/碰/杠/胡/过）改成发给服务端，等服务端确认再更新。
 *   大厅、房间座位表这些额外界面画在同一张 canvas 上。
 * ============================================================ */
(function () {
  'use strict';
  if (window.MJ_ONLINE) return;

  // 页面脚本版本对不上时不要静悄悄什么都不做——黑屏最难查，直接说清楚
  function bail(msg) {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99;padding:10px 12px;' +
      'font:13px/1.6 "PingFang SC","Microsoft YaHei",sans-serif;color:#ffe08a;' +
      'background:#3a1a12;border-bottom:1px solid #ffb27a;white-space:pre-wrap';
    d.textContent = msg;
    document.body.appendChild(d);
  }
  if (!window.__mjDebug) { bail('联机脚本没找到游戏内核（__mjDebug）。请刷新页面。'); return; }
  if (!window.__mjDebug.rawRender) {
    bail('联机脚本与页面版本不匹配（缺少 rawRender 钩子）。\n请强制刷新：手机上关掉这个页面再重新打开。');
    return;
  }

  var DBG = window.__mjDebug;
  var CV = document.querySelector('canvas');
  var CTX = CV.getContext('2d');
  var VW = 1280, VH = 720;                   // 与单机页面同一套逻辑分辨率
  var SEATS_CN = ['东', '南', '西', '北'];

  // 客户端版本号：改完这里，手机上能直接看到大厅底部显示的是哪一版，
  // 用来判断「是不是浏览器还缓存着旧文件」。
  var VERSION = '2026-10-28d';

  // 画了几帧 / 最近一次绘制异常：手机上黑屏时靠它俩定位问题
  var FRAMES = 0;
  var LASTERR = '';

  window.MJ_ONLINE = true;

  /* ---------------- 状态 ---------------- */
  var ST = {
    phase: 'menu',          // menu | lobby | playing | lost
    ws: null,
    connected: false,
    playerId: null,
    name: '',
    room: null,             // { code, seats, started }
    seat: 0,                // 我的座位（服务端告知的真座位号）
    editing: false,
    err: '',
    errAt: 0,
    hints: [],
    turnMs: 30000,          // 服务端规定的每人思考时限
    turnLeft: 0,            // 收到 state 那一刻的剩余毫秒
    turnAt: 0,              // 收到 state 的本地时间（用来往下扣时间）
    myTurn: false           // 现在是不是该我做决定
  };
  window.__mjOnline = ST;

  /* ---------------- 工具 ---------------- */
  function T() { return Date.now(); }
  // 屏幕坐标 → 逻辑坐标（1280x720）
  // 单机页面按 cv.clientWidth/clientHeight 算缩放和居中留白；手机上的
  // getBoundingClientRect 可能含缩放/安全区偏差，所以用 clientWidth 对齐。
  function toLogical(clientX, clientY) {
    var r = CV.getBoundingClientRect();
    var w = CV.clientWidth || r.width || VW;
    var h = CV.clientHeight || r.height || VH;
    if (!w || !h) return { x: -1, y: -1 };
    var s = Math.min(w / VW, h / VH);
    var ox = (w - VW * s) / 2, oy = (h - VH * s) / 2;
    return { x: (clientX - r.left - ox) / s, y: (clientY - r.top - oy) / s };
  }
  function setErr(t) { ST.err = t; ST.errAt = T(); DBG.markDirty(); }
  function hint(t) {
    ST.hints.push({ text: t, at: T() });
    if (ST.hints.length > 3) ST.hints.shift();
  }
  function errVisible() { return ST.err && T() - ST.errAt < 8000; }

  /* ---------------- 绘制小工具 ---------------- */
  function roundRectPath(x, y, w, h, r) {
    CTX.beginPath();
    if (CTX.roundRect) { CTX.roundRect(x, y, w, h, r); return; }
    CTX.moveTo(x + r, y);
    CTX.arcTo(x + w, y, x + w, y + h, r);
    CTX.arcTo(x + w, y + h, x, y + h, r);
    CTX.arcTo(x, y + h, x, y, r);
    CTX.arcTo(x, y, x + w, y, r);
    CTX.closePath();
  }
  function text(s, x, y, size, color, align, weight) {
    CTX.save();
    CTX.fillStyle = color || 'rgba(226,244,232,0.9)';
    CTX.font = (weight || '500') + ' ' + (size || 20) + 'px "PingFang SC","Microsoft YaHei",sans-serif';
    CTX.textAlign = align || 'left';
    CTX.textBaseline = 'middle';
    CTX.fillText(s, x, y);
    CTX.restore();
  }
  function panel(x, y, w, h, accent) {
    CTX.save();
    roundRectPath(x, y, w, h, 18);
    CTX.fillStyle = 'rgba(8,26,18,0.80)';
    CTX.fill();
    CTX.strokeStyle = accent || 'rgba(150,220,180,0.22)';
    CTX.lineWidth = 2;
    CTX.stroke();
    CTX.restore();
  }
  var UI_BTN = [];
  function button(label, x, y, w, h, opts) {
    opts = opts || {};
    UI_BTN.push({ x: x, y: y, w: w, h: h, action: opts.action });
    CTX.save();
    roundRectPath(x, y, w, h, 14);
    var g = CTX.createLinearGradient(0, y, 0, y + h);
    if (opts.hot) { g.addColorStop(0, '#f0d58a'); g.addColorStop(1, '#c99b3f'); }
    else { g.addColorStop(0, 'rgba(30,70,50,0.95)'); g.addColorStop(1, 'rgba(12,36,24,0.95)'); }
    CTX.fillStyle = g;
    CTX.fill();
    CTX.strokeStyle = opts.hot ? 'rgba(255,236,175,0.95)' : 'rgba(150,220,180,0.35)';
    CTX.lineWidth = 2;
    CTX.stroke();
    CTX.restore();
    text(label, x + w / 2, y + h / 2 + 1, opts.size || 22,
      opts.hot ? '#20170a' : 'rgba(226,244,232,0.95)', 'center', '700');
  }

  /* ---------------- WebSocket ---------------- */
  function openSocket(onReady) {
    if (ST.ws && ST.ws.readyState === 1) { onReady && onReady(); return; }
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var url = proto + location.host;
    var ws;
    try { ws = new WebSocket(url); } catch (e) { setErr('连接失败：' + e.message); return; }
    ST.ws = ws;
    ws.onopen = function () {
      ST.connected = true;
      DBG.markDirty();
      onReady && onReady();
    };
    ws.onclose = function () {
      ST.connected = false;
      if (ST.phase === 'playing') { ST.phase = 'lost'; setErr('与服务器的连接断了'); }
      DBG.markDirty();
    };
    ws.onerror = function () {
      ST.connected = false;
      setErr('连不上 ' + url + '（服务器没启动，或设备不在同一网络）');
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      onServer(msg);
    };
  }
  function send(obj) {
    if (!ST.ws || ST.ws.readyState !== 1) { setErr('还没连上服务器'); return; }
    try { ST.ws.send(JSON.stringify(obj)); } catch (e) { setErr('发送失败'); }
  }

  /* ---------------- 服务端消息 ---------------- */
  function onServer(msg) {
    switch (msg.t) {
      case 'welcome':
        ST.playerId = msg.playerId;
        if (msg.name) ST.name = msg.name;
        break;
      case 'joined':
        ST.room = { code: msg.code, seats: [], started: false };
        ST.seat = msg.seat;
        ST.phase = 'lobby';
        break;
      case 'room':
        ST.room = msg;
        if (typeof msg.mySeat === 'number') ST.seat = msg.mySeat;
        if (ST.phase === 'menu') ST.phase = 'lobby';
        if (msg.started) ST.phase = 'playing';
        break;
      case 'state':
        ST.phase = msg.view.phase === 'playing' ? 'playing' : ST.phase;
        // 30 秒思考时限：服务端给的是「这一刻还剩多少」，本地按收到时间往下扣
        ST.turnMs = msg.turnMs || 30000;
        ST.turnLeft = (typeof msg.turnLeft === 'number') ? msg.turnLeft : 0;
        ST.turnAt = Date.now();
        ST.myTurn = (msg.view.waitingFor === 'me' || msg.view.waitingFor === 'claim');
        applyView(msg.view);
        return;
      case 'log':
        hint(msg.text);
        break;
      case 'error':
        setErr(msg.message);
        break;
      case 'left':
        ST.room = null; ST.seat = 0; ST.phase = 'menu';
        break;
    }
    DBG.markDirty();
  }

  // 把服务端视角旋转成「我在 0 号位」放进单机版的 G，原绘制逻辑即可直接渲染
  function applyView(v) {
    var G = DBG.getG();
    var seat = v.seat;
    G.phase = v.phase === 'playing' ? 'playing' : 'over';
    G.turn = (v.turn - seat + 4) % 4;
    G.wallLeft = v.wallLeft;
    G.lastDiscard = v.lastDiscard;
    // 服务端的 winner 形状是 {seat,tile,from,selfDraw}，单机版要 {p,...}，且座位要旋转
    if (v.winner) {
      G.winner = {
        p: (v.winner.seat - seat + 4) % 4,
        tile: v.winner.tile,
        from: (v.winner.from == null ? null : (v.winner.from - seat + 4) % 4),
        selfDraw: !!v.winner.selfDraw,
        reason: v.winner.reason
      };
    } else {
      G.winner = null;
    }
    G.log = (v.log || []).slice();
    G.waitingFor = v.waitingFor === 'me' ? 'discard' : (v.waitingFor === 'claim' ? 'claim' : 'ai');

    G.players = [0, 1, 2, 3].map(function (k) {
      var src = v.players[(seat + k) % 4];
      var hand = [];
      if (src.hand) hand = src.hand.slice();
      else for (var i = 0; i < src.handCount; i++) hand.push(-1);   // 别人的牌：只看张数
      return {
        id: k,
        name: src.name,
        hand: hand,
        melds: src.melds || [],
        discards: src.discards || [],
        tenpai: []
      };
    });

    // 摸到的牌：单机版把摸到的牌放在手牌末尾，靠 drawnTile 高亮
    G.drawnTile = null;
    var mine = v.players[seat];
    if (mine.drawn != null) {
      var h0 = G.players[0].hand;
      var di = h0.indexOf(mine.drawn);
      if (di >= 0 && di !== h0.length - 1) {
        h0.splice(di, 1);
        h0.push(mine.drawn);
      }
      G.drawnTile = mine.drawn;
    }

    // 碰杠胡等待：仿单机版的 pendingClaim 结构（from 也按座位旋转）
    if (v.claim) {
      G.pendingClaim = {
        from: (v.claim.from - seat + 4) % 4,
        tile: v.claim.tile,
        options: v.claim.options.slice()
      };
      G.lastDiscard = { player: (v.claim.from - seat + 4) % 4, tile: v.claim.tile };
    } else {
      G.pendingClaim = null;
    }

    ST.myTurn = v.waitingFor === 'me';
    ST.canTsumo = !!(v.claim && v.claim.options.indexOf('hu') >= 0);
    DBG.markDirty();
  }

  /* ---------------- 动作：一律发给服务端 ---------------- */
  window.__mjOnlineAct = function (type, tile, extra) {
    if (!ST.connected) { setErr('还没连上服务器'); return; }
    var a = { type: type };
    if (tile != null) a.tile = tile;
    if (extra) a.claim = extra;
    send({ t: 'action', action: a });
  };

  // 装到单机页面的扩展点上
  DBG.onlineAction = function (kind, tile, claim) {
    if (!ST.connected) { setErr('还没连上服务器'); return; }
    if (kind === 'discard') send({ t: 'action', action: { type: 'discard', tile: tile } });
    else if (kind === 'claim') send({ t: 'action', action: { type: 'claim', action: claim } });
    else if (kind === 'tsumo') send({ t: 'action', action: { type: 'tsumo' } });
    else if (kind === 'ankan') send({ t: 'action', action: { type: 'ankan', tile: tile } });
    else if (kind === 'again') send({ t: 'again' });
  };
  // 单机页面里 onlineAction 是普通变量，这里用 getter 不支持，故直接改导出属性
  DBG.setOnlineAction(function (kind, tile, claim) { DBG.onlineAction(kind, tile, claim); });

/* ---------------- 大厅界面：真 DOM ----------------
   * 为什么大厅不用 canvas 画：canvas 只要因为浏览器差异没拿到正确尺寸，
   * 整块画面就是一片黑，用户连「创建房间」都点不到（真实踩过）。
   * 大厅改成普通 HTML 元素后，按钮是浏览器原生控件，竖屏横屏都正常，
   * 输入房号还能直接调出手机键盘。牌桌仍然由 canvas 画。 */
  var CODE = '';
  var UI_BTN = [];        // 旧 canvas 命中表，DOM 模式不再使用，留着防旧引用报错
  var UI = null;

  function injectUiStyles() {
    var css = [
      '#mj-ui{position:fixed;top:0;left:0;right:0;bottom:0;inset:0;z-index:30;',
      'display:flex;align-items:center;justify-content:center;overflow-y:auto;',
      'padding:14px;box-sizing:border-box;',
      'font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;',
      'color:#eaf5ee;-webkit-tap-highlight-color:transparent}',
      '#mj-ui .card{width:100%;max-width:430px;margin:auto;padding:20px 18px 16px;',
      'border-radius:18px;background:rgba(7,20,13,.82);',
      'border:1px solid rgba(150,220,180,.20);box-shadow:0 16px 44px rgba(0,0,0,.5)}',
      '#mj-ui h1{margin:0 0 6px;font-size:26px;text-align:center;letter-spacing:.08em;color:#f6efd8}',
      '#mj-ui .sub{margin:0 0 16px;text-align:center;font-size:13px;line-height:1.6;color:rgba(232,196,106,.88)}',
      '#mj-ui input{display:block;width:100%;box-sizing:border-box;padding:12px 8px;margin:0;',
      'font-size:22px;letter-spacing:.34em;text-align:center;text-transform:uppercase;',
      'border-radius:12px;border:1px solid rgba(150,220,180,.35);background:rgba(0,0,0,.35);',
      'color:#ffdf95;outline:none;font-family:inherit}',
      '#mj-ui input::placeholder{letter-spacing:.08em;font-size:15px;color:rgba(180,210,195,.55)}',
      '#mj-ui button{display:block;width:100%;box-sizing:border-box;margin:10px 0 0;padding:15px 10px;',
      'font-size:17px;font-weight:700;border-radius:14px;border:1px solid rgba(150,220,180,.26);',
      'background:rgba(255,255,255,.07);color:#eaf5ee;font-family:inherit;cursor:pointer}',
      '#mj-ui button:active{background:rgba(255,255,255,.16)}',
      '#mj-ui button.primary{background:linear-gradient(180deg,#2e9059,#1b653c);',
      'border-color:rgba(255,225,150,.38);color:#fffbe9}',
      '#mj-ui button.small{font-size:15px;padding:12px 10px;font-weight:600}',
      '#mj-ui .seats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0 2px}',
      '#mj-ui .seat{padding:10px;border-radius:12px;border:1px solid rgba(150,220,180,.18);',
      'background:rgba(255,255,255,.04);min-height:54px}',
      '#mj-ui .seat.me{border-color:rgba(255,220,140,.65);background:rgba(255,220,140,.09)}',
      '#mj-ui .seat b{display:block;font-size:11px;letter-spacing:.12em;margin-bottom:5px;',
      'color:rgba(232,196,106,.82);font-weight:600}',
      '#mj-ui .seat .who{font-size:14px;color:rgba(226,244,232,.95);word-break:break-all}',
      '#mj-ui .seat.empty .who{color:rgba(180,210,195,.5)}',
      '#mj-ui .code{margin:2px 0 0;text-align:center;font-size:34px;font-weight:800;',
      'letter-spacing:.2em;color:#ffdf95}',
      '#mj-ui .status{margin:14px 0 0;text-align:center;font-size:12px;color:rgba(180,210,195,.72)}',
      '#mj-ui .err{margin:10px 0 0;text-align:center;font-size:12.5px;color:#ff9a8c;min-height:1em}'
    ].join('');
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
  }

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function mkBtn(label, action, cls) {
    var b = el('button', cls || null, label);
    b.type = 'button';
    // 用 pointerdown 而不是 click：手机上更跟手，也不会被 300ms 延迟吞掉
    b.addEventListener('click', function (ev) {
      ev.preventDefault();
      handleUI(action);
    });
    return b;
  }

  function buildUi() {
    if (UI) return UI;
    injectUiStyles();
    var root = el('div');
    root.id = 'mj-ui';
    UI = { root: root };

    // ---------- 主菜单 ----------
    var menu = el('div', 'card');
    menu.appendChild(el('h1', null, '联机麻将'));
    menu.appendChild(el('p', 'sub', '四人一桌 · 人不够由电脑补位'));
    var input = el('input');
    input.maxLength = 4;
    input.autocapitalize = 'characters';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = '输入 4 位房号';
    input.addEventListener('input', function () {
      CODE = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      if (input.value !== CODE) input.value = CODE;
    });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') handleUI('join'); });
    menu.appendChild(input);
    menu.appendChild(mkBtn('加入房间', 'join', 'primary'));
    menu.appendChild(mkBtn('创建房间', 'create'));
    menu.appendChild(mkBtn('单人练习', 'solo', 'small'));
    UI.menuStatus = el('p', 'status', '');
    UI.menuErr = el('p', 'err', '');
    menu.appendChild(UI.menuStatus);
    menu.appendChild(UI.menuErr);
    UI.codeInput = input;

    // ---------- 房间 ----------
    var lobby = el('div', 'card');
    lobby.appendChild(el('h1', null, '房间'));
    UI.roomCode = el('p', 'code', '----');
    lobby.appendChild(UI.roomCode);
    lobby.appendChild(el('p', 'sub', '把房号告诉朋友，他们在大厅输入就能进来；空位开局后由电脑补上。'));
    var seats = el('div', 'seats');
    UI.seatEls = [];
    for (var i = 0; i < 4; i++) {
      var s = el('div', 'seat');
      var lab = el('b', null, SEATS_CN[i] + '位');
      var who = el('div', 'who', '空位 → 电脑');
      s.appendChild(lab); s.appendChild(who);
      seats.appendChild(s);
      UI.seatEls.push({ box: s, who: who });
    }
    lobby.appendChild(seats);
    lobby.appendChild(mkBtn('开始游戏', 'start', 'primary'));
    lobby.appendChild(mkBtn('复制房号', 'copy', 'small'));
    lobby.appendChild(mkBtn('退出房间', 'leave', 'small'));
    UI.lobbyErr = el('p', 'err', '');
    lobby.appendChild(UI.lobbyErr);

    // ---------- 断线 ----------
    var lost = el('div', 'card');
    lost.appendChild(el('h1', null, '连接断开了'));
    lost.appendChild(el('p', 'sub', '网络或服务器中断了。重连后如果座位还在，会回到原来的牌局。'));
    lost.appendChild(mkBtn('重连', 'reconnect', 'primary'));
    lost.appendChild(mkBtn('回大厅', 'menu', 'small'));
    UI.lostErr = el('p', 'err', '');
    lost.appendChild(UI.lostErr);

    UI.screens = { menu: menu, lobby: lobby, lost: lost };
    root.appendChild(menu);
    root.appendChild(lobby);
    root.appendChild(lost);
    document.body.appendChild(root);
    return UI;
  }

  // 把当前状态刷到 DOM 上；每帧渲染和每次操作后都会调，幂等、开销小
  function syncUi() {
    if (!UI) return;
    var playing = (ST.phase === 'playing' || ST.phase === 'solo');
    UI.root.style.display = playing ? 'none' : 'flex';
    if (playing) return;

    UI.screens.menu.style.display = ST.phase === 'menu' ? 'block' : 'none';
    UI.screens.lobby.style.display = ST.phase === 'lobby' ? 'block' : 'none';
    UI.screens.lost.style.display = ST.phase === 'lost' ? 'block' : 'none';

    // 连接状态不再显示（用户要求：不要「已连接 + 网址」那行）；只有连不上时才给一句提示
    UI.menuStatus.style.display = ST.connected ? 'none' : 'block';
    UI.menuStatus.textContent = ST.connected ? '' : '正在连接服务器…';
    UI.menuErr.textContent = errVisible() && ST.phase === 'menu' ? ST.err : '';

    if (ST.phase === 'lobby') {
      var room = ST.room || {};
      UI.roomCode.textContent = room.code || '----';
      var seats = room.seats || [];
      for (var i = 0; i < 4; i++) {
        var s = seats[i], cell = UI.seatEls[i];
        var mine = ST.seat === i;
        cell.box.className = 'seat' + (mine ? ' me' : '') + (s ? '' : ' empty');
        cell.who.textContent = s ? (s.name + (s.isAI ? '（电脑）' : '') + (mine ? ' · 你' : '')) : '空位 → 电脑';
      }
      UI.lobbyErr.textContent = errVisible() ? ST.err : '';
    }
    if (ST.phase === 'lost') UI.lostErr.textContent = ST.err || '';
  }

  /* ---------------- 点击分发 ---------------- */
  // DOM 模式下 canvas 上的点击一律不交给单机逻辑（大厅没有可点的画布内容）
  DBG.onlineTap = function () { return ST.phase !== 'playing'; };

  function handleUI(a) {
    if (DBG.sfxOne) DBG.sfxOne('tap');
    if (a === 'create') openSocket(function () { send({ t: 'create' }); });
    else if (a === 'join') {
      if (!ST.connected) { openSocket(function () { send({ t: 'join', code: CODE }); }); return; }
      if (CODE.length < 4) { setErr('请先输入 4 位房号'); return; }
      send({ t: 'join', code: CODE });
    }
    else if (a === 'start') send({ t: 'start' });
    else if (a === 'leave') { send({ t: 'leave' }); ST.phase = 'menu'; ST.room = null; }
    else if (a === 'copy') {
      var code = (ST.room && ST.room.code) || '';
      var done = function () { setErr('房号 ' + code + ' 已复制'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(done, function () { setErr('房号：' + code); });
      } else setErr('房号：' + code);
    }
    else if (a === 'reconnect') reconnect();
    else if (a === 'menu') { ST.phase = 'menu'; }
    else if (a === 'solo') soloMode();
    syncUi();
    DBG.markDirty();
  }

  function reconnect() {
    if (ST.ws) { try { ST.ws.close(); } catch (e) { /* 忽略 */ } }
    ST.ws = null;
    ST.connected = false;
    ST.err = '';
    openSocket(function () { send({ t: 'hello', playerId: ST.playerId, name: ST.name }); });
  }

  function soloMode() {
    if (ST.ws) { try { ST.ws.close(); } catch (e) { /* 忽略 */ } }
    ST.ws = null;
    ST.connected = false;
    ST.phase = 'solo';
    window.MJ_ONLINE = false;
    // 单机练习时把大厅 DOM 收起来，否则它会盖在牌桌上
    if (UI) UI.root.style.display = 'none';
    DBG.setOnlineAction(null);
    DBG.setRenderOverride(null);
    DBG.onlineTap = null;
    DBG.start();
    DBG.markDirty();
  }

  /* ---------------- CSS 像素坐标系（canvas 底纹用） ----------------
   * 牌桌用 1280x720 逻辑坐标；大厅底纹改用画布 CSS 像素，这样竖屏也不会被压成一条。
   * uiW/uiH 返回画布的 CSS 尺寸，uiUnit 是一个与屏幕宽度挂钩的基准单位。 */
  function uiDpr() { return window.devicePixelRatio || 1; }
  function uiW() { return CV.clientWidth || CV.width / uiDpr(); }
  function uiH() { return CV.clientHeight || CV.height / uiDpr(); }
  function uiUnit() {
    var w = uiW(), h = uiH();
    return Math.max(56, Math.min(w, h) * 0.24);
  }
  function beginUISpace() {
    var d = uiDpr();
    CTX.setTransform(d, 0, 0, d, 0, 0);
  }

  /* 大厅底纹：一层深绿渐变 + 细网格，纯装饰，不承载任何信息 */
  function drawBackdrop() {
    var w = uiW(), h = uiH();
    var g = CTX.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#0b2018');
    g.addColorStop(0.55, '#0a1a13');
    g.addColorStop(1, '#061009');
    CTX.fillStyle = g;
    CTX.fillRect(0, 0, w, h);

    CTX.strokeStyle = 'rgba(120,200,160,0.05)';
    CTX.lineWidth = 1;
    var step = 28;
    for (var x = 0; x < w; x += step) {
      CTX.beginPath(); CTX.moveTo(x + 0.5, 0); CTX.lineTo(x + 0.5, h); CTX.stroke();
    }
    for (var y = 0; y < h; y += step) {
      CTX.beginPath(); CTX.moveTo(0, y + 0.5); CTX.lineTo(w, y + 0.5); CTX.stroke();
    }

    // 顶部一抹暖光，避免整屏死气沉沉
    var rg = CTX.createRadialGradient(w * 0.5, h * 0.06, 0, w * 0.5, h * 0.06, Math.max(w, h) * 0.55);
    rg.addColorStop(0, 'rgba(120,220,170,0.10)');
    rg.addColorStop(1, 'rgba(120,220,170,0)');
    CTX.fillStyle = rg;
    CTX.fillRect(0, 0, w, h);
  }

  /* ---------------- 接管渲染 ----------------
   * 大厅/房间/断线这三屏现在是 DOM（见 buildUi），canvas 只负责铺一层底纹；
   * 打牌时把画面完全交还单机逻辑。
   * 注意 save/restore：canvas 底纹用「CSS 像素」坐标系，牌桌用 1280x720 逻辑坐标，
   * 共用同一个 ctx，切过去画完必须还原，否则回到牌桌时 transform 是错的。 */
  DBG.setRenderOverride(function () {
    var playing = (ST.phase === 'playing' || ST.phase === 'solo');
    try {
      syncUi();
      if (!playing) {
        CTX.save();
        try {
          beginUISpace();
          drawBackdrop();
        } finally {
          CTX.restore();
        }
      }
    } catch (e) {
      LASTERR = (e && e.message) || String(e);
    }
    FRAMES++;
    return !playing;
  });

  /* ---------------- 竖屏辅助 ----------------
   * 单机页在竖屏时会弹一个盖满屏幕的「请把手机横过来」提示，
   * 但联机大厅本身已经能竖屏正常用，所以联机模式下把它关掉，
   * 换成只在打牌时提示的细条（不挡操作）。 */

  // 进全屏 + 尝试锁横屏。iOS Safari 不支持 orientation.lock，静默失败即可
  function enterFullscreenLandscape() {
    var elx = document.documentElement;
    var p = (elx.requestFullscreen || elx.webkitRequestFullscreen || function () {});
    try {
      var r = p.call(elx, { navigationUI: 'hide' });
      if (r && r.catch) r.catch(function () { /* 用户拒绝就不勉强 */ });
    } catch (e) { /* 忽略 */ }
    setTimeout(function () {
      try {
        var o = screen.orientation || screen.webkitOrientation;
        if (o && o.lock) {
          var lr = o.lock('landscape');
          if (lr && lr.catch) lr.catch(function () { /* 不支持 */ });
        }
      } catch (e) { /* 忽略 */ }
    }, 120);
  }

  function setupPortraitHelp() {
    var st = document.createElement('style');
    st.textContent = '#rotate-tip{display:none !important}';
    document.head.appendChild(st);

    var bar = document.createElement('div');
    bar.id = 'mj-portrait-bar';
    bar.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'top:0', 'z-index:40',
      'padding:8px 10px', 'text-align:center', 'font-size:13px',
      'color:rgba(255,235,180,0.95)', 'background:rgba(6,16,10,0.86)',
      'display:none', 'cursor:pointer',
      'font-family:"PingFang SC","Microsoft YaHei",sans-serif'
    ].join(';');
    bar.textContent = '竖屏能玩 · 点这里全屏横屏（更大）';
    // 点一下就進全屏并尝试锁定横屏，很多安卓浏览器支持，iOS Safari 不支持也不影响玩
    bar.addEventListener('click', function () { enterFullscreenLandscape(); });
    document.body.appendChild(bar);

    // 竖屏打牌时牌桌是 16:9，屏幕下方会空出一大块；把那块地方做成一个「横过来」的大按钮
    var fsBtn = document.createElement('div');
    fsBtn.id = 'mj-fs-btn';
    fsBtn.style.cssText = [
      'position:fixed', 'left:50%', 'transform:translateX(-50%)', 'bottom:8%',
      'z-index:39', 'display:none', 'padding:16px 26px', 'border-radius:999px',
      'border:1px solid rgba(160,230,190,0.42)',
      'background:linear-gradient(180deg,rgba(46,144,89,0.96),rgba(24,90,54,0.96))',
      'color:#fffbe9', 'font:700 16px/1 "PingFang SC","Microsoft YaHei",sans-serif',
      'letter-spacing:.04em', 'box-shadow:0 10px 30px rgba(0,0,0,.45)', 'cursor:pointer'
    ].join(';');
    fsBtn.textContent = '⛶ 全屏横屏（更大更清楚）';
    fsBtn.addEventListener('click', function () { enterFullscreenLandscape(); });
    document.body.appendChild(fsBtn);

    // 右上角的 30 秒思考倒计时：只有轮到自己做决定时才出现
    var clock = document.createElement('div');
    clock.id = 'mj-clock';
    clock.style.cssText = [
      'position:fixed', 'right:10px', 'top:10px', 'z-index:42',
      'display:none', 'padding:7px 13px', 'border-radius:999px',
      'border:1px solid rgba(150,240,180,0.45)',
      'background:rgba(8,28,18,0.82)', 'color:rgba(190,245,210,0.96)',
      'font:700 14px/1 "PingFang SC","Microsoft YaHei",sans-serif',
      'letter-spacing:.02em', 'pointer-events:none',
      'box-shadow:0 6px 18px rgba(0,0,0,.4)'
    ].join(';');
    document.body.appendChild(clock);

    // 左下角的自检小字：黑屏时让主人把这行字截图给本鱼，一眼就知道卡在哪
    var diag = document.createElement('div');
    diag.id = 'mj-diag';
    diag.style.cssText = [
      'position:fixed', 'left:6px', 'bottom:4px', 'z-index:41',
      'font:10px/1.35 ui-monospace,Consolas,monospace',
      'color:rgba(170,220,190,0.55)', 'pointer-events:none',
      'max-width:96vw', 'white-space:pre-wrap'
    ].join(';');
    document.body.appendChild(diag);

    function paintDiag() {
      // 平时不显示，免得压住「上家·13 张」这类信息；
      // 出错时强制显示，或在地址后加 ?diag=1 主动打开。
      var want = LASTERR || /[?&]diag=1/.test(location.search);
      if (!want) { diag.style.display = 'none'; return; }
      diag.style.display = 'block';
      var s = 'v' + VERSION + ' · ' + ST.phase + ' · ' + Math.round(uiW()) + 'x' + Math.round(uiH()) +
        ' · f' + FRAMES + ' · ws:' + (ST.connected ? 'ok' : 'no');
      if (LASTERR) s += '\n错误: ' + LASTERR;
      diag.textContent = s;
    }

    window.addEventListener('error', function (e) {
      LASTERR = (e.message || 'error') + ' @' + (e.lineno || '?');
      paintDiag();
    });
    window.addEventListener('unhandledrejection', function (e) {
      LASTERR = 'promise: ' + ((e.reason && e.reason.message) || e.reason);
      paintDiag();
    });

    function update() {
      var portrait = window.innerHeight > window.innerWidth * 1.04;
      var playing = ST.phase === 'playing';
      bar.style.display = (portrait && playing) ? 'block' : 'none';
      // 竖屏打牌：屏幕下方那块空白放一个进全屏横屏的按钮
      fsBtn.style.display = (portrait && playing) ? 'block' : 'none';
      // 我的回合才显示倒计时；超时会由服务端自动代打
      var showClock = playing && ST.myTurn;
      if (showClock) {
        var left = Math.max(0, ST.turnLeft - (Date.now() - ST.turnAt));
        var sec = Math.ceil(left / 1000);
        clock.style.display = 'block';
        clock.textContent = '⏱ ' + sec + '秒';
        var hot = sec <= 10;
        clock.style.color = hot ? 'rgba(255,170,150,0.98)' : 'rgba(190,245,210,0.96)';
        clock.style.borderColor = hot ? 'rgba(255,140,110,0.6)' : 'rgba(150,240,180,0.45)';
        clock.style.background = hot ? 'rgba(60,14,10,0.85)' : 'rgba(8,28,18,0.82)';
      } else {
        clock.style.display = 'none';
      }
      // 看门狗：一帧都没画出来就主动催一次重绘（首帧撞上 0 尺寸时能自愈）
      if (FRAMES === 0) { try { DBG.markDirty(); } catch (e) { /* 忽略 */ } }
      paintDiag();
    }
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', function () { setTimeout(update, 80); });
    setInterval(update, 250);
    update();
  }

  /* ---------------- 启动 ---------------- */
  (function boot() {
    try { ST.name = (localStorage.getItem('mj_name') || '').trim(); } catch (e) { ST.name = ''; }
    if (!ST.name) {
      ST.name = '玩家' + Math.random().toString(36).slice(2, 6).toUpperCase();
      try { localStorage.setItem('mj_name', ST.name); } catch (e) { /* 忽略 */ }
    }
    setupPortraitHelp();
    buildUi();
    syncUi();
    openSocket(function () { send({ t: 'hello', name: ST.name, playerId: ST.playerId }); });
  })();

  setInterval(function () {
    if (ST.ws && ST.ws.readyState === 1) {
      try { ST.ws.send(JSON.stringify({ t: 'ping', at: T() })); } catch (e) { /* 忽略 */ }
    }
  }, 20000);
})();