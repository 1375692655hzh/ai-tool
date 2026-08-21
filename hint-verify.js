function cdp(wsUrl){const ws=new WebSocket(wsUrl);let id=0;const p=new Map();ws.addEventListener('message',e=>{const d=JSON.parse(e.data);if(d.id&&p.has(d.id)){p.get(d.id)(d.result);p.delete(d.id)}});const send=(m,pa={})=>new Promise(r=>{const i=++id;p.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:pa}))});return new Promise(r=>ws.addEventListener('open',()=>r({send,close:()=>ws.close()})))}
(async()=>{
  const list=await(await fetch('http://127.0.0.1:9225/json/list')).json();
  const pet=list.find(x=>x.type==='page'&&/pet/.test(x.url));
  const pc=await cdp(pet.webSocketDebuggerUrl);
  const r=await pc.send('Runtime.evaluate',{returnByValue:true,expression:`(()=>{
    const t=document.querySelector('.first-hint');
    const m=document.querySelector('.pet-media');const rr=m?m.getBoundingClientRect():null;
    let px=0;if(m&&m.tagName==='CANVAS'){try{const d=m.getContext('2d').getImageData(0,0,m.width,m.height).data;for(let i=3;i<d.length;i+=400)if(d[i]>8)px++}catch(e){}}
    return {hint:!!t,hintText:t?t.textContent:null,flag:localStorage.getItem('hint-rightclick'),
      petW:rr?Math.round(rr.width):0,opaque:px};})()`});
  console.log(JSON.stringify(r.result.value));
  pc.close();
})().catch(e=>console.error('ERR',e.message));
