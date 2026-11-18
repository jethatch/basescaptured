// The swarm: one dot per hitter along the chosen measure, stacked where values collide.
// Dots are kept by player id so they spring from their old place to their new one
// when the season or measure changes.

import { fmtv, headshot } from './data.js';

const MIN_H = 220;

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
    this.offLo = document.createElement('span');
    this.offLo.className = 'offscale offscale-lo';
    this.offHi = document.createElement('span');
    this.offHi.className = 'offscale offscale-hi';
    this.offLo.hidden = this.offHi.hidden = true;
    el.append(this.offLo, this.offHi);
    this.overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.overlay.setAttribute('class', 'overlay');
    this.overlay.setAttribute('aria-hidden', 'true');
    this.overlay.setAttribute('preserveAspectRatio', 'none');
    this.yaxis = document.createElement('div');
    this.yaxis.className = 'yaxis';
    this.yaxis.setAttribute('aria-hidden', 'true');
    el.append(this.overlay, this.yaxis);

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

    let place;
    let H;
    let offLo = 0;
    let offHi = 0;
    if (opts.compare) {
      ({ place, H, offLo, offHi } = this.scatter({ ...opts, shown, faceRows, dotRows, W, d, F, xOf, lo, hi }));
    } else {
      ({ place, H, offLo, offHi } = this.swarmLayout({ metric, faceRows, dotRows, d, F, step, xOf, lo, hi }));
    }
    this.el.classList.toggle('is-scatter', !!opts.compare);
    this.el.style.setProperty('--swarm-h', H + 'px');

    this.offLo.hidden = !offLo;
    this.offLo.textContent = `◂ ${offLo} below the scale`;
    this.offHi.hidden = !offHi;
    this.offHi.textContent = `${offHi} above the scale ▸`;

    // league line
    const lx = xOf(league);
    this.league.style.transform = `translateX(${lx}px)`;
    this.league.firstChild.textContent = metric === 'plus' ? 'League 100' : `League ${fmtv(metric, league)}`;
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
      n.setAttribute('aria-label', `${r.name}, ${r.team}, ${fmtv(metric, r.m[metric])}`);
      n.classList.toggle('faint', p.faint && !p.face);
      n.classList.toggle('off', !!p.off);
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

    this.drawAxis(lo, hi, W, metric);
  }

  swarmLayout({ metric, faceRows, dotRows, d, F, step, xOf, lo, hi }) {
    // a centred swarm: dots in each one-dot-wide column alternate above and below the middle line,
    // so height shows only where values crowd together, not a count. dy is the offset from the line.
    const count = new Map();
    const upExt = new Map();
    const place = new Map();
    let offLo = 0;
    let offHi = 0;
    let maxUp = d / 2;
    let maxDown = d / 2;
    for (const r of dotRows) {
      const v = r.m[metric];
      const off = v < lo ? 'lo' : v > hi ? 'hi' : '';
      if (off === 'lo') offLo++;
      if (off === 'hi') offHi++;
      const x = xOf(v);
      const bin = Math.round(x / d);
      const n = count.get(bin) || 0;
      count.set(bin, n + 1);
      const k = Math.ceil(n / 2);
      const dy = n === 0 ? 0 : (n % 2 ? 1 : -1) * k * step;
      upExt.set(bin, Math.max(upExt.get(bin) || 0, dy));
      maxUp = Math.max(maxUp, dy + d / 2);
      maxDown = Math.max(maxDown, -dy + d / 2);
      place.set(r.id, { x, dy, size: d, face: false, faint: !r.qualified, off });
    }

    // faces float just above the dots beneath them, stepping up to avoid each other
    const placed = [];
    for (const r of faceRows) {
      const x = xOf(r.m[metric]);
      let top = -step;
      for (let b = Math.round((x - F / 2) / d); b <= Math.round((x + F / 2) / d); b++) {
        if (count.has(b)) top = Math.max(top, upExt.get(b));
      }
      let dy = top + d / 2 + 4 + F / 2;
      let moved = true;
      while (moved) {
        moved = false;
        for (const p of placed) {
          if (Math.abs(p.x - x) < F + 2 && Math.abs(p.dy - dy) < F + 2) {
            dy = p.dy + F + 4;
            moved = true;
          }
        }
      }
      placed.push({ x, dy });
      maxUp = Math.max(maxUp, dy + F / 2);
      place.set(r.id, { x, dy, size: F, face: true, faint: !r.qualified, off: '' });
    }

    const H = Math.max(MIN_H, Math.ceil(maxUp + maxDown) + 44);
    const mid = maxDown + (H - maxUp - maxDown) / 2; // the middle line, measured from the bottom
    for (const p of place.values()) p.bottom = mid + p.dy - p.size / 2;
    this.el.style.setProperty('--swarm-h', H + 'px');

    return { place, H, offLo, offHi };
  }

  // scatter: the chosen measure across, a familiar stat up the side, with a best-fit line
  scatter({ rows, shown, faceRows, dotRows, metric, compare, yDomain, yLeague, W, d, F, xOf, lo, hi }) {
    const H = W < 560 ? 300 : 380;
    const T = 18;
    const B = 16;
    const [ylo, yhi] = yDomain;
    const yv = (r) => r.t[compare];
    const yOf = (v) => B + ((Math.min(yhi, Math.max(ylo, v)) - ylo) / (yhi - ylo)) * (H - T - B);
    const place = new Map();
    let offLo = 0;
    let offHi = 0;
    for (const r of [...dotRows, ...faceRows]) {
      const face = faceRows.includes(r);
      const size = face ? F : d;
      const x = r.m[metric];
      const y = yv(r);
      const off = x < lo || y < ylo ? 'lo' : x > hi || y > yhi ? 'hi' : '';
      if (off === 'lo') offLo++;
      if (off === 'hi') offHi++;
      place.set(r.id, { x: xOf(x), bottom: yOf(y) - size / 2, size, face, faint: !r.qualified, off });
    }

    // least-squares line through the qualified hitters
    const q = shown.filter((r) => r.qualified);
    const n = q.length;
    const mx = q.reduce((a, r) => a + r.m[metric], 0) / n;
    const my = q.reduce((a, r) => a + yv(r), 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (const r of q) {
      const dx = r.m[metric] - mx;
      const dy = yv(r) - my;
      sxy += dx * dy;
      sxx += dx * dx;
      syy += dy * dy;
    }
    const slope = sxx ? sxy / sxx : 0;
    const yAt = (x) => my + slope * (x - mx);
    this.corr = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
    const y1 = H - yOf(yAt(lo));
    const y2 = H - yOf(yAt(hi));
    const yl = yLeague != null ? H - yOf(yLeague) : null;
    this.overlay.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.overlay.innerHTML = `<line class="fit" x1="0" y1="${y1.toFixed(1)}" x2="${W}" y2="${y2.toFixed(1)}"/>` +
      (yl != null ? `<line class="yleague" x1="0" y1="${yl.toFixed(1)}" x2="${W}" y2="${yl.toFixed(1)}"/>` : '');

    // y-axis labels
    const ticks = niceTicks(ylo, yhi, 5);
    this.yaxis.innerHTML = ticks.map((v) => `<span style="bottom:${(yOf(v) - 7).toFixed(1)}px">${fmtv(compare, v)}</span>`).join('');
    return { place, H, offLo, offHi };
  }

  drawAxis(lo, hi, W, metric) {
    const span = hi - lo;
    const tick = metric === 'plus'
      ? (span <= 120 ? 10 : 20)
      : span <= 0.08 ? 0.01 : span <= 0.24 ? 0.02 : 0.05;
    const parts = [];
    const first = Math.ceil(lo / tick - 1e-9) * tick;
    for (let v = first; v <= hi + 1e-9; v += tick) {
      const left = ((v - lo) / span) * 100;
      if (left < 2 || left > 98) continue;
      parts.push(`<span style="left:${left.toFixed(2)}%">${fmtv(metric, v)}</span>`);
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

function niceTicks(lo, hi, n) {
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => m >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out.filter((v) => v > lo + step * 0.3 && v < hi - step * 0.1);
}
