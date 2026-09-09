/*!
 * vanta-bg.js — drop-in animated background runtime for the component library.
 * Wraps Vanta.js (MIT, github.com/tengbao/vanta) with the guards a real site needs:
 * reduced-motion, mobile/low-power opt-out, WebGL check, lazy loading, brand-token colors.
 *
 * Usage (see .claude/skills/create-website/backgrounds.md):
 *   <section class="hero">
 *     <div class="vanta-bg" data-vanta="net"
 *          data-vanta-color="var(--color-brand)"
 *          data-vanta-background="var(--color-ink)"></div>
 *     <div class="hero__inner"> …content… </div>
 *   </section>
 *
 * Required CSS (ship it with the page):
 *   .hero { position: relative; isolation: isolate; }
 *   .vanta-bg { position: absolute; inset: 0; z-index: 0; pointer-events: none;
 *               background: var(--color-ink); }   ← the no-JS / reduced-motion fallback
 *   .hero__inner { position: relative; z-index: 1; }
 *
 * Self-hosting: set window.VANTA_BG_CONFIG = { threeSrc, p5Src, vantaBase } before this file.
 */
(function () {
  'use strict';

  var CFG = Object.assign({
    threeSrc: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r134/three.min.js',
    p5Src: 'https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.1.9/p5.min.js',
    vantaBase: 'https://cdn.jsdelivr.net/npm/vanta@0.5.24/dist/',
    minWidth: 900,        // below this viewport width, stay static (phones + small tablets)
    rootMargin: '200px',  // start loading just before the section scrolls in
    lazy: true            // false = init immediately (skips IntersectionObserver)
  }, window.VANTA_BG_CONFIG || {});

  // Which library each effect needs, and how the generic color slots map to its own option names.
  var EFFECTS = {
    birds:    { dep: 'three', color: 'color1',         color2: 'color2',   bg: 'backgroundColor' },
    cells:    { dep: 'three', color: 'color1',         color2: 'color2',   bg: 'backgroundColor' },
    clouds:   { dep: 'three', color: 'cloudColor',     color2: 'skyColor', bg: 'backgroundColor' },
    clouds2:  { dep: 'three', color: 'cloudColor',     color2: 'skyColor', bg: 'backgroundColor' },
    dots:     { dep: 'three', color: 'color',          color2: 'color2',   bg: 'backgroundColor' },
    fog:      { dep: 'three', color: 'highlightColor', color2: 'midtoneColor', bg: 'baseColor' },
    globe:    { dep: 'three', color: 'color',          color2: 'color2',   bg: 'backgroundColor' },
    halo:     { dep: 'three', color: 'baseColor',      color2: 'color2',   bg: 'backgroundColor' },
    net:      { dep: 'three', color: 'color',          color2: null,       bg: 'backgroundColor' },
    rings:    { dep: 'three', color: 'color',          color2: null,       bg: 'backgroundColor' },
    ripple:   { dep: 'three', color: 'color1',         color2: 'color2',   bg: 'backgroundColor' },
    topology: { dep: 'p5',    color: 'color',          color2: null,       bg: 'backgroundColor' },
    trunk:    { dep: 'p5',    color: 'color',          color2: null,       bg: 'backgroundColor' },
    waves:    { dep: 'three', color: 'color',          color2: null,       bg: null }
  };

  var loading = {};
  function loadScript(src) {
    if (loading[src]) return loading[src];
    loading[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('failed to load ' + src)); };
      document.head.appendChild(s);
    });
    return loading[src];
  }

  function hasWebGL() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext &&
        (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { return false; }
  }

  function lowPowerDevice() {
    var conn = navigator.connection || {};
    if (conn.saveData) return true;
    if (typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 2) return true;
    if (typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency <= 2) return true;
    return false;
  }

  var probeCtx = null;
  // Resolve any CSS color (hex, rgb(), a var(--token), oklch()) to a 0xRRGGBB integer.
  function toHexInt(value, contextEl) {
    if (value == null || value === '') return null;
    var raw = String(value).trim();
    if (/^0x[0-9a-f]{6}$/i.test(raw)) return parseInt(raw.slice(2), 16);
    if (/^#[0-9a-f]{6}$/i.test(raw)) return parseInt(raw.slice(1), 16);

    var probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden';
    probe.style.color = raw;
    (contextEl || document.body).appendChild(probe);
    var computed = getComputedStyle(probe).color;
    probe.remove();

    var m = computed.match(/^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (m) return (+m[1] << 16) + (+m[2] << 8) + (+m[3]);

    // Non-legacy color space (oklch/lab/…): rasterize one pixel and read it back.
    try {
      if (!probeCtx) probeCtx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      probeCtx.clearRect(0, 0, 1, 1);
      probeCtx.fillStyle = computed;
      probeCtx.fillRect(0, 0, 1, 1);
      var d = probeCtx.getImageData(0, 0, 1, 1).data;
      return (d[0] << 16) + (d[1] << 8) + d[2];
    } catch (e) { return null; }
  }

  function coerce(v) {
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v !== '' && !isNaN(Number(v))) return Number(v);
    return v;
  }

  function buildOptions(el, spec) {
    var d = el.dataset;
    var opts = {
      el: el,
      mouseControls: d.vantaMouse !== 'false',
      touchControls: false,          // never hijack touch scrolling on a phone
      gyroControls: false,
      minHeight: 200,
      minWidth: 200,
      scale: 1,
      scaleMobile: 1
    };

    var pairs = [['vantaColor', spec.color], ['vantaColor2', spec.color2], ['vantaBackground', spec.bg]];
    pairs.forEach(function (p) {
      if (!p[1] || !d[p[0]]) return;
      var hex = toHexInt(d[p[0]], el);
      if (hex != null) opts[p[1]] = hex;
    });

    // Pass any remaining effect option through: data-vanta-opt-wave-height="20" → waveHeight: 20
    Object.keys(d).forEach(function (key) {
      if (key.indexOf('vantaOpt') !== 0 || key === 'vantaOpt') return;
      var name = key.slice(8);
      name = name.charAt(0).toLowerCase() + name.slice(1);
      var val = d[key];
      // a color-ish option keeps its color handling
      opts[name] = /color/i.test(name) ? (toHexInt(val, el) != null ? toHexInt(val, el) : coerce(val)) : coerce(val);
    });

    return opts;
  }

  function start(el) {
    var name = (el.dataset.vanta || '').toLowerCase();
    var spec = EFFECTS[name];
    if (!spec) { console.warn('[vanta-bg] unknown effect: "' + name + '"'); return; }

    var parent = el.parentElement;
    if (parent && getComputedStyle(parent).position === 'static') {
      console.warn('[vanta-bg] the container of a .vanta-bg needs position:relative', parent);
    }

    var depSrc = spec.dep === 'p5' ? CFG.p5Src : CFG.threeSrc;
    loadScript(depSrc)
      .then(function () { return loadScript(CFG.vantaBase + 'vanta.' + name + '.min.js'); })
      .then(function () {
        var fn = window.VANTA && window.VANTA[name.toUpperCase()];
        if (!fn) throw new Error('VANTA.' + name.toUpperCase() + ' not available');
        var instance = fn(buildOptions(el, spec));
        el.vantaEffect = instance;
        el.classList.add('is-vanta-active');   // lets CSS fade out the static fallback
        window.addEventListener('pagehide', function () {
          try { instance.destroy(); } catch (e) {}
        });
      })
      .catch(function (err) {
        // Static fallback stays exactly as it was — the section still looks intentional.
        console.warn('[vanta-bg] disabled:', err.message);
      });
  }

  function init() {
    var els = document.querySelectorAll('[data-vanta]');
    if (!els.length) return;

    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var tooNarrow = window.innerWidth < CFG.minWidth;
    if (reduced || tooNarrow || lowPowerDevice() || !hasWebGL()) return;

    if (!CFG.lazy || !('IntersectionObserver' in window)) {
      els.forEach(function (el) { start(el); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        io.unobserve(entry.target);
        start(entry.target);
      });
    }, { rootMargin: CFG.rootMargin });
    els.forEach(function (el) { io.observe(el); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
