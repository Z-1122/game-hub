// 通过 GitHub REST API 上传整个仓库（绕过 github.com 的 git 协议，改用稳定的 api.github.com）
// 用法: node tools/push-via-api.js <owner> <repo> <token> [分支] [提交信息文本或信息文件路径]
//
// ⚠️ 历史教训（2026-10-26 踩坑）：
// 本脚本原来把待上传文件写成**硬编码白名单**，结果 games/mahjong.html 不在名单里，
// 每次「推送成功 PUSH_OK」都是假的——麻将的修复压根没上过线，用户看到的一直是旧版本。
// 现在改为**递归扫描仓库目录**，默认上传全部文件，只有显式忽略规则才会跳过，并逐个打印，
// 从机制上杜绝这种「静默漏传」。
const fs = require('fs');
const path = require('path');
const https = require('https');

const OWNER = process.argv[2];
const REPO = process.argv[3];
const TOKEN = process.argv[4];
const BRANCH = process.argv[5] || 'main';
const MSG_ARG = process.argv[6] || '';
const ROOT = path.join(__dirname, '..');

if (!OWNER || !REPO || !TOKEN) {
  console.error('用法: node tools/push-via-api.js <owner> <repo> <token> [branch] [message|messageFile]');
  process.exit(1);
}

// 忽略规则：点开头（.git 等）、下划线开头（临时目录 _probe/_mt 等）、node_modules
function ignored(name) {
  return name.startsWith('.') || name.startsWith('_') || name === 'node_modules';
}

function walk(dir, base, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored(ent.name)) continue;
    const full = path.join(dir, ent.name);
    const rel = base ? base + '/' + ent.name : ent.name;
    if (ent.isDirectory()) walk(full, rel, out);
    else if (ent.isFile()) out.push(rel);
  }
  return out;
}

let MESSAGE = '更新游戏小屋';
if (MSG_ARG) {
  MESSAGE = fs.existsSync(MSG_ARG) ? fs.readFileSync(MSG_ARG, 'utf8').trim() : MSG_ARG;
}

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
  const FILES = walk(ROOT, '', []).sort();
  console.log(`上传到 ${OWNER}/${REPO} (分支 ${BRANCH})，共 ${FILES.length} 个文件`);

  let parentSha = null;
  const refRes = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  if (refRes.status === 200) {
    parentSha = refRes.body.object.sha;
    console.log('  当前 HEAD:', parentSha.slice(0, 7));
  } else {
    console.log('  分支为空，将创建首个提交');
  }

  const tree = [];
  for (const rel of FILES) {
    const full = path.join(ROOT, rel);
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

  const treeBody = { tree };
  if (parentSha) treeBody.base_tree = parentSha;
  const treeRes = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, treeBody);
  if (treeRes.status !== 201) {
    console.error('!! tree 失败:', treeRes.status, JSON.stringify(treeRes.body).slice(0, 400));
    process.exit(1);
  }

  const commitRes = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message: MESSAGE,
    tree: treeRes.body.sha,
    parents: parentSha ? [parentSha] : []
  });
  if (commitRes.status !== 201) {
    console.error('!! commit 失败:', commitRes.status, JSON.stringify(commitRes.body).slice(0, 400));
    process.exit(1);
  }
  const newSha = commitRes.body.sha;
  console.log('  commit:', newSha.slice(0, 7));

  const refRes2 = parentSha
    ? await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: newSha, force: true })
    : await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: newSha });
  if (refRes2.status !== 200 && refRes2.status !== 201) {
    console.error('!! 更新引用失败:', refRes2.status, JSON.stringify(refRes2.body).slice(0, 400));
    process.exit(1);
  }

  // 推送后自检：重新从远端读回 tree，逐个核对大小，漏传/大小不符一律报错
  console.log('\n推送后自检：');
  const check = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${newSha}?recursive=1`);
  const remote = {};
  for (const e of (check.body.tree || [])) if (e.type === 'blob') remote[e.path] = e.size;
  let bad = 0;
  for (const rel of FILES) {
    const localSize = fs.statSync(path.join(ROOT, rel)).size;
    if (remote[rel] === undefined) { console.error(`  ✗ 远端缺失: ${rel}`); bad++; }
    else if (remote[rel] !== localSize) { console.error(`  ✗ 大小不符: ${rel} 远端=${remote[rel]} 本地=${localSize}`); bad++; }
  }
  if (bad) { console.error(`\n自检失败：${bad} 个文件不一致`); process.exit(1); }

  console.log(`  ✓ 全部 ${FILES.length} 个文件与本地一致`);
  console.log('\nPUSH_OK');
  console.log('分支:', BRANCH, '->', newSha.slice(0, 7));
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });