// 给 games/ 下的游戏注入统一的「返回门户」浮标。
// 用法: node tools/inject-nav.js
const fs = require('fs');
const path = require('path');

const GAMES_DIR = path.join(__dirname, '..', 'games');
const MARK = 'data-hub-nav';

const NAV_CSS = `
<style ${MARK}="css">
  #hub-nav {
    position: fixed; top: 14px; left: 14px; z-index: 2147483000;
    display: inline-flex; align-items: center; gap: 7px;
    padding: 7px 14px 7px 11px; border-radius: 999px;
    font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
    font-size: 12.5px; font-weight: 600; line-height: 1;
    color: #dff6ff; text-decoration: none; cursor: pointer;
    background: rgba(8, 16, 28, 0.62);
    border: 1px solid rgba(120, 200, 255, 0.28);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    box-shadow: 0 6px 22px -8px rgba(0, 0, 0, 0.75);
    opacity: 0.55; transition: opacity .2s, transform .2s, border-color .2s;
  }
  #hub-nav:hover, #hub-nav:focus-visible {
    opacity: 1; transform: translateY(-1px);
    border-color: rgba(120, 200, 255, 0.65);
    outline: none;
  }
  #hub-nav svg { width: 13px; height: 13px; flex: none; }

  /* 浅色背景的游戏（如 2048）加 class="hub-nav-light" 覆盖配色。
     注入时脚本会自动检测背景色并加上这个 class。 */
  #hub-nav.hub-nav-light {
    color: #3a332c;
    background: rgba(255, 255, 255, 0.82);
    border-color: rgba(120, 100, 80, 0.28);
    box-shadow: 0 6px 20px -8px rgba(90, 75, 60, 0.45);
  }
  #hub-nav.hub-nav-light:hover, #hub-nav.hub-nav-light:focus-visible {
    border-color: rgba(120, 100, 80, 0.55);
  }
  @media (max-width: 560px) {
    #hub-nav { top: 10px; left: 10px; padding: 6px 11px 6px 9px; font-size: 12px; }
  }
  @media print { #hub-nav { display: none; } }
</style>
`;

const NAV_HTML = `<a id="hub-nav" href="../index.html" title="返回游戏小屋" aria-label="返回游戏小屋">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
游戏小屋
</a>
`;

// 从游戏 CSS 里猜背景亮度，浅色背景用深色文字的浮标，避免看不见。
function isLightBackground(css) {
  // 抓取 body / html 规则里的 background 颜色
  const bodyRules = css.match(/(?:^|\})\s*(?:html\s*,\s*)?body[^{]*\{([^}]*)\}/gi) || [];
  const text = bodyRules.join(' ') + ' ' + css;
  const m = text.match(/background(?:-color)?\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]+\))/i);
  if (!m) return false;
  const c = m[1].trim().toLowerCase();
  let r, g, b;
  if (c.startsWith('#')) {
    let h = c.slice(1);
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
  } else {
    const n = c.match(/[\d.]+/g).map(Number);
    [r, g, b] = n;
  }
  if ([r, g, b].some((v) => typeof v !== 'number' || isNaN(v))) return false;
  // 相对亮度（sRGB 近似）
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.6;
}

function inject(file) {
  const full = path.join(GAMES_DIR, file);
  let html = fs.readFileSync(full, 'utf8');

  if (html.includes(MARK)) {
    console.log(`  跳过（已注入）: ${file}`);
    return false;
  }

  const light = isLightBackground(html);
  const navHtml = light
    ? NAV_HTML.replace('id="hub-nav"', 'id="hub-nav" class="hub-nav-light"')
    : NAV_HTML;

  // 1) 注入样式：放在 </head> 前
  const headClose = html.lastIndexOf('</head>');
  if (headClose === -1) {
    console.log(`  !! 未找到 </head>，跳过: ${file}`);
    return false;
  }
  html = html.slice(0, headClose) + NAV_CSS + html.slice(headClose);

  // 2) 注入节点：放在 <body ...> 之后
  const bodyMatch = html.match(/<body[^>]*>/i);
  if (!bodyMatch) {
    console.log(`  !! 未找到 <body>，跳过: ${file}`);
    return false;
  }
  const at = bodyMatch.index + bodyMatch[0].length;
  html = html.slice(0, at) + '\n' + navHtml + html.slice(at);

  fs.writeFileSync(full, html, 'utf8');
  console.log(`  ✓ 已注入: ${file}${light ? '（检测到浅色背景，使用深色浮标）' : ''}`);
  return true;
}

const files = fs.readdirSync(GAMES_DIR).filter((f) => f.endsWith('.html'));
if (!files.length) {
  console.log('games/ 下没有 html 文件');
  process.exit(0);
}
console.log(`在 ${GAMES_DIR} 中注入导航栏：`);
let n = 0;
for (const f of files) if (inject(f)) n++;
console.log(`完成，共修改 ${n} 个文件。`);