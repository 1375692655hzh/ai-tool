// 定时轮询所有渠道，结果持久化并广播给用量面板 / 宠物窗口
const { queryChannel } = require('./sniffer');

class Poller {
  /**
   * @param store  Store 实例
   * @param onUpdate  (results: {channelId: result}) => void
   */
  constructor(store, onUpdate) {
    this.store = store;
    this.onUpdate = onUpdate;
    this.timer = null;
    this.running = false;
  }

  start() {
    this.stop();
    const min = Math.max(Number(this.store.settings.pollIntervalMin) || 5, 0.5);
    this.timer = setInterval(() => this.pollNow(), min * 60 * 1000);
    this.pollNow();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  restart() { this.start(); }

  async pollNow() {
    if (this.running) return this.store.lastResults;
    this.running = true;
    const channels = this.store.getChannelsWithKeys();
    const results = { ...this.store.lastResults };
    await Promise.all(
      channels.map(async (ch) => {
        let r = await queryChannel(ch);
        if (r.ok && r.detectedType && r.detectedType !== ch.detectedType) {
          this.store.setDetectedType(ch.id, r.detectedType);
        }
        // 失败降级：保留上次成功数据，标注"刷新失败"，避免面板数据闪断
        const prev = this.store.lastResults[ch.id];
        if (!r.ok && prev && prev.ok) {
          r = { ...prev, stale: true, staleMessage: r.message, checkedAt: Date.now() };
        }
        this.store.setResult(ch.id, r);
        results[ch.id] = r;
      })
    );
    this.running = false;
    this.onUpdate(results);
    return results;
  }
}

module.exports = { Poller };
