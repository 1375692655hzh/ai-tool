// 渠道用量查询：按厂商模板直查，或自动嗅探接口格式
// 支持：GLM Coding Plan / Kimi Coding Plan（5小时·每周·月度多窗口配额）
//       火山引擎官方 OpenAPI（AK/SK 签名）/ OpenAI 兼容计费（new-api 等中转站）
//       DeepSeek 余额 / 本机 CLI（Claude Code / Codex / Antigravity）/ 自定义端点
// 归一化输出：
//   套餐窗口 { ok, kind:'windows', windows:[{key,label,percent,used,limit,resetAt,group?}], status, ... }
//                                                                （group: 可选组标题，如 Cursor 的 "Pro · 1884/2000"）
//   额度模式 { ok, kind:'usage', used, total, balance, percent, status, ... }
//   余额模式 { ok, kind:'balance', balance, currency, status, ... }
//   失败     { ok:false, status:'error', message }

function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function originOf(base) {
  try { return new URL(base).origin; } catch { return base; }
}

function hostOf(base) {
  try { return new URL(base).hostname; } catch { return ''; }
}

function billingBase(base) {
  // 用户可能填到 /v1 层级，计费接口在 {base}/v1/dashboard/...
  return /\/v1$/i.test(base) ? base : base + '/v1';
}

async function fetchJson(url, apiKey, { auth = 'bearer', timeoutMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Authorization: auth === 'raw' ? apiKey : `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept-Language': 'zh-CN,zh',
        'User-Agent': 'ai-volume-pet/1.0',
      },
    });
    if (!res.ok) {
      let body = '';
      try { body = (await res.text()).slice(0, 200); } catch {}
      throw new Error(`HTTP ${res.status}${body ? ': ' + body : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function getByPath(obj, dotPath) {
  if (!dotPath) return undefined;
  return dotPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function toFloat(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const localClis = require('./local-clis');

function pctOf(used, limit) {
  if (used == null || limit == null || limit <= 0) return null;
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

function parseReset(v) {
  if (v == null) return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    if (n <= 0) return null;
    return n > 1e12 ? n : n * 1000; // 毫秒/秒
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// —— Coding Plan 套餐（多窗口配额） ——

const WINDOW_LABELS = { fiveHour: '5小时', weekly: '每周', monthly: '月度' };

function win(key, percent, used, limit, resetAt) {
  return { key, label: WINDOW_LABELS[key], percent, used, limit, resetAt: resetAt || null };
}

async function queryGlmCoding(base, ch) {
  const url = originOf(base) + '/api/monitor/usage/quota/limit';
  const data = await fetchJson(url, ch.apiKey, { auth: 'raw' }); // GLM 裸 key，不带 Bearer
  if (data && data.success === false) throw new Error(data.msg || '平台返回失败');
  const payload = (data && typeof data.data === 'object' && data.data) || data;
  const limits = (payload && payload.limits) || [];
  const found = {};
  const unmatched = [];
  for (const item of limits) {
    const type = item.type;
    const used = toFloat(item.currentValue);
    const limit = toFloat(item.usage);
    let percent = pctOf(used, limit);
    if (percent == null) {
      const raw = toFloat(item.percentage); // GLM percentage 恒为 0-100
      if (raw != null) percent = Math.max(0, Math.min(100, raw));
    }
    const resetAt = parseReset(item.nextResetTime);
    if (type === 'TOKENS_LIMIT' || type === 'CREDIT_LIMIT') {
      const unit = toFloat(item.unit);
      const number = toFloat(item.number);
      if (unit === 3 && number === 5) found.fiveHour = win('fiveHour', percent, used, limit, resetAt);
      else if (unit === 6 && number === 1) found.weekly = win('weekly', percent, used, limit, resetAt);
      else unmatched.push(win(null, percent, used, limit, resetAt));
    } else if (type === 'TIME_LIMIT') {
      found.monthly = win('monthly', percent, used, limit, resetAt);
    }
  }
  // 未识别的 TOKENS_LIMIT 按顺序兜底：第一个 → 5h，第二个 → 7d
  for (const w of unmatched) {
    if (!found.fiveHour) { w.key = 'fiveHour'; w.label = WINDOW_LABELS.fiveHour; found.fiveHour = w; }
    else if (!found.weekly) { w.key = 'weekly'; w.label = WINDOW_LABELS.weekly; found.weekly = w; }
  }
  const windows = ['fiveHour', 'weekly', 'monthly'].map((k) => found[k]).filter(Boolean);
  if (!windows.length) throw new Error('响应中未找到配额数据: ' + JSON.stringify(data).slice(0, 300));
  return { kind: 'windows', windows };
}

async function queryKimiCoding(base, ch) {
  const b = normalizeBase(base);
  let data;
  try {
    data = await fetchJson(`${b}/usages`, ch.apiKey);
  } catch (e) {
    data = await fetchJson(`${b}/usage`, ch.apiKey); // 旧路径兜底
  }
  const toWindow = (key, detail) => {
    let used = toFloat(detail.used);
    const limit = toFloat(detail.limit);
    const remaining = toFloat(detail.remaining);
    if (used == null && limit != null && remaining != null) used = limit - remaining;
    let resetAt = null;
    for (const k of ['resetTime', 'reset_at', 'reset_time', 'reset_in']) {
      if (detail[k] != null) { resetAt = parseReset(detail[k]); if (resetAt) break; }
    }
    return win(key, pctOf(used, limit), used, limit, resetAt);
  };
  const found = {};
  for (const item of data.limits || []) {
    const w = item.window || {};
    const detail = item.detail || item;
    const duration = toFloat(w.duration);
    const unit = String(w.timeUnit || '').toUpperCase().replace('TIME_UNIT_', '');
    if ((duration === 300 && unit.startsWith('MINUTE')) || (duration === 5 && unit.startsWith('HOUR'))) {
      found.fiveHour = toWindow('fiveHour', detail);
    } else if ((duration === 7 && unit.startsWith('DAY')) || (duration === 1 && unit.startsWith('WEEK'))) {
      found.weekly = toWindow('weekly', detail);
    }
  }
  if (!found.weekly && data.usage && typeof data.usage === 'object') {
    found.weekly = toWindow('weekly', data.usage); // 顶层 usage 是周汇总
  }
  const windows = ['fiveHour', 'weekly', 'monthly'].map((k) => found[k]).filter(Boolean);
  if (!windows.length) throw new Error('响应中未找到用量窗口数据');
  return { kind: 'windows', windows };
}

// —— 火山引擎官方 OpenAPI（AK/SK + V4 签名） ——

const { buildCanonicalQuery, signedHeadersV4 } = require('./volcano-sign');

const VOLC_HOST = 'open.volcengineapi.com';
const VOLC_REGION = 'cn-beijing';
const VOLC_SERVICE = 'ark';
const VOLC_VERSION = '2024-01-01';

async function callVolcano(action, ch) {
  const query = buildCanonicalQuery(action, VOLC_REGION, VOLC_VERSION);
  const body = '';
  const headers = signedHeadersV4({
    ak: ch.accessKeyId, sk: ch.secretAccessKey,
    region: VOLC_REGION, service: VOLC_SERVICE, host: VOLC_HOST,
    query, body, now: new Date(),
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let data;
  try {
    const res = await fetch(`https://${VOLC_HOST}/?${query}`, { method: 'POST', headers, body, signal: ctrl.signal });
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const err = data && data.ResponseMetadata && data.ResponseMetadata.Error;
  if (err) throw new Error(`${err.Code || ''}: ${err.Message || '火山接口错误'}`);
  return data;
}

function normalizePercent(p) {
  const n = toFloat(p);
  if (n == null) return null;
  return Math.max(0, Math.min(100, n <= 1 ? n * 100 : n)); // 兼容 0-1 与 0-100
}

// 同一窗口可能出现周期切换瞬间的新旧两条记录，取重置时间在未来且最近的一条
function pickWindow(candidates) {
  const now = Date.now();
  const future = candidates.filter((w) => w.resetAt && w.resetAt > now).sort((a, b) => a.resetAt - b.resetAt);
  return future[0] || candidates[0];
}

function parseAfpWindows(data) {
  const result = (data && data.Result) || {};
  const fields = [['AFPFiveHour', 'fiveHour'], ['AFPWeekly', 'weekly'], ['AFPMonthly', 'monthly']];
  const windows = [];
  for (const [field, key] of fields) {
    const w = result[field];
    if (!w || typeof w !== 'object') continue;
    const quota = toFloat(w.Quota);
    if (!quota || quota <= 0) continue; // 未订阅该窗口
    const used = toFloat(w.Used) || 0;
    const resetRaw = parseReset(w.ResetTime);
    windows.push(win(key, pctOf(used, quota), used, quota, resetRaw && resetRaw > 0 ? resetRaw : null));
  }
  return windows;
}

function parseCodingWindows(data) {
  const quota = ((data && data.Result) || {}).QuotaUsage || [];
  const levelMap = { session: 'fiveHour', '5h': 'fiveHour', hour: 'fiveHour', weekly: 'weekly', week: 'weekly', monthly: 'monthly', month: 'monthly' };
  const candidates = {};
  for (const item of quota) {
    const level = String(item.Level || '').toLowerCase();
    const key = Object.keys(levelMap).find((k) => level.includes(k));
    if (!key) continue;
    const resetRaw = parseReset(item.ResetTimestamp);
    const w = win(levelMap[key], normalizePercent(item.Percent), null, null, resetRaw && resetRaw > 0 ? resetRaw : null);
    (candidates[key] = candidates[key] || []).push(w);
  }
  return ['fiveHour', 'weekly', 'monthly'].map((k) => candidates[k] && pickWindow(candidates[k])).filter(Boolean);
}

async function queryVolcanoOpenapi(base, ch) {
  if (!ch.accessKeyId || !ch.secretAccessKey) throw new Error('未配置火山 AccessKey/SecretKey');
  // Agent Plan 优先；无有效窗口（未订阅 Agent）回退 Coding Plan
  let windows = parseAfpWindows(await callVolcano('GetAFPUsage', ch));
  if (!windows.length) windows = parseCodingWindows(await callVolcano('GetCodingPlanUsage', ch));
  if (!windows.length) throw new Error('响应中未找到用量窗口（可能未订阅套餐）');
  return { kind: 'windows', windows };
}

// —— 中转站计费 / 余额 ——

async function queryOpenAiBilling(base, ch) {
  const b = billingBase(base);
  const sub = await fetchJson(`${b}/dashboard/billing/subscription`, ch.apiKey);
  const total = Number(sub.hard_limit_usd);
  if (!Number.isFinite(total) || total <= 0) throw new Error('subscription 无总额度字段');
  const now = new Date();
  const usage = await fetchJson(
    `${b}/dashboard/billing/usage?start_date=${monthStart()}&end_date=${dateStr(new Date(now.getTime() + 86400000))}`,
    ch.apiKey
  );
  const used = Number(usage.total_usage) / 100; // 美分 → 美元
  if (!Number.isFinite(used)) throw new Error('usage 无已用字段');
  return { kind: 'usage', used, total, balance: Math.max(total - used, 0) };
}

async function queryDeepSeekBalance(base, ch) {
  const data = await fetchJson(`${base}/user/balance`, ch.apiKey);
  const info = Array.isArray(data.balance_infos) ? data.balance_infos[0] : null;
  const balance = info ? Number(info.total_balance) : NaN;
  if (!Number.isFinite(balance)) throw new Error('balance 无余额字段');
  return { kind: 'balance', balance, currency: (info && info.currency) || '' };
}

async function queryCustom(base, ch) {
  if (!ch.endpointPath) throw new Error('未配置自定义查询路径');
  const data = await fetchJson(base + ch.endpointPath, ch.apiKey);
  const m = ch.fieldMapping || {};
  const used = Number(getByPath(data, m.used));
  const total = Number(getByPath(data, m.total));
  const balance = Number(getByPath(data, m.balance));
  if (Number.isFinite(used) && Number.isFinite(total) && total > 0) return { kind: 'usage', used, total, balance: Math.max(total - used, 0) };
  if (Number.isFinite(balance)) return { kind: 'balance', balance };
  throw new Error('自定义端点返回数据无法按字段映射解析');
}

const QUERIERS = {
  'glm-coding': queryGlmCoding,
  'kimi-coding': queryKimiCoding,
  'volcano-openapi': queryVolcanoOpenapi,
  'openai-billing': queryOpenAiBilling,
  'deepseek-balance': queryDeepSeekBalance,
  custom: queryCustom,
  // 本机 CLI（无需 URL/KEY）
  'local-codex': () => localClis.queryCodex(),
  'local-claude': () => localClis.queryClaudeCode(),
  'local-agy': () => localClis.queryAntigravity(),
  'local-bailian': () => localClis.queryBailian(),
  'local-minimax': () => localClis.queryMinimax(),
  'local-cursor': () => localClis.queryCursor(),
  // 明确不支持的平台：给直接说明而不是一串 404
  'glm-team-legacy': async () => {
    throw new Error('智谱老版团队 API 未开放额度查询接口（余额只能在 open.bigmodel.cn 控制台查看）');
  },
  'minimax-unsupported': async () => {
    throw new Error('MiniMax 额度请用官方 mmx CLI 查询：安装 npm install -g mmx-cli 并用「MiniMax Token Plan（本机 mmx CLI）」模板');
  },
};

// 设置页厂商模板 → 查询类型（local: 无需 URL/KEY）
const VENDOR_TYPES = {
  kimi: { type: 'kimi-coding' },
  'glm-personal': { type: 'glm-coding' },
  'glm-team': { type: 'glm-coding' },
  'glm-team-legacy': { type: 'glm-team-legacy' },
  deepseek: { type: 'deepseek-balance' },
  minimax: { type: 'local-minimax', local: true },
  volcano: { type: 'volcano-openapi' },
  'openai-relay': { type: 'openai-billing' },
  'claude-code': { type: 'local-claude', local: true },
  codex: { type: 'local-codex', local: true },
  antigravity: { type: 'local-agy', local: true },
  bailian: { type: 'local-bailian', local: true },
  cursor: { type: 'local-cursor', local: true },
};

// 按域名给出探测顺序与失败时的针对性提示
const HOST_HINTS = [
  { match: /bigmodel\.cn|z\.ai/i, first: 'glm-coding' },
  { match: /kimi\.com|moonshot/i, first: 'kimi-coding' },
  { match: /minimaxi\.com|minimax\.io/i, failHint: 'MiniMax 的套餐额度请用「MiniMax Token Plan（本机 mmx CLI）」模板：需安装官方 mmx-cli 并 mmx auth login 登录' },
  { match: /dashscope\.aliyuncs|bailian/i, failHint: '阿里百炼的套餐额度请用「阿里百炼 Coding/Token Plan（本机 bl CLI）」模板：需安装官方 bailian-cli 并 bl auth login --console 登录' },
  { match: /volces\.com|volcengine/i, first: 'volcano-openapi', failHint: '火山引擎需要在设置里填 AccessKey/SecretKey（IAM 只读子账号即可），推理 API Key 查不了用量' },
];

/**
 * 查询单个渠道。已嗅探过的渠道直接用记住的类型，否则按域名特征 + 优先级依次探测。
 */
async function queryChannel(ch) {
  const base = normalizeBase(ch.baseUrl);

  // 厂商模板：直接按选定类型查询，不再嗅探
  if (ch.vendor && ch.vendor !== 'auto') {
    const v = VENDOR_TYPES[ch.vendor];
    if (!v) return { ok: false, status: 'error', message: '未知厂商模板: ' + ch.vendor, updatedAt: Date.now() };
    const needCreds = !v.local && ch.vendor !== 'glm-team-legacy' && ch.vendor !== 'minimax';
    // 火山走 AccessKey/SecretKey（独立字段），不该被 apiKey 门槛拦下
    const hasAkSk = !!(ch.accessKeyId && ch.secretAccessKey);
    if (needCreds && !hasAkSk && (!base || !ch.apiKey)) {
      return { ok: false, status: 'error', message: '缺少 URL 或 APIKEY', updatedAt: Date.now() };
    }
    try {
      const r = await QUERIERS[v.type](base, ch);
      return finalize(r, ch, v.type);
    } catch (e) {
      return { ok: false, status: 'error', message: String((e && e.message) || e), updatedAt: Date.now() };
    }
  }

  // 自动模式：按域名特征 + 优先级依次探测
  if (!base || !ch.apiKey) {
    return { ok: false, status: 'error', message: '缺少 URL 或 APIKEY（或在设置里选择厂商模板）', updatedAt: Date.now() };
  }
  const host = hostOf(base);
  const hint = HOST_HINTS.find((h) => h.match.test(host)) || {};

  const order = [];
  if (ch.detectedType && QUERIERS[ch.detectedType]) order.push(ch.detectedType);
  if (ch.endpointPath) order.push('custom');
  if (hint.first) {
    // 火山未填 AK/SK 时不走签名查询，让兜底 404 触发 failHint 引导文案
    if (!(hint.first === 'volcano-openapi' && !(ch.accessKeyId && ch.secretAccessKey))) order.push(hint.first);
  }
  order.push('openai-billing', 'deepseek-balance');
  const tried = [...new Set(order)];

  let lastErr = null;
  const errByType = {};
  for (const type of tried) {
    try {
      const r = await QUERIERS[type](base, ch);
      return finalize(r, ch, type);
    } catch (e) {
      lastErr = e;
      errByType[type] = e;
    }
  }
  // 优先展示域名特征对应的专用适配器错误（通用兜底接口的 404 没有诊断价值）
  const shownErr = (hint.first && errByType[hint.first]) || lastErr;
  let msg = shownErr && shownErr.name === 'AbortError' ? '请求超时' : String((shownErr && shownErr.message) || shownErr);
  if (hint.failHint && /^HTTP 4\d\d/.test(msg)) msg = hint.failHint; // 该平台根本查不了时给出人话提示
  return { ok: false, status: 'error', message: msg, updatedAt: Date.now() };
}

function finalize(r, ch, detectedType) {
  const out = {
    ok: true,
    status: 'ok',
    kind: r.kind,
    note: r.note || null,
    windows: r.windows || null,
    used: r.used ?? null,
    total: r.total ?? null,
    balance: r.balance ?? null,
    currency: r.currency || '',
    percent: null,
    message: '',
    detectedType,
    updatedAt: Date.now(),
  };
  if (r.kind === 'windows') {
    // 面板状态灯按最紧张的窗口分级
    const pcts = r.windows.map((w) => w.percent).filter((p) => p != null);
    out.percent = pcts.length ? Math.max(...pcts) : null;
    if (out.percent != null && out.percent >= 85) out.status = 'warn';
  } else if (r.kind === 'usage' && r.total > 0) {
    out.percent = Math.min((r.used / r.total) * 100, 100);
    if (out.percent >= 80) out.status = 'warn';
  } else if (r.kind === 'balance' && ch.totalOverride > 0) {
    out.kind = 'usage';
    out.total = ch.totalOverride;
    out.used = Math.max(ch.totalOverride - r.balance, 0);
    out.percent = Math.min((out.used / ch.totalOverride) * 100, 100);
    if (out.percent >= 80) out.status = 'warn';
  }
  return out;
}

function monthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = { queryChannel };
