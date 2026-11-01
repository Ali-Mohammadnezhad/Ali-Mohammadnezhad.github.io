/*
 * Spiking neuron network background for al-folio
 * ------------------------------------------------
 * Draws a field of neurons (somata + dendrites) connected by curved axons.
 * Neurons integrate incoming spikes, fire when they cross threshold, and send
 * glowing action potentials down their axons, so activity cascades across the
 * network. Moving the mouse excites nearby neurons.
 *
 * Sparks are shiny white; the network uses the site's text color and adapts
 * to light/dark mode. Respects "reduce motion" system settings.
 */
(() => {
  // ---------- Settings you can tweak ----------
  const CFG = {
    density: 1 / 11000, // neurons per pixel² of screen
    minNeurons: 35,
    maxNeurons: 5000,
    connectRadius: 230, // max axon length (px)
    maxTargets: 1000, // outgoing axons per neuron
    spontaneousRate: 0.06, // random firings per neuron per second
    leak: 1.6, // how fast membrane potential decays (per second)
    refractory: 0.7, // seconds a neuron can't fire after a spike
    spikeSpeed: [110, 220], // px per second (min, max)
    cellAlpha: 0.38, // opacity of somata and dendrites
    axonAlpha: 0.13, // opacity of resting axons
    mouseRadius: 110, // mouse excitation radius (px)
    maxSpikes: 500, // safety cap on simultaneous spikes
  };

  const root = document.documentElement;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- Canvas + styling ----------
  const style = document.createElement("style");
  style.textContent = `
    #neuron-bg { position: fixed; inset: 0; width: 100vw; height: 100vh;
                 z-index: -1; pointer-events: none; display: block; }
    html { background-color: var(--global-bg-color); }
    body { background-color: transparent !important; }
  `;
  document.head.appendChild(style);

  const canvas = document.createElement("canvas");
  canvas.id = "neuron-bg";
  canvas.setAttribute("aria-hidden", "true");
  document.body.prepend(canvas);
  const ctx = canvas.getContext("2d");

  let W = 0,
    H = 0,
    DPR = 1;
  let neurons = [],
    axons = [],
    spikes = [];

  // ---------- Theme colors ----------
  const probe = document.createElement("canvas").getContext("2d");
  function toRGB(color, fallback) {
    probe.fillStyle = fallback;
    probe.fillStyle = color || fallback;
    const c = probe.fillStyle; // normalized: "#rrggbb" or "rgba(...)"
    if (c[0] === "#") return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    return c
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map(Number);
  }
  let col = {},
    dark = false,
    glow = null,
    star = null,
    lastThemeKey = "";
  function readTheme() {
    const cs = getComputedStyle(root);
    const theme = cs.getPropertyValue("--global-theme-color").trim();
    const cell = cs.getPropertyValue("--global-text-color-light").trim();
    const bg = cs.getPropertyValue("--global-bg-color").trim();
    const key = theme + cell + bg;
    if (key === lastThemeKey) return;
    lastThemeKey = key;
    col.theme = toRGB(theme, "#b509ac");
    col.cell = toRGB(cell, "#828282");
    const b = toRGB(bg, "#ffffff");
    dark = 0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2] < 128;
    col.lit = dark ? [255, 255, 255] : [90, 90, 105]; // color of active axons/somata
    glow = makeGlow(dark);
    star = makeStar(dark);
  }
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  // Pre-rendered sprites for spikes (much faster than shadowBlur).
  // Sparks are shiny white; on light backgrounds they get a soft grey halo
  // so the white stays visible.
  function makeGlow(isDark) {
    const s = 64,
      g = document.createElement("canvas");
    g.width = g.height = s;
    const gc = g.getContext("2d");
    const grad = gc.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    if (isDark) {
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(0.2, "rgba(255,255,255,0.9)");
      grad.addColorStop(0.5, "rgba(220,235,255,0.25)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
    } else {
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(0.18, "rgba(255,255,255,1)");
      grad.addColorStop(0.3, "rgba(120,120,140,0.6)");
      grad.addColorStop(0.6, "rgba(120,120,140,0.18)");
      grad.addColorStop(1, "rgba(150,150,170,0)");
    }
    gc.fillStyle = grad;
    gc.fillRect(0, 0, s, s);
    return g;
  }
  // Glint: glow plus a four-pointed star flare, used for spike heads
  function makeStar(isDark) {
    const s = 64,
      g = document.createElement("canvas");
    g.width = g.height = s;
    const gc = g.getContext("2d");
    gc.drawImage(makeGlow(isDark), 0, 0);
    const ray = (horizontal) => {
      const lg = horizontal ? gc.createLinearGradient(0, 0, s, 0) : gc.createLinearGradient(0, 0, 0, s);
      lg.addColorStop(0, "rgba(255,255,255,0)");
      lg.addColorStop(0.5, "rgba(255,255,255,1)");
      lg.addColorStop(1, "rgba(255,255,255,0)");
      gc.fillStyle = lg;
      if (horizontal) gc.fillRect(0, s / 2 - 1, s, 2);
      else gc.fillRect(s / 2 - 1, 0, 2, s);
    };
    ray(true);
    ray(false);
    return g;
  }

  // ---------- Network construction ----------
  const rand = (a, b) => a + Math.random() * (b - a);

  function makeDendrites(n) {
    // A few short, branching dendrites per soma, stored as line segments
    const segs = [];
    const count = Math.floor(rand(3, 6));
    for (let i = 0; i < count; i++) {
      grow(n.x, n.y, rand(0, Math.PI * 2), rand(10, 22), 2);
    }
    function grow(x, y, ang, len, depth) {
      const x2 = x + Math.cos(ang) * len,
        y2 = y + Math.sin(ang) * len;
      segs.push([x, y, x2, y2, depth]);
      if (depth > 0) {
        const k = Math.random() < 0.7 ? 2 : 1;
        for (let j = 0; j < k; j++) grow(x2, y2, ang + rand(-0.7, 0.7), len * rand(0.5, 0.75), depth - 1);
      }
    }
    return segs;
  }

  function build() {
    const area = W * H;
    const N = Math.max(CFG.minNeurons, Math.min(CFG.maxNeurons, Math.round(area * CFG.density)));
    neurons = [];
    axons = [];
    spikes = [];

    // Spread neurons with a simple minimum-distance rule so they don't clump
    const minD = Math.sqrt(area / N) * 0.55;
    let tries = 0;
    while (neurons.length < N && tries < N * 40) {
      tries++;
      const x = rand(20, W - 20),
        y = rand(20, H - 20);
      if (neurons.some((n) => (n.x - x) ** 2 + (n.y - y) ** 2 < minD * minD)) continue;
      const n = { x, y, r: rand(2.2, 4.2), v: rand(0, 0.6), refr: 0, flash: 0, out: [] };
      n.dend = makeDendrites(n);
      neurons.push(n);
    }

    // Connect each neuron to a few nearby targets with a curved axon
    for (const a of neurons) {
      const near = neurons
        .filter((b) => b !== a)
        .map((b) => ({ b, d: Math.hypot(b.x - a.x, b.y - a.y) }))
        .filter((o) => o.d < CFG.connectRadius && o.d > 25)
        .sort((p, q) => p.d - q.d)
        .slice(0, 6);
      const k = Math.min(near.length, Math.floor(rand(1, CFG.maxTargets + 1)));
      for (let i = 0; i < k; i++) {
        const { b, d } = near.splice(Math.floor(Math.random() * near.length), 1)[0];
        const mx = (a.x + b.x) / 2,
          my = (a.y + b.y) / 2;
        const nx = -(b.y - a.y) / d,
          ny = (b.x - a.x) / d; // perpendicular
        const bend = rand(-0.35, 0.35) * d;
        const ax = {
          from: a,
          to: b,
          cx: mx + nx * bend,
          cy: my + ny * bend,
          len: d,
          w: rand(0.45, 0.9), // synaptic weight
          lit: 0,
        };
        axons.push(ax);
        a.out.push(ax);
      }
    }
  }

  function bez(ax, t) {
    const u = 1 - t;
    return [u * u * ax.from.x + 2 * u * t * ax.cx + t * t * ax.to.x, u * u * ax.from.y + 2 * u * t * ax.cy + t * t * ax.to.y];
  }

  // ---------- Dynamics ----------
  function fire(n) {
    if (n.refr > 0) return;
    n.v = 0;
    n.refr = CFG.refractory;
    n.flash = 1;
    for (const ax of n.out) {
      if (spikes.length >= CFG.maxSpikes) break;
      spikes.push({ ax, t: 0, speed: rand(...CFG.spikeSpeed) / ax.len });
    }
  }

  function step(dt) {
    for (const n of neurons) {
      n.refr = Math.max(0, n.refr - dt);
      n.flash = Math.max(0, n.flash - dt * 2.2);
      n.v *= Math.exp(-CFG.leak * dt);
      if (Math.random() < CFG.spontaneousRate * dt) fire(n);
      else if (n.v >= 1) fire(n);
    }
    for (const ax of axons) ax.lit = Math.max(0, ax.lit - dt * 1.5);
    for (let i = spikes.length - 1; i >= 0; i--) {
      const s = spikes[i];
      s.t += s.speed * dt;
      s.ax.lit = 1;
      if (s.t >= 1) {
        const target = s.ax.to;
        target.v += s.ax.w;
        target.flash = Math.max(target.flash, 0.35);
        spikes.splice(i, 1);
      }
    }
  }

  // ---------- Drawing ----------
  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = "round";

    // Axons (brighter while a spike is travelling along them)
    for (const ax of axons) {
      const a = CFG.axonAlpha + ax.lit * 0.25;
      ctx.strokeStyle = ax.lit > 0.02 ? rgba(col.lit, a) : rgba(col.cell, CFG.axonAlpha);
      ctx.lineWidth = 0.8 + ax.lit * 0.6;
      ctx.beginPath();
      ctx.moveTo(ax.from.x, ax.from.y);
      ctx.quadraticCurveTo(ax.cx, ax.cy, ax.to.x, ax.to.y);
      ctx.stroke();
    }

    // Dendrites + somata
    for (const n of neurons) {
      const c = n.flash > 0.05 ? col.lit : col.cell;
      const a = CFG.cellAlpha * (dark ? 0.75 : 1) + n.flash * 0.5;
      ctx.strokeStyle = rgba(c, a * 0.8);
      for (const [x1, y1, x2, y2, depth] of n.dend) {
        ctx.lineWidth = 0.5 + depth * 0.45;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.fillStyle = rgba(c, Math.min(1, a + 0.15));
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + n.flash * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Glows: firing somata and travelling spikes (with short comet tails)
    ctx.globalCompositeOperation = dark ? "lighter" : "source-over";
    for (const n of neurons) {
      if (n.flash > 0.05) {
        const s = 26 + n.flash * 30;
        ctx.globalAlpha = n.flash * (dark ? 0.9 : 0.8);
        ctx.drawImage(glow, n.x - s / 2, n.y - s / 2, s, s);
      }
    }
    for (const sp of spikes) {
      for (let k = 0; k < 5; k++) {
        const t = sp.t - k * 0.025;
        if (t < 0) break;
        const [x, y] = bez(sp.ax, t);
        const s = k === 0 ? 30 : 16 - k * 2.5;
        ctx.globalAlpha = (1 - k / 5) * (k === 0 ? 1 : 0.8);
        ctx.drawImage(k === 0 ? star : glow, x - s / 2, y - s / 2, s, s);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  // ---------- Sizing ----------
  function resize(force) {
    const w = window.innerWidth,
      h = window.innerHeight;
    // Ignore small height changes (mobile address bar) to avoid rebuilding
    if (!force && w === W && Math.abs(h - H) < 150) return;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = w;
    H = h;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    build();
    if (reduceMotion) draw();
  }
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => resize(false), 200);
  });

  // ---------- Mouse interaction ----------
  window.addEventListener(
    "pointermove",
    (e) => {
      if (reduceMotion) return;
      const R2 = CFG.mouseRadius ** 2;
      for (const n of neurons) {
        const d2 = (n.x - e.clientX) ** 2 + (n.y - e.clientY) ** 2;
        if (d2 < R2) n.v += 0.06 * (1 - d2 / R2);
      }
    },
    { passive: true }
  );

  // Re-read colors when light/dark mode is toggled
  new MutationObserver(() => {
    readTheme();
    if (reduceMotion) draw();
  }).observe(root, { attributes: true, attributeFilter: ["data-theme", "class"] });

  // ---------- Start ----------
  readTheme();
  resize(true);
  if (reduceMotion) return; // static network only

  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt);
    draw();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
