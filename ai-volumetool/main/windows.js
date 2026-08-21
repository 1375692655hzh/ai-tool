// 三个窗口的创建与显隐：宠物窗（透明无边框）、用量面板、设置窗
const path = require('path');
const { BrowserWindow, screen } = require('electron');
const { petSizeFor } = require('./characters');

const FRAME_W = 192;
const FRAME_H = 208;

const PRELOAD = path.join(__dirname, 'preload.js');

function webPrefs() {
  return { preload: PRELOAD, contextIsolation: true, nodeIntegration: false };
}

function createPetWindow(store) {
  const { width: w, height: h } = petSizeFor(store.settings);
  const primary = screen.getPrimaryDisplay().workArea;
  const pos = store.petPosition || { x: primary.x + primary.width - w - 60, y: primary.y + primary.height - h - 60 };
  // 钳制到宠物所在显示器的工作区（可能是副屏），而不是死盯主屏
  const area = screen.getDisplayMatching({ x: pos.x, y: pos.y, width: w, height: h }).workArea;

  const win = new BrowserWindow({
    width: w,
    height: h,
    x: Math.min(Math.max(pos.x, area.x), area.x + area.width - w),
    y: Math.min(Math.max(pos.y, area.y), area.y + area.height - h),
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: webPrefs(),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenu(null);
  win.loadFile(path.join(__dirname, '../renderer/pet/index.html'));
  return win;
}

function createUsageWindow(store) {
  // 高度由渲染器按内容量好后经 usage:fit-height 上报贴合（这里只是初始占位）
  const win = new BrowserWindow({
    width: 260,
    height: 200,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#f6f8fb',
    webPreferences: webPrefs(),
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, '../renderer/usage/index.html'));
  // 不做失焦自动隐藏：点击别处保持显示，用标题栏 X / 右键 显示用量 开关收起
  return win;
}

/** 用量面板贴着宠物弹出：优先左侧，空间不足放右侧 */
function placeUsageNearPet(usageWin, petWin) {
  const pb = petWin.getBounds();
  const area = screen.getDisplayMatching(pb).workArea;
  const [w, h] = usageWin.getSize();
  let x = pb.x - w - 12;
  if (x < area.x) x = pb.x + pb.width + 12;
  if (x + w > area.x + area.width) x = area.x + area.width - w;
  let y = pb.y + pb.height - h;
  y = Math.min(Math.max(y, area.y), area.y + area.height - h);
  usageWin.setPosition(Math.round(x), Math.round(y));
}

function createSettingsWindow() {
  const win = new BrowserWindow({
    width: 620,
    height: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    title: '设置 - AI用量宠物',
    webPreferences: webPrefs(),
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, '../renderer/settings/index.html'));
  return win;
}

module.exports = { createPetWindow, createUsageWindow, createSettingsWindow, placeUsageNearPet };
