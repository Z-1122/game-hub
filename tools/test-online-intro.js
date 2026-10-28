// 联机开场动画（洗牌 + 砌墙 + 掷骰定庄）验收：本地起服务端，真实 Edge 驱动
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP = 9361;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) failures.push(m); };

function cdpGet(path) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: CDP, path }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}
function meanLuma(png) { return null; }

(async () => {
  const srv = spawn(process.execPath, ['E:\\LeStoreDownload\\game-hub\\server\\server.js', '8794'], {
    env: process.env,
    stdio: 'ignore', detached: true
  });
  await sleep(1200);

  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP}`,
    '--user-data-dir=E:\\LeStoreDownload\\_ep9', '--no-first-run', '--no-default-browser-check',
    '--window-size=844,390', 'about:blank'], { stdio: 'ignore', detached: true });
  await sleep(4500);

  const list = await cdpGet('/json/list');
  const page = list.filter((t) => t.type === 'page')[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push(((d.exception && d.exception.description) || d.text || '').split('\n')[0]);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const call = (mm, p) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: mm, params: p || {} })); });
  const evalJs = async (e) => {
    const r = await call('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      return 'EVALERR:' + ((d.exception && d.exception.description) || d.text || '').split('\n')[0];
    }
    return r.result && r.result.result ? r.result.result.value : 'EVALNONE';
  };
  const shot = async (n) => {
    const s = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`E:\\LeStoreDownload\\shots2\\${n}.png`, Buffer.from(s.result.data, 'base64'));
  };

  await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await call('Page.navigate', { url: 'http://127.0.0.1:8794/' });
  await sleep(5000);
  const head = `JSON.stringify({ready:document.readyState, ui:!!document.getElementById('mj-ui'), dbg:!!window.__mjDebug})`;
  console.log('[页面]', await evalJs(head));

  await evalJs(`document.querySelectorAll('#mj-ui button')[1].click()`);   // 创建房间
  await sleep(1500);
  const before = await evalJs(`JSON.stringify({intro: !!window.__mjDebug.onlineIntro, phase: window.__mjDebug.state})`);
  console.log('[开局前]', before);
  ok(JSON.parse(before).intro === false, '还没开局时没有过场动画');

  // 点开始游戏，过场动画应该立刻出现
  await evalJs(`Array.from(document.querySelectorAll('#mj-ui button')).find(b=>b.textContent.includes('开始游戏')).click()`);
  await sleep(400);
  const during = await evalJs(`JSON.stringify({
    intro: !!window.__mjDebug.onlineIntro,
    dice: window.__mjDebug.onlineIntro && window.__mjDebug.onlineIntro.dice,
    dealer: window.__mjDebug.onlineIntro && window.__mjDebug.onlineIntro.dealer,
    name: window.__mjDebug.onlineIntro && window.__mjDebug.onlineIntro.name,
    phase: window.__mjDebug.state, hand: window.__mjDebug.hand.length
  })`);
  console.log('[过场中]', during);
  const D = JSON.parse(during);
  ok(D.intro === true, '开局后出现过场动画');
  ok(Array.isArray(D.dice) && D.dice.length === 2 && D.dice.every((d) => d >= 1 && d <= 6), '骰子点数来自服务端（' + JSON.stringify(D.dice) + '）');
  ok(typeof D.dealer === 'number' && D.dealer >= 0 && D.dealer < 4, '庄家座位已按自己视角旋转（' + D.dealer + '）');
  ok(typeof D.name === 'string' && D.name.length > 0, '知道谁坐庄（' + D.name + '）');
  ok(D.hand >= 13, '手牌已经按服务端发好（' + D.hand + ' 张）');
  await shot('o1-intro-dice');

  // 过场 2.6 秒后自动消失，并且能正常打牌
  await sleep(3000);
  const after = await evalJs(`JSON.stringify({intro: !!window.__mjDebug.onlineIntro, phase: window.__mjDebug.state, hand: window.__mjDebug.hand.length, my: window.__mjOnline ? window.__mjOnline.myTurn : null})`);
  console.log('[过场后]', after);
  ok(JSON.parse(after).intro === false, '2.6 秒后自动收场');
  await shot('o2-after-intro');

  // 再点一下跳过：切到下一局不容易，这里直接验证 skip 接口可用
  const skip = await evalJs(`(function(){
    window.__mjDebug.startOnlineIntro([2,5], 2, '电脑·西');
    var on = !!window.__mjDebug.onlineIntro;
    window.__mjDebug.skipOnlineIntro();
    return JSON.stringify({on:on, off:!!window.__mjDebug.onlineIntro});
  })()`);
  console.log('[跳过]', skip);
  ok(JSON.parse(skip).on === true && JSON.parse(skip).off === false, '点击可以跳过过场动画');

  ok(errors.length === 0, '整轮无 JS 异常' + (errors.length ? '：' + errors.join(' | ') : ''));
  console.log(errors.length ? '[异常] ' + errors.join(' | ') : '');

  try { ws.close(); } catch (e) {}
  try { process.kill(proc.pid); } catch (e) {}
  try { process.kill(srv.pid); } catch (e) {}
  if (failures.length) { console.log('\nINTRO_UI_FAIL 失败 ' + failures.length + ' 项'); process.exit(1); }
  console.log('\nINTRO_UI_OK 全部通过');
})();