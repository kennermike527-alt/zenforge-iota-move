const STORAGE_KEY = 'cursorAnimationEnabled';
const MOBILE_BREAKPOINT = 768;
const PARTICLE_POOL_SIZE = 100;
const HOVER_SELECTOR = 'button, a, [data-hover]';

class CursorAnimationEngine {
  constructor() {
    this.preferenceEnabled = this.readPreference();
    this.runtimeEnabled = false;

    this.canvas = null;
    this.ctx = null;
    this.rafId = 0;

    this.width = 0;
    this.height = 0;
    this.dpr = 1;

    const cx = (typeof window !== 'undefined' ? window.innerWidth : 0) / 2;
    const cy = (typeof window !== 'undefined' ? window.innerHeight : 0) / 2;

    this.target = { x: cx, y: cy };
    this.current = { x: cx, y: cy };

    this.particles = Array.from({ length: PARTICLE_POOL_SIZE }, () => this.makeParticle());
    this.nextParticleIndex = 0;

    this.isHovering = false;
    this.isOverCard = false;
    this.clickPulse = 0;
    this.lastMoveAt = 0;

    this.cardRects = [];
    this.lastCardRectSync = 0;

    this.toggleButton = null;

    this.boundMove = (event) => this.onPointerMove(event);
    this.boundDown = (event) => this.onPointerDown(event);
    this.boundResize = () => this.onResize();
    this.boundScroll = () => this.refreshCardRects(true);
    this.boundTick = () => this.tick();
  }

  makeParticle() {
    return {
      alive: false,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      life: 0,
      size: 0,
      alpha: 0,
    };
  }

  readPreference() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      if (value === null) return true;
      return value === '1' || value === 'true' || value === 'on';
    } catch {
      return true;
    }
  }

  writePreference(enabled) {
    try {
      localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
    } catch {}
  }

  canRun() {
    if (typeof window === 'undefined') return false;
    if (window.innerWidth < MOBILE_BREAKPOINT) return false;

    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    return finePointer.matches;
  }

  init({ toggleSelector } = {}) {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    window.addEventListener('mousemove', this.boundMove, { passive: true });
    window.addEventListener('mousedown', this.boundDown, { passive: true });
    window.addEventListener('resize', this.boundResize, { passive: true });
    window.addEventListener('scroll', this.boundScroll, { passive: true });

    if (toggleSelector) {
      this.bindToggle(toggleSelector);
    }

    this.syncRuntime();
  }

  bindToggle(selector) {
    const button = document.querySelector(selector);
    if (!button || button === this.toggleButton) {
      this.renderToggleLabel();
      return;
    }

    this.toggleButton = button;

    if (!button.dataset.cursorAnimationBound) {
      button.dataset.cursorAnimationBound = '1';
      button.addEventListener('click', () => {
        if (this.preferenceEnabled) {
          this.disableCursor();
        } else {
          this.enableCursor();
        }
      });
    }

    this.renderToggleLabel();
  }

  renderToggleLabel() {
    if (!this.toggleButton) return;

    const disabledByDevice = !this.canRun();
    if (disabledByDevice) {
      this.toggleButton.textContent = this.preferenceEnabled ? 'Cursor FX: Auto-Off (mobile)' : 'Cursor FX: Off';
      this.toggleButton.disabled = true;
      return;
    }

    this.toggleButton.disabled = false;
    this.toggleButton.textContent = `Cursor FX: ${this.preferenceEnabled ? 'On' : 'Off'}`;
  }

  enableCursor() {
    this.preferenceEnabled = true;
    this.writePreference(true);
    this.syncRuntime();
  }

  disableCursor() {
    this.preferenceEnabled = false;
    this.writePreference(false);
    this.syncRuntime();
  }

  syncRuntime() {
    const shouldRun = this.preferenceEnabled && this.canRun();
    if (shouldRun) {
      this.startRuntime();
    } else {
      this.stopRuntime();
    }

    this.renderToggleLabel();
  }

  startRuntime() {
    if (this.runtimeEnabled) return;

    this.runtimeEnabled = true;
    this.mountCanvas();
    this.resizeCanvas();
    this.refreshCardRects(true);
    this.lastMoveAt = performance.now();

    document.body.classList.add('cursor-animation-enabled');

    cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(this.boundTick);
  }

  stopRuntime() {
    if (!this.runtimeEnabled) {
      document.body.classList.remove('cursor-animation-enabled');
      this.unmountCanvas();
      return;
    }

    this.runtimeEnabled = false;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;

    document.body.classList.remove('cursor-animation-enabled');
    this.unmountCanvas();

    for (const particle of this.particles) {
      particle.alive = false;
      particle.life = 0;
      particle.alpha = 0;
    }
  }

  mountCanvas() {
    if (this.canvas) return;

    const canvas = document.createElement('canvas');
    canvas.className = 'cursor-canvas-overlay';
    canvas.setAttribute('aria-hidden', 'true');

    document.body.appendChild(canvas);

    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', {
      alpha: true,
      desynchronized: true,
    });
  }

  unmountCanvas() {
    if (!this.canvas) return;

    this.canvas.remove();
    this.canvas = null;
    this.ctx = null;
  }

  onResize() {
    this.syncRuntime();
    if (this.runtimeEnabled) this.resizeCanvas();
    this.refreshCardRects(true);
  }

  resizeCanvas() {
    if (!this.canvas || !this.ctx) return;

    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  refreshCardRects(force = false) {
    if (typeof document === 'undefined') return;

    const now = performance.now();
    if (!force && now - this.lastCardRectSync < 140) return;
    this.lastCardRectSync = now;

    this.cardRects = Array.from(document.querySelectorAll('.card'))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 4 && r.height > 4)
      .map((r) => ({
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
      }));
  }

  emitCardEntryBounce(cardEl, pointerX, pointerY) {
    if (!cardEl || !this.runtimeEnabled) return;

    const rect = cardEl.getBoundingClientRect();
    const dl = Math.abs(pointerX - rect.left);
    const dr = Math.abs(rect.right - pointerX);
    const dt = Math.abs(pointerY - rect.top);
    const db = Math.abs(rect.bottom - pointerY);

    const min = Math.min(dl, dr, dt, db);

    let impactX = pointerX;
    let impactY = pointerY;
    let nx = 0;
    let ny = 0;

    if (min === dl) {
      impactX = rect.left;
      nx = -1;
    } else if (min === dr) {
      impactX = rect.right;
      nx = 1;
    } else if (min === dt) {
      impactY = rect.top;
      ny = -1;
    } else {
      impactY = rect.bottom;
      ny = 1;
    }

    this.spawnDirectionalBurst(impactX, impactY, nx, ny, 14);
  }

  spawnDirectionalBurst(x, y, nx, ny, count = 12) {
    const baseAngle = Math.atan2(ny, nx);

    for (let i = 0; i < count; i += 1) {
      const particle = this.nextParticle();
      const spread = (Math.random() - 0.5) * 0.9;
      const angle = baseAngle + spread;
      const speed = 1.15 + Math.random() * 1.45;

      particle.alive = true;
      particle.x = x;
      particle.y = y;
      particle.vx = Math.cos(angle) * speed;
      particle.vy = Math.sin(angle) * speed;
      particle.life = 1;
      particle.size = 6 + Math.random() * 9;
      particle.alpha = 1;
    }
  }

  onPointerMove(event) {
    this.target.x = event.clientX;
    this.target.y = event.clientY;
    this.lastMoveAt = performance.now();

    this.refreshCardRects();

    const targetEl = event.target;
    const cardEl = targetEl && targetEl.closest ? targetEl.closest('.card') : null;
    const wasOverCard = this.isOverCard;

    this.isHovering = Boolean(targetEl && targetEl.closest && targetEl.closest(HOVER_SELECTOR));
    this.isOverCard = Boolean(cardEl);

    if (this.runtimeEnabled && this.isOverCard && !wasOverCard) {
      this.emitCardEntryBounce(cardEl, event.clientX, event.clientY);
    }

    if (!this.runtimeEnabled || this.isOverCard) return;

    const spawnCount = this.isHovering ? this.randomInt(3, 5) : this.randomInt(2, 4);
    this.spawnParticles(spawnCount, this.current.x, this.current.y);
  }

  onPointerDown(event) {
    this.target.x = event.clientX;
    this.target.y = event.clientY;
    this.lastMoveAt = performance.now();
    this.clickPulse = 1;

    if (!this.runtimeEnabled || this.isOverCard) return;

    this.spawnParticles(10, this.current.x, this.current.y, 1.8);
  }

  randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  nextParticle() {
    for (let i = 0; i < this.particles.length; i += 1) {
      this.nextParticleIndex = (this.nextParticleIndex + 1) % this.particles.length;
      const particle = this.particles[this.nextParticleIndex];
      if (!particle.alive) return particle;
    }

    this.nextParticleIndex = (this.nextParticleIndex + 1) % this.particles.length;
    return this.particles[this.nextParticleIndex];
  }

  spawnParticles(count, x, y, speedBoost = 1) {
    for (let i = 0; i < count; i += 1) {
      const particle = this.nextParticle();

      const angle = Math.random() * Math.PI * 2;
      const speed = (0.45 + Math.random() * 1.2) * speedBoost * (this.isHovering ? 1.12 : 1);

      particle.alive = true;
      particle.x = x;
      particle.y = y;
      particle.vx = Math.cos(angle) * speed;
      particle.vy = Math.sin(angle) * speed;
      particle.life = 1;
      particle.size = 7 + Math.random() * 8;
      particle.alpha = 1;
    }
  }

  drawGradientCircle(x, y, radius, alpha) {
    if (!this.ctx || radius <= 0 || alpha <= 0) return;

    const gradient = this.ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, `rgba(175, 245, 255, ${0.4 * alpha})`);
    gradient.addColorStop(0.36, `rgba(114, 203, 255, ${0.24 * alpha})`);
    gradient.addColorStop(1, 'rgba(70, 110, 255, 0)');

    this.ctx.fillStyle = gradient;
    this.ctx.beginPath();
    this.ctx.arc(x, y, radius, 0, Math.PI * 2);
    this.ctx.fill();
  }

  resolveCardCollision(particle, nextX, nextY) {
    for (const rect of this.cardRects) {
      if (nextX <= rect.left || nextX >= rect.right || nextY <= rect.top || nextY >= rect.bottom) continue;

      const dl = Math.abs(nextX - rect.left);
      const dr = Math.abs(rect.right - nextX);
      const dt = Math.abs(nextY - rect.top);
      const db = Math.abs(rect.bottom - nextY);
      const min = Math.min(dl, dr, dt, db);

      if (min === dl) {
        particle.vx = -Math.abs(particle.vx) * 0.86;
        particle.vy *= 0.92;
        nextX = rect.left - 0.8;
      } else if (min === dr) {
        particle.vx = Math.abs(particle.vx) * 0.86;
        particle.vy *= 0.92;
        nextX = rect.right + 0.8;
      } else if (min === dt) {
        particle.vy = -Math.abs(particle.vy) * 0.86;
        particle.vx *= 0.92;
        nextY = rect.top - 0.8;
      } else {
        particle.vy = Math.abs(particle.vy) * 0.86;
        particle.vx *= 0.92;
        nextY = rect.bottom + 0.8;
      }

      particle.life -= 0.03;
      break;
    }

    return { x: nextX, y: nextY };
  }

  maskCards() {
    if (!this.ctx || !this.cardRects.length) return;

    this.ctx.globalCompositeOperation = 'destination-out';
    this.ctx.fillStyle = 'rgba(0,0,0,0.62)';

    for (const rect of this.cardRects) {
      const x = Math.floor(rect.left) - 1;
      const y = Math.floor(rect.top) - 1;
      const w = Math.ceil(rect.right - rect.left) + 2;
      const h = Math.ceil(rect.bottom - rect.top) + 2;
      this.ctx.fillRect(x, y, w, h);
    }
  }

  tick() {
    if (!this.runtimeEnabled || !this.ctx || !this.canvas) return;

    this.refreshCardRects();

    this.current.x += (this.target.x - this.current.x) * 0.12;
    this.current.y += (this.target.y - this.current.y) * 0.12;

    this.ctx.globalCompositeOperation = 'destination-out';
    this.ctx.fillStyle = 'rgba(0,0,0,0.08)';
    this.ctx.fillRect(0, 0, this.width, this.height);

    this.ctx.globalCompositeOperation = 'lighter';

    for (const particle of this.particles) {
      if (!particle.alive) continue;

      let nextX = particle.x + particle.vx;
      let nextY = particle.y + particle.vy;
      const adjusted = this.resolveCardCollision(particle, nextX, nextY);
      nextX = adjusted.x;
      nextY = adjusted.y;

      particle.x = nextX;
      particle.y = nextY;
      particle.life -= 0.02;

      if (particle.life <= 0) {
        particle.alive = false;
        continue;
      }

      particle.alpha = particle.life;
      particle.size *= 0.98;

      this.drawGradientCircle(particle.x, particle.y, particle.size, particle.alpha);
    }

    const idleMs = performance.now() - this.lastMoveAt;
    let idleScale = 1;
    if (idleMs > 2000) {
      idleScale = Math.max(0.18, 1 - (idleMs - 2000) / 2500);
    }

    if (!this.isOverCard) {
      let baseRadius = 24;
      if (this.isHovering) baseRadius *= 1.4;

      if (this.clickPulse > 0.001) {
        baseRadius *= 1 - this.clickPulse * 0.22;
        this.clickPulse *= 0.82;
      } else {
        this.clickPulse = 0;
      }

      this.drawGradientCircle(this.current.x, this.current.y, baseRadius, 0.95 * idleScale);
      this.drawGradientCircle(this.current.x, this.current.y, baseRadius * 0.58, 0.72 * idleScale);
    } else {
      this.clickPulse = 0;
    }

    this.maskCards();

    this.rafId = requestAnimationFrame(this.boundTick);
  }
}

let engine = null;

function getEngine() {
  if (!engine) {
    engine = new CursorAnimationEngine();
  }
  return engine;
}

export function initCursorAnimation(options = {}) {
  const instance = getEngine();
  instance.init(options);
  return {
    enableCursor,
    disableCursor,
  };
}

export function enableCursor() {
  getEngine().enableCursor();
}

export function disableCursor() {
  getEngine().disableCursor();
}

if (typeof window !== 'undefined') {
  window.enableCursor = enableCursor;
  window.disableCursor = disableCursor;
}
