// 用量面板：紧凑卡片，剩余导向（剩余百分比/余额为主数字，进度条表示剩余量）
(async function () {
  const cardsEl = document.getElementById('cards');
  let channels = [];
  let results = {};

  const btnRefresh = document.getElementById('btn-refresh');
  btnRefresh.classList.add('spin'); // 初始加载即转圈，首批数据到达后停止
  btnRefresh.addEventListener('click', async () => {
    btnRefresh.classList.add('spin');
    const payload = await window.api.invoke('quota:poll-now');
    applyPayload({ results: payload, channels });
    btnRefresh.classList.remove('spin');
  });
  document.getElementById('btn-close').addEventListener('click', () => {
    window.api.invoke('usage:close');
  });

  // 主进程推送：{ results, channels }（轮询完成 / 面板打开 / 渠道保存后都会推）
  window.api.on('quota:update', (payload) => applyPayload(payload));

  function applyPayload(payload) {
    if (!payload) return;
    if (payload.channels) channels = payload.channels;
    if (payload.results) results = payload.results;
    render();
    btnRefresh.classList.remove('spin');
  }

  function fmtMoney(n, currency) {
    if (n == null || !Number.isFinite(Number(n))) return '-';
    const sym = currency === 'CNY' ? '¥' : '$';
    return sym + Number(n).toFixed(2);
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function fmtResetShort(ts) {
    const diff = ts - Date.now();
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
    if (diff <= 0) return '即将重置';
    if (diff < 3600000) return `${Math.ceil(diff / 60000)}分`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}时${Math.round((diff % 3600000) / 60000) || ''}分`;
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    if (diff < 7 * 86400000) return `${days[d.getDay()]}${hm}`;
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function statusOf(r) {
    if (!r) return 'unknown';
    if (r.stale) return 'warn';
    if (r.ok === false) return 'error';
    if (r.status === 'warn') return 'warn';
    if (r.ok) return 'ok';
    return 'unknown';
  }

  // 剩余量分级配色：绿 ≥ 40% > 黄 ≥ 15% > 红
  function remClass(remainPct) {
    if (remainPct == null) return '';
    if (remainPct < 15) return ' danger';
    if (remainPct < 40) return ' warn';
    return '';
  }

  const TYPE_TAG = { usage: '额度', balance: '余额', windows: '套餐' };

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function head(ch, r, st) {
    const head = el('div', 'card-head');
    head.innerHTML = `<span class="dot ${st}"></span><span class="name"></span>`;
    head.querySelector('.name').textContent = ch.name;
    if (r && r.ok) head.appendChild(el('span', 'tag', r.note || TYPE_TAG[r.kind] || '额度'));
    if (ch.official !== false) { // 本机渠道且没填官网地址时不显示按钮
      const siteBtn = el('button', 'site-btn', '官网');
      siteBtn.addEventListener('click', () => window.api.invoke('open:official', ch.id));
      head.appendChild(siteBtn);
    }
    return head;
  }

  function staleNote(r) {
    if (!r || !r.stale) return null;
    return el('div', 'stale-note',
      `⚠ 刷新失败，显示 ${fmtTime(r.updatedAt)} 的数据${r.staleMessage ? '：' + r.staleMessage : ''}`);
  }

  // 渲染完成后把自然高度（标题栏 + 卡片内容）报给主进程贴合窗口，消灭下方留白。
  // 失败/不支持的渠道沉底（.bad）：高度只量到最后一张正常卡，把它们留在窗口底边之下（可滚动查看）
  function fitHeight() {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const tb = document.getElementById('titlebar');
      const okCards = cardsEl.querySelectorAll('.card:not(.bad)');
      let natural;
      if (okCards.length) {
        const last = okCards[okCards.length - 1];
        natural = last.offsetTop + last.offsetHeight + 5; // +cards 底 padding
      } else {
        natural = tb.offsetHeight + cardsEl.scrollHeight;
      }
      window.api.invoke('usage:fit-height', natural);
    }));
  }

  function render() {
    if (!channels.length) {
      cardsEl.innerHTML = '<div class="empty">还没有配置渠道<br>右键宠物 → 设置 添加<br>各厂商怎么填见 README 渠道配置指南</div>';
      fitHeight();
      return;
    }

    // 显示顺序：正常渠道按设置页顺序（↑↓ 手动调整），查询失败/不支持的压到最底下
    const okList = [], badList = [];
    for (const ch of channels) {
      const r = results[ch.id];
      (r && r.ok ? okList : badList).push(ch);
    }
    const sorted = [...okList, ...badList];

    // ② 全局更新时间 = 所有渠道里最新一次
    const times = Object.values(results).map((r) => r && r.updatedAt).filter(Boolean);
    const updatedEl = document.getElementById('updated');
    updatedEl.textContent = times.length ? '更新 ' + fmtTime(Math.max(...times)) : '';

    cardsEl.innerHTML = '';
    for (const ch of sorted) {
      const r = results[ch.id];
      const st = statusOf(r);
      const card = el('div', 'card');
      if (!(r && r.ok)) card.classList.add('bad');
      card.appendChild(head(ch, r, st));

      if (r && r.ok && r.kind === 'windows' && Array.isArray(r.windows)) {
        // Coding Plan 套餐：单行 = 档位 + 剩余条 + 剩xx% + 重置时间
        // 带组前缀的标签（Antigravity 的 "Gemini 每周"/"Claude/GPT 5小时"）拆成
        // 组标题 + 短档位行，避免长标签溢出盖住进度条
        const tierRe = /^(.+)\s+(每周|月度|5小时|\d+小时|\d+天)$/;
        const groups = [];
        for (const w of r.windows) {
          const m = tierRe.exec(String(w.label || ''));
          let g = m ? groups.find((x) => x.name === m[1]) : null;
          if (!g) { g = { name: m ? m[1] : null, rows: [] }; groups.push(g); }
          g.rows.push([m ? m[2] : String(w.label || ''), w]);
        }
        for (const g of groups) {
          if (g.name) card.appendChild(el('div', 'win-group', g.name));
          for (const [label, w] of g.rows) {
            const rem = w.percent != null ? Math.max(100 - Math.round(w.percent), 0) : null;
            const row = el('div', 'win-row');
            const lbl = el('span', 'win-label', label);
            const track = el('span', 'bar-track');
            const fill = el('span', 'bar-fill' + remClass(rem));
            fill.style.width = (rem ?? 0) + '%';
            track.appendChild(fill);
            const pct = el('span', 'win-pct' + remClass(rem), rem != null ? '剩' + rem + '%' : 'N/A');
            const rst = el('span', 'win-reset-inline', w.resetAt ? fmtResetShort(w.resetAt) : '');
            row.append(lbl, track, pct, rst);
            card.appendChild(row);
          }
        }
      } else if (r && r.ok && r.kind === 'usage') {
        // 额度模式：剩余金额为主数字 + 剩余占比条 + 已用/总额
        const rem = r.percent != null ? Math.max(100 - Math.round(r.percent), 0) : null;
        const top = el('div', 'usage-top');
        top.innerHTML = `<span class="usage-remain${remClass(rem)}">${fmtMoney(r.balance)}</span>
          <span class="usage-total">剩 ${rem != null ? rem + '%' : '?'} / 共 ${fmtMoney(r.total)}</span>`;
        card.appendChild(top);
        const track = el('div', 'bar-track');
        track.innerHTML = `<span class="bar-fill${remClass(rem)}" style="width:${rem ?? 0}%"></span>`;
        card.appendChild(track);
        card.appendChild(el('div', 'card-foot sub', '')).innerHTML =
          `<span>已用 ${fmtMoney(r.used)}</span><span>更新 ${fmtTime(r.updatedAt)}</span>`;
      } else if (r && r.ok && r.kind === 'balance') {
        // 余额模式：大字余额 + 更新时间
        const top = el('div', 'usage-top');
        top.innerHTML = `<span class="usage-remain">${fmtMoney(r.balance, r.currency)}</span>
          <span class="usage-total">更新 ${fmtTime(r.updatedAt)}</span>`;
        card.appendChild(top);
      } else if (r && r.ok === false) {
        // 错误：单行折叠，完整信息悬停可见
        const err = el('div', 'err-msg', r.message || '查询失败');
        err.title = r.message || '';
        card.appendChild(err);
        card.appendChild(el('div', 'card-foot sub', '')).innerHTML =
          `<span></span><span>${fmtTime(r.updatedAt) || fmtTime(r.checkedAt)}</span>`;
      } else {
        card.appendChild(el('div', 'card-foot sub', '')).innerHTML = '<span>等待首次查询…</span>';
      }

      const note = staleNote(r);
      if (note) card.appendChild(note);
      cardsEl.appendChild(card);
    }
    fitHeight();
  }

  // 初始化
  applyPayload(await window.api.invoke('quota:get-results'));
})();
