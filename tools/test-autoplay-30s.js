/* 验证单机模式下「30 秒到点自动出牌」是真的会自己触发（不是只测 autoPlay 函数）。
 * 做法：Edge headless + CDP 的虚拟时间，把 30 秒快进掉，再看牌河/日志有没有变化。 */
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9337;
const SRC = 'E:\\LeStoreDownload\\game-hub\\games\\mahjong.html';
const TMP = 'E:\\LeStoreDownload\\_shot4\\autoplay.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(path) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

(async () => {
  fs.mkdirSync('E:\\LeStoreDownload\\_shot4', { recursive: true });
  const html = fs.readFileSync(SRC, 'utf8');
  fs.writeFileSync(TMP, html.replace('<head>', '<head>\n<script>window.__MJ_AUTOSTART=true;</script>'), 'utf8');

  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=E:\\LeStoreDownload\\_shot4\\cdp-profile',
    '--window-size=1280,720',
    'file:///E:/LeStoreDownload/_shot4/autoplay.html'
  ], { stdio: 'ignore' });

  let ws = null, id = 0;
  const pending = new Map();
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try {
      const list = await get('/json/list');
      const page = list.find((t) => t.type === 'page' && t.url.indexOf('autoplay') >= 0);
      if (!page) continue;
      ws = new WebSocket(page.webSocketDebuggerUrl);
      break;
    } catch (e) { /* 还没起来 */ }
  }
  if (!ws) { console.log('NO_CDP'); proc.kill(); process.exit(1); }

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const call = (mm, p) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: mm, params: p || {} })); });
  const evalJs = async (e) => { const r = await call('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : null; };

  await call('Runtime.enable');
  await sleep(2500);
  const before = JSON.parse(await evalJs(`JSON.stringify({phase:window.__mjDebug.state, disc:(window.__mjDebug.discards[0]||[]).length, turn:window.__mjDebug.turn, log:window.__mjDebug.log.length, left:window.__mjDebug.clockLeft()})`));
  console.log('[30 秒前]', JSON.stringify(before));

  // 虚拟时间快进 33 秒（Date.now 与定时器一起往前走）
  await call('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: 33000 });
  await sleep(4000);

  const after = JSON.parse(await evalJs(`JSON.stringify({phase:window.__mjDebug.state, disc:(window.__mjDebug.discards[0]||[]).length, turn:window.__mjDebug.turn, log:window.__mjDebug.log.length, left:window.__mjDebug.clockLeft(), auto:window.__mjDebug.clockAuto})`));
  console.log('[30 秒后]', JSON.stringify(after));

  let pass = 0, fail = 0;
  const ok = (c, n, x) => { if (c) { pass++; console.log('  ✓ ' + n + (x !== undefined ? ' [' + x + ']' : '')); } else { fail++; console.log('  ✗ ' + n + (x !== undefined ? ' [' + x + ']' : '')); } };
  ok(before.phase === 'playing', '开局进入 playing', before.phase);
  ok(before.left > 0 && before.left <= 30000, '开始计时（剩余毫秒）', before.left);
  ok(after.auto >= 1, '30 秒到点自动托管被触发', after.auto);
  ok(after.log > before.log || after.disc !== before.disc || after.turn !== before.turn,
    '自动出牌导致局面推进', '日志 ' + before.log + '→' + after.log + '，牌河 ' + before.disc + '→' + after.disc + '，轮次 ' + before.turn + '→' + after.turn);

  console.log('\n' + (fail === 0 ? 'AUTOPLAY_OK' : 'AUTOPLAY_FAIL') + ' 通过 ' + pass + ' 失败 ' + fail);
  ws.close();
  try { process.kill(proc.pid); } catch (e) {}
  try { fs.rmSync('E:\\LeStoreDownload\\_shot4', { recursive: true, force: true }); } catch (e) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });