// 用法: node gen.js
// 生成若干"场景页"：在 echo.html 基础上注入测试钩子 + 一段断言脚本，
// 断言结果以 <pre> 显示在页面上，便于用 --screenshot 读取。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'games', 'echo.html');
const OUT = path.join(require('os').tmpdir(), 'echo-mobile-scenarios');

const src = fs.readFileSync(SRC, 'utf8');

// 1) 在主 IIFE 结束前插入测试钩子（必须留在 IIFE 内部才能访问局部变量）
const HOOK = [
  '  window.__echoTest = {',
  '    get state() { return state; },',
  '    get paused() { return paused; },',
  '    get isTouch() { return isTouch; },',
  '    get fsGuardUntil() { return fsGuardUntil; },',
  '    start: function () { startGame(); },',
  '    setPaused: function (v) { paused = !!v; },',
  '    setCharge: function (v) { charge = v; },',
  '    fireBlur: function () { window.dispatchEvent(new Event("blur")); },',
  '    tap: function (x, y) {',
  '      var r = canvas.getBoundingClientRect();',
  '      var sx = r.left + (x / W) * r.width, sy = r.top + (y / H) * r.height;',
  '      canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: sx, clientY: sy, pointerId: 1, bubbles: true }));',
  '    },',
  '    tapUp: function (x, y) {',
  '      var r = canvas.getBoundingClientRect();',
  '      var sx = r.left + (x / W) * r.width, sy = r.top + (y / H) * r.height;',
  '      canvas.dispatchEvent(new PointerEvent("pointerup", { clientX: sx, clientY: sy, pointerId: 1, bubbles: true }));',
  '    }',
  '  };'
].join('\n');

const ANCHOR_RE = /\}\)\(\);\r?\n<\/script>/;
if (!ANCHOR_RE.test(src)) {
  console.error('找不到主 IIFE 结尾锚点');
  process.exit(1);
}
const withHook = src.replace(ANCHOR_RE, HOOK + '\n})();\n</script>');

// 2) 场景：每段代码在页面 400ms 后执行，逐条 assert
function scenario(bodyLines) {
  const script = [
    '<script>',
    'setTimeout(function () {',
    '  var T = window.__echoTest;',
    '  var log = [];',
    '  function assert(label, ok) { log.push((ok ? "PASS " : "FAIL ") + label); }',
    '  try {',
    bodyLines.map((l) => '    ' + l).join('\n'),
    '  } catch (e) { log.push("THROW " + e.message); }',
    '  var pre = document.createElement("pre");',
    '  pre.style.cssText = "position:fixed;left:6px;top:96px;z-index:2147483647;color:#7dff9b;background:#000;font:13px/1.5 monospace;padding:8px 10px;white-space:pre-wrap;max-width:94vw;border:1px solid #7dff9b";',
    '  pre.textContent = log.join(String.fromCharCode(10));',
    '  document.body.appendChild(pre);',
    '}, 400);',
    '</scr' + 'ipt>'
  ].join('\n');
  return withHook.replace('</body>', script + '\n</body>');
}

const cases = {
  // 触屏：全屏切换引发的 blur 不应把游戏暂停
  'a-touch-blur': [
    'assert("识别为触屏", T.isTouch === true);',
    'T.start();',
    'assert("开局后 playing", T.state === "playing");',
    'assert("开局后未暂停", T.paused === false);',
    'T.fireBlur();',
    'assert("触屏 blur 后不暂停", T.paused === false);',
    'T.fireBlur();',
    'assert("连续 blur 仍不暂停", T.paused === false);'
  ],
  // 暂停后轻触屏幕恢复
  'b-tap-resume': [
    'T.start();',
    'T.setPaused(true);',
    'assert("已暂停", T.paused === true);',
    'T.tap(480, 300);',
    'assert("轻触空白处恢复", T.paused === false);'
  ],
  // 暂停时点静音按钮：不应恢复游戏
  'c-pause-mute': [
    'T.start();',
    'T.setPaused(true);',
    'T.tap(916, 200);',
    'assert("点静音按钮后仍暂停", T.paused === true);'
  ],
  // 暂停时点全屏按钮：不应恢复游戏
  'd-pause-full': [
    'T.start();',
    'T.setPaused(true);',
    'T.tap(916, 104);',
    'assert("点全屏按钮后仍暂停", T.paused === true);'
  ],
  // 暂停时点暂停按钮：仍为暂停
  'e-pause-pause': [
    'T.start();',
    'T.setPaused(true);',
    'T.tap(916, 152);',
    'assert("点暂停按钮后仍暂停", T.paused === true);'
  ],
  // 游玩中点暂停按钮 → 暂停；再轻触 → 恢复
  'f-play-pause-toggle': [
    'T.start();',
    'T.tap(916, 152);',
    'assert("点暂停按钮进入暂停", T.paused === true);',
    'T.tap(480, 300);',
    'assert("轻触恢复", T.paused === false);',
    'T.tap(916, 152);',
    'assert("可再次暂停", T.paused === true);'
  ],
  // 游玩中点冲刺按钮不应误触发暂停
  'g-dash-not-pause': [
    'T.start();',
    'T.tap(764, 538);',
    'assert("点冲刺不暂停", T.paused === false);'
  ]
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, body] of Object.entries(cases)) {
  fs.writeFileSync(path.join(OUT, name + '.html'), scenario(body), 'utf8');
}
console.log('已生成:', Object.keys(cases).join(', '));