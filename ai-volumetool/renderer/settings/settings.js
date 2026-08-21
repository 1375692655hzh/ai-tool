// 设置页：厂商模板驱动 + 渠道 CRUD + 偏好，保存后主进程热生效
(async function () {
  const listEl = document.getElementById('channel-list');
  let channels = [];

  const uid = () => 'ch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // 厂商模板：fields 控制显示哪些输入（baseUrl=URL+KEY，accessKey=AK/SK，custom=端点+映射，override=总额度）
  const VENDORS = {
    auto:              { label: '自动检测', fields: ['baseUrl', 'accessKey', 'custom', 'override'], hint: '按 URL 自动识别厂商；识别不出来或想固定行为，请选具体模板' },
    kimi:              { label: 'Kimi Coding Plan', fields: ['baseUrl'], url: 'https://api.kimi.com/coding/v1' },
    'glm-personal':    { label: 'GLM Coding Plan（新版·个人）', fields: ['baseUrl'], url: 'https://open.bigmodel.cn/api/coding/paas/v4' },
    'glm-team':        { label: 'GLM Coding Plan（新版·团队）', fields: ['baseUrl'], url: 'https://open.bigmodel.cn/api/coding/paas/v4' },
    'glm-team-legacy': { label: 'GLM 老版团队 API（不支持查询）', fields: [], hint: '智谱官方未开放老版团队的额度查询接口（已实测确认），此渠道会显示说明。想看百分比需换用新版 Coding Plan 的 Key' },
    deepseek:          { label: 'DeepSeek 官方', fields: ['baseUrl', 'override'], url: 'https://api.deepseek.com' },
    minimax:           { label: 'MiniMax Token Plan（本机 mmx CLI）', fields: [], local: '自动调用官方 MiniMax CLI 查询 Token Plan 剩余额度（按模型组的 5小时/每周窗口）。前提：npm install -g mmx-cli 且运行过 mmx auth login（粘贴 API key 或浏览器登录）。官网地址建议填 https://platform.minimaxi.com' },
    volcano:           { label: '火山引擎 Coding/Agent Plan', fields: ['baseUrl', 'accessKey'], url: 'https://ark.cn-beijing.volces.com/api/plan/v3', hint: '需要 IAM 密钥管理里的 AccessKey/SecretKey（子账号授 ArkReadOnlyAccess 只读权限即可）；推理 API Key 查不了套餐用量' },
    'openai-relay':    { label: 'OpenAI 兼容中转站', fields: ['baseUrl'], hint: 'new-api / one-api 等中转站的计费接口（额度=已用/总额）' },
    bailian:          { label: '阿里百炼 Coding/Token Plan（本机 bl CLI）', fields: [], local: '自动调用官方百炼 CLI 查询 Coding Plan / Token Plan 额度。前提：npm install -g bailian-cli 且运行过 bl auth login --console（浏览器登录）。官网地址建议填控制台 https://bailian.console.aliyun.com/?tab=dashboard' },
    'claude-code':     { label: 'Claude Code / Pro / Max（本机额度）', fields: [], local: '优先用 Claude Code 登录凭证（~/.claude/.credentials.json）查官方实时额度；没有订阅登录时回退读 statusline 快照（~/.claude/usage-status.json），无需填写任何东西' },
    codex:             { label: 'Codex（本机额度）', fields: [], local: '自动读取本机 ~/.codex 会话里的官方额度记录，无需填写任何东西' },
    antigravity:       { label: 'Antigravity（本机额度）', fields: [], local: '自动用本机 Antigravity 登录凭证查 Google 官方配额接口，无需填写任何东西' },
    cursor:            { label: 'Cursor（本机额度）', fields: [], local: '自动读取桌面版 Cursor 的本地登录凭据（state.vscdb）查询官方 Pro 套餐用量：总额度 / Auto / API 三条剩余 + 重置日期，无需填任何东西。前提：Cursor 已登录。凭据只在本机读取、只发给 cursor.com 官方接口。官网地址可填 https://cursor.com' },
    custom:            { label: '自定义端点', fields: ['baseUrl', 'custom', 'override'] },
  };

  function vendorDef(v) { return VENDORS[v] || VENDORS.auto; }

  function channelCard(ch) {
    const def = vendorDef(ch.vendor);
    const card = document.createElement('div');
    card.className = 'channel-card collapsed';
    card.dataset.id = ch.id;
    card.innerHTML = `
      <div class="card-head-row" title="点击展开/折叠">
        <span class="chevron">▸</span>
        <span class="ch-name-display"></span>
        <span class="ch-vendor-tag"></span>
        <span class="ch-order-btns">
          <button class="btn-order btn-up" title="上移（面板中优先显示）">↑</button>
          <button class="btn-order btn-down" title="下移">↓</button>
        </span>
      </div>
      <div class="card-body">
      <div class="row">
        <label>厂商模板
          <select data-f="vendor"></select>
        </label>
        <label>渠道名称<input type="text" data-f="name" placeholder="例如：Kimi 主力号"></label>
      </div>
      <div class="row f-baseUrl">
        <label>URL<input type="text" data-f="baseUrl" placeholder="https://api.example.com"></label>
        <label>APIKEY<input type="password" data-f="apiKey" placeholder="sk-..."></label>
      </div>
      <div class="row f-accessKey">
        <label>AccessKey（火山）<input type="text" data-f="accessKeyId" placeholder="AK..."></label>
        <label>SecretKey（火山）<input type="password" data-f="secretAccessKey" placeholder="SK..."></label>
      </div>
      <div class="row f-custom">
        <label>自定义查询路径<input type="text" data-f="endpointPath" placeholder="/api/user/self"></label>
      </div>
      <div class="row hint f-custom">返回 JSON 的取值字段（点号路径）：已用 used / 总额 total / 余额 balance，如 data.quota</div>
      <div class="row f-custom">
        <label>已用字段<input type="text" data-f="mapUsed" placeholder="data.used"></label>
        <label>总额字段<input type="text" data-f="mapTotal" placeholder="data.total"></label>
        <label>余额字段<input type="text" data-f="mapBalance" placeholder="data.balance"></label>
      </div>
      <div class="row f-override">
        <label>总额度（可选，余额型接口算百分比用）<input type="number" data-f="totalOverride" min="0" step="any"></label>
      </div>
      <div class="row f-official">
        <label>官网地址（可选，"官网"按钮和右键菜单打开这里）<input type="text" data-f="officialUrl" placeholder="https://platform.example.com"></label>
      </div>
      <div class="row hint f-hint"></div>
      <div class="card-actions">
        <button class="btn secondary btn-test">测试查询</button>
        <span class="test-result"></span>
        <span style="flex:1"></span>
        <button class="btn danger btn-del">删除</button>
      </div>
      </div>`;

    const vendorSel = card.querySelector('[data-f="vendor"]');
    for (const [k, v] of Object.entries(VENDORS)) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = v.label;
      vendorSel.appendChild(o);
    }
    vendorSel.value = ch.vendor || 'auto';

    card.querySelector('[data-f="name"]').value = ch.name || '';
    card.querySelector('[data-f="baseUrl"]').value = ch.baseUrl || '';
    card.querySelector('[data-f="apiKey"]').value = ch.apiKey || '';
    card.querySelector('[data-f="accessKeyId"]').value = ch.accessKeyId || '';
    card.querySelector('[data-f="secretAccessKey"]').value = ch.secretAccessKey || '';
    card.querySelector('[data-f="endpointPath"]').value = ch.endpointPath || '';
    card.querySelector('[data-f="officialUrl"]').value = ch.officialUrl || '';
    card.querySelector('[data-f="totalOverride"]').value = ch.totalOverride || '';
    const fm = ch.fieldMapping || {};
    card.querySelector('[data-f="mapUsed"]').value = fm.used || '';
    card.querySelector('[data-f="mapTotal"]').value = fm.total || '';
    card.querySelector('[data-f="mapBalance"]').value = fm.balance || '';

    // 厂商模板 → 字段联动
    function syncFields() {
      const d = vendorDef(vendorSel.value);
      const show = (f, on) => { const el = card.querySelector('.f-' + f); if (el) el.style.display = on ? '' : 'none'; };
      for (const f of ['baseUrl', 'accessKey', 'custom', 'override']) show(f, d.fields.includes(f));
      // 自动模式下：URL 是火山域名才显示 AK/SK
      if (vendorSel.value === 'auto') {
        show('accessKey', /volces\.com|volcengine/i.test(card.querySelector('[data-f="baseUrl"]').value));
      }
      const hintEl = card.querySelector('.f-hint');
      hintEl.textContent = d.hint || d.local || '';
      hintEl.style.display = hintEl.textContent ? '' : 'none';
    }
    vendorSel.addEventListener('change', () => {
      const d = vendorDef(vendorSel.value);
      const urlInput = card.querySelector('[data-f="baseUrl"]');
      if (d.url && !urlInput.value.trim()) urlInput.value = d.url; // 模板默认 URL
      syncFields();
    });
    card.querySelector('[data-f="baseUrl"]').addEventListener('input', syncFields);
    syncFields();

    // 折叠头部：一行显示 渠道名 + 厂商标签，点击整行展开/折叠
    const nameDisplay = card.querySelector('.ch-name-display');
    const vendorTag = card.querySelector('.ch-vendor-tag');
    const syncHead = () => {
      nameDisplay.textContent = card.querySelector('[data-f="name"]').value.trim() || '（未命名渠道）';
      vendorTag.textContent = vendorDef(vendorSel.value).label;
    };
    card.querySelector('[data-f="name"]').addEventListener('input', syncHead);
    vendorSel.addEventListener('change', syncHead);
    syncHead();
    card.querySelector('.card-head-row').addEventListener('click', () => card.classList.toggle('collapsed'));

    // 排序按钮：在列表里上移/下移（保存后即为用量面板的显示顺序）
    const move = (dir) => {
      const sib = dir < 0 ? card.previousElementSibling : card.nextElementSibling;
      if (!sib || !sib.classList.contains('channel-card')) return;
      if (dir < 0) listEl.insertBefore(card, sib); else listEl.insertBefore(sib, card);
      markDirty();
    };
    card.querySelector('.btn-up').addEventListener('click', (e) => { e.stopPropagation(); move(-1); });
    card.querySelector('.btn-down').addEventListener('click', (e) => { e.stopPropagation(); move(1); });

    card.querySelector('.btn-del').addEventListener('click', () => {
      channels = channels.filter((c) => c.id !== ch.id);
      card.remove();
    });

    card.querySelector('.btn-test').addEventListener('click', async () => {
      const resEl = card.querySelector('.test-result');
      resEl.className = 'test-result';
      resEl.textContent = '查询中…';
      let payload = readCard(card);
      if (payload.apiKey === '__KEEP__' || payload.secretAccessKey === '__KEEP__') {
        await saveAll(true); // 用已存的真实密钥测试：先保存
        payload = readCard(card);
      }
      const r = await window.api.invoke('channel:test', payload);
      if (r.ok) {
        resEl.classList.add('ok');
        resEl.textContent = r.kind === 'windows'
          ? '✓ ' + r.windows.map((w) => `${w.label}剩${100 - Math.round(w.percent)}%`).join(' ')
          : r.kind === 'usage' ? `✓ 剩 $${Number(r.balance).toFixed(2)}（剩${Math.round(100 - r.percent)}%）`
          : `✓ 余额 ${r.balance}`;
      } else {
        resEl.classList.add('err');
        resEl.textContent = '✗ ' + (r.message || '查询失败');
      }
    });

    return card;
  }

  function readCard(card) {
    const visible = (f) => {
      const el = card.querySelector('.f-' + f);
      return !el || el.style.display !== 'none';
    };
    const v = (f) => card.querySelector(`[data-f="${f}"]`).value.trim();
    // 隐藏的字段读 '__KEEP__'，避免切换模板时误清已存的密钥
    const apiKey = visible('baseUrl') ? v('apiKey') : '__KEEP__';
    const sk = visible('accessKey') ? v('secretAccessKey') : '__KEEP__';
    const mapUsed = v('mapUsed'), mapTotal = v('mapTotal'), mapBalance = v('mapBalance');
    const fieldMapping = (mapUsed || mapTotal || mapBalance)
      ? { used: mapUsed || undefined, total: mapTotal || undefined, balance: mapBalance || undefined }
      : null;
    return {
      id: card.dataset.id,
      vendor: v('vendor'),
      name: v('name'),
      baseUrl: v('baseUrl'),
      apiKey,
      accessKeyId: v('accessKeyId'),
      secretAccessKey: sk,
      endpointPath: v('endpointPath'),
      officialUrl: v('officialUrl'),
      totalOverride: v('totalOverride'),
      fieldMapping,
    };
  }

  function renderList() {
    listEl.innerHTML = '';
    for (const ch of channels) listEl.appendChild(channelCard(ch));
  }

  async function saveAll(silent) {
    channels = [...listEl.querySelectorAll('.channel-card')].map(readCard);
    await window.api.invoke('channels:save', channels);
    await window.api.invoke('settings:save', {
      pollIntervalMin: Number(document.getElementById('poll-interval').value) || 5,
      scale: Number(document.getElementById('pet-scale').value) || 1.5,
      autoStart: document.getElementById('auto-start').checked,
      character: document.getElementById('pet-character').value,
      launchTools: parseTools(document.getElementById('launch-tools').value),
    });
    channels = (await window.api.invoke('channels:get-for-settings'));
    renderList();
    if (!silent) {
      const tip = document.getElementById('save-tip');
      tip.textContent = '已保存 ✓';
      setTimeout(() => { tip.textContent = ''; }, 2000);
    }
  }

  document.getElementById('btn-add').addEventListener('click', () => {
    const ch = { id: uid(), vendor: 'auto', name: '', baseUrl: '', apiKey: '', endpointPath: '', officialUrl: '', totalOverride: '', fieldMapping: null };
    channels.push(ch);
    const card = channelCard(ch);
    card.classList.remove('collapsed'); // 新建的直接展开方便填写
    listEl.appendChild(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    card.querySelector('[data-f="name"]').focus();
    markDirty();
  });
  document.getElementById('btn-save').addEventListener('click', async () => {
    dirty = false;
    await saveAll(false);
  });
  document.getElementById('btn-close').addEventListener('click', () => window.api.invoke('settings:close'));

  // 有未保存编辑时不被外部刷新覆盖
  let dirty = false;
  function markDirty() { dirty = true; }
  listEl.addEventListener('input', markDirty);
  listEl.addEventListener('change', markDirty);
  window.api.on('channels:refresh', async () => {
    if (dirty) return;
    channels = await window.api.invoke('channels:get-for-settings');
    renderList();
  });

  async function reload() {
    channels = await window.api.invoke('channels:get-for-settings');
    renderList();
  }

  // 启动工具编辑框：每行「名称 | app/term | 命令」
  const parseTools = (text) =>
    String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, type, ...rest] = l.split('|').map((x) => x.trim());
      return { name: name || '未命名', type: type === 'term' ? 'term' : 'app', cmd: rest.join('|').trim() };
    }).filter((t) => t.cmd);
  const fmtTools = (tools) => (tools || []).map((t) => `${t.name} | ${t.type} | ${t.cmd}`).join('\n');

  // 初始化
  await reload();
  const s = await window.api.invoke('settings:get');
  document.getElementById('poll-interval').value = s.pollIntervalMin || 5;
  document.getElementById('pet-scale').value = String(s.scale || 1.5);
  document.getElementById('auto-start').checked = !!s.autoStart;
  document.getElementById('launch-tools').value = fmtTools(s.launchTools);
  const charSel = document.getElementById('pet-character');
  const packs = await window.api.invoke('characters:list');
  for (const p of packs) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    charSel.appendChild(o);
  }
  charSel.value = s.character || 'whale-girl';
})();
