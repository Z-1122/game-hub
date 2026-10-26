// 门户站端到端测试：起本地服务器，用无头 DOM 桩验证 games.json 读取与卡片渲染
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = 'E:\\LeStoreDownload\\game-hub';
const PORT = 8731;

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const full = path.join(ROOT, p);
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  res.end(fs.readFileSync(full));
});

function makeEl(tag) {
  const el = {
    tagName: tag, children: [], style: { setProperty() {} }, _html: '', _text: '',
    hidden: false, href: '', title: '', className: '', animationDelay: '',
    appendChild(c) { this.children.push(c); return c; },
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    set textContent(v) { this._text = v; }, get textContent() { return this._text; },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    querySelectorAll() { return []; }
  };
  return el;
}

const els = {};
for (const id of ['grid', 'empty', 'stats', 'siteTitle', 'siteSubtitle', 'footerText', 'footerLink']) els[id] = makeEl('div');

const documentStub = {
  getElementById: (id) => els[id] || null,
  createElement: (t) => makeEl(t),
  querySelectorAll: () => [],
  addEventListener: () => {},
  title: ''
};

const sandbox = {
  document: documentStub,
  window: { addEventListener: () => {}, location: { href: 'http://localhost/' } },
  console, setTimeout, clearTimeout, Date, Math, JSON, Set, Map, Array, Object, String, Number, Boolean, Error, Promise,
  fetch: (url) => {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${PORT}/${url}`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: () => Promise.resolve(JSON.parse(body)),
          text: () => Promise.resolve(body)
        }));
      }).on('error', reject);
    });
  }
};
sandbox.globalThis = sandbox;

server.listen(PORT, '127.0.0.1', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const code = scripts.join('\n');

  const ctx = vm.createContext(sandbox);
  try {
    vm.runInContext(code, ctx, { filename: 'hub.js' });
  } catch (e) {
    console.error('LOAD_ERROR:', e.stack || e); server.close(); process.exit(1);
  }

  setTimeout(() => {
    try {
      const cards = els.grid.children;
      console.log('渲染卡片数:', cards.length);
      // 期望卡片数与 games.json 中的游戏数一致（不再写死数字，避免加游戏后测试失效）
      const expected = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'games.json'), 'utf8')).games.length;
      if (cards.length !== expected) throw new Error('期望 ' + expected + ' 张卡片，实际 ' + cards.length);

      cards.forEach((c, i) => {
        const hasName = /<h2>/.test(c.innerHTML);
        const hasDesc = /class="desc"/.test(c.innerHTML);
        const hasTags = /class="tag"/.test(c.innerHTML);
        console.log(`  卡片${i + 1}: href=${c.href} 标题=${hasName} 描述=${hasDesc} 标签=${hasTags}`);
        if (!hasName) throw new Error('卡片缺少标题');
      });

      console.log('stats:', els.stats.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      console.log('empty.hidden:', els.empty.hidden, '(应为 true)');
      console.log('document.title:', documentStub.title);
      if (els.empty.hidden !== true) throw new Error('empty 应隐藏');

      console.log('\nHUB_TEST_OK');
      server.close(); process.exit(0);
    } catch (e) {
      console.error('ASSERT_ERROR:', e.message); server.close(); process.exit(1);
    }
  }, 900);
});

setTimeout(() => { console.error('TIMEOUT'); server.close(); process.exit(1); }, 12000);