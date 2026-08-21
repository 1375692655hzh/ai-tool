function cdp(wsUrl){const ws=new WebSocket(wsUrl);let id=0;const p=new Map();ws.addEventListener('message',e=>{const d=JSON.parse(e.data);if(d.id&&p.has(d.id)){p.get(d.id)(d.result);p.delete(d.id)}});const send=(m,pa={})=>new Promise(r=>{const i=++id;p.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:pa}))});return new Promise(r=>ws.addEventListener('open',()=>r({send,close:()=>ws.close()})))}
(async()=>{
  const list=await(await fetch('http://127.0.0.1:9225/json/list')).json();
  const pet=list.find(x=>x.type==='page'&&/pet/.test(x.url));
  const pc=await cdp(pet.webSocketDebuggerUrl);
  const r=await pc.send('Runtime.evaluate',{returnByValue:true,expression:`(()=>{
    localStorage.removeItem('hint-rightclick'); location.reload(); return 'reloading';})()`});
  await new Promise(r=>setTimeout(r,4000));
  const r2=await pc.send('Runtime.evaluate',{returnByValue:true,expression:`(()=>{
    const t=document.querySelector('.first-hint');
    return {hint:!!t,text:t?t.textContent:null,rect:t?JSON.stringify({w:Math.round(t.getBoundingClientRect().width),fit:t.getBoundingClientRect().width<=window.innerWidth}):null};})()`});
  console.log(JSON.stringify(r2.result.value));
  pc.close();
})().catch(e=>console.error('ERR',e.message));
