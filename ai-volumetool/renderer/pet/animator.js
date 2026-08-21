// 精灵图帧动画播放器（canvas drawImage 版）
// 用 canvas 而不是 CSS background：Chromium 在透明窗口里渲染大图背景会截断，drawImage 则完整可靠
const FRAME_W = 192;
const FRAME_H = 208;

const STATES = {
  idle:            { row: 0, frames: 6, fps: 7,  loop: true },
  'running-right': { row: 1, frames: 8, fps: 11, loop: true },
  'running-left':  { row: 2, frames: 8, fps: 11, loop: true },
  waving:          { row: 3, frames: 4, fps: 7,  loop: false },
  jumping:         { row: 4, frames: 5, fps: 8,  loop: false },
  failed:          { row: 5, frames: 8, fps: 7,  loop: false },
  waiting:         { row: 6, frames: 6, fps: 6,  loop: true },
  running:         { row: 7, frames: 6, fps: 11, loop: true },
  review:          { row: 8, frames: 6, fps: 7,  loop: true },
};

class Animator {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 1.5;
    this.state = 'idle';
    this.frame = 0;
    this.timer = null;
    this.onFinish = null;
    this._locked = false; // 一次性动画播放期间锁定，避免被行为循环打断
    this.img = new Image();
    this.img.src = '../../assets/spritesheet.webp';
    this.ready = this.img.decode().catch(() => {}); // 解码完成后再播，避免首帧空白
    this.ready.then(() => { this.setScale(this.scale); this.play('idle', { force: true }); });
  }

  // 缩放直接体现在画布缓冲尺寸上（1:1 对应窗口），不用 CSS transform，避开合成器缩放层的渲染问题
  setScale(s) {
    this.scale = s;
    this.canvas.width = Math.round(FRAME_W * s);
    this.canvas.height = Math.round(FRAME_H * s);
    this.canvas.style.width = this.canvas.width + 'px';
    this.canvas.style.height = this.canvas.height + 'px';
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    this._draw(STATES[this.state]);
  }

  get locked() { return this._locked; }

  play(name, { force = false, onFinish = null } = {}) {
    if (!STATES[name]) return;
    if (this._locked && !force) return;
    const cfg = STATES[name];
    this.state = name;
    this.frame = 0;
    this.onFinish = onFinish;
    this._locked = !cfg.loop;
    clearInterval(this.timer);
    this._draw(cfg);
    this.timer = setInterval(() => this._tick(), 1000 / cfg.fps);
  }

  _tick() {
    const cfg = STATES[this.state];
    this.frame++;
    if (this.frame >= cfg.frames) {
      if (cfg.loop) {
        this.frame = 0;
      } else {
        clearInterval(this.timer);
        this._locked = false;
        const cb = this.onFinish;
        this.onFinish = null;
        if (cb) cb();
        else this.play('idle', { force: true });
        return;
      }
    }
    this._draw(cfg);
  }

  _draw(cfg) {
    if (!this.img.complete || !this.img.naturalWidth) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.drawImage(
      this.img,
      this.frame * FRAME_W, cfg.row * FRAME_H, FRAME_W, FRAME_H,
      0, 0, w, h
    );
  }
}

window.Animator = Animator;
window.PET_STATES = STATES;
