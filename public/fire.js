/**
 * The slot catches fire as the round heats up.
 *
 * Canvas 2D, no dependency, no WebGL. A WebGL flame would mean shipping a
 * renderer into a WebView that is scored on how fast it loads, and WebGL
 * support inside mobile WebViews is patchy enough that a dead canvas was not
 * worth the risk.
 *
 * The flame is not decoration. Its height and colour are driven by how hot the
 * round is, so a bidding war is visible before anyone reads a number.
 */

const MAX_PARTICLES = 160;

export function createFire(canvas) {
  const ctx = canvas.getContext('2d', { alpha: true });
  const particles = [];
  let heat = 0;        // 0 quiet, 1 about to end
  let target = 0;
  let raf = null;
  let width = 0;
  let height = 0;

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    width = rect.width;
    height = rect.height;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawn() {
    // Cooler rounds get fewer, shorter, slower embers.
    const count = Math.round(heat * 6);
    for (let i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
      // Clustered toward the middle so it reads as a fire rather than a row of
      // dots: three samples averaged approximates a bell curve cheaply.
      const bias = (Math.random() + Math.random() + Math.random()) / 3;
      particles.push({
        x: bias * width,
        y: height + 6,
        vx: (Math.random() - 0.5) * 0.5,
        vy: -(1.1 + Math.random() * 2.6 * (0.5 + heat)),
        life: 1,
        decay: 0.009 + Math.random() * 0.014,
        r: 6 + Math.random() * (10 + heat * 16),
      });
    }
  }

  /** A warm bed of light along the bottom edge, under the rising tongues. */
  function drawBed() {
    const bed = ctx.createLinearGradient(0, height, 0, height - height * (0.3 + heat * 0.45));
    bed.addColorStop(0, `hsl(30 100% 58% / ${0.42 * heat})`);
    bed.addColorStop(0.5, `hsl(20 100% 52% / ${0.16 * heat})`);
    bed.addColorStop(1, 'hsl(14 100% 50% / 0)');
    ctx.fillStyle = bed;
    ctx.fillRect(0, 0, width, height);
  }

  function frame() {
    heat += (target - heat) * 0.05;
    ctx.clearRect(0, 0, width, height);

    if (heat > 0.02) {
      spawn();
      ctx.globalCompositeOperation = 'lighter';
      drawBed();

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy *= 0.985;
        p.life -= p.decay;
        if (p.life <= 0) { particles.splice(i, 1); continue; }

        // Yellow at the base, through orange, to a dim red as it dies.
        const hue = 8 + p.life * 46;
        const alpha = p.life * p.life * (0.42 + heat * 0.55);
        const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
        glow.addColorStop(0, `hsl(${hue} 100% 66% / ${alpha})`);
        glow.addColorStop(0.45, `hsl(${hue - 4} 100% 54% / ${alpha * 0.45})`);
        glow.addColorStop(1, `hsl(${hue} 100% 50% / 0)`);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (raf || reduced) return;
    resize();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = null;
    ctx.clearRect(0, 0, width, height);
  }

  addEventListener('resize', resize, { passive: true });
  // A backgrounded tab should not burn the phone's battery on a flame nobody sees.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') start(); else stop();
  });

  return {
    /** 0 is embers, 1 is roaring. */
    setHeat(value) {
      target = Math.max(0, Math.min(1, value));
      if (target > 0.02) start();
    },
    /** A short flare when a bump lands. */
    flare() {
      const was = target;
      target = 1;
      setTimeout(() => { target = was; }, 700);
    },
    start,
    stop,
    get reduced() { return reduced; },
  };
}

/**
 * How hot the round is, from the two things that make it tense: how far the
 * price has climbed above the floor, and how little time is left.
 */
export function heatFrom({ price, floor, endsIn, roundMs = 300_000, holder }) {
  if (!holder) return 0;
  const climb = Math.min(1, Math.log2(Math.max(1, price / floor)) / 4);
  const urgency = endsIn === null ? 0 : 1 - Math.min(1, endsIn / roundMs);
  return Math.min(1, 0.18 + climb * 0.5 + urgency * 0.55);
}
