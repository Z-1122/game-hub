// 小屋真实浏览器验收：起本地服务器 + 无头 Edge(CDP)，检查门户卡片与四个新游戏的悬浮导航
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = 'E:\\LeStoreDownload\\game-hub';
const PORT = 8732;
const DBG = 9361;

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.css': 'text/css; charset=utf-8' };
const HITS = new Set();
const MISSES = new Set();

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const full = path.join(ROOT, p);
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    MISSES.add(p);
    res.writeHead(404); res.end('not found'); return;
  }
  HITS.add(p);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(full));
});

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + (extra ? ' :: ' + JSON.stringify(extra) : '')); console.log('  FAIL ' + name + (extra ? ' :: ' + JSON.stringify(extra) : '')); }
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (!p) return;
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      } else this.events.push(m);
    });
  }
  send(method, params) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    return r.result.value;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + PORT;

  const userDir = path.join(ROOT, '_hublive');
  if (fs.existsSync(userDir)) fs.rmSync(userDir, { recursive: true, force: true });
  fs.mkdirSync(userDir, { recursive: true });

  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--remote-debugging-port=' + DBG,
    '--user-data-dir=' + userDir,
    '--window-size=1440,900',
    'about:blank'
  ], { stdio: 'ignore' });

  let list = null;
  for (let i = 0; i < 60; i++) {
    try {
      list = await (await fetch('http://127.0.0.1:' + DBG + '/json/list')).json();
      if (list.some((t) => t.type === 'page')) break;
    } catch (e) { /* not ready */ }
    await sleep(250);
  }
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  async function goto(url, waitMs) {
    cdp.events.length = 0;
    await cdp.send('Page.navigate', { url });
    await sleep(waitMs || 1400);
    const errs = [];
    for (const ev of cdp.events) {
      if (ev.method === 'Runtime.exceptionThrown') {
        const d = ev.params.exceptionDetails;
        errs.push('exception: ' + (d.exception ? d.exception.description : d.text));
      }
      if (ev.method === 'Log.entryAdded' && ev.params.entry.level === 'error') {
        const u = ev.params.entry.url || '';
        if (/favicon\.ico$/.test(u)) continue; // 浏览器自动请求，页面本身没引用，不算页面错误
        errs.push('log: ' + ev.params.entry.text + (u ? ' @ ' + u : ''));
      }
      if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
        errs.push('console: ' + ev.params.args.map((a) => a.value || a.description || '').join(' '));
      }
    }
    return errs;
  }

  // ---------- 门户 ----------
  console.log('[1] 门户：卡片渲染');
  const errs = await goto(base + '/', 1800);
  ok('门户加载无 JS 异常', errs.length === 0, errs.slice(0, 3));

  const portal = await cdp.evalJs(`(() => {
    const cards = Array.from(document.querySelectorAll('#grid a'));
    const rectOf = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; };
    return {
      count: cards.length,
      ids: cards.map(a => (a.getAttribute('href') || '').replace(/^.*games\\//, '').replace(/\\.html$/, '')),
      hrefs: cards.map(a => a.getAttribute('href')),
      names: cards.map(a => (a.querySelector('h2, h3, .card-title, .name') || {}).textContent || (a.textContent || '').trim().split('\\n')[0].trim()),
      texts: cards.map(a => (a.textContent || '').replace(/\\s+/g, ' ').trim()),
      rects: cards.map(rectOf),
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyText: (document.body.innerText || '').slice(-400),
      totalText: (document.body.innerText || '').replace(/\\s+/g, ' ').length,
      gridRect: rectOf(document.getElementById('grid'))
    };
  })()`);

  ok('渲染出 7 张卡片', portal.count === 7, portal.count);
  const expectOrder = ['starfall', 'abyss', 'dungeon', 'mahjong', 'snake', 'echo', '2048'];
  ok('卡片顺序按日期从新到旧', JSON.stringify(portal.ids) === JSON.stringify(expectOrder), portal.ids);
  ok('每张卡片都有文字内容', portal.texts.every((t) => t.length > 12), portal.texts.map((t) => t.length));
  ok('门户无横向溢出（桌面 1440）', portal.overflowX <= 0, portal.overflowX);
  ok('页脚版本号已更新', portal.bodyText.includes('2026-10-29a'), portal.bodyText.slice(-120));

  let overlap = [];
  for (let i = 0; i < portal.rects.length; i++) {
    for (let j = i + 1; j < portal.rects.length; j++) {
      const a = portal.rects[i], b = portal.rects[j];
      const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      const oy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      if (ox > 1 && oy > 1) overlap.push([i, j]);
    }
  }
  ok('卡片之间不重叠', overlap.length === 0, overlap);
  ok('卡片都在可视宽度内', portal.rects.every((r) => r.l >= -1 && r.r <= 1441), portal.rects.map((r) => [r.l, r.r]));

  console.log('[2] 门户：四个新游戏的链接真的能打开');
  for (const id of ['starfall', 'abyss', 'dungeon', 'snake']) {
    const href = portal.hrefs[portal.ids.indexOf(id)];
    const resp = await cdp.evalJs(`fetch(${JSON.stringify(href)}).then(r => r.status + ':' + r.headers.get('content-type'))`);
    ok(id + ' 链接返回 200 且是 HTML', /^200:.*text\/html/.test(resp), resp);
  }

  console.log('[3] 手机竖屏 390×844 门户');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const errsM = await goto(base + '/', 1500);
  const mob = await cdp.evalJs(`(() => {
    const cards = Array.from(document.querySelectorAll('#grid a'));
    const rects = cards.map(a => { const r = a.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, r: r.right }; });
    return {
      count: cards.length,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      minTap: Math.min.apply(null, rects.map(r => Math.min(r.w, r.h))),
      outOfView: rects.filter(r => r.l < -1 || r.r > 391).length
    };
  })()`);
  ok('竖屏无异常', errsM.length === 0, errsM.slice(0, 2));
  ok('竖屏仍渲染 7 张卡片', mob.count === 7, mob.count);
  ok('竖屏无横向溢出', mob.overflowX <= 0, mob.overflowX);
  ok('竖屏卡片不出界', mob.outOfView === 0, mob.outOfView);
  ok('竖屏卡片高度 >= 88px（两行可读）', mob.minTap >= 88, mob.minTap);
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  // ---------- 各游戏页 ----------
  for (const id of ['starfall', 'abyss', 'dungeon', 'snake']) {
    console.log('[4] 游戏页 ' + id);
    const e2 = await goto(base + '/games/' + id + '.html', id === 'abyss' ? 2000 : 1500);
    ok(id + ' 加载无 JS 异常', e2.length === 0, e2.slice(0, 3));
    const info = await cdp.evalJs(`(() => {
      const nav = document.getElementById('hub-nav');
      const cv = document.querySelector('canvas');
      const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; };
      const nr = rectOf(nav), cr = rectOf(cv);
      let coverCanvas = false;
      if (nr && cr) {
        const ox = Math.min(nr.r, cr.r) - Math.max(nr.l, cr.l);
        const oy = Math.min(nr.b, cr.b) - Math.max(nr.t, cr.t);
        coverCanvas = ox > 2 && oy > 2;
      }
      return {
        hasNav: !!nav, navHref: nav ? nav.getAttribute('href') : null, navRect: nr,
        visible: nav ? (getComputedStyle(nav).display !== 'none' && nr.w > 20 && nr.h > 10) : false,
        hasCanvas: !!cv, canvasRect: cr, coverCanvas,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    })()`);
    ok(id + ' 有返回小屋的悬浮按钮', info.hasNav && info.visible, info.navRect);
    ok(id + ' 悬浮按钮指向 ../index.html', info.navHref === '../index.html', info.navHref);
    ok(id + ' 悬浮按钮在视口内', !!info.navRect && info.navRect.l >= -1 && info.navRect.t >= -1 && info.navRect.b <= 901, info.navRect);
    ok(id + ' 悬浮按钮没压住画布', !info.coverCanvas, info.canvasRect && info.navRect);
    ok(id + ' 有画布且尺寸合理', info.hasCanvas && info.canvasRect.w > 200 && info.canvasRect.h > 200, info.canvasRect);
    ok(id + ' 无横向溢出', info.overflowX <= 0, info.overflowX);
  }

  console.log('[5] 悬浮按钮真的能点回小屋');
  await goto(base + '/games/starfall.html', 1200);
  await cdp.evalJs(`document.getElementById('hub-nav').click()`);
  await sleep(1200);
  const backUrl = await cdp.evalJs(`location.pathname`);
  ok('点悬浮按钮回到门户', backUrl === '/' || /index\.html$/.test(backUrl), backUrl);

  ws.close();
  edge.kill();
  server.close();
  await sleep(300);
  if (fs.existsSync(userDir)) fs.rmSync(userDir, { recursive: true, force: true });

  console.log('\n----');
  console.log('RESULT: ' + fail + ' FAILED / ' + pass + ' passed');
  if (fail) { console.log('failures:'); failures.forEach((f) => console.log('  - ' + f)); }
  console.log('HITS: ' + HITS.size + ' files served');
  console.log('404: ' + (MISSES.size ? Array.from(MISSES).join(', ') : 'none'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
