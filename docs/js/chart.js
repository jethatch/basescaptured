// The swarm: one dot per hitter along the chosen measure, stacked where values collide.
// Dots are kept by player id so they spring from their old place to their new one
// when the season or measure changes.

import { fmt, headshot } from './data.js';

const MIN_H = 240;

export class Swarm {
  constructor(el, axisEl, { onHover, onLeave, onPick }) {
    this.el = el;
    this.axisEl = axisEl;
    this.nodes = new Map();
    this.onHover = onHover;
    this.onLeave = onLeave;
    this.onPick = onPick;
    this.last = null;

    this.league = document.createElement('div');
    this.league.className = 'league';
    this.league.innerHTML = '<span></span>';
    el.appendChild(this.league);

    el.addEventListener('pointerover', (e) => {
      const n = e.target.closest('.dot');
      if (n && !n.classList.contains('leaving')) this.onHover(n.dataset.id, n);
    });
    el.addEventListener('pointerout', (e) => {
      const n = e.target.closest('.dot');
      if (n && !(e.relatedTarget && n.contains(e.relatedTarget))) this.onLeave(n.dataset.id);
    });
    el.addEventListener('click', (e) => {
      const n = e.target.closest('.dot');
      if (n) this.onPick(n.dataset.id);
    });
    el.addEventListener('focusin', (e) => {
      const n = e.target.closest('.dot');
      if (n) this.onHover(n.dataset.id, n);
    });
    el.addEventListener('focusout', (e) => {
      const n = e.target.closest('.dot');
      if (n) this.onLeave(n.dataset.id);
    });

    let t;
    new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => this.last && this.update(this.last), 120);
    }).observe(el);
  }

  update(opts) {
    this.last = opts;
    const { rows, metric, domain, league, faces, selected, faint } = opts;
    const W = this.el.clientWidth;
    if (!W) return;
    const narrow = W < 560;
    const d = narrow ? 8 : 11;
    const F = narrow ? 34 : 44;
    const step = d + 2;
    const [lo, hi] = domain;
    const clamp = (v) => Math.min(hi, Math.max(lo, v));
    const xOf = (v) => ((clamp(v) - lo) / (hi - lo)) * W;

    const shown = rows.filter((r) => r.qualified || (faint && r.faintOk));
    const faceRows = shown.filter((r) => faces.has(r.id)).sort((a, b) => b.m[metric] - a.m[metric]);
    const dotRows = shown.filter((r) => !faces.has(r.id))
      .sort((a, b) => (b.qualified - a.qualified) || (a.m[metric] - b.m[metric]));

    // stack dots in columns one dot wide
    const stack = new Map();
    const place = new Map();
    for (const r of dotRows) {
      const x = xOf(r.m[metric]);
      const bin = Math.round(x / d);
      const n = stack.get(bin) || 0;
      stack.set(bin, n + 1);
      place.set(r.id, { x, bottom: 4 + n * step, size: d, face: false, faint: !r.qualified });
    }
    let maxStack = 0;
    for (const n of stack.values()) maxStack = Math.max(maxStack, n);

    // faces sit on top of the dots below them, stepping up to avoid each other
    const placed = [];
    let faceTop = 0;
    for (const r of faceRows) {
      const x = xOf(r.m[metric]);
      let base = 0;
      for (let b = Math.round((x - F / 2) / d); b <= Math.round((x + F / 2) / d); b++) base = Math.max(base, stack.get(b) || 0);
      let bottom = 6 + base * step;
      let moved = true;
      while (moved) {
        moved = false;
        for (const p of placed) {
          if (Math.abs(p.x - x) < F + 2 && Math.abs(p.bottom - bottom) < F + 2) {
            bottom = p.bottom + F + 4;
            moved = true;
          }
        }
      }
      placed.push({ x, bottom });
      faceTop = Math.max(faceTop, bottom + F);
      place.set(r.id, { x, bottom, size: F, face: true, faint: !r.qualified });
    }

    const H = Math.max(MIN_H, maxStack * step + 40, faceTop + 16);
    this.el.style.setProperty('--swarm-h', H + 'px');

    // league line
    const lx = xOf(league);
    this.league.style.transform = `translateX(${lx}px)`;
    this.league.firstChild.textContent = `League ${fmt(league)}`;
    this.league.firstChild.style.left = lx > W - 110 ? '-104px' : '6px';

    // enter / update
    const byId = new Map(shown.map((r) => [r.id, r]));
    for (const [id, p] of place) {
      const r = byId.get(id);
      let n = this.nodes.get(id);
      const fresh = !n;
      if (fresh) {
        n = document.createElement('button');
        n.type = 'button';
        n.className = 'dot entering';
        n.dataset.id = id;
        n.tabIndex = -1;
        this.el.appendChild(n);
        this.nodes.set(id, n);
      } else if (n.classList.contains('leaving')) {
        clearTimeout(n._gone);
        n.classList.remove('leaving');
      }
      n.setAttribute('aria-label', `${r.name}, ${r.team}, ${fmt(r.m[metric])}`);
      n.classList.toggle('faint', p.faint && !p.face);
      n.classList.toggle('face', p.face);
      n.classList.toggle('selected', id === selected);
      n.tabIndex = p.face ? 0 : -1;
      if (p.face && !n.firstChild) {
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = headshot(r.mlbam);
        n.appendChild(img);
      } else if (!p.face && n.firstChild) {
        n.textContent = '';
      }
      n.style.setProperty('--d', p.size + 'px');
      n.style.setProperty('--x', (p.x - p.size / 2).toFixed(1) + 'px');
      n.style.setProperty('--y', (H - p.bottom - p.size).toFixed(1) + 'px');
      if (fresh) requestAnimationFrame(() => requestAnimationFrame(() => n.classList.remove('entering')));
    }

    // leave
    for (const [id, n] of this.nodes) {
      if (place.has(id) || n.classList.contains('leaving')) continue;
      n.classList.add('leaving');
      n._gone = setTimeout(() => {
        n.remove();
        this.nodes.delete(id);
      }, 450);
    }

    this.drawAxis(lo, hi, W);
  }

  drawAxis(lo, hi, W) {
    const span = hi - lo;
    const tick = span <= 0.08 ? 0.01 : span <= 0.24 ? 0.02 : 0.05;
    const parts = [];
    const first = Math.ceil(lo / tick - 1e-9) * tick;
    for (let v = first; v <= hi + 1e-9; v += tick) {
      const left = ((v - lo) / span) * 100;
      if (left < 2 || left > 98) continue;
      parts.push(`<span style="left:${left.toFixed(2)}%">${fmt(v)}</span>`);
    }
    if (this.axisEl.dataset.key !== parts.join('')) {
      this.axisEl.innerHTML = parts.join('');
      this.axisEl.dataset.key = parts.join('');
    }
  }

  nodeFor(id) {
    return this.nodes.get(id);
  }
}
