const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { app, ipcMain, shell, dialog, Tray, Menu, nativeImage } = require('electron');
const { Store } = require('./store');
const { Poller } = require('./quota/poller');
const { queryChannel } = require('./quota/sniffer');
const { createPetWindow, createUsageWindow, createSettingsWindow, placeUsageNearPet } = require('./windows');
const { popupPetMenu } = require('./contextMenu');
const { listCharacters, loadCharacter, petSizeFor } = require('./characters');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let store;
let petWin, usageWin, settingsWin, tray, poller;

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
    const { screen } = require('electron');
    const size = petWin.getSize();
    // 钳制到所有显示器工作区的联合边界（而不是最近单个显示器），
    // 否则跨屏拖动时会在屏幕交界处撞"空气墙"
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const d of screen.getAllDisplays()) {
      const a = d.workArea;
      minX = Math.min(minX, a.x); minY = Math.min(minY, a.y);
      maxX = Math.max(maxX, a.x + a.width); maxY = Math.max(maxY, a.y + a.height);
    }
    const cx = Math.min(Math.max(x, minX), maxX - size[0]);
    const cy = Math.min(Math.max(y, minY), maxY - size[1]);
    petWin.setPosition(Math.round(cx), Math.round(cy));
    store.setPetPosition({ x: Math.round(cx), y: Math.round(cy) });
  });
  // 用量面板按内容自适应高度：渲染器量好自然高度上报，这里钳到工作区内再贴合
  ipcMain.handle('usage:fit-height', (_e, h) => {
    if (!usageWin || usageWin.isDestroyed()) return;
    const n = Math.round(Number(h) || 0);
    if (!(n > 0)) return;
    const { screen } = require('electron');
    const maxH = screen.getPrimaryDisplay().workArea.height - 40;
    const height = Math.min(Math.max(n, 120), maxH);
    const [w, curH] = usageWin.getSize();
    if (Math.abs(curH - height) <= 1) return;
    usageWin.setSize(w, height);
    if (usageWin.isVisible()) placeUsageNearPet(usageWin, petWin); // 高度变了重新贴宠物
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
