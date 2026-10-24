// 通过 GitHub REST API 上传文件（绕过 github.com 的 git 协议，改用稳定的 api.github.com）
// 用法: node tools/push-via-api.js <owner> <repo> <token> [分支]
const fs = require('fs');
const path = require('path');
const https = require('https');

const OWNER = process.argv[2];
const REPO = process.argv[3];
const TOKEN = process.argv[4];
const BRANCH = process.argv[5] || 'main';
const ROOT = path.join(__dirname, '..');

if (!OWNER || !REPO || !TOKEN) {
  console.error('用法: node tools/push-via-api.js <owner> <repo> <token> [branch]');
  process.exit(1);
}

// 需要上传的文件（相对路径）
const FILES = [
  'index.html',
  'games.json',
  'README.md',
  '离线版.html',
  'games/echo.html',
  'games/2048.html',
  'tools/inject-nav.js',
  'tools/build-offline.js',
  'tools/push-via-api.js',
  'tools/test-hub.js',
  'tools/test-games.js',
  'tools/test-touch.js',
  'tools/test-mobile.js'
];

function api(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: endpoint,
      method,
      headers: Object.assign({
        'User-Agent': 'dsh-push',
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + TOKEN,
        'X-GitHub-Api-Version': '2022-11-28'
      }, payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (e) { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  console.log(`上传到 ${OWNER}/${REPO} (分支 ${BRANCH})`);

  // 1) 取分支当前 HEAD，作为父提交
  let parentSha = null;
  const refRes = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  if (refRes.status === 200) {
    parentSha = refRes.body.object.sha;
    console.log('  当前 HEAD:', parentSha.slice(0, 7));
  } else {
    console.log('  分支为空，将创建首个提交');
  }

  // 2) 逐个创建 blob
  const tree = [];
  for (const rel of FILES) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) { console.log(`  跳过（不存在）: ${rel}`); continue; }
    const content = fs.readFileSync(full);
    const isText = /\.(html|json|js|md|txt)$/i.test(rel);
    const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: isText ? content.toString('utf8') : content.toString('base64'),
      encoding: isText ? 'utf-8' : 'base64'
    });
    if (blob.status !== 201) {
      console.error(`  !! blob 失败 ${rel}:`, blob.status, JSON.stringify(blob.body).slice(0, 300));
      process.exit(1);
    }
    tree.push({ path: rel, mode: '100644', type: 'blob', sha: blob.body.sha });
    console.log(`  ✓ ${rel}  (${(content.length / 1024).toFixed(1)} KB)`);
  }

  // 3) 创建 tree
  const treeBody = { tree };
  if (parentSha) treeBody.base_tree = parentSha;
  const treeRes = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, treeBody);
  if (treeRes.status !== 201) {
    console.error('!! tree 失败:', treeRes.status, JSON.stringify(treeRes.body).slice(0, 400));
    process.exit(1);
  }
  console.log('  tree:', treeRes.body.sha.slice(0, 7));

  // 4) 创建 commit
  const commitBody = {
    message: '游戏小屋：小游戏合集门户\n\n- 门户首页从 games.json 动态生成卡片，加游戏零改动 HTML\n- 收录 回声·ECHO 与 2048 两个游戏\n- tools/inject-nav.js 自动注入返回门户浮标（含浅色背景检测）\n- tools/ 下含门户与游戏的自动化测试',
    tree: treeRes.body.sha,
    parents: parentSha ? [parentSha] : []
  };
  const commitRes = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, commitBody);
  if (commitRes.status !== 201) {
    console.error('!! commit 失败:', commitRes.status, JSON.stringify(commitRes.body).slice(0, 400));
    process.exit(1);
  }
  console.log('  commit:', commitRes.body.sha.slice(0, 7));

  // 5) 更新或创建分支引用
  let refRes2;
  if (parentSha) {
    refRes2 = await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
      sha: commitRes.body.sha, force: true
    });
  } else {
    refRes2 = await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, {
      ref: `refs/heads/${BRANCH}`, sha: commitRes.body.sha
    });
  }
  if (refRes2.status !== 200 && refRes2.status !== 201) {
    console.error('!! 更新引用失败:', refRes2.status, JSON.stringify(refRes2.body).slice(0, 400));
    process.exit(1);
  }

  console.log('\nPUSH_OK');
  console.log('分支:', BRANCH, '->', commitRes.body.sha.slice(0, 7));
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });