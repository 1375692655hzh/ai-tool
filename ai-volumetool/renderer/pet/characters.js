// 角色渲染器：按 character.json 的 type 分发三种实现，对外统一 Animator 接口
//   spritesheet — canvas drawImage 网格精灵图（默认鲸鱼娘 / 奔跑小鱼）
//   video       — 透明 webm 逐状态播放（dsh-pet 51 动作）
//   static      — 静态立绘按状态换图 + CSS 呼吸浮动（pet-app 服装 / 鲸鱼挂件）
// 统一接口：ready / play(name,{force,onFinish}) / setScale(s) / locked / state / destroy()
//   + contentBounds() -> {fx,fy,fw,fh}|null 实测不透明内容占比（供边界钳制消除"空气墙"）
//   + onContentBounds 回调：测量完成后触发（media 异步加载）

// 素材地址：主进程已把外置包素材解析为绝对 file:// URL（中文/空格名已编码）；
// 没有 base 的（内置鲸鱼娘）保持页面相对路径，交给浏览器自己解析
const mediaUrl = (base, f) => (base && !/^[a-z]+:\/\//i.test(f) ? `${base}/${f}` : f);

// 实测素材的不透明内容占比 {fx,fy,fw,fh}（相对窗口宽高）：
// 窗口盒 ≠ 可见形象（视频/精灵图四周常有透明 padding），
// 边界钳制若按窗口算，形象还没到屏幕边就被"空气墙"挡住。
// 缩到 ≤256px 扫 alpha，一次测量后缓存。
function measureAlphaBounds(draw, w, h, reuseCv) {
  try {
    const s = Math.min(1, 256 / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
    const cv = reuseCv || document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    const ctx = cv.getContext('2d');
    draw(ctx, cw, ch);
    const d = ctx.getImageData(0, 0, cw, ch).data;
    let minX = cw, minY = ch, maxX = -1, maxY = -1;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        if (d[(y * cw + x) * 4 + 3] > 16) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0 || maxX < minX) return null;
    return { fx: minX / cw, fy: minY / ch, fw: (maxX + 1 - minX) / cw, fh: (maxY + 1 - minY) / ch };
  } catch { return null; }
}

// —— 精灵图（canvas 网格）——
class SheetRenderer {
  constructor(el, cfg) {
    this.cfg = cfg;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pet-media';
    el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.scale = 1.5;
    this.state = 'idle';
    this.frame = 0;
    this.timer = null;
    this.onFinish = null;
    this._locked = false;
    this.img = new Image();
    this.img.src = mediaUrl(cfg.base, cfg.file);
    this.ready = this.img.decode().catch(() => {});
    this.ready.then(() => {
      this.setScale(this.scale);
      this.play('idle', { force: true });
      // 用 idle 行第一帧实测内容占比（其余帧差异通常可忽略）
      const st = cfg.states.idle || {};
      const b = measureAlphaBounds(
        (ctx, cw, ch) => ctx.drawImage(this.img, 0, (st.row || 0) * cfg.frameH, cfg.frameW, cfg.frameH, 0, 0, cw, ch),
        cfg.frameW, cfg.frameH
      );
      this._bounds = b;
      if (b && this.onContentBounds) this.onContentBounds(b);
    });
  }
  contentBounds() { return this._bounds || null; }
  setScale(s) {
    this.scale = s;
    const w = Math.round(this.cfg.width * s), h = Math.round(this.cfg.height * s);
    this.canvas.width = w; this.canvas.height = h;
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    this._draw(this.cfg.states[this.state]);
  }
  get locked() { return this._locked; }
  play(name, { force = false, onFinish = null } = {}) {
    const cfg = this.cfg.states[name];
    if (!cfg) return;
    if (this._locked && !force) return;
    this.state = name;
    this.frame = 0;
    this.onFinish = onFinish;
    this._locked = !cfg.loop;
    clearInterval(this.timer);
    this._draw(cfg);
    this.timer = setInterval(() => this._tick(), 1000 / cfg.fps);
  }
  _tick() {
    const cfg = this.cfg.states[this.state];
    this.frame++;
    if (this.frame >= cfg.frames) {
      if (cfg.loop) this.frame = 0;
      else {
        clearInterval(this.timer);
        this._locked = false;
        const cb = this.onFinish; this.onFinish = null;
        if (cb) cb(); else this.play('idle', { force: true });
        return;
      }
    }
    this._draw(cfg);
  }
  _draw(cfg) {
    if (!this.img.complete || !this.img.naturalWidth || !cfg) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(
      this.img,
      this.frame * this.cfg.frameW, cfg.row * this.cfg.frameH, this.cfg.frameW, this.cfg.frameH,
      0, 0, this.canvas.width, this.canvas.height
    );
  }
  destroy() { clearInterval(this.timer); this.canvas.remove(); }
}

// —— 透明 webm 视频：隐藏 <video> 解码 + rAF 逐帧画到 canvas ——
// 直接把 <video> 放进透明窗口，视频层不参与 alpha 合成（黑块/不渲染），canvas 通道稳定
class VideoRenderer {
  constructor(el, cfg) {
    this.cfg = cfg;
    this.scale = 1.5;
    this.state = 'idle';
    this.onFinish = null;
    this._locked = false;
    this._timer = null;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pet-media';
    el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.video = document.createElement('video'); // 不挂到 DOM，只做解码源
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.playsInline = true;
    // 构造时立刻挂上 idle 素材并起播：ready 等 loadeddata，而 src 只在 play() 里设，
    // 不先设 src 的话 ready 永远不 resolve，宠物会隐身到第一个外部 play 事件为止
    const idleSt = this.cfg.states.idle || {};
    const idleFile = idleSt.file || (idleSt.files || [])[0];
    if (idleFile) {
      this.video.loop = idleSt.loop !== false;
      this.video.src = mediaUrl(this.cfg.base, idleFile);
      this.video.play().catch(() => {});
    }
    // 足迹锚定：以首个 idle 片段（files[0]）的实测占比为整个会话的钳制基准，
    // 只在该片段播放时采样。各片段构图差异大（0.67~0.90 都有），若跟着当前片段变，
    // 贴墙距离会忽远忽近；锚定后贴墙距离恒定，宽片段在墙边播放时鲸鱼边缘短暂
    // 出画（透明画布裁切）——比 140px 空气墙好得多
    this._anchorClip = this._curClip = idleFile ? mediaUrl(this.cfg.base, idleFile) : null;
    this._sampleCv = null;
    this._lastSampleAt = 0;
    this._reportedBounds = null;
    this._lastReportAt = 0;
    const pump = () => {
      if (this.video.readyState >= 2 && this.video.videoWidth) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
        const now = Date.now();
        if (now - this._lastSampleAt > 500) {
          this._lastSampleAt = now;
          this._sampleFootprint();
        }
      }
      this._raf = requestAnimationFrame(pump);
    };
    this._raf = requestAnimationFrame(pump);
    this.ready = new Promise((res) => {
      this.video.onloadeddata = () => res();
      this.video.onerror = () => res();
    });
    this.video.addEventListener('ended', () => {
      this._locked = false;
      const cb = this.onFinish; this.onFinish = null;
      if (cb) cb(); else this.play('idle', { force: true });
    });
  }
  // 测锚定 idle 片段当前帧的占比并入足迹（只测锚定片段，其它片段播放时不采样）；
  // 比上次上报明显变大（>1%）且距上次上报 >3s 才再报
  _sampleFootprint() {
    try {
      if (this._curClip !== this._anchorClip) return;
      if (!this._sampleCv) this._sampleCv = document.createElement('canvas');
      const b = measureAlphaBounds(
        (ctx, cw, ch) => ctx.drawImage(this.video, 0, 0, cw, ch),
        this.video.videoWidth, this.video.videoHeight, this._sampleCv
      );
      if (!b) return;
      if (!this._bounds) {
        this._bounds = b;
        this._reportedBounds = { ...b };
        this._lastReportAt = Date.now();
        if (this.onContentBounds) this.onContentBounds(b);
        return;
      }
      const x1 = Math.max(this._bounds.fx + this._bounds.fw, b.fx + b.fw);
      const y1 = Math.max(this._bounds.fy + this._bounds.fh, b.fy + b.fh);
      this._bounds.fx = Math.min(this._bounds.fx, b.fx);
      this._bounds.fy = Math.min(this._bounds.fy, b.fy);
      this._bounds.fw = x1 - this._bounds.fx;
      this._bounds.fh = y1 - this._bounds.fy;
      const r = this._reportedBounds;
      const grown = this._bounds.fx < r.fx - 0.01 || this._bounds.fy < r.fy - 0.01
        || this._bounds.fx + this._bounds.fw > r.fx + r.fw + 0.01
        || this._bounds.fy + this._bounds.fh > r.fy + r.fh + 0.01;
      if (grown && Date.now() - this._lastReportAt > 3000) {
        this._reportedBounds = { ...this._bounds };
        this._lastReportAt = Date.now();
        if (this.onContentBounds) this.onContentBounds(this._bounds);
      }
    } catch { /* 采样失败不影响渲染 */ }
  }
  contentBounds() { return this._bounds || null; }
  setScale(s) {
    this.scale = s;
    const w = Math.round(this.cfg.width * s), h = Math.round(this.cfg.height * s);
    this.canvas.width = w; this.canvas.height = h;
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
  }
  get locked() { return this._locked; }
  // 视频时长不可控：非循环状态给一个兜底定时器（9s）保证解锁
  play(name, { force = false, onFinish = null } = {}) {
    const st = this.cfg.states[name];
    if (!st || !st.files || !st.files.length) return;
    if (this._locked && !force) return;
    const pick = st.files[Math.floor(Math.random() * st.files.length)];
    this.state = name;
    this.onFinish = onFinish;
    this._locked = !st.loop;
    this._curClip = mediaUrl(this.cfg.base, pick); // 足迹锚定不变，仅记录当前片段供采样判断
    clearTimeout(this._timer);
    if (!st.loop) this._timer = setTimeout(() => {
      if (this.state === name && this._locked) { // ended 没触发时的保险
        this._locked = false;
        const cb = this.onFinish; this.onFinish = null;
        if (cb) cb(); else this.play('idle', { force: true });
      }
    }, 9000);
    this.video.loop = !!st.loop;
    this.video.src = mediaUrl(this.cfg.base, pick);
    this.video.play().catch(() => {});
  }
  destroy() {
    cancelAnimationFrame(this._raf);
    clearTimeout(this._timer);
    this.video.pause();
    this.video.src = '';
    this.canvas.remove();
  }
}

// —— 静态立绘：换图 + 呼吸浮动 ——
class StaticRenderer {
  constructor(el, cfg) {
    this.cfg = cfg;
    this.scale = 1.5;
    this.state = 'idle';
    this.onFinish = null;
    this._locked = false;
    this._timer = null;
    this.img = document.createElement('img');
    this.img.className = 'pet-media';
    this.img.draggable = false;
    el.appendChild(this.img);
    // 同 VideoRenderer：构造时直接挂 idle 图，否则 ready 等 onload 而 src 未设，永远不渲染
    const idleSt = cfg.states.idle || {};
    const idleFile = idleSt.file || (idleSt.files || [])[0];
    if (idleFile) {
      this.img.classList.toggle('bob', !!idleSt.bob);
      this.img.src = mediaUrl(cfg.base, idleFile);
    }
    this.ready = new Promise((res) => {
      this.img.onload = () => res();
      this.img.onerror = () => res();
    });
    this.ready.then(() => {
      this.setScale(this.scale);
      this.play('idle', { force: true });
      const b = this.img.naturalWidth
        ? measureAlphaBounds((ctx, cw, ch) => ctx.drawImage(this.img, 0, 0, cw, ch), this.img.naturalWidth, this.img.naturalHeight)
        : null;
      this._bounds = b;
      if (b && this.onContentBounds) this.onContentBounds(b);
    });
  }
  contentBounds() { return this._bounds || null; }
  setScale(s) {
    this.scale = s;
    const w = Math.round(this.cfg.width * s), h = Math.round(this.cfg.height * s);
    this.img.style.width = w + 'px';
    this.img.style.height = h + 'px';
  }
  get locked() { return this._locked; }
  play(name, { force = false, onFinish = null } = {}) {
    const st = this.cfg.states[name];
    if (!st) return;
    const file = st.files && st.files.length ? st.files[Math.floor(Math.random() * st.files.length)] : st.file;
    if (!file) return;
    if (this._locked && !force) return;
    this.state = name;
    this.onFinish = onFinish;
    this._locked = !st.loop;
    clearTimeout(this._timer);
    this.img.classList.toggle('bob', !!st.bob);
    this.img.src = mediaUrl(this.cfg.base, file);
    if (!st.loop) this._timer = setTimeout(() => {
      this._locked = false;
      const cb = this.onFinish; this.onFinish = null;
      if (cb) cb(); else this.play('idle', { force: true });
    }, st.hold || 2500);
  }
  destroy() { clearTimeout(this._timer); this.img.remove(); }
}

function createCharacter(el, cfg) {
  if (cfg.type === 'video') return new VideoRenderer(el, cfg);
  if (cfg.type === 'static') return new StaticRenderer(el, cfg);
  return new SheetRenderer(el, cfg);
}

// 默认角色：随应用打包的鲸鱼娘精灵图
window.DEFAULT_CHARACTER = {
  id: 'whale-girl', name: '鲸鱼娘（默认）', type: 'spritesheet',
  width: 192, height: 208, frameW: 192, frameH: 208,
  file: '../../assets/spritesheet.webp',
  states: {
    idle:            { row: 0, frames: 6, fps: 7,  loop: true },
    'running-right': { row: 1, frames: 8, fps: 11, loop: true },
    'running-left':  { row: 2, frames: 8, fps: 11, loop: true },
    waving:          { row: 3, frames: 4, fps: 7,  loop: false },
    jumping:         { row: 4, frames: 5, fps: 8,  loop: false },
    failed:          { row: 5, frames: 8, fps: 7,  loop: false },
    waiting:         { row: 6, frames: 6, fps: 6,  loop: true },
    running:         { row: 7, frames: 6, fps: 11, loop: true },
    review:          { row: 8, frames: 6, fps: 7,  loop: true },
  },
};
window.createCharacter = createCharacter;
