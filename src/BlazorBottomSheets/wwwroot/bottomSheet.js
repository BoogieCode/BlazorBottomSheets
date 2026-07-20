// BlazorBottomSheets interop module. One Sheet instance is created per open and
// disposed on close; the Blazor component owns the DOM lifecycle.

const SLOP_PX = 4;              // movement before a gesture is classified
const PROJECTION_MS = 160;      // how far ahead velocity projects the release position
const FLICK_VELOCITY = 0.5;     // px/ms; a decisive flick
const DISMISS_FLICK_VELOCITY = 0.7;
const SNAP_EPSILON = 1e-6;

let bodyLockCount = 0;
let savedBodyOverflow = '';
let savedBodyPaddingRight = '';
const openSheets = [];

function lockBodyScroll() {
  if (bodyLockCount++ !== 0) return;
  savedBodyOverflow = document.body.style.overflow;
  savedBodyPaddingRight = document.body.style.paddingRight;
  const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
  if (scrollbarWidth > 0) {
    const current = parseFloat(getComputedStyle(document.body).paddingRight) || 0;
    document.body.style.paddingRight = `${current + scrollbarWidth}px`;
  }
  document.body.style.overflow = 'hidden';
}

function unlockBodyScroll() {
  if (bodyLockCount === 0 || --bodyLockCount !== 0) return;
  document.body.style.overflow = savedBodyOverflow;
  document.body.style.paddingRight = savedBodyPaddingRight;
}

export function createSheet(container, sheet, content, dotNetRef, options) {
  return new Sheet(container, sheet, content, dotNetRef, options);
}

class Sheet {
  constructor(container, sheet, content, dotNetRef, options) {
    this.container = container;
    this.sheet = sheet;
    this.content = content;
    this.backdrop = container.querySelector('.bbs-backdrop');
    this.footer = container.querySelector('.bbs-footer');
    this.dotNetRef = dotNetRef;
    this.applyOptions(options);

    this.state = 'closed';      // closed | opening | open | closing
    this.dragState = 'idle';    // idle | pending | dragging | native
    this.disposed = false;
    this.animating = false;
    this.locked = false;
    this.closePromise = null;
    this.prevFocus = null;
    this.pointerId = null;
    this.samples = [];
    this.rafId = 0;
    this.pendingY = 0;
    this.dragTranslate = 0;

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onPointerCancel = this.onPointerCancel.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onBackdropClick = this.onBackdropClick.bind(this);
    this.onResize = this.onResize.bind(this);
    this.onTouchMove = (e) => {
      // Non-passive: cancelling the first touchmove is what actually suppresses
      // native scrolling once a gesture has been claimed as a sheet drag.
      if (this.dragState === 'dragging') e.preventDefault();
    };
    this.applyDragFrame = () => {
      this.rafId = 0;
      if (this.dragState === 'dragging') this.applyDrag(this.pendingY);
    };

    sheet.addEventListener('pointerdown', this.onPointerDown);
    // Move/up/cancel live on document: a mouse dragging upward leaves the sheet
    // immediately (no implicit capture for mouse pointers), so sheet-level
    // listeners would never see the gesture. The pointerId guard scopes them.
    document.addEventListener('pointermove', this.onPointerMove);
    document.addEventListener('pointerup', this.onPointerUp);
    document.addEventListener('pointercancel', this.onPointerCancel);
    sheet.addEventListener('touchmove', this.onTouchMove, { passive: false });
    document.addEventListener('keydown', this.onKeyDown);
    if (this.backdrop) this.backdrop.addEventListener('click', this.onBackdropClick);
    window.addEventListener('resize', this.onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', this.onResize);
  }

  applyOptions(options) {
    this.options = options || {};
    const sp = this.options.snapPoints;
    this.snapPoints = sp && sp.length ? [...sp].sort((a, b) => a - b) : null;
    this.maxSnap = this.snapPoints ? this.snapPoints[this.snapPoints.length - 1] : null;
  }

  updateOptions(options) {
    const previous = this.snapPoints;
    this.applyOptions(options);
    if (this.state !== 'open') return;
    if (this.dragState === 'idle') {
      const t = this.restingTranslatePx();
      this.setHiddenVars(t, t); // reflects a live PinFooter toggle
    }
    if (!this.snapPoints) return;
    if (JSON.stringify(previous) === JSON.stringify(this.snapPoints)) return;
    // Snap set changed while open: settle on the current snap if it survived, else the nearest.
    let target = this.snapPoints.find((s) => Math.abs(s - this.currentSnap) < SNAP_EPSILON);
    if (target === undefined) {
      target = this.snapPoints.reduce((a, b) =>
        Math.abs(b - this.currentSnap) < Math.abs(a - this.currentSnap) ? b : a);
    }
    this.settleTo(target);
  }

  // ---- open / close ----

  async open() {
    if (this.disposed || this.state !== 'closed') return;
    this.state = 'opening';
    this.currentSnap = this.snapPoints ? (this.options.initialSnapPoint ?? this.snapPoints[0]) : null;
    lockBodyScroll();
    this.locked = true;
    openSheets.push(this);
    this.prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The sheet renders at its hidden baseline (translateY(100%)); force a layout
    // so the transition below animates instead of jumping.
    this.sheet.getBoundingClientRect();
    this.container.classList.add('bbs-open');
    this.sheet.style.transform = this.restingTransform();
    const resting = this.restingTranslatePx();
    this.setHiddenVars(resting, resting);
    try { this.sheet.focus({ preventScroll: true }); } catch { /* ignore */ }
    await this.waitForSettle();
    if (this.state === 'opening') this.state = 'open';
  }

  close() {
    if (this.state === 'closed') return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.state = 'closing';
    this.cancelDragTracking();
    this.closePromise = (async () => {
      this.sheet.style.transform = 'translateY(100%)';
      this.setHiddenVars(0, 0); // footer rejoins the sheet on the way out
      this.container.classList.remove('bbs-open');
      await this.waitForSettle();
      this.state = 'closed';
      this.releaseGlobals();
    })();
    return this.closePromise;
  }

  async dismiss(reason) {
    if (this.state !== 'open') return;
    await this.close();
    if (!this.disposed && this.dotNetRef) {
      try {
        await this.dotNetRef.invokeMethodAsync('OnUserDismissedJs', this.options.generation ?? 0, reason);
      } catch { /* circuit torn down */ }
    }
  }

  async snapTo(snap) {
    if (this.disposed || this.state !== 'open' || !this.snapPoints) return;
    const match = this.snapPoints.find((s) => Math.abs(s - snap) < SNAP_EPSILON);
    if (match === undefined) return;
    this.cancelDragTracking();
    await this.settleTo(match);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelDragTracking();
    this.sheet.removeEventListener('pointerdown', this.onPointerDown);
    document.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerup', this.onPointerUp);
    document.removeEventListener('pointercancel', this.onPointerCancel);
    this.sheet.removeEventListener('touchmove', this.onTouchMove);
    document.removeEventListener('keydown', this.onKeyDown);
    if (this.backdrop) this.backdrop.removeEventListener('click', this.onBackdropClick);
    window.removeEventListener('resize', this.onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', this.onResize);
    this.releaseGlobals();
    this.dotNetRef = null;
  }

  releaseGlobals() {
    const i = openSheets.indexOf(this);
    if (i >= 0) openSheets.splice(i, 1);
    if (this.locked) {
      this.locked = false;
      unlockBodyScroll();
    }
    if (this.prevFocus && this.prevFocus.isConnected) {
      try { this.prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
    this.prevFocus = null;
  }

  // ---- global event handlers ----

  onKeyDown(e) {
    if (e.key !== 'Escape' || !this.options.closeOnEscape) return;
    if (this.state !== 'open' || this.animating) return;
    if (openSheets[openSheets.length - 1] !== this) return; // only the topmost sheet
    this.dismiss('escape');
  }

  onBackdropClick() {
    if (!this.options.closeOnBackdropClick || this.state !== 'open' || this.animating) return;
    this.dismiss('backdrop');
  }

  onResize() {
    if (this.disposed) return;
    // Resting positions are %-based, so they self-correct; just abort an in-flight drag.
    if (this.dragState === 'dragging' || this.dragState === 'pending') {
      this.cancelDragTracking();
      this.sheet.style.transform = this.restingTransform();
      const resting = this.restingTranslatePx();
      this.setHiddenVars(resting, resting);
    }
  }

  // ---- drag engine ----

  onPointerDown(e) {
    if (this.disposed || this.state !== 'open' || this.animating || !this.options.enableDrag) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.pointerId = e.pointerId;
    this.gestureStartY = e.clientY;
    this.inContent = this.content.contains(e.target);
    this.dragState = 'pending';
    this.samples = [[performance.now(), e.clientY]];
  }

  onPointerMove(e) {
    if (e.pointerId !== this.pointerId) return;
    if (this.dragState !== 'pending' && this.dragState !== 'dragging') return;
    if (this.dragState === 'pending') {
      const dy = e.clientY - this.gestureStartY;
      if (Math.abs(dy) < SLOP_PX) return;
      if (!this.shouldStartDrag(dy)) {
        this.dragState = 'native'; // native scroll owns the rest of this gesture
        return;
      }
      this.startDrag(e);
    }
    this.recordSample(e.clientY);
    this.pendingY = e.clientY;
    if (!this.rafId) this.rafId = requestAnimationFrame(this.applyDragFrame);
  }

  onPointerUp(e) {
    if (e.pointerId !== this.pointerId) return;
    const wasDragging = this.dragState === 'dragging';
    this.pointerId = null;
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    if (!wasDragging) {
      this.dragState = 'idle';
      return;
    }
    this.applyDrag(e.clientY);
    this.recordSample(e.clientY);
    this.finishDrag(this.velocity());
  }

  onPointerCancel(e) {
    if (e.pointerId !== this.pointerId) return;
    const wasDragging = this.dragState === 'dragging';
    this.pointerId = null;
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    if (wasDragging) this.finishDrag(0);
    else this.dragState = 'idle';
  }

  shouldStartDrag(dy) {
    if (!this.inContent) return true; // handle, header, footer always drag
    if (dy > 0) return this.content.scrollTop <= 0; // pull down only from the top
    return !!this.snapPoints && this.currentSnap < this.maxSnap - SNAP_EPSILON; // pull up to expand
  }

  startDrag(e) {
    this.dragState = 'dragging';
    this.dragStartY = e.clientY;
    this.baseTranslate = this.currentTranslatePx();
    this.dragTranslate = this.baseTranslate;
    try { this.sheet.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.container.classList.add('bbs-dragging');
  }

  applyDrag(clientY) {
    let y = this.baseTranslate + (clientY - this.dragStartY);
    if (y < 0) y = -this.rubberBand(-y);
    const hidden = this.sheet.offsetHeight;
    if (y > hidden) y = hidden;
    this.dragTranslate = y;
    this.sheet.style.transform = `translateY(${y}px)`;
    this.setHiddenVars(y); // per-frame: transform-only on the footer, no layout
  }

  finishDrag(v) {
    this.dragState = 'idle';
    this.container.classList.remove('bbs-dragging');
    if (this.snapPoints) this.settleSnap(this.dragTranslate, v);
    else this.settleAuto(this.dragTranslate, v);
  }

  settleAuto(y, v) {
    const h = this.sheet.offsetHeight;
    const shouldDismiss = v > FLICK_VELOCITY || (y > h * 0.5 && v > -0.05);
    if (shouldDismiss && this.options.allowSwipeDismiss) {
      this.dismiss('drag');
      return;
    }
    this.sheet.style.transform = 'translateY(0)';
  }

  settleSnap(y, v) {
    const ch = this.container.clientHeight || 1;
    const hidden = this.sheet.offsetHeight;
    const positions = this.snapPoints.map((s) => [s, (this.maxSnap - s) * ch]);
    const lowestY = positions[0][1]; // lowest snap = largest resting translate
    const projected = y + v * PROJECTION_MS;
    const atLowest = Math.abs(this.currentSnap - this.snapPoints[0]) < SNAP_EPSILON;
    if (this.options.allowSwipeDismiss &&
        (projected > lowestY + (hidden - lowestY) * 0.5 || (v > DISMISS_FLICK_VELOCITY && atLowest))) {
      this.dismiss('drag');
      return;
    }

    let best = positions[0];
    for (const p of positions) {
      if (Math.abs(p[1] - projected) < Math.abs(best[1] - projected)) best = p;
    }
    // A decisive flick always moves at least one snap in its direction.
    if (Math.abs(v) > FLICK_VELOCITY && Math.abs(best[0] - this.currentSnap) < SNAP_EPSILON) {
      const idx = this.snapPoints.findIndex((s) => Math.abs(s - this.currentSnap) < SNAP_EPSILON);
      if (v > 0 && idx > 0) best = positions[idx - 1];
      else if (v < 0 && idx >= 0 && idx < positions.length - 1) best = positions[idx + 1];
    }
    this.settleTo(best[0]);
  }

  async settleTo(snap) {
    const previous = this.currentSnap;
    this.currentSnap = snap;
    this.animating = true;
    this.sheet.style.transform = this.restingTransform();
    const resting = this.restingTranslatePx();
    this.setHiddenVars(resting, resting);
    await this.waitForSettle();
    this.animating = false;
    if (!this.disposed && this.dotNetRef && Math.abs(snap - previous) > SNAP_EPSILON) {
      try {
        await this.dotNetRef.invokeMethodAsync('OnSnapChangedJs', this.options.generation ?? 0, snap);
      } catch { /* circuit torn down */ }
    }
  }

  cancelDragTracking() {
    this.pointerId = null;
    this.dragState = 'idle';
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    this.container.classList.remove('bbs-dragging');
  }

  // ---- helpers ----

  restingTransform() {
    if (!this.snapPoints) return 'translateY(0)';
    const pct = (1 - this.currentSnap / this.maxSnap) * 100;
    return `translateY(${pct}%)`;
  }

  restingTranslatePx() {
    if (!this.snapPoints) return 0;
    return (this.maxSnap - this.currentSnap) * (this.container.clientHeight || 0);
  }

  pinActive() {
    return !!(this.options.pinFooter && this.footer && this.snapPoints);
  }

  // --bbs-hidden drives the footer's counter-translation (updated per frame while dragging);
  // --bbs-hidden-settled pads the content's scroll end (updated only when the sheet settles,
  // because padding changes trigger layout).
  setHiddenVars(px, settledPx) {
    const active = this.pinActive();
    this.sheet.style.setProperty('--bbs-hidden', `${active ? Math.max(0, px) : 0}px`);
    if (settledPx !== undefined) {
      this.sheet.style.setProperty('--bbs-hidden-settled', `${active ? Math.max(0, settledPx) : 0}px`);
    }
  }

  currentTranslatePx() {
    const t = getComputedStyle(this.sheet).transform;
    if (!t || t === 'none') return 0;
    return new DOMMatrixReadOnly(t).m42;
  }

  rubberBand(overshoot) {
    const c = (this.container.clientHeight || 600) * 0.12;
    return c * (1 - 1 / (overshoot / c + 1));
  }

  recordSample(y) {
    this.samples.push([performance.now(), y]);
    if (this.samples.length > 12) this.samples.shift();
  }

  velocity() {
    const now = performance.now();
    const recent = this.samples.filter(([t]) => now - t <= 120);
    if (recent.length < 2) return 0;
    const [t0, y0] = recent[0];
    const [t1, y1] = recent[recent.length - 1];
    return t1 > t0 ? (y1 - y0) / (t1 - t0) : 0; // px/ms, positive = downward
  }

  transitionMs() {
    const raw = getComputedStyle(this.sheet).transitionDuration.split(',')[0].trim();
    const ms = raw.endsWith('ms') ? parseFloat(raw) : parseFloat(raw) * 1000;
    return Number.isFinite(ms) ? ms : 300;
  }

  waitForSettle() {
    return new Promise((resolve) => {
      const el = this.sheet;
      let done = false;
      let timer = 0;
      const finish = () => {
        if (done) return;
        done = true;
        el.removeEventListener('transitionend', onEnd);
        clearTimeout(timer);
        resolve();
      };
      const onEnd = (e) => {
        if (e.target === el && e.propertyName === 'transform') finish();
      };
      el.addEventListener('transitionend', onEnd);
      timer = setTimeout(finish, this.transitionMs() + 120);
    });
  }
}
