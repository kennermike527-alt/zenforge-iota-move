const dot = document.querySelector('#cursorDot');
const glow = document.querySelector('#cursorGlow');

if (dot && glow && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
  let x = window.innerWidth / 2;
  let y = window.innerHeight / 2;
  let gx = x;
  let gy = y;

  const move = (e) => {
    x = e.clientX;
    y = e.clientY;
    dot.style.left = `${x}px`;
    dot.style.top = `${y}px`;
  };

  const tick = () => {
    gx += (x - gx) * 0.18;
    gy += (y - gy) * 0.18;
    glow.style.left = `${gx}px`;
    glow.style.top = `${gy}px`;
    requestAnimationFrame(tick);
  };

  const setActive = (on) => {
    glow.style.width = on ? '48px' : '34px';
    glow.style.height = on ? '48px' : '34px';
    glow.style.borderColor = on ? 'rgba(143, 173, 255, 0.75)' : 'rgba(110, 255, 199, 0.55)';
    glow.style.background = on ? 'rgba(143, 173, 255, 0.12)' : 'rgba(110, 255, 199, 0.08)';
  };

  window.addEventListener('mousemove', move, { passive: true });
  document.querySelectorAll('a, button, .btn').forEach((el) => {
    el.addEventListener('mouseenter', () => setActive(true));
    el.addEventListener('mouseleave', () => setActive(false));
  });

  tick();
}
