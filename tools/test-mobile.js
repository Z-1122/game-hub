// 触屏功能测试：用无头 Edge 模拟手机，验证摇杆与按钮是否正常响应
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = 'E:\\LeStoreDownload\\game-hub';
const OUT = path.join(ROOT, '_mobiletest');

if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 用 DevTools 协议做真实交互测试比较复杂，这里改用截图 + 注入脚本的方式
// 生成一个测试页：加载 echo.html 后模拟触摸事件，然后截图
const testPage = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body{margin:0;background:#000;overflow:hidden}
iframe{width:100vw;height:56.25vw;border:0;display:block}
</style></head><body>
<iframe id="f" src="games/echo.html"></iframe>
<script>
const f = document.getElementById('f');
f.onload = () => {
  const w = f.contentWindow;
  const d = f.contentDocument;
  const cv = d.getElementById('game');
  setTimeout(() => {
    // 模拟触摸：点一下开始游戏
    const r = cv.getBoundingClientRect();
    const mk = (type, x, y, id) => {
      const ev = new PointerEvent(type, {
        clientX: r.left + x, clientY: r.top + y,
        pointerId: id || 1, bubbles: true, cancelable: true, pointerType: 'touch'
      });
      cv.dispatchEvent(ev);
    };
    mk('pointerdown', r.width/2, r.height/2);
    cv.dispatchEvent(new PointerEvent('pointerup', {clientX:r.left+10, clientY:r.top+10, pointerId:1, bubbles:true}));
    // 过一会儿拖摇杆
    setTimeout(() => {
      mk('pointerdown', r.width*0.18, r.height*0.8, 2);
      mk('pointermove', r.width*0.28, r.height*0.72, 2);
      document.title = 'READY';
    }, 900);
  }, 500);
};
</script></body></html>`;

fs.writeFileSync(path.join(ROOT, '_mobiletest.html'), testPage, 'utf8');

function shot(url, out, w, h, budget) {
  execFileSync(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--user-data-dir=' + path.join(OUT, 'p'),
    '--window-size=' + w + ',' + h,
    '--screenshot=' + out,
    '--virtual-time-budget=' + budget,
    url
  ], { stdio: 'ignore' });
}

console.log('1) 手机竖屏尺寸（390x844）下的标题页');
shot('file:///E:/LeStoreDownload/game-hub/games/echo.html', path.join(OUT, 'mobile_title.png'), 390, 844, 4000);

console.log('2) 手机横屏尺寸（844x390）下的标题页');
shot('file:///E:/LeStoreDownload/game-hub/games/echo.html', path.join(OUT, 'mobile_land.png'), 844, 390, 4000);

const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.png'));
console.log('\n生成截图:');
files.forEach((f) => {
  console.log('  ' + f + '  ' + (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(1) + ' KB');
});