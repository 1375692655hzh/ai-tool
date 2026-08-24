// 配置持久化：channels / settings / 轮询缓存，APIKEY 用 safeStorage 加密落盘
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULTS = {
  channels: [],          // {id,name,baseUrl,apiKeyEnc,endpointPath,fieldMapping,totalOverride,detectedType}
  settings: {
    pollIntervalMin: 5, scale: 1.5, autoStart: false,
    // 宠物右键「启动工具」列表：type app=直接启动程序 / term=开终端窗口运行 CLI。
    // 默认留空（每个人装的 AI 工具不同），在 设置 → 偏好 → 启动工具 里自行添加
    launchTools: [],
  },
  lastResults: {},       // channelId -> 最近一次查询结果（启动时立即可显示）
  petPosition: null,     // {x,y}
  reminders: {},         // 低额度提醒去重：key(channelId|窗口|重置周期) -> 已提醒时间戳
};

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'config.json');
    this.data = structuredClone(DEFAULTS);
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = { ...structuredClone(DEFAULTS), ...raw, settings: { ...DEFAULTS.settings, ...(raw.settings || {}) } };
      }
    } catch (e) {
      console.error('读取配置失败，使用默认配置:', e);
    }
    this._saveTimer = null;
  }

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
      catch (e) { console.error('写入配置失败:', e); }
    }, 200);
  }

  saveNow() {
    clearTimeout(this._saveTimer);
    try { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
    catch (e) { console.error('写入配置失败:', e); }
  }

  get settings() { return this.data.settings; }
  setSettings(patch) { Object.assign(this.data.settings, patch); this.save(); }

  get petPosition() { return this.data.petPosition; }
  setPetPosition(pos) { this.data.petPosition = pos; this.save(); }

  get channels() { return this.data.channels; }

  encryptKey(plain) {
    if (!plain) return '';
    try {
      if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(plain).toString('base64');
    } catch (e) { console.error('safeStorage 加密失败:', e); }
    return 'raw:' + plain;
  }

  decryptKey(stored) {
    if (!stored) return '';
    if (stored.startsWith('enc:')) {
      try { return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64')); }
      catch (e) { console.error('safeStorage 解密失败:', e); return ''; }
    }
    if (stored.startsWith('raw:')) return stored.slice(4);
    return stored; // 兼容旧数据
  }

  /** 返回给查询层使用的渠道（含解密后的 key / SK） */
  getChannelsWithKeys() {
    return this.data.channels.map((c) => ({
      ...c,
      apiKey: this.decryptKey(c.apiKeyEnc),
      secretAccessKey: this.decryptKey(c.secretAccessKeyEnc),
    }));
  }

  /** 设置页保存整份渠道列表；apiKey/secretAccessKey 为 '__KEEP__' 表示未修改 */
  saveChannels(list) {
    const oldById = new Map(this.data.channels.map((c) => [c.id, c]));
    this.data.channels = list.map((c) => {
      const old = oldById.get(c.id);
      return {
        id: c.id,
        name: c.name || '未命名渠道',
        vendor: c.vendor || 'auto',
        baseUrl: (c.baseUrl || '').trim(),
        apiKeyEnc: c.apiKey === '__KEEP__' ? (old ? old.apiKeyEnc : '') : this.encryptKey(c.apiKey || ''),
        accessKeyId: (c.accessKeyId || '').trim(),
        secretAccessKeyEnc: c.secretAccessKey === '__KEEP__' ? (old ? old.secretAccessKeyEnc : '') : this.encryptKey(c.secretAccessKey || ''),
        endpointPath: (c.endpointPath || '').trim(),
        officialUrl: (c.officialUrl || '').trim(),
        fieldMapping: c.fieldMapping || null,
        totalOverride: Number(c.totalOverride) > 0 ? Number(c.totalOverride) : null,
        detectedType: old && old.baseUrl === (c.baseUrl || '').trim() ? old.detectedType : null,
      };
    });
    this.save();
  }

  /** 设置页展示用：key/SK 不回传明文，用 '__KEEP__' 占位 */
  getChannelsForSettings() {
    return this.data.channels.map((c) => ({
      id: c.id, name: c.name, vendor: c.vendor || 'auto', baseUrl: c.baseUrl, apiKey: c.apiKeyEnc ? '__KEEP__' : '',
      accessKeyId: c.accessKeyId || '', secretAccessKey: c.secretAccessKeyEnc ? '__KEEP__' : '',
      endpointPath: c.endpointPath, officialUrl: c.officialUrl || '', fieldMapping: c.fieldMapping, totalOverride: c.totalOverride,
    }));
  }

  setResult(channelId, result) {
    const { ok, status, kind, note, windows, used, total, balance, currency, percent, message, stale, staleMessage, checkedAt } = result;
    this.data.lastResults[channelId] = { ok, status, kind, note, windows, used, total, balance, currency, percent, message, stale, staleMessage, checkedAt, updatedAt: result.updatedAt };
    this.save();
  }

  get lastResults() { return this.data.lastResults; }

  setDetectedType(channelId, type) {
    const c = this.data.channels.find((x) => x.id === channelId);
    if (c) { c.detectedType = type; this.save(); }
  }

  /** 低额度提醒去重：同一渠道同一重置周期只提醒一次（resetAt 变化即视为新周期） */
  hasReminded(key) { return Object.prototype.hasOwnProperty.call(this.data.reminders, key); }

  markReminded(key) {
    const now = Date.now();
    // 顺手清掉 45 天前的旧周期记录，防止长期使用后无限膨胀
    for (const k of Object.keys(this.data.reminders)) {
      if (now - this.data.reminders[k] > 45 * 86400000) delete this.data.reminders[k];
    }
    this.data.reminders[key] = now;
    this.save();
  }
}

module.exports = { Store };
