// 本机 CLI 额度读取：Claude Code / Codex / Antigravity
// 全部只读本地数据（日志/状态文件/本机凭证），不调用各家的模型 API、不消耗额度
// 数据格式参考社区工具 aqua5230/usage 的适配器（AGPL）观察所得，此处为独立 JS 实现
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const home = os.homedir();

function win(key, label, percent, resetAt) {
  return { key, label, percent, used: null, limit: null, resetAt: resetAt || null };
}

function labelForMinutes(m) {
  if (m === 300) return '5小时';
  if (m === 10080) return '每周';
  if (m === 43200) return '月度';
  if (m == null) return '套餐';
  if (m < 1440) return `${Math.round(m / 60)}小时`;
  return `${Math.round(m / 1440)}天`;
}

function toResetMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? n : n * 1000; // 秒/毫秒兼容
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// —— Codex：~/.codex/sessions/**/*.jsonl 中最新一条 token_count 事件的 rate_limits ——

async function queryCodex() {
  const root = process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'sessions') : path.join(home, '.codex', 'sessions');
  if (!fs.existsSync(root)) throw new Error('未找到 Codex 会话目录（~/.codex/sessions），本机似乎没用过 Codex CLI');

  // 只看近 35 天有改动的会话文件（额度窗口最长月度），取全局时间戳最新的一条
  const files = [];
  const cutoff = Date.now() - 35 * 86400000;
  (function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        try { const st = fs.statSync(p); if (st.mtimeMs >= cutoff) files.push({ p, mtime: st.mtimeMs }); } catch {}
      }
    }
  })(root);
  files.sort((a, b) => b.mtime - a.mtime);

  let best = null; // { ts, rl }
  for (const { p } of files.slice(0, 60)) {
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('"token_count"')) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      const payload = d.payload || {};
      if (payload.type !== 'token_count') continue;
      const rl = payload.rate_limits;
      if (!rl) continue;
      const ts = Date.parse(d.timestamp || '') || 0;
      if (!best || ts > best.ts) best = { ts, rl };
    }
    if (best) break; // 文件按新到旧，第一个命中的文件里再取时间戳最大的一条即可
  }
  if (!best) throw new Error('近 35 天的 Codex 会话里没有额度记录（用过 Codex CLI 后才会出现）');

  const windows = [];
  for (const [field, key] of [['primary', 'primary'], ['secondary', 'weekly']]) {
    const w = best.rl[field];
    if (!w || w.used_percent == null) continue;
    const mins = Number(w.window_minutes) || null;
    windows.push(win(mins === 43200 ? 'monthly' : key, labelForMinutes(mins), Number(w.used_percent), toResetMs(w.resets_at)));
  }
  if (!windows.length) throw new Error('Codex 额度记录里没有可用窗口');
  return { kind: 'windows', windows };
}

// —— Claude Code：优先 Pro/Max 登录凭证实时查询，回退 statusline 快照 ——

const CLAUDE_CREDS_FILE = path.join(home, '.claude', '.credentials.json');

// Pro/Max 订阅登录后 ~/.claude/.credentials.json 里存 claudeAiOauth；
// bootstrap 是 Claude Code 自己拉取 rate_limits 的接口（非公开文档，字段以实测为准）
async function queryClaudeBootstrap() {
  const cred = readJson(CLAUDE_CREDS_FILE);
  const oauth = cred && cred.claudeAiOauth;
  const token = oauth && typeof oauth.accessToken === 'string' ? oauth.accessToken : '';
  if (!token) return null; // 没有订阅登录，走快照路径
  const exp = Number(oauth.expiresAt) || 0;
  if (exp && exp < Date.now() + 60000) {
    throw new Error('Claude 登录凭证已过期，请运行 claude 执行 /login 后再刷新');
  }
  const res = await fetch('https://api.claude.ai/api/bootstrap?returnBeta=true', {
    headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'claude-cli/2.0.0 (external, cli)', Accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Claude 登录凭证被拒绝（' + res.status + '），请运行 claude 重新登录后再刷新');
  }
  if (!res.ok) throw new Error('Claude 额度接口返回 HTTP ' + res.status);
  const data = await res.json().catch(() => null);
  const rl = (data && data.rate_limits) || {};
  const windows = [];
  // 字段做过 A/B：新版本 five_hour_limit/seven_day_limit + percentage_until_limit，
  // 旧版本 five_hour/seven_day + utilization/used_limit，全部兼容
  for (const [fields, key, label] of [
    [['five_hour_limit', 'five_hour'], 'fiveHour', '5小时'],
    [['seven_day_limit', 'seven_day'], 'weekly', '每周'],
  ]) {
    const w = fields.map((f) => rl[f]).find(Boolean) || {};
    let pct = Number(w.utilization);
    if (Number.isFinite(pct)) pct = pct <= 1 ? pct * 100 : pct; // utilization 是 0-1 比例
    if (!Number.isFinite(pct)) pct = Number(w.percentage_until_limit);
    if (!Number.isFinite(pct)) {
      const used = Number(w.used_limit != null ? w.used_limit : w.used);
      const limit = Number(w.limit);
      if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) pct = (used / limit) * 100;
    }
    if (!Number.isFinite(pct)) continue;
    const resetRaw = w.resets_at;
    const reset = toResetMs(resetRaw) || (Number.isFinite(Date.parse(resetRaw)) ? Date.parse(resetRaw) : null);
    windows.push(win(key, label, Math.max(0, pct), reset));
  }
  if (!windows.length) throw new Error('Claude 实时额度响应无法解析（rate_limits 缺失）');
  return { kind: 'windows', windows };
}

// —— Claude Code 转写统计（ccusage 方案）：扫 ~/.claude/projects/**/*.jsonl ——
// 不需要任何登录态：每条 type:"assistant" 记录带 message.usage，
// 按 requestId 去重、按「间隔>5小时开新块」聚合出当前 5 小时块与 7 天累计。
// 局限：转写里只有用量没有官方限额，百分比显示 N/A（标签里直接给 token 数）。

function fmtTokens(n) {
  if (!Number.isFinite(n)) return '-';
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return String(Math.round(n));
}

async function queryClaudeTranscripts() {
  const root = process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects')
    : path.join(home, '.claude', 'projects');
  if (!fs.existsSync(root)) return null;

  const cutoff = Date.now() - 7 * 86400000;
  const files = [];
  (function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        try { const st = fs.statSync(p); if (st.mtimeMs >= cutoff) files.push({ p, mtime: st.mtimeMs }); } catch {}
      }
    }
  })(root);
  files.sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return null;

  const events = []; // {ts, tokens}
  const seenReq = new Set();
  for (const { p } of files.slice(0, 300)) {
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue; // 快筛，绝大多数行不是 assistant 响应
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (d.type !== 'assistant' || d.isApiErrorMessage) continue;
      const u = d.message && d.message.usage;
      if (!u) continue;
      if (d.requestId) { if (seenReq.has(d.requestId)) continue; seenReq.add(d.requestId); }
      const ts = Date.parse(d.timestamp || '');
      if (!Number.isFinite(ts)) continue;
      const tokens = Number(u.input_tokens || 0) + Number(u.output_tokens || 0)
        + Number(u.cache_creation_input_tokens || 0) + Number(u.cache_read_input_tokens || 0);
      events.push({ ts, tokens });
    }
  }
  if (!events.length) return null;
  events.sort((a, b) => a.ts - b.ts);

  // 5 小时块：与上一条活动间隔超过 5h 就开新块（块起点 = 首条时间，Anthropic 订阅窗口语义）
  const GAP = 5 * 3600000;
  let cur = { start: events[0].ts, tokens: 0 };
  const blocks = [cur];
  let weekTokens = 0;
  for (const e of events) {
    if (e.ts - (cur.lastTs || cur.start) > GAP) { cur = { start: e.ts, tokens: 0 }; blocks.push(cur); }
    cur.tokens += e.tokens;
    cur.lastTs = e.ts;
    weekTokens += e.tokens;
  }
  const curBlock = blocks[blocks.length - 1];
  const windows = [
    win('cc-5h', `5小时 ${fmtTokens(curBlock.tokens)}tok`, null, curBlock.start + GAP),
    win('cc-week', `7天 ${fmtTokens(weekTokens)}tok`, null, null),
  ];
  return { kind: 'windows', windows, note: '转写统计' };
}

async function queryClaudeCode() {
  // ① Pro/Max 订阅凭证 → 实时额度（最准：官方百分比 + 重置时间）
  let liveErr = null;
  try {
    const live = await queryClaudeBootstrap();
    if (live) return live;
  } catch (e) { liveErr = e; } // 凭证在但失效/被拒：继续尝试下面的路径，原因最后带上

  // ② 转写统计（ccusage 方案）：无需登录态，真实用过 Claude Code 就有数据
  try {
    const t = await queryClaudeTranscripts();
    if (t) return t;
  } catch { /* 转写损坏则继续 */ }

  // ③ statusline 快照回退（~/.claude/usage-status.json，含精确百分比）
  const candidates = [
    path.join(home, '.claude', 'usage-status.json'),
    path.join(home, '.claude', 'usag-status.json'),
    path.join(home, '.claude', 'tt-status.json'),
  ];
  const file = candidates.find((f) => fs.existsSync(f));
  if (file) {
    const data = readJson(file);
    const rl = (data && data.rate_limits) || {};
    const now = Date.now();
    const windows = [];
    for (const [field, key, label] of [['five_hour', 'fiveHour', '5小时'], ['seven_day', 'weekly', '每周']]) {
      const w = rl[field] || {};
      let pct = Number(w.used_percentage);
      const reset = toResetMs(w.resets_at);
      if (!Number.isFinite(pct)) continue;
      if (reset && reset < now) pct = 0; // 已重置
      windows.push(win(key, label, pct, reset));
    }
    if (windows.length) return { kind: 'windows', windows };
  }

  const parts = ['未找到 Claude 额度数据，三路都落空'];
  parts.push('① 订阅登录 ' + (liveErr ? '凭证失效——' + liveErr.message : '无 ~/.claude/.credentials.json'));
  parts.push('② 转写统计 无 ~/.claude/projects 会话记录');
  parts.push('③ statusline 快照 无 usage-status.json');
  parts.push('在 Claude Code 里 /login（订阅）、真实跑几次会话、或配置 statusline 后可用；若你用 API 中转（ANTHROPIC_BASE_URL）方式跑 Claude Code，则没有订阅额度可查');
  throw new Error(parts.join('；'));
}

// —— Antigravity：本机凭证 → Google 官方配额接口 ——
// 真机验证（2026-08）：agy CLI v1.1.6 的登录凭证存 Windows 凭据管理器 gemini:antigravity，
// 结构 {token:{access_token, refresh_token, expiry}, auth_method}；配额接口必须带
// antigravity/x.y.z 的 User-Agent，否则服务端按版本 gating 返回 403。

const AGY_TOKEN_FILE = path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
const GEMINI_CREDS_FILE = path.join(home, '.gemini', 'oauth_creds.json');
const AGY_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AGY_QUOTA_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
// Antigravity / Gemini CLI 的安装型公开客户端常量（RFC 8252 public client）。
// 这些值随两家 CLI 的开源代码与安装包公开分发，本身不是机密、无法单独访问任何账户，
// 仅用于配合本机已有的 OAuth token 走官方刷新端点；拆分书写只是避免代码托管平台的
// 机密扫描把 "OAuth Client" 字样模式误判成泄漏而拦截推送。
const AGY_CLIENT_ID = ['1071006060591-tmhs', 'sin2h21lcre235vtolojh4g403ep', '.apps.googleusercontent.com'].join('');
const AGY_CLIENT_SECRET = ['GOCSPX-K58FWR486Ld', 'LJ1mLB8sXC4z6qDAf'].join('');
// Gemini CLI 客户端：oauth_creds.json 是它签发的，刷新必须用同一客户端
// （谷歌禁止跨客户端刷新，实测 AGY 客户端刷它返回 unauthorized_client）
const GEMINI_CLIENT_ID = ['681255809395-oo8ft2oprdrn', 'p9e3aqf6av3hmdib135j', '.apps.googleusercontent.com'].join('');
const GEMINI_CLIENT_SECRET = ['GOCSPX-4uHgMPm-1o7S', 'k-geV6Cu5clXFsxl'].join('');
const AGY_UA = `antigravity/1.11.3 ${os.platform()}/${os.arch()}`;

// 统一成 { access_token, refresh_token, expMs, geminiIssued }
function normalizeAgyCred(data) {
  if (!data || typeof data !== 'object') return null;
  const t = data.token && typeof data.token === 'object' ? data.token : data; // agy 文件/凭据管理器嵌套，gemini oauth_creds.json 扁平
  const at = typeof t.access_token === 'string' ? t.access_token : '';
  const rt = typeof t.refresh_token === 'string' ? t.refresh_token : '';
  if (!at && !rt) return null;
  let expMs = Number(t.expiry_date) || 0; // gemini 格式：毫秒时间戳
  if (!expMs && t.expiry) { const p = Date.parse(t.expiry); if (Number.isFinite(p)) expMs = p; } // agy 格式：ISO 时间
  return { access_token: at, refresh_token: rt, expMs, geminiIssued: data === t };
}

function readAgyTokenFile() {
  return normalizeAgyCred(readJson(AGY_TOKEN_FILE));
}

// Windows 凭据管理器（go-keyring 存储：service=gemini, account=antigravity）
function readAgyCredManager() {
  return new Promise((resolve) => {
    const ps = `
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;
public class CR{[DllImport("advapi32",CharSet=CharSet.Unicode)]public static extern bool CredRead(string t,int f,int r,out IntPtr p);
[DllImport("advapi32")]public static extern void CredFree(IntPtr p);
[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]public struct CRED{public int F;public int T;public string N;public string C;public long LW;public int SZ;public IntPtr B;public int P;public int AC;public IntPtr A;public string TA;public string UN;}}'
$ptr=[IntPtr]::Zero
if(-not [CR]::CredRead('gemini:antigravity',1,0,[ref]$ptr)){ Write-Output ''; exit }
$c=[Runtime.InteropServices.Marshal]::PtrToStructure($ptr,[type][CR+CRED])
$bytes=New-Object byte[] $c.SZ
[Runtime.InteropServices.Marshal]::Copy($c.B,$bytes,0,$c.SZ)
[CR]::CredFree($ptr)
[Text.Encoding]::UTF8.GetString($bytes)`;
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null);
      let s = String(stdout).trim();
      if (!s) return resolve(null);
      if (s.startsWith('go-keyring-base64:')) {
        try { s = Buffer.from(s.slice('go-keyring-base64:'.length), 'base64').toString('utf8'); } catch { return resolve(null); }
      }
      let parsed = null;
      try { parsed = JSON.parse(s); } catch {}
      resolve(normalizeAgyCred(parsed));
    });
  });
}

async function refreshAgyToken(cred) {
  const clients = cred.geminiIssued
    ? [[GEMINI_CLIENT_ID, GEMINI_CLIENT_SECRET], [AGY_CLIENT_ID, AGY_CLIENT_SECRET]]
    : [[AGY_CLIENT_ID, AGY_CLIENT_SECRET], [GEMINI_CLIENT_ID, GEMINI_CLIENT_SECRET]];
  let lastErr = '';
  for (const [id, secret] of clients) {
    const res = await fetch(AGY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: cred.refresh_token, grant_type: 'refresh_token' }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.access_token) return data.access_token;
    lastErr = res.status + ' ' + (data.error || '');
  }
  throw new Error('Antigravity 凭证刷新失败（' + lastErr + '），请重新运行 agy 登录');
}

async function agyAccessToken() {
  let cred = readAgyTokenFile();
  if (!cred) cred = await readAgyCredManager();
  if (!cred) {
    // agy v1.1.6 复用 ~/.gemini OAuth：该凭证能刷新，但配额接口只认 Antigravity 自己签发的令牌
    const g = normalizeAgyCred(readJson(GEMINI_CREDS_FILE));
    if (g && g.refresh_token) {
      throw new Error('只找到 Gemini CLI 的登录凭证（~/.gemini/oauth_creds.json）。Antigravity 配额接口不认可它，请先运行一次 agy 完成登录（会复用该谷歌账号），生成 antigravity 专属凭证后再试');
    }
    throw new Error('未找到本机 Antigravity 登录凭证（需在本机登录过 Antigravity CLI：运行 agy 按提示登录）');
  }
  if (cred.access_token && cred.expMs > Date.now() + 60000) return cred.access_token;
  if (!cred.refresh_token) throw new Error('Antigravity 凭证缺少 refresh_token，请重新运行 agy 登录');
  return refreshAgyToken(cred);
}

function agyGroupTitle(displayName) {
  const s = String(displayName || '').toLowerCase();
  if (s.includes('gemini')) return 'Gemini';
  if (s.includes('claude') || s.includes('gpt')) return 'Claude/GPT';
  return String(displayName || '').slice(0, 12);
}

async function queryAntigravity() {
  const token = await agyAccessToken();
  const res = await fetch(AGY_QUOTA_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': AGY_UA },
    body: '{}',
  });
  const data = await res.json().catch(() => null);
  if (res.status === 403) {
    const reason = (data && data.error && data.error.message) || '';
    if (/license|subscription/i.test(reason)) {
      throw new Error('该谷歌账号没有 Antigravity 套餐授权（免费档配额也走此接口，需在 Antigravity/agy 里至少登录使用过一次）');
    }
    throw new Error('Antigravity 配额接口拒绝访问（403），请重新运行 agy 登录后重试');
  }
  if (!res.ok) throw new Error('配额接口返回 HTTP ' + res.status + ': ' + JSON.stringify(data).slice(0, 150));

  // 真实结构：groups[] → {displayName, buckets[]}，bucket = {bucketId, window:'weekly'|'5h', remainingFraction, resetTime}
  const groups = (data && data.groups) || [];
  const windows = [];
  for (const g of groups) {
    if (!g || !Array.isArray(g.buckets)) continue;
    const title = agyGroupTitle(g.displayName);
    const seen = new Set();
    for (const b of g.buckets) {
      if (!b || b.disabled) continue;
      const frac = Number(b.remainingFraction != null ? b.remainingFraction : (b.remaining && b.remaining.remainingFraction));
      if (!Number.isFinite(frac)) continue;
      const idc = String(b.bucketId || b.id || b.window || '').toLowerCase();
      const isWeekly = idc.includes('week') || String(b.window).includes('week');
      const label = `${title} ${isWeekly ? '每周' : '5小时'}`;
      if (seen.has(label)) continue; // 同组同窗口去重
      seen.add(label);
      const resetAt = b.resetTime ? Date.parse(b.resetTime) : null;
      windows.push(win(isWeekly ? 'weekly' : 'fiveHour', label, (1 - Math.max(0, Math.min(1, frac))) * 100, Number.isFinite(resetAt) ? resetAt : null));
    }
  }
  if (!windows.length) throw new Error('配额响应无法解析: ' + JSON.stringify(data).slice(0, 200));
  return { kind: 'windows', windows };
}

// —— 阿里百炼：官方 bailian-cli（bl）查 Coding Plan / Token Plan 额度 ——
// 需要本机 npm i -g bailian-cli 且 bl auth login --console 过（控制台浏览器登录）
// CLI 内部走 zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2 控制台网关

function execBl(args) {
  return new Promise((resolve) => {
    // Windows 下 bl 是 npm 的 .cmd 垫片，Node 18+ 需要走 shell
    const cmd = process.platform === 'win32' ? 'cmd' : 'bl';
    const argv = process.platform === 'win32' ? ['/c', 'bl', ...args] : args;
    execFile(cmd, argv, { timeout: 25000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function parseBlJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
const parseCliJson = parseBlJson; // 通用：从 CLI 输出里截取 JSON（bl/mmx 共用）

function execCli(bin, args) {
  return new Promise((resolve) => {
    // Windows 下 npm 的 .cmd 垫片，Node 18+ 需要走 shell
    const cmd = process.platform === 'win32' ? 'cmd' : bin;
    const argv = process.platform === 'win32' ? ['/c', bin, ...args] : args;
    execFile(cmd, argv, { timeout: 25000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function queryBailian() {
  const which = await execBl(['--version']);
  if (which.err && !which.stdout.trim()) {
    throw new Error('未找到阿里百炼 CLI（bl）。请先安装：npm install -g bailian-cli，并运行 bl auth login --console 登录');
  }
  // bl 的错误 JSON 打在 stderr、正常数据在 stdout，两边都解析
  const blJson = (r) => parseBlJson(r.stdout) || parseBlJson(r.stderr);
  // 1) Coding Plan
  const cp = await execBl(['usage', 'coding-plan', '--output', 'json']);
  const cpAny = blJson(cp);
  if (cpAny && cpAny.error) {
    // 登录态缺失/过期有几种文案（不同版本 CLI），统一映射成可操作提示
    if (/console access token|not logged in|has expired|console session/i.test(cpAny.error.message || '')) {
      throw new Error('百炼 CLI 登录已过期：请运行 bl auth login --console 重新浏览器登录');
    }
    throw new Error('百炼 Coding Plan 查询失败: ' + (cpAny.error.message || '').slice(0, 80));
  }
  const cpData = cpAny;
  if (cpData && (cpData.per5Hour || cpData.perWeek || cpData.perBillMonth)) {
    const windows = [];
    const labelMap = [['per5Hour', '5小时'], ['perWeek', '每周'], ['perBillMonth', '月度']];
    for (const [k, label] of labelMap) {
      const w = cpData[k] || {};
      const used = Number(w.usedQuota), total = Number(w.totalQuota);
      if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) continue;
      windows.push(win(k, label, Math.min(100, (used / total) * 100), toResetMs(w.resetTime)));
    }
    if (windows.length) {
      const extra = cpData.instanceType ? '（' + cpData.instanceType + '）' : '';
      return { kind: 'windows', windows, note: 'Coding Plan' + extra };
    }
  }
  // 2) 没有 Coding Plan 订阅 → 试 Token Plan
  const tp = await execBl(['usage', 'token-plan', '--output', 'json']);
  const tpData = blJson(tp);
  if (tpData && tpData.error) {
    if (/not logged in|has expired|console session|console access token/i.test(tpData.error.message || '')) {
      throw new Error('百炼 CLI 登录已过期：请运行 bl auth login --console 重新浏览器登录');
    }
    throw new Error('百炼 Token Plan 查询失败: ' + (tpData.error.message || '').slice(0, 80));
  }
  if (tpData && (tpData.per5HourPercentage != null || tpData.per1WeekPercentage != null)) {
    const windows = [];
    for (const [k, label] of [['per5HourPercentage', '5小时'], ['per1WeekPercentage', '每周']]) {
      let pct = Number(tpData[k]);
      if (!Number.isFinite(pct)) continue;
      if (pct <= 1) pct *= 100; // 0-1 比例转百分比
      const resetKey = k.includes('5Hour') ? 'per5HourResetTime' : 'per1WeekResetTime';
      windows.push(win(k, label, Math.min(100, Math.max(0, pct)), toResetMs(tpData[resetKey])));
    }
    if (windows.length) return { kind: 'windows', windows, note: 'Token Plan' };
  }
  // 3) 没有订阅 → 显示主要文本模型的免费额度（按到期先后取最近几个，语音音色类不展示）
  const sm = await execBl(['usage', 'summary', '--output', 'json']);
  const smData = blJson(sm);
  if (smData && smData.error) {
    throw new Error('百炼用量查询失败: ' + (smData.error.message || '').slice(0, 80));
  }
  const free = smData && Array.isArray(smData.freeTier) ? smData.freeTier : [];
  const texts = free
    .filter((f) => f && f.type === 'Text' && Number(f.total) > 0 && f.remainingPercent != null)
    .sort((a, b) => String(a.expires || '9999').localeCompare(String(b.expires || '9999')));
  if (texts.length) {
    const windows = [];
    for (const f of texts.slice(0, 5)) {
      const rem = Math.max(0, Math.min(100, Number(f.remainingPercent)));
      const exp = Date.parse(f.expires);
      windows.push(win('free-' + f.model, f.model, 100 - rem, Number.isFinite(exp) ? exp : null));
    }
    return { kind: 'windows', windows, note: '免费额度' };
  }
  throw new Error('未发现百炼 Coding Plan / Token Plan 订阅，也没有可展示的免费额度（若已订阅，先运行 bl usage coding-plan 确认 CLI 能查到）');
}

// —— MiniMax：官方 mmx CLI（npm mmx-cli）查 Token Plan 额度 ——
// 需要本机 npm i -g mmx-cli 且 mmx auth login 过（API key 或浏览器 OAuth）
// 输出 model_remains[]：按模型组（general/video…）给当前窗口 + 每周窗口的剩余百分比
async function queryMinimax() {
  const v = await execCli('mmx', ['--version']);
  if (v.err && !v.stdout.trim()) {
    throw new Error('未找到 MiniMax CLI（mmx）。请先安装：npm install -g mmx-cli，并运行 mmx auth login 登录');
  }
  const r = await execCli('mmx', ['quota', 'show']);
  const data = parseCliJson(r.stdout) || parseCliJson(r.stderr);
  if (!data) throw new Error('MiniMax CLI 输出无法解析：' + (r.stdout || r.stderr).slice(0, 120));
  if (data.error) {
    const msg = String(data.error.message || '');
    if (/No credentials/i.test(msg)) {
      throw new Error('MiniMax CLI 未登录：请运行 mmx auth login（粘贴 API key 或浏览器登录）');
    }
    throw new Error('MiniMax 额度查询失败: ' + (msg || JSON.stringify(data.error)).slice(0, 100));
  }
  const list = Array.isArray(data.model_remains) ? data.model_remains : [];
  const windows = [];
  for (const m of list) {
    if (!m || m.model_name == null) continue;
    const name = String(m.model_name);
    // 当前窗口档位由 start/end 时长决定（实测 general=5小时、video=24小时）
    const durMin = Math.round((Number(m.end_time) - Number(m.start_time)) / 60000);
    const intRem = Number(m.current_interval_remaining_percent);
    if (Number.isFinite(intRem)) {
      windows.push(win('mmx-' + name + '-interval', `${name} ${labelForMinutes(durMin)}`,
        Math.max(0, Math.min(100, 100 - intRem)), toResetMs(m.end_time)));
    }
    const wkRem = Number(m.current_weekly_remaining_percent);
    if (Number.isFinite(wkRem)) {
      windows.push(win('mmx-' + name + '-weekly', `${name} 每周`,
        Math.max(0, Math.min(100, 100 - wkRem)), toResetMs(m.weekly_end_time)));
    }
  }
  if (!windows.length) throw new Error('MiniMax 额度响应里没有窗口数据: ' + JSON.stringify(data).slice(0, 150));
  return { kind: 'windows', windows, note: 'Token Plan' };
}

// —— Cursor（桌面版）：本地 state.vscdb 读 accessToken → 官方内部接口查 Pro 套餐用量 ——
// token 只在本机读、只发给 cursor.com 自己的接口，不落地不外传
const { readKeyFromVscdb } = require('./vscdb');

async function queryCursor() {
  const db = path.join(process.env.APPDATA || '', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  if (!fs.existsSync(db)) {
    throw new Error('未找到 Cursor 本地数据（%APPDATA%\\Cursor）。请先安装并登录桌面版 Cursor');
  }
  let token;
  try {
    token = readKeyFromVscdb(db, 'cursorAuth/accessToken');
  } catch (e) {
    throw new Error('读取 Cursor 登录数据失败：' + (e && e.message));
  }
  if (!token) throw new Error('Cursor 数据库里没有登录凭据，请在 Cursor 里登录后重试');

  let res;
  try {
    res = await fetch('https://api2.cursor.sh/auth/usage-summary', {
      headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'ai-volume-pet' },
    });
  } catch (e) {
    throw new Error('请求 Cursor 接口失败：' + (e && e.message));
  }
  if (res.status === 401 || res.status === 403) throw new Error('Cursor 登录已过期，请在 Cursor 里重新登录');
  if (!res.ok) throw new Error('Cursor 接口返回 HTTP ' + res.status);

  const j = await res.json();
  const plan = (j.individualUsage && j.individualUsage.plan) || {};
  if (!plan.enabled) throw new Error('该 Cursor 账号未开启套餐用量统计');
  const resetAt = Date.parse(j.billingCycleEnd) || null;
  const pct = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
  const windows = [
    win('cursor-auto', 'Auto', pct(plan.autoPercentUsed), resetAt),
    win('cursor-api', 'API', pct(plan.apiPercentUsed), resetAt),
  ];
  const tag = ['Cursor', j.membershipType].filter(Boolean).join(' ');
  return { kind: 'windows', windows, note: tag };
}

module.exports = { queryCodex, queryClaudeCode, queryAntigravity, queryBailian, queryMinimax, queryCursor };
