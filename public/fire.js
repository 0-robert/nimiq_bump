/**
 * The slot catches fire as the day heats up.
 *
 * Heat diffusion on a low resolution buffer, the way fire was done before
 * shaders: seed the bottom row hot, and every cell above takes the cell below
 * it minus a little randomness, drifting sideways as it cools. Scaled up with
 * smoothing, that gives rising tongues that actually behave like flame.
 *
 * The first attempt used soft radial particles and read as floating blobs,
 * because a flame is a continuous field, not a crowd of dots.
 *
 * Canvas 2D on purpose. A WebGL flame would mean shipping a renderer into a
 * WebView that is scored on load speed, and WebGL support in mobile WebViews is
 * patchy enough that a dead canvas was a real risk.
 */

/** Classic fire ramp: near black, through red and orange, to white hot. */
const PALETTE = [
  [7, 7, 7], [31, 7, 7], [47, 15, 7], [71, 15, 7], [87, 23, 7], [103, 31, 7],
  [119, 31, 7], [143, 39, 7], [159, 47, 7], [175, 63, 7], [191, 71, 7], [199, 71, 7],
  [223, 79, 7], [223, 87, 7], [223, 87, 7], [215, 95, 7], [215, 95, 7], [215, 103, 15],
  [207, 111, 15], [207, 119, 15], [207, 127, 15], [207, 135, 23], [199, 135, 23],
  [199, 143, 23], [199, 151, 31], [191, 159, 31], [191, 159, 31], [191, 167, 39],
  [191, 167, 39], [191, 175, 47], [183, 175, 47], [183, 183, 47], [183, 183, 55],
  [207, 207, 111], [223, 223, 159], [239, 239, 199], [255, 255, 255],
];
const TOP = PALETTE.length - 1;

/** One buffer cell per this many device pixels. Coarse on purpose: fire is soft. */
const SCALE = 5;
/** Flame is low frequency, so the extra frames are spent for nothing. */
const FPS = 30;

export function createFire(canvas) {
  const ctx = canvas.getContext('2d', { alpha: true });

  /**
   * A canvas carries an intrinsic aspect ratio from its width and height
   * attributes, 300x150 by default. With a height set in CSS that ratio wins
   * over left and right stretching, so the element silently comes out half as
   * wide as its container. Clearing it lets layout size the box.
   */
  canvas.style.aspectRatio = 'auto';

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let cols = 0;
  let rows = 0;
  let cells = new Uint8Array(0);
  let image = null;
  let buffer = null;      // offscreen at buffer resolution, scaled up on draw
  let bufferCtx = null;
  let heat = 0;
  let target = 0;
  let raf = null;
  let last = 0;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;

    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);

    cols = Math.max(8, Math.ceil(canvas.width / SCALE));
    rows = Math.max(6, Math.ceil(canvas.height / SCALE));
    cells = new Uint8Array(cols * rows);

    buffer = document.createElement('canvas');
    buffer.width = cols;
    buffer.height = rows;
    bufferCtx = buffer.getContext('2d');
    image = bufferCtx.createImageData(cols, rows);
  }

  /** Seed the bottom row, then pull the heat upward. */
  function diffuse() {
    const base = Math.round(TOP * (0.7 + heat * 0.3));
    const bottom = (rows - 1) * cols;
    for (let x = 0; x < cols; x++) {
      // A little variation along the base stops the flame reading as a bar.
      cells[bottom + x] = Math.random() < 0.88 ? base : Math.max(0, base - 6 - Math.random() * 8);
    }

    for (let y = rows - 1; y > 0; y--) {
      for (let x = 0; x < cols; x++) {
        const from = y * cols + x;
        const value = cells[from];
        if (value === 0) { cells[from - cols] = 0; continue; }

        /*
         * Cooling has to be fast enough that the palette is swept in roughly a
         * third of the buffer height. Too slow and every cell sits near the top
         * of the ramp, which paints a solid yellow slab rather than a fire with
         * a thin white core and mostly orange above it.
         */
        const decay = Math.round(Math.random() * (3.6 + (1 - heat) * 3));
        const drift = Math.round(Math.random() * 2) - 1;
        const to = from - cols + drift;
        if (to >= 0 && to < cells.length) cells[to] = Math.max(0, value - decay);
      }
    }
  }

  function paint() {
    const data = image.data;
    for (let i = 0; i < cells.length; i++) {
      const [r, g, b] = PALETTE[cells[i]];
      const at = i * 4;
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      // Alpha tracks heat so the flame melts into the panel instead of sitting
      // on it as a rectangle.
      data[at + 3] = cells[i] === 0 ? 0 : Math.min(240, cells[i] * 7);
    }
    bufferCtx.putImageData(image, 0, 0);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // Drawn normally, not added: the palette already carries the brightness, and
    // adding it on top of the panel colour turned the flame green.
    ctx.drawImage(buffer, 0, 0, canvas.width, canvas.height);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - last < 1000 / FPS) return;
    last = now;

    heat += (target - heat) * 0.06;
    if (heat < 0.015) {
      if (cells.some(Boolean)) { cells.fill(0); ctx.clearRect(0, 0, canvas.width, canvas.height); }
      return;
    }
    diffuse();
    paint();
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
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  addEventListener('resize', resize, { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(canvas);
  // A hidden tab should not burn battery on a flame nobody can see.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') start(); else stop();
  });

  return {
    /** 0 is out, 1 is roaring. */
    setHeat(value) {
      target = Math.max(0, Math.min(1, value));
      if (target > 0.015) start();
    },
    /** A short flare when a bump lands. */
    flare() {
      const was = target;
      target = 1;
      setTimeout(() => { target = was; }, 900);
    },
    start,
    stop,
    get reduced() { return reduced; },
  };
}

/**
 * How hot the day is, from the two things that make it tense: how far the price
 * has climbed above the floor, and how little time is left before the close.
 */
export function heatFrom({ price, floor, endsIn, roundMs = 86_400_000, holder }) {
  if (!holder) return 0;
  const climb = Math.min(1, Math.log2(Math.max(1, price / floor)) / 4);
  const urgency = endsIn === null ? 0 : 1 - Math.min(1, endsIn / roundMs);
  return Math.min(1, 0.4 + climb * 0.36 + urgency * 0.34);
}
