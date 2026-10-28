// 联机整局自动打：真实钩子驱动，检查全程无 JS 异常、能结束、能再来一局
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9356;
const HOST = '121.196.175.181';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdpGet(path) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

(async () => {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
    '--user-data-dir=E:\\LeStoreDownload\\_ep8', '--no-first-run', '--no-default-browser-check',
    '--window-size=844,390', 'about:blank'], { stdio: 'ignore', detached: true });
  await sleep(4500);
  const list = await cdpGet('/json/list');
  const pages = list.filter((t) => t.type === 'page');
  const page = pages.find((t) => t.url.indexOf(HOST) >= 0) || pages[0];
  console.log('[tab]', page.url);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push(((d.exception && d.exception.description) || d.text || '').split('\n')[0] + ' @' + d.lineNumber);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const call = (mm, p) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: mm, params: p || {} })); });
  const evalJs = async (e) => { const r = await call('Runtime.evaluate', { expression: e, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : JSON.stringify(r.result); };
  const shot = async (n) => {
    const s = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`E:\\LeStoreDownload\\shots2\\${n}.png`, Buffer.from(s.result.data, 'base64'));
  };

  await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await call('Page.navigate', { url: 'http://' + HOST + ':8787/' });
  await sleep(6000);
  console.log('[页面]', await evalJs(`JSON.stringify({url:location.href, ui:!!document.getElementById('mj-ui'), diag:!!document.getElementById('mj-diag')})`));

  await evalJs(`document.querySelectorAll('#mj-ui button')[1].click()`);
  await sleep(1500);
  await evalJs(`Array.from(document.querySelectorAll('#mj-ui button')).find(b=>b.textContent.includes('开始游戏')).click()`);
  await sleep(3000);
  console.log('[开局]', await evalJs(`JSON.stringify({phase:window.__mjDebug.state, hand:window.__mjDebug.hand.length, wall:window.__mjDebug.wallLeft})`));

  let steps = 0, overSeen = false, againTested = false;
  for (let i = 0; i < 300; i++) {
    const snap = JSON.parse(await evalJs(`JSON.stringify({
      phase: window.__mjDebug.state,
      waiting: window.__mjDebug.waitingFor,
      hand: window.__mjDebug.hand,
      claim: (window.__mjDebug.pendingClaim || null),
      wall: window.__mjDebug.wallLeft
    })`));

    if (snap.phase === 'over') {
      overSeen = true;
      const w = await evalJs(`JSON.stringify(window.__mjDebug.winner)`);
      console.log('[本局结束] winner=', w, 'wall=', snap.wall);
      await shot('g1-over');
      if (!againTested) {
        againTested = true;
        await evalJs(`window.__mjDebug.action('restart')`);
        await sleep(2500);
        console.log('[再来一局]', await evalJs(`JSON.stringify({phase:window.__mjDebug.state, hand:window.__mjDebug.hand.length, wall:window.__mjDebug.wallLeft})`));
      }
      break;
    }

    if (snap.waiting === 'discard' && snap.hand.length) {
      const t = snap.hand[Math.floor(Math.random() * snap.hand.length)];
      await evalJs(`window.__mjDebug.discard(${t})`);
      steps++;
    } else if (snap.waiting === 'claim' && snap.claim) {
      const opts = snap.claim.options || [];
      const pick = opts.indexOf('hu') >= 0 ? 'hu' : (opts.indexOf('pon') >= 0 && Math.random() < 0.4 ? 'pon' : 'pass');
      await evalJs(`window.__mjDebug.action('${pick}')`);
      steps++;
    }
    await sleep(300);
  }

  console.log('[收尾]', await evalJs(`JSON.stringify({phase:window.__mjDebug.state, wall:window.__mjDebug.wallLeft, disc:(window.__mjDebug.discards[0]||[]).length})`), 'steps=', steps, 'overSeen=', overSeen);
  console.log('[异常]', errors.length ? errors.join(' | ') : 'none');
  await shot('g2-final');

  ws.close();
  try { process.kill(proc.pid); } catch (e) {}
  process.exit(0);
})();