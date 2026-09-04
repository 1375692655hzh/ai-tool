// 所有窗口共用的 preload：只暴露受控的 IPC 通道
const { contextBridge, ipcRenderer } = require('electron');

const VALID_INVOKE = new Set([
  'pet:ready', 'pet:set-position', 'pet:menu', 'pet:content-bounds',
  'channels:get-for-settings', 'channels:save',
  'settings:get', 'settings:save',
  'channel:test', 'quota:get-results', 'quota:poll-now',
  'open:official', 'usage:toggle', 'usage:close', 'usage:fit-height', 'settings:open', 'settings:close', 'app:quit',
  'characters:list', 'tool:launch', 'bailian:relogin',
]);

const VALID_ON = new Set(['quota:update', 'pet:play', 'pet:config', 'channels:refresh']);

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, ...args) => {
    if (!VALID_INVOKE.has(channel)) return Promise.reject(new Error('非法通道: ' + channel));
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, cb) => {
    if (!VALID_ON.has(channel)) return;
    ipcRenderer.on(channel, (_e, ...args) => cb(...args));
  },
});
