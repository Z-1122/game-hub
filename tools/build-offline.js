// 生成「双击即可玩」的单文件离线版门户。
// 原理：把 games.json 的数据直接内嵌进 HTML，绕开 file:// 协议禁止 fetch 的限制。
// 用法: node tools/build-offline.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '离线版.html');

const indexPath = path.join(ROOT, 'index.html');
const jsonPath = path.join(ROOT, 'games.json');

if (!fs.existsSync(indexPath) || !fs.existsSync(jsonPath)) {
  console.error('找不到 index.html 或 games.json');
  process.exit(1);
}

let html = fs.readFileSync(indexPath, 'utf8');
const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

// 1) 把 fetch 那段替换成直接内嵌数据，并保留原有的 render 逻辑
const embedded = JSON.stringify(data, null, 2);

const fetchBlock = /fetch\('games\.json'[\s\S]*?\n\s*\}\);/.exec(html);
if (!fetchBlock) {
  console.error('未能在 index.html 中定位 fetch 代码块');
  process.exit(1);
}

const replacement = `// 离线版：数据直接内嵌，不依赖 fetch（file:// 也能用）
  var EMBEDDED_DATA = ${embedded};
  try {
    render(EMBEDDED_DATA);
  } catch (err) {
    empty.hidden = false;
    empty.textContent = '渲染失败：' + err.message;
  }`;

html = html.replace(fetchBlock[0], replacement);

// 2) 标题与提示改成离线版
html = html.replace('<title>游戏小屋</title>', '<title>游戏小屋（离线版）</title>');
html = html.replace(
  /<div class="brand">Game Hub<\/div>/,
  '<div class="brand">Game Hub · 离线版</div>'
);

// 3) 加一条离线提示条（可关闭）
const banner = `
<div id="offline-note" style="
  position:relative;z-index:2;margin:0 0 26px;padding:12px 16px;border-radius:10px;
  background:rgba(95,240,255,0.07);border:1px solid rgba(95,240,255,0.22);
  font-size:13px;line-height:1.6;color:rgba(190,225,245,0.85);
  display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
  <span style="flex:1;min-width:200px;">
    📴 离线版 —— 数据已内嵌，双击即可用。
    <span style="opacity:.7">在线版（可自动更新）在
    <a href="https://z-1122.github.io/game-hub/" target="_blank" rel="noopener"
       style="color:#5ff0ff;text-decoration:none;">z-1122.github.io/game-hub</a></span>
  </span>
  <button onclick="this.parentNode.remove()" style="
    background:none;border:1px solid rgba(120,200,255,0.25);border-radius:6px;
    color:rgba(190,225,245,0.7);font-size:12px;padding:3px 10px;cursor:pointer;
    font-family:inherit;">知道了</button>
</div>
`;
html = html.replace('<header>', banner + '\n  <header>');

// 4) 门户页底部原有的「加游戏」教学块已在 2026-10-27 按用户要求整段删除，这里不再注入任何内容

// 5) 把游戏链接改成可直接双击的同目录路径（离线版与 games/ 同目录，路径无需变）
//    games/*.html 在离线版里仍是相对路径，file:// 下点击可正常跳转。

fs.writeFileSync(OUT, html, 'utf8');

const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`已生成离线版: ${OUT}  (${kb} KB)`);
console.log(`内嵌游戏数: ${data.games.length}`);
data.games.forEach((g) => {
  const f = path.join(ROOT, g.file);
  console.log(`  - ${g.name.padEnd(14)} ${g.file}  ${fs.existsSync(f) ? '存在' : '!! 缺失'}`);
});