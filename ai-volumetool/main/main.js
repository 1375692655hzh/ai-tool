const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { app, ipcMain, shell, dialog, Tray, Menu, nativeImage, Notification } = require('electron');
const { Store } = require('./store');
const { Poller } = require('./quota/poller');
const { queryChannel } = require('./quota/sniffer');
const { createPetWindow, createUsageWindow, createSettingsWindow, placeUsageNearPet } = require('./windows');
const { popupPetMenu } = require('./contextMenu');
const { listCharacters, loadCharacter, petSizeFor } = require('./characters');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

// Windows 通知身份（与 package.json 的 appId 一致）：不设置的话托盘气泡可能不显示或显示成 Electron 默认名
app.setAppUserModelId('com.aivolumetool.pet');

let store;
let petWin, usageWin, settingsWin, tray, poller;
// 渲染器实测的可见内容占比 {fx,fy,fw,fh}（相对窗口）：透明 padding 不算"身体"，
// 拖拽/散步的边界钳制按内容盒算，形象才能真正贴到屏幕边（消除空气墙）
let petContent = null;

function validFractions(b) {
  return b && [b.fx, b.fy, b.fw, b.fh].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) && b.fw > 0 && b.fh > 0
    ? { fx: b.fx, fy: b.fy, fw: b.fw, fh: b.fh } : null;
}

// 所有显示器工作区的联合边界
function unionWorkArea() {
  const { screen } = require('electron');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of screen.getAllDisplays()) {
    const a = d.workArea;
    minX = Math.min(minX, a.x); minY = Math.min(minY, a.y);
    maxX = Math.max(maxX, a.x + a.width); maxY = Math.max(maxY, a.y + a.height);
  }
  return { minX, minY, maxX, maxY };
}

// 把宠物窗口钳制到"内容盒完全在联合工作区内"的位置；缩放/换角色后窗口尺寸变化时也走这里重钳
function clampPetPosition() {
  if (!petWin || petWin.isDestroyed()) return;
  const [w, h] = petWin.getSize();
  const f = petContent || { fx: 0, fy: 0, fw: 1, fh: 1 };
  const { minX, minY, maxX, maxY } = unionWorkArea();
  const loX = minX - f.fx * w, hiX = Math.max(loX, maxX - (f.fx + f.fw) * w);
  const loY = minY - f.fy * h, hiY = Math.max(loY, maxY - (f.fy + f.fh) * h);
  const [x, y] = petWin.getPosition();
  const cx = Math.round(Math.min(Math.max(x, loX), hiX));
  const cy = Math.round(Math.min(Math.max(y, loY), hiY));
  if (cx !== x || cy !== y) {
    petWin.setPosition(cx, cy);
    store.setPetPosition({ x: cx, y: cy });
  }
}

function officialUrlOf(baseUrl) {
  try { return new URL(baseUrl).origin; } catch { return baseUrl; }
}

// 启动外部工具：app=直接拉起程序，term=开一个终端窗口运行 CLI
function launchTool(t) {
  if (!t || !t.cmd) return;
  try {
    if (t.type === 'term') {
      const wt = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');
      if (fs.existsSync(wt)) {
        spawn(wt, ['-d', os.homedir(), 'cmd', '/k', t.cmd], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('cmd', ['/c', 'start', '', 'cmd', '/k', t.cmd], { detached: true, stdio: 'ignore' }).unref();
      }
    } else {
      if (!fs.existsSync(t.cmd)) {
        dialog.showErrorBox('启动失败', '找不到程序：\n' + t.cmd + '\n\n请在 设置 → 偏好 → 启动工具 里修改路径');
        return;
      }
      spawn(t.cmd, [], { detached: true, stdio: 'ignore', cwd: path.dirname(t.cmd) }).unref();
    }
  } catch (e) {
    dialog.showErrorBox('启动失败', String((e && e.message) || e));
  }
}

function openOfficial(channelId) {
  const ch = store.channels.find((c) => c.id === channelId);
  if (!ch) return;
  // 优先用户在设置里填的官网地址；没填则退回 baseUrl 的源站
  const target = (ch.officialUrl || '').trim() || (ch.baseUrl ? officialUrlOf(ch.baseUrl) : '');
  if (target) shell.openExternal(target);
}

function channelList() {
  return store.channels.map((c) => ({ id: c.id, name: c.name, official: !!(c.officialUrl || c.baseUrl) }));
}

function usagePayload(results) {
  return { results: results || store.lastResults, channels: channelList() };
}

// 窗口可能被系统关闭（设置窗的 ✕、Alt+F4），销毁后引用要清空、用前要懒重建
function ensureUsageWin() {
  if (usageWin && !usageWin.isDestroyed()) return usageWin;
  usageWin = createUsageWindow(store);
  usageWin.on('closed', () => { usageWin = null; });
  usageWin.webContents.once('did-finish-load', () => {
    if (usageWin && !usageWin.isDestroyed()) usageWin.webContents.send('quota:update', usagePayload());
  });
  return usageWin;
}

function ensureSettingsWin() {
  if (settingsWin && !settingsWin.isDestroyed()) return settingsWin;
  settingsWin = createSettingsWindow();
  settingsWin.on('closed', () => { settingsWin = null; });
  settingsWin.webContents.once('did-finish-load', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('channels:refresh');
  });
  return settingsWin;
}

function toggleUsage() {
  const win = ensureUsageWin();
  if (win.isVisible()) { win.hide(); return; }
  placeUsageNearPet(win, petWin);
  win.show();
  win.webContents.send('quota:update', usagePayload());
}

function openSettings() {
  const win = ensureSettingsWin();
  win.show();
  win.focus();
  if (!win.webContents.isLoading()) win.webContents.send('channels:refresh'); // 每次打开时同步最新渠道
}

function summarize(name, r) {
  if (!r) return `${name}：未查询`;
  if (r.stale) return `${name}：刷新失败（显示上次数据）`;
  if (r.ok === false) return `${name}：查询失败`;
  if (r.kind === 'windows') {
    const parts = (r.windows || []).map((w) => `${w.label}剩${w.percent != null ? 100 - Math.round(w.percent) : '?'}%`);
    return `${name}：${parts.join(' ')}`;
  }
  if (r.kind === 'usage') return `${name}：剩 ${r.balance != null ? '$' + Number(r.balance).toFixed(2) : (100 - Math.round(r.percent)) + '%'}`;
  return `${name}：余额 ${r.balance != null ? r.balance : '-'}${r.currency === 'CNY' ? '元' : ''}`;
}

function broadcast(results) {
  if (usageWin && !usageWin.isDestroyed()) usageWin.webContents.send('quota:update', usagePayload(results));
  if (tray) {
    const lines = store.channels.map((c) => summarize(c.name, results[c.id]));
    tray.setToolTip(['AI用量宠物', ...lines].join('\n'));
  }
  const anyError = Object.values(results).some((r) => r && r.ok === false);
  if (anyError && petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:play', 'failed');
  checkLowQuota(results);
}

// —— 低额度主动提醒 ——
// 任一渠道剩余 <15% 时弹一次托盘气泡 + 宠物播 failed 动画；
// 去重 key 含 resetAt，每轮重置周期只提醒一次；无 resetAt 的渠道（金额型）退化为每天一次
const LOW_QUOTA_ALERT = 15;

function dayAnchor() {
  const d = new Date();
  return `d${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function showLowQuotaNotice(body) {
  if (tray) {
    try { tray.displayBalloon({ iconType: 'warning', title: 'AI用量宠物 · 额度告急', content: body }); return; }
    catch (e) { /* 气泡不可用时走系统通知兜底 */ }
  }
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: 'AI用量宠物 · 额度告急', body });
    n.on('click', toggleUsage);
    n.show();
  } catch (e) { /* 通知失败不影响主流程 */ }
}

function checkLowQuota(results) {
  const fresh = [];
  for (const c of store.channels) {
    const r = results[c.id];
    if (!r || !r.ok) continue;
    const units = r.kind === 'windows'
      ? (r.windows || []).map((w) => ({ key: w.key || '', label: w.label, resetAt: w.resetAt, percent: w.percent }))
      : r.kind === 'usage' && r.percent != null
        ? [{ key: '', label: '', resetAt: null, percent: r.percent }]
        : [];
    for (const u of units) {
      if (u.percent == null) continue;
      const rem = Math.max(100 - u.percent, 0);
      if (rem >= LOW_QUOTA_ALERT) continue;
      const dedupeKey = `${c.id}|${u.key}|${u.resetAt || dayAnchor()}`;
      if (store.hasReminded(dedupeKey)) continue;
      store.markReminded(dedupeKey);
      fresh.push(`${c.name}${u.label ? '·' + u.label : ''} 剩 ${Math.round(rem)}%`);
    }
  }
  if (!fresh.length) return;
  showLowQuotaNotice(fresh.join('；').slice(0, 220));
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('pet:play', 'failed');
}

function refreshPetConfig() {
  if (!petWin) return;
  const { screen } = require('electron');
  petWin.webContents.send('pet:config', {
    scale: Number(store.settings.scale) || 1.5,
    workArea: screen.getPrimaryDisplay().workArea,
    character: loadCharacter(store.settings.character),
  });
}

// 创建宠物窗口并挂上事件（启动与角色切换重建共用）
function spawnPetWindow() {
  petWin = createPetWindow(store);
  petWin.webContents.on('did-finish-load', refreshPetConfig);
  petWin.on('moved', () => { if (petWin) store.setPetPosition(petWin.getBounds()); });
}

function resizePetWindow() {
  if (!petWin || petWin.isDestroyed()) return;
  const size = petSizeFor(store.settings);
  const b = petWin.getBounds();
  if (b.width === size.width && b.height === size.height) return;
  // Windows 上对 resizable:false 的透明窗口程序化 setSize 不可靠（尺寸半生效）。
  // 角色切换是低频操作，直接按新尺寸重建窗口最稳；位置沿用当前左上角
  store.setPetPosition({ x: b.x, y: b.y });
  petWin.destroy();
  spawnPetWindow();
  clampPetPosition(); // 放大后左上角不变会让窗口越出工作区，按新尺寸重钳（否则散步立即撞"墙"卡死）
}

// 切换角色：立即保存并热生效（宠物窗口收到 pet:config 后重建渲染器）
function setCharacter(id) {
  store.setSettings({ character: id });
  resizePetWindow();
  refreshPetConfig();
}

function setupIpc() {
  // —— 宠物窗口 ——
  ipcMain.handle('pet:ready', () => {
    const { screen } = require('electron');
    return {
      scale: Number(store.settings.scale) || 1.5,
      workArea: screen.getPrimaryDisplay().workArea,
      character: loadCharacter(store.settings.character),
    };
  });
  ipcMain.handle('pet:set-position', (_e, x, y) => {
    if (!petWin) return;
    const [w, h] = petWin.getSize();
    // 钳制到所有显示器工作区的联合边界（而不是最近单个显示器），
    // 否则跨屏拖动时会在屏幕交界处撞"空气墙"；再按内容占比收缩，
    // 让可见形象（而非透明窗口盒）贴边即停
    const f = petContent || { fx: 0, fy: 0, fw: 1, fh: 1 };
    const { minX, minY, maxX, maxY } = unionWorkArea();
    const loX = minX - f.fx * w, hiX = Math.max(loX, maxX - (f.fx + f.fw) * w);
    const loY = minY - f.fy * h, hiY = Math.max(loY, maxY - (f.fy + f.fh) * h);
    const cx = Math.round(Math.min(Math.max(x, loX), hiX));
    const cy = Math.round(Math.min(Math.max(y, loY), hiY));
    petWin.setPosition(cx, cy);
    store.setPetPosition({ x: cx, y: cy });
  });
  // 渲染器量完素材内容占比后上报；到达即重钳一次当前位置（窗口可能已越界）
  ipcMain.handle('pet:content-bounds', (_e, b) => {
    const v = validFractions(b);
    if (!v) return;
    const changed = !petContent
      || ['fx', 'fy', 'fw', 'fh'].some((k) => Math.abs(v[k] - petContent[k]) > 0.001);
    petContent = v;
    if (changed) clampPetPosition();
  });
  // 用量面板按内容自适应尺寸：渲染器量好自然宽高上报，这里钳到工作区内再贴合
  ipcMain.handle('usage:fit-height', (_e, h, w) => {
    if (!usageWin || usageWin.isDestroyed()) return;
    const n = Math.round(Number(h) || 0);
    if (!(n > 0)) return;
    const { screen } = require('electron');
    const area = screen.getPrimaryDisplay().workArea;
    const maxH = area.height - 40;
    const height = Math.min(Math.max(n, 120), maxH);
    let width = Math.round(Number(w) || 0);
    if (width) width = Math.min(Math.max(width, 200), area.width - 20); // 双列 515 也要放得下
    const [curW, curH] = usageWin.getSize();
    if (!width) width = curW;
    if (Math.abs(curH - height) <= 1 && Math.abs(curW - width) <= 1) return;
    // resizable:false 的窗口直接 setSize 会"半生效"（尤其缩小时）——临时解锁再锁回
    usageWin.setResizable(true);
    usageWin.setSize(width, height);
    usageWin.setResizable(false);
    if (usageWin.isVisible()) placeUsageNearPet(usageWin, petWin); // 尺寸变了重新贴宠物
    // 宽度变化后渲染器会自校准重测高度（fitHeight 检测到视口变宽会再报一轮）
  });
  ipcMain.handle('pet:menu', () => {
    popupPetMenu({
      tools: store.settings.launchTools,
      characters: listCharacters(),
      currentCharacter: store.settings.character || 'whale-girl',
      onShowUsage: toggleUsage,
      onOpenSettings: openSettings,
      onLaunchTool: launchTool,
      onSetCharacter: setCharacter,
      onQuit: () => app.quit(),
    });
  });

  // —— 设置 ——
  ipcMain.handle('channels:get-for-settings', () => store.getChannelsForSettings());
  ipcMain.handle('channels:save', (_e, list) => {
    if (!Array.isArray(list)) return { ok: false, error: '渠道列表格式错误，已拒绝保存（防止误清空）' };
    store.saveChannels(list);
    broadcast(store.lastResults); // 面板立即刷新渠道列表，不用等轮询
    poller.restart();
    return { ok: true };
  });
  ipcMain.handle('settings:get', () => store.settings);
  ipcMain.handle('settings:save', (_e, patch) => {
    store.setSettings(patch || {});
    app.setLoginItemSettings({ openAtLogin: !!store.settings.autoStart });
    if (petWin) resizePetWindow();
    refreshPetConfig();
    poller.restart();
    return { ok: true };
  });
  ipcMain.handle('settings:open', () => openSettings());
  ipcMain.handle('settings:close', () => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.hide(); });
  ipcMain.handle('tool:launch', (_e, tool) => launchTool(tool));
  ipcMain.handle('characters:list', () => listCharacters());
  // 百炼会话过期的一键重登：拉起终端跑 bl auth login --console（浏览器登录后下轮轮询自动恢复）
  ipcMain.handle('bailian:relogin', () => {
    launchTool({ type: 'term', cmd: 'bl auth login --console' });
    return { ok: true };
  });

  // —— 用量查询 ——
  ipcMain.handle('channel:test', (_e, ch) => {
    // 设置页对未修改的 key/SK 传 '__KEEP__' 占位，需取已存的真实值
    const saved = ch && store.channels.find((c) => c.id === ch.id);
    if (ch && ch.apiKey === '__KEEP__') {
      ch = { ...ch, apiKey: saved ? store.decryptKey(saved.apiKeyEnc) : '' };
    }
    if (ch && ch.secretAccessKey === '__KEEP__') {
      ch = { ...ch, secretAccessKey: saved ? store.decryptKey(saved.secretAccessKeyEnc) : '' };
    }
    return queryChannel(ch);
  });
  ipcMain.handle('quota:get-results', () => usagePayload());
  ipcMain.handle('quota:poll-now', () => poller.pollNow());
  ipcMain.handle('open:official', (_e, channelId) => openOfficial(channelId));
  ipcMain.handle('usage:toggle', () => toggleUsage());
  ipcMain.handle('usage:close', () => { if (usageWin && !usageWin.isDestroyed()) usageWin.hide(); });

  ipcMain.handle('app:quit', () => app.quit());
}

function createTray() {
  const iconPath = path.join(__dirname, '../assets/icon.png');
  if (!fs.existsSync(iconPath)) return;
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 24, height: 24 }));
  tray.setToolTip('AI用量宠物');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示用量', click: toggleUsage },
    { label: '设置', click: openSettings },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('balloon-click', toggleUsage); // 点气泡直接看用量面板
}

app.whenReady().then(() => {
  store = new Store();
  app.setLoginItemSettings({ openAtLogin: !!store.settings.autoStart });

  spawnPetWindow();
  ensureUsageWin();
  ensureSettingsWin();

  setupIpc();
  createTray();

  poller = new Poller(store, broadcast);
  poller.start();

  // 轮询开始时让宠物进入"审查"状态（广播前由 poller 触发结果，这里仅结果态联动）
});

app.on('window-all-closed', () => {
  // 宠物应用：窗口都关了也常驻托盘，除非显式退出
});

app.on('before-quit', () => {
  if (store) store.saveNow();
  if (poller) poller.stop();
});

app.on('second-instance', () => {
  if (petWin) petWin.show();
});
