// 统一出站 HTTP：Electron 主进程里优先 net.fetch（Chromium 网络栈，自动遵循
// 系统代理/PAC——国内环境下 Google 等被墙域名必须走系统代理才通，Node 原生
// fetch 不读系统代理）；net.fetch 网络层失败时回退 Node 直连兜底（覆盖
// 「系统代理开关残留但代理进程没在跑」的场景）。纯 Node 环境（测试脚本）里
// 退化为 global fetch，行为不变。
let electronNetFetch = null;
try {
  if (process.versions.electron) {
    const { net } = require('electron');
    if (net && typeof net.fetch === 'function') electronNetFetch = net.fetch;
  }
} catch { /* 拿不到 electron 模块就当纯 Node 用 */ }

async function smartFetch(url, opts) {
  if (electronNetFetch) {
    let netErr = null;
    try {
      return await electronNetFetch(url, opts);
    } catch (e) {
      netErr = e; // 落到直连重试；两边都挂时优先报直连的错误（更接近用户直觉）
    }
  }
  try {
    return await globalThis.fetch(url, opts);
  } catch (e) {
    if (netErr) e.message = String(e.message) + '（经系统代理亦失败: ' + String(netErr.message || netErr) + '）';
    throw e;
  }
}

module.exports = { smartFetch };
