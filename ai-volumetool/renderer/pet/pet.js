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
    }
    sizeWindowTo(character, scale);
    animator.setScale(scale);
  });

  // —— 自主行为：随机散步 + 久不互动发呆 ——
  const SCALE = () => animator.scale;
  const CHAR_W = () => character.width;

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
    const mover = setInterval(() => {
      const x = window.screenX + step;
      const w = CHAR_W() * SCALE();
      if (x < workArea.x || x > workArea.x + workArea.width - w) {
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
