#!/usr/bin/env node
// 一键运行时回归：拉起打包后的应用（CDP 调试端口），驱动真实 IPC 路径验证——
//   ① 宠物真实渲染（以媒体元素不透明像素 > 0 为准，而不是元素存在）
//   ② 用量面板可开、宽度合理、无横向溢出、高度贴合内容
//   ③ 渠道轮询有结果（无渠道则 SKIP）
//   ④ 所有角色逐个切换并回到原角色（每次切换后窗口重建，需重新找 pet 页面）
// 用法：node tools/verify.js [exe路径] [--port=9229]
// 要求 Node ≥ 22（原生 WebSocket）。会先结束已运行的「AI用量宠物」实例（单例锁），结束时不重启。
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='));
const PORT = portArg ? Number(portArg.slice(7)) : 9229;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findExe() {
  const arg = args.find((a) => !a.startsWith('--'));
  if (arg) return path.resolve(arg);
  const dist = path.join(__dirname, '..', 'dist');
  try {
    return fs.readdirSync(dist)
      .filter((f) => /^AI.*\.exe$/i.test(f) && !/setup|uninstall/i.test(f))
      .map((f) => path.join(dist, f))[0];
  } catch { return null; }
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const d = JSON.parse(e.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); }
  });
  const send = (m, pa = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: pa })); });
  return new Promise((res, rej) => {
    ws.addEventListener('open', () => res({ send, close: () => ws.close() }));
    ws.addEventListener('error', () => rej(new Error('ws connect fail')));
    setTimeout(() => rej(new Error('ws connect timeout')), 8000);
  });
}

async function pages() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  return list.filter((t) => t.type === 'page');
}
const ev = async (pc, expression) => {
  const r = await pc.send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression });
  return r && r.result && r.result.value;
};

// —— 断言采集 ——
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: ok ? 'PASS' : 'FAIL', detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + JSON.stringify(detail) : ''}`); };
const skip = (name, why) => { results.push({ name, ok: 'SKIP', detail: why }); console.log('SKIP  ' + name + '  ' + why); };

const PET_OPAQUE_JS = `(()=>{
  const m=document.querySelector('.pet-media'); if(!m) return {opaque:0};
  let px=0;
  try{
    let src=m;
    if(m.tagName==='IMG'){src=document.createElement('canvas');src.width=m.naturalWidth||1;src.height=m.naturalHeight||1;src.getContext('2d').drawImage(m,0,0)}
    const d=src.getContext('2d').getImageData(0,0,Math.min(src.width,500),Math.min(src.height,500)).data;
    for(let i=3;i<d.length;i+=400)if(d[i]>8)px++;
  }catch(e){}
  return {opaque:px};})()`;

(async () => {
  const exe = findExe();
  if (!exe) { console.error('找不到待测 exe：先 npm run dist，或传入路径'); process.exit(1); }
  console.log('target:', exe, '| port:', PORT);

  // 单例锁：先结束在跑的实例（进程名固定为 AI用量宠物.exe）
  try { execSync('taskkill /IM "AI用量宠物.exe" /F', { stdio: 'ignore' }); await sleep(1500); } catch {}
  spawn(exe, [`--remote-debugging-port=${PORT}`], { detached: true, stdio: 'ignore' }).unref();

  // 等 CDP 就绪
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) }); up = true; break; } catch { await sleep(1000); }
  }
  if (!up) { console.error('FAIL  CDP 未就绪（应用可能没起来）'); process.exit(1); }
  await sleep(2500);

  // ① 宠物渲染
  let pet = (await pages()).find((t) => /\/pet\//.test(t.url));
  let pc = await cdp(pet.webSocketDebuggerUrl);
  check('宠物渲染（不透明像素>0）', (await ev(pc, PET_OPAQUE_JS)).opaque > 0, await ev(pc, PET_OPAQUE_JS));
  pc.close();

  // ② 用量面板
  const usage = (await pages()).find((t) => /\/usage\//.test(t.url));
  const uc = await cdp(usage.webSocketDebuggerUrl);
  await ev(uc, `window.api.invoke('usage:toggle').then(()=>new Promise(r=>setTimeout(r,1500)))`);
  const panel = await ev(uc, `(()=>{
    const okCards=[...document.querySelectorAll('.card:not(.bad)')];
    const last=okCards[okCards.length-1];
    return { cards:document.querySelectorAll('.card').length,
      empty:!!document.querySelector('.empty'),
      winW:window.innerWidth, winH:window.innerHeight,
      hOverflow:document.documentElement.scrollWidth>window.innerWidth+1,
      fitBottom:last?Math.round(last.getBoundingClientRect().bottom):null };})()`);
  check('面板宽度合理', panel.winW >= 200 && panel.winW <= 400, { winW: panel.winW });
  check('面板无横向溢出', !panel.hOverflow);
  if (panel.cards > 0) {
    check('面板高度贴合内容', Math.abs((panel.fitBottom || 0) - panel.winH) <= 8, { fitBottom: panel.fitBottom, winH: panel.winH });
  } else {
    skip('面板高度贴合内容', '无渠道卡片');
  }

  // ③ 渠道轮询
  const polled = await ev(uc, `window.api.invoke('quota:poll-now').then(()=>new Promise(r=>setTimeout(r,8000))).then(()=>window.api.invoke('quota:get-results')).then(p=>({n:Object.keys(p.results||{}).length,ok:Object.values(p.results||{}).filter(v=>v&&v.ok).length}))`);
  if (polled.n > 0) check('渠道轮询有成功结果', polled.ok > 0, polled);
  else skip('渠道轮询', '本机未配置渠道');
  uc.close();

  // ④ 全角色切换（从设置页驱动，宠物页会被销毁重建）
  const settings = (await pages()).find((t) => /\/settings\//.test(t.url));
  const sc = await cdp(settings.webSocketDebuggerUrl);
  const chars = await ev(sc, `window.api.invoke('characters:list').then(l=>l.map(c=>c.id))`);
  const orig = await ev(sc, `window.api.invoke('settings:get').then(s=>s.character||'whale-girl')`);
  let allCharOk = true; const charDetail = [];
  for (const id of chars) {
    await ev(sc, `window.api.invoke('settings:save',{character:'${id}'}).then(()=>new Promise(r=>setTimeout(r,2200)))`);
    pet = (await pages()).find((t) => /\/pet\//.test(t.url));
    if (!pet) { allCharOk = false; charDetail.push(id + ':no-page'); continue; }
    pc = await cdp(pet.webSocketDebuggerUrl);
    const o = (await ev(pc, PET_OPAQUE_JS)).opaque;
    pc.close();
    const okChar = o > 0; if (!okChar) allCharOk = false;
    charDetail.push(id + ':' + o);
  }
  await ev(sc, `window.api.invoke('settings:save',{character:'${orig}'}).then(()=>new Promise(r=>setTimeout(r,2200)))`);
  sc.close();
  check(`全部角色切换渲染（${chars.length} 个，已还原 ${orig}）`, allCharOk, charDetail);

  // 汇总
  const fails = results.filter((r) => r.ok === 'FAIL').length;
  console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
  try { execSync('taskkill /IM "AI用量宠物.exe" /F', { stdio: 'ignore' }); } catch {}
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
