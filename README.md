# 游戏小屋 · Game Hub

我写的小游戏合集，一个网站就能玩全部。

**在线地址：** https://z-1122.github.io/game-hub/

## 现在有哪些游戏

| 游戏 | 说明 |
| --- | --- |
| [回声 · ECHO](games/echo.html) | 把过去 1.4 秒的移动轨迹变成「回声」，替你挡子弹、收光点。**支持手机触屏** |
| [2048](games/2048.html) | 经典数字合并游戏 |

## 操作说明

### 回声 · ECHO

**电脑键盘：**

| 按键 | 作用 |
| --- | --- |
| `WASD` / 方向键 | 移动 |
| `空格` | 召唤回声（消耗 28 能量） |
| `Shift` | 冲刺（短暂无敌） |
| `P` / `M` | 暂停 / 静音 |

**手机触屏：**

| 操作 | 作用 |
| --- | --- |
| 左侧拖动 | 移动（虚拟摇杆，按在哪里就从哪里起摇） |
| 右下「回声」按钮 | 召唤回声 |
| 右下「冲刺」按钮 | 冲刺 |

竖屏打开会提示横过来（宽屏视野更好），也可以点「竖屏也能玩」跳过。

## 怎么加一个新游戏

**只需要两步，不用改任何 HTML。**

### 1. 放入游戏文件

把游戏的 HTML 放进 `games/` 文件夹：

```
games/your-game.html
```

如果游戏有多个文件（图片、js、css），就建一个子文件夹：

```
games/your-game/index.html
games/your-game/style.css
games/your-game/script.js
```

### 2. 在 `games.json` 里加一条

打开根目录的 `games.json`，在 `games` 数组里追加一条：

```json
{
  "id": "your-game",
  "name": "你的游戏名",
  "file": "games/your-game.html",
  "tagline": "一句话卖点",
  "description": "两三句话介绍玩法。",
  "tags": ["休闲", "益智"],
  "accent": "#5ff0ff",
  "accent2": "#a98bff",
  "icon": "★",
  "featured": false,
  "controls": "方向键 移动 · 空格 跳跃"
}
```

**字段说明：**

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 唯一标识，英文小写 |
| `name` | 是 | 显示的游戏名 |
| `file` | 是 | 相对路径，指向游戏 HTML |
| `tagline` | 否 | 标题下的一句话 |
| `description` | 否 | 卡片上的玩法介绍 |
| `tags` | 否 | 标签数组，会显示成小胶囊 |
| `accent` / `accent2` | 否 | 卡片主题色（渐变的两个色），默认青色到紫色 |
| `icon` | 否 | 卡片图标，建议用单个字符（如 `◉` `★` `⬢`） |
| `featured` | 否 | `true` 会在卡片上显示「主打」角标 |
| `controls` | 否 | 操作说明，显示在卡片底部 |
| `date` | 否 | 日期，备用 |

### 3. 提交

```bash
git add -A
git commit -m "添加新游戏：xxx"
git push
```

推送后等 Pages 构建完（约 1 分钟），**刷新网页新卡片就自动出现了**。

## 给游戏加「返回门户」按钮

为了让玩家能从游戏里回到首页，`tools/inject-nav.js` 会自动往游戏 HTML 里注入一个左上角浮标。

把游戏文件放进 `games/` 后运行：

```bash
node tools/inject-nav.js
```

它会：

- 在 `</head>` 前插入导航栏样式
- 在 `<body>` 后插入返回按钮
- 自动跳过已经注入过的文件（可重复运行，不会重复插入）

标记是 `data-hub-nav`，想手动删除也很容易搜到。

> 注意：`index.html` 指向 `../index.html`，所以游戏必须放在 `games/` 的**下一级**。如果你的游戏放在子文件夹里（如 `games/your-game/index.html`），需要手动把链接改成 `../../index.html`。

## 本地打开（两种方式）

### 方式一：双击 `离线版.html`（最省事）

**直接双击 `离线版.html` 就能用**，不需要服务器、不需要联网。

它的原理是把 `games.json` 的数据**直接内嵌进 HTML**，绕开 `file://` 协议禁止 `fetch` 的限制。

> 缺点：游戏列表是写死的。加了新游戏后需要重新生成一次：
> ```bash
> node tools/build-offline.js
> ```

### 方式二：起本地服务器（改了就生效，不用重新生成）

```bash
cd game-hub
python -m http.server 8000
# 打开 http://localhost:8000
```

或者用 Node：

```bash
npx serve .
```

这种方式读的是实时的 `games.json`，改完刷新就生效。

### ⚠️ 为什么不能直接双击 `index.html`

`index.html` 要用 `fetch('games.json')` 来生成卡片，而浏览器安全策略**禁止 `file://` 页面读取其他本地文件**，请求会被拦掉，页面只剩标题、卡片出不来。

- 想双击 → 用 `离线版.html`
- 想双击 `index.html` → 必须起服务器

游戏本身（`games/` 里的文件）是独立单文件，**双击直接能玩**，不受这个限制。

## 目录结构

```
game-hub/
├── index.html            # 门户首页（卡片从 games.json 动态生成，需服务器）
├── 离线版.html            # 双击即用的单文件版（数据已内嵌）
├── games.json            # 游戏清单 —— 加游戏改这里
├── games/
│   ├── echo.html         # 回声 · ECHO
│   └── 2048.html         # 2048
├── tools/
│   ├── inject-nav.js     # 给游戏注入「返回门户」浮标
│   ├── build-offline.js  # 生成离线版.html
│   ├── push-via-api.js   # 用 GitHub API 上传（git 协议不通时的备用方案）
│   ├── test-hub.js       # 门户端到端测试
│   ├── test-games.js     # 游戏加载测试
│   ├── test-touch.js     # 触屏操作测试
│   └── test-mobile.js    # 手机尺寸截图
└── README.md
```

## 技术说明

- **纯静态**，无框架、无构建步骤，GitHub Pages 直接托管
- 首页卡片由 `games.json` 动态渲染，加游戏零改动 HTML
- 深色霓虹视觉，卡片主题色可单独配置
- 响应式，手机上单列显示
- 支持 `prefers-reduced-motion`，尊重系统减弱动效设置

## 相关仓库

- [echo-game](https://github.com/Z-1122/echo-game) —— 回声的原始独立仓库