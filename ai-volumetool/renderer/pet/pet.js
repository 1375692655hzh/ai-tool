// 宠物主逻辑：角色渲染（可切换）+ 状态机 + 自主行为（散步/发呆）+ 主进程事件联动
(async function () {
  const el = document.getElementById('pet');

  function sizeWindowTo(cfg, scale) {
    el.style.width = Math.round(cfg.width * scale) + 'px';
    el.style.height = Math.round(cfg.height * scale) + 'px';
  }

  const config = await window.api.invoke('pet:ready');
  // 主进程对鲸鱼娘返回 character:null（渲染器自带内置配置），归一化成同一对象才能比较 id
  const resolveCharacter = (c) => (c && c.id && c.id !== 'whale-girl' ? c : window.DEFAULT_CHARACTER);
  let character = resolveCharacter(config.character);
  let scale = config.scale || 1.5;
  let animator = window.createCharacter(el, character);
  sizeWindowTo(character, scale);
  let workArea = config.workArea;

  // 内容占比上报：主进程的拖拽钳制按"可见形象"而非窗口盒计算（消除透明 padding 空气墙）
  function attachBounds(a) {
    a.onContentBounds = (b) => window.api.invoke('pet:content-bounds', b);
    if (a.contentBounds()) window.api.invoke('pet:content-bounds', a.contentBounds());
  }
  attachBounds(animator);

  // 首次启动提示：告诉新用户右键有菜单（localStorage 记一次即不再出现）
  try {
    if (!localStorage.getItem('hint-rightclick')) {
      const tip = document.createElement('div');
      tip.className = 'first-hint';
      tip.textContent = '👉 右键我';
      el.appendChild(tip);
      const dismiss = () => { tip.classList.add('fade'); setTimeout(() => tip.remove(), 700); };
      setTimeout(dismiss, 9000);
      el.addEventListener('contextmenu', dismiss, { once: true });
      localStorage.setItem('hint-rightclick', '1');
    }
  } catch { /* localStorage 不可用就算了 */ }

  // —— 交互 ——
  let lastActivity = Date.now();
  new window.PetInteraction(el, {
    onDragTo: (x, y) => window.api.invoke('pet:set-position', x, y),
    onDragStart: () => { if (animator.cfg.states.drag && !animator.locked) animator.play('drag'); },
    onDragEnd: () => { if (animator.state === 'drag') animator.play('idle', { force: true }); },
    onClick: () => animator.play('waving'),
    onDoubleClick: () => animator.play('jumping'),
    onContextMenu: () => window.api.invoke('pet:menu'),
    onUserActivity: () => { lastActivity = Date.now(); },
  });

  // —— 主进程联动 ——
  window.api.on('pet:play', (state) => animator.play(state));
  window.api.on('pet:config', (cfg) => {
    if (cfg.scale) scale = cfg.scale;
    if (cfg.workArea) workArea = cfg.workArea;
    const next = resolveCharacter(cfg.character);
    if (next.id !== character.id) {
      animator.destroy();
      character = next;
      animator = window.createCharacter(el, character);
      attachBounds(animator);
    }
    sizeWindowTo(character, scale);
    animator.setScale(scale);
  });

  // —— 自主行为：随机散步 + 久不互动发呆 ——
  const SCALE = () => animator.scale;

  function wander() {
    if (animator.locked || animator.state !== 'idle') return;
    const idleFor = Date.now() - lastActivity;
    if (idleFor > 3 * 60 * 1000 && Math.random() < 0.5) {
      animator.play('waiting'); // 发呆
      setTimeout(() => { if (animator.state === 'waiting') animator.play('idle', { force: true }); }, 8000);
      return;
    }
    const dir = Math.random() < 0.5 ? 'left' : 'right';
    const duration = 1500 + Math.random() * 2500;
    const speed = 2; // px / 100ms
    animator.play(`running-${dir}`);
    const step = dir === 'left' ? -speed : speed;
    // 边界按"可见形象"（内容占比）而非窗口盒算，不然透明 padding 会让宠物提前撞空气墙掉头
    const frac = animator.contentBounds() || { fx: 0, fy: 0, fw: 1, fh: 1 };
    const W = window.innerWidth;
    const leftLimit = workArea.x - frac.fx * W;
    const rightLimit = workArea.x + workArea.width - (frac.fx + frac.fw) * W;
    const mover = setInterval(() => {
      const x = window.screenX + step;
      if (x < leftLimit || x > rightLimit) {
        clearInterval(mover);
        animator.play('idle', { force: true });
        return;
      }
      window.api.invoke('pet:set-position', x, window.screenY);
    }, 100);
    setTimeout(() => {
      clearInterval(mover);
      if (animator.state.startsWith('running-')) animator.play('idle', { force: true });
    }, duration);
  }

  // 每 25~55 秒决定一次要不要动
  (function scheduleWander() {
    setTimeout(() => { wander(); scheduleWander(); }, 25000 + Math.random() * 30000);
  })();
})();
