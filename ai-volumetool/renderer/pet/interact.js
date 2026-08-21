// 宠物交互：手动拖拽（保留点击事件）、单击、双击、右键
// 不用 -webkit-app-region: drag，因为它会吞掉单击/双击事件
class PetInteraction {
  /**
   * @param el       宠物元素
   * @param handlers { onDragTo(x,y), onDragStart, onDragEnd, onClick, onDoubleClick, onContextMenu, onUserActivity }
   */
  constructor(el, handlers) {
    this.el = el;
    this.h = handlers;
    this.dragging = false;
    this.moved = false;
    this.downAt = 0;

    el.addEventListener('mousedown', (e) => this._down(e));
    window.addEventListener('mousemove', (e) => this._move(e));
    window.addEventListener('mouseup', (e) => this._up(e));
    el.addEventListener('dblclick', () => { this._activity(); this.h.onDoubleClick(); });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._activity();
      this.h.onContextMenu();
    });
  }

  _activity() { if (this.h.onUserActivity) this.h.onUserActivity(); }

  _down(e) {
    if (e.button !== 0) return;
    this._activity();
    this.dragging = true;
    this.moved = false;
    this.downAt = Date.now();
    // screenX/Y 是屏幕绝对坐标，主进程据此 setPosition
    this.startScreenX = e.screenX;
    this.startScreenY = e.screenY;
    this.winX = window.screenX;
    this.winY = window.screenY;
    this.el.classList.add('dragging');
  }

  _move(e) {
    if (!this.dragging) return;
    const dx = e.screenX - this.startScreenX;
    const dy = e.screenY - this.startScreenY;
    if (!this.moved && Math.hypot(dx, dy) > 5) {
      this.moved = true;
      if (this.h.onDragStart) this.h.onDragStart();
    }
    if (this.moved) {
      this._activity();
      this.h.onDragTo(this.winX + dx, this.winY + dy);
    }
  }

  _up(e) {
    if (!this.dragging) return;
    this.dragging = false;
    this.el.classList.remove('dragging');
    if (this.moved && this.h.onDragEnd) this.h.onDragEnd();
    if (!this.moved && Date.now() - this.downAt < 300 && e.button === 0) {
      this._activity();
      this.h.onClick();
    }
  }
}

window.PetInteraction = PetInteraction;
