'use strict';

// ---------- параметры теста ----------
const CFG = {
  pingCount: 20,          // замеров задержки в покое
  udpPackets: 200,        // пакетов для оценки потерь
  udpInterval: 12,        // мс между пакетами
  downStreams: 6,
  upStreams: 4,
  phaseMs: 10000,         // длительность загрузки и отдачи
  graceMs: 1500,          // отбрасываемый «разгон» TCP в начале фазы
  loadedPingEvery: 200,   // мс между пингами под нагрузкой
  downChunk: 64 << 20,
  upChunk: 8 << 20,
};

const $ = (s, r = document) => r.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => performance.now();
const MB = 1 << 20;

// ---------- статистика ----------
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const jitterOf = a => a.length < 2 ? NaN : mean(a.slice(1).map((v, i) => Math.abs(v - a[i])));
const stdev = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };
const ok = v => Number.isFinite(v);

// ---------- форматирование ----------
function fmtSpeed(v) {
  if (!ok(v)) return '—';
  if (v >= 1000) return Math.round(v).toLocaleString('ru-RU');
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}
const fmtMs = v => !ok(v) ? '—' : v >= 100 ? v.toFixed(0) : v.toFixed(1);
const fmtPct = v => !ok(v) ? '—' : v === 0 ? '0' : v < 1 ? v.toFixed(2) : v.toFixed(1);
const fmtBytes = b => b >= 1024 * MB ? (b / 1024 / MB).toFixed(2) + ' ГБ' : (b / MB).toFixed(b >= 100 * MB ? 0 : 1) + ' МБ';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 1800);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast('Скопировано');
}

// ---------- тема ----------
(function theme() {
  const root = document.documentElement;
  let saved = null;
  try { saved = localStorage.getItem('st.theme'); } catch {}
  const sys = matchMedia('(prefers-color-scheme: light)');
  const apply = t => {
    root.dataset.theme = t;
    dispatchEvent(new Event('themechange'));
    $('meta[name="theme-color"]').content = t === 'light' ? '#f3f5fa' : '#0b0f1a';
  };
  apply(saved || (sys.matches ? 'light' : 'dark'));
  sys.addEventListener('change', e => { if (!saved) apply(e.matches ? 'light' : 'dark'); });
  document.addEventListener('DOMContentLoaded', () => $('#themeBtn').addEventListener('click', () => {
    saved = root.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('st.theme', saved); } catch {}
    apply(saved);
  }));
})();

// ---------- плавная анимация значений ----------
const anim = {
  items: new Set(),
  running: false,
  last: 0,
  add(item) { this.items.add(item); this.kick(); },
  kick() {
    if (this.running) return;
    this.running = true;
    this.last = now();
    requestAnimationFrame(t => this.frame(t));
  },
  frame(t) {
    const dt = Math.min(64, t - this.last);
    this.last = t;
    let busy = false;
    for (const it of this.items) busy = it.step(dt) || busy;
    if (chart.dirty) { chart.draw(); busy = true; }
    if (busy) requestAnimationFrame(x => this.frame(x));
    else this.running = false;
  },
};

class Tween {
  constructor(render, tau = 140) { this.cur = 0; this.target = 0; this.render = render; this.tau = tau; anim.add(this); }
  set(v, instant = false) { this.target = v; if (instant) this.cur = v; anim.kick(); }
  step(dt) {
    const d = this.target - this.cur;
    if (Math.abs(d) < 1e-3 * Math.max(1, Math.abs(this.target))) { this.cur = this.target; this.render(this.cur); return false; }
    this.cur += d * (1 - Math.exp(-dt / this.tau));
    this.render(this.cur);
    return true;
  }
}

// ---------- спидометр ----------
const SCALES = {
  speed: [0, 5, 10, 25, 50, 100, 250, 500, 750, 1000],
  speedHi: [0, 10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
};
const gauge = {
  cx: 150, cy: 150, r: 120, a0: 135, sweep: 270,
  scale: SCALES.speed,
  mode: 'down',
  init() {
    this.fill = $('#gFill');
    this.needle = $('#gNeedle');
    this.ticks = $('#gTicks');
    $('#gTrack').setAttribute('d', this.arc(0, 1));
    this.setScale(SCALES.speed);
    // стрелка анимируется по положению на шкале (шкала нелинейная), число — по значению
    this.tween = new Tween(f => this.render(f), 180);
    this.num = new Tween(v => { $('#bigVal').textContent = fmtSpeed(v); }, 180);
  },
  pt(angle, r) {
    const a = angle * Math.PI / 180;
    return [this.cx + r * Math.cos(a), this.cy + r * Math.sin(a)];
  },
  arc(f0, f1) {
    const a0 = this.a0 + this.sweep * f0, a1 = this.a0 + this.sweep * Math.max(f1, f0 + 1e-4);
    const [x0, y0] = this.pt(a0, this.r), [x1, y1] = this.pt(a1, this.r);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${this.r} ${this.r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  },
  frac(v) {
    const s = this.scale;
    if (v <= 0) return 0;
    if (v >= s[s.length - 1]) return 1;
    let i = 0;
    while (v > s[i + 1]) i++;
    return (i + (v - s[i]) / (s[i + 1] - s[i])) / (s.length - 1);
  },
  setScale(scale) {
    if (this.scale === scale && this.ticks.childElementCount) return;
    this.scale = scale;
    const n = scale.length - 1;
    let html = '';
    scale.forEach((v, i) => {
      const a = this.a0 + this.sweep * i / n;
      const [x, y] = this.pt(a, 92);
      const [lx0, ly0] = this.pt(a, 103), [lx1, ly1] = this.pt(a, 108);
      const label = v >= 1000 ? (v / 1000) + 'k' : v;
      html += `<line x1="${lx0}" y1="${ly0}" x2="${lx1}" y2="${ly1}"/><text x="${x}" y="${y}">${label}</text>`;
    });
    this.ticks.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350 });
    this.ticks.innerHTML = html;
  },
  setMode(mode) {
    this.mode = mode;
    this.fill.style.stroke = `url(#${mode === 'up' ? 'gUp' : 'gDown'})`;
    this.setScale(SCALES.speed);
    this.tween.set(0, true);
    this.num.set(0, true);
  },
  set(v) {
    if (v > 900 && this.scale === SCALES.speed) this.setScale(SCALES.speedHi);
    this.tween.set(this.frac(v));
    this.num.set(v);
  },
  // плавно опустить стрелку к нулю перед сменой фазы
  async drop() {
    if (this.tween.cur <= 0.002) return;
    this.tween.set(0);
    this.num.set(0);
    await sleep(600);
  },
  render(f) {
    this.fill.setAttribute('d', this.arc(0, f));
    this.fill.style.opacity = f < 0.003 ? 0 : 1; // без «точки» от скруглённого конца на нуле
    this.needle.style.transform = `rotate(${this.a0 + this.sweep * f + 90}deg)`;
  },
};

// ---------- график ----------
const chart = {
  series: { down: [], up: [], ping: [] },
  dirty: false,
  init() {
    this.cv = $('#chart');
    this.ctx = this.cv.getContext('2d');
    new ResizeObserver(() => { this.resize(); this.draw(); }).observe(this.cv);
    addEventListener('themechange', () => { this.colors = null; this.dirty = true; anim.kick(); });
  },
  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const { width, height } = this.cv.getBoundingClientRect();
    this.w = width; this.h = height;
    this.cv.width = Math.round(width * dpr);
    this.cv.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  },
  reset() { this.series = { down: [], up: [], ping: [] }; this.dirty = true; anim.kick(); },
  push(name, t, v) { this.series[name].push([t, v]); this.dirty = true; anim.kick(); },
  draw() {
    this.dirty = false;
    const { ctx, w, h } = this;
    if (!w) return;
    if (!this.colors) {
      const css = getComputedStyle(document.documentElement);
      this.colors = Object.fromEntries(['--faint', '--down', '--up', '--ping'].map(n => [n, css.getPropertyValue(n).trim()]));
    }
    const col = n => this.colors[n];
    ctx.clearRect(0, 0, w, h);
    const pad = 8, top = 12, T = CFG.phaseMs / 1000;
    const speeds = [...this.series.down, ...this.series.up].map(p => p[1]);
    const ymax = Math.max(1, ...speeds) * 1.15;
    const X = t => pad + (w - 2 * pad) * Math.min(1, t / T);
    const Y = (v, m) => h - pad - (h - pad - top) * Math.min(1, v / m);

    ctx.strokeStyle = col('--faint');
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) { const y = top + (h - pad - top) * i / 4; ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke(); }

    const line = (pts, color, m, area) => {
      if (pts.length < 2) return;
      ctx.beginPath();
      pts.forEach(([t, v], i) => i ? ctx.lineTo(X(t), Y(v, m)) : ctx.moveTo(X(t), Y(v, m)));
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
      if (area) {
        ctx.lineTo(X(pts.at(-1)[0]), h); ctx.lineTo(X(pts[0][0]), h); ctx.closePath();
        const g = ctx.createLinearGradient(0, top, 0, h);
        g.addColorStop(0, color + '55'); g.addColorStop(1, color + '00');
        ctx.fillStyle = g; ctx.fill();
      }
    };
    line(this.series.down, col('--down'), ymax, true);
    line(this.series.up, col('--up'), ymax, true);
    const pm = Math.max(50, ...this.series.ping.map(p => p[1])) * 1.2;
    ctx.globalAlpha = .85;
    ctx.fillStyle = col('--ping');
    for (const [t, v] of this.series.ping) { ctx.beginPath(); ctx.arc(X(t), Y(v, pm), 2, 0, 7); ctx.fill(); }
    ctx.globalAlpha = 1;
  },
};

// ---------- WebSocket-пинг ----------
class Pinger {
  constructor() { this.pending = new Map(); this.seq = 0; }
  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
      const timer = setTimeout(() => { ws.close(); reject(new Error('ws timeout')); }, 5000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
      ws.onmessage = e => {
        const t1 = now();
        const cb = this.pending.get(+e.data);
        if (cb) { this.pending.delete(+e.data); cb(t1); }
      };
      this.ws = ws;
    });
  }
  ping(timeout = 3000) {
    return new Promise(resolve => {
      if (this.ws?.readyState !== 1) return resolve(NaN);
      const id = ++this.seq, t0 = now();
      const timer = setTimeout(() => { this.pending.delete(id); resolve(NaN); }, timeout);
      this.pending.set(id, t1 => { clearTimeout(timer); resolve(t1 - t0); });
      this.ws.send(String(id));
    });
  }
  // фоновые пинги во время загрузки/отдачи
  startLoaded(onSample) {
    let stop = false, busy = false;
    const samples = [];
    const iv = setInterval(async () => {
      if (stop || busy) return;
      busy = true;
      const rtt = await this.ping(5000);
      busy = false;
      if (!stop && ok(rtt)) { samples.push(rtt); onSample(rtt); }
    }, CFG.loadedPingEvery);
    return () => { stop = true; clearInterval(iv); return samples; };
  }
  close() { this.ws?.close(); }
}

async function measureLatency(pinger, onSample) {
  await pinger.ping(); // прогрев
  const rtts = [];
  for (let i = 0; i < CFG.pingCount; i++) {
    const rtt = await pinger.ping();
    if (ok(rtt)) { rtts.push(rtt); onSample(rtt, (i + 1) / CFG.pingCount); }
    await sleep(40);
  }
  return {
    median: median(rtts), min: Math.min(...rtts), max: Math.max(...rtts), avg: mean(rtts),
    jitter: jitterOf(rtts), stdev: stdev(rtts), lost: CFG.pingCount - rtts.length,
  };
}

// ---------- потери пакетов (WebRTC, UDP без повторов) ----------
// view.sent(i) — пакет отправлен, view.echo(i) — вернулся, view.lost(i) — не вернулся за 1 с,
// view.update(отправлено, учтено, потеряно, rtt[]) — после каждого шага
async function measureUdp(view) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  try {
    const dc = pc.createDataChannel('loss', { ordered: false, maxRetransmits: 0 });
    dc.binaryType = 'arraybuffer';
    await pc.setLocalDescription(await pc.createOffer());
    await Promise.race([
      new Promise(r => { if (pc.iceGatheringState === 'complete') r(); pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && r()); }),
      sleep(1500),
    ]);
    const resp = await fetch('/api/rtc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pc.localDescription) });
    if (!resp.ok) throw new Error('rtc ' + resp.status);
    await pc.setRemoteDescription(await resp.json());
    await Promise.race([
      new Promise(r => dc.addEventListener('open', r, { once: true })),
      sleep(5000).then(() => { throw new Error('udp: нет соединения'); }),
    ]);

    const N = CFG.udpPackets, sent = new Float64Array(N), rtt = new Float64Array(N).fill(NaN);
    dc.onmessage = e => {
      const i = new DataView(e.data).getUint32(0);
      if (i < N && !ok(rtt[i]) && !(sent[i] < 0)) { rtt[i] = now() - sent[i]; view.echo(i); }
    };
    // пакет считается потерянным, если не вернулся за секунду
    let settled = 0, lost = 0;
    const settle = all => {
      while (settled < N && sent[settled] > 0 && (all || now() - sent[settled] > 1000)) {
        if (!ok(rtt[settled])) { lost++; sent[settled] = -1; view.lost(settled); }
        settled++;
      }
    };
    const buf = new ArrayBuffer(64);
    for (let i = 0; i < N; i++) {
      new DataView(buf).setUint32(0, i);
      sent[i] = now();
      dc.send(buf);
      view.sent(i);
      settle(false);
      view.update(i + 1, settled, lost, rtt);
      await sleep(CFG.udpInterval);
    }
    for (let k = 0; k < 10; k++) { await sleep(100); settle(false); view.update(N, settled, lost, rtt); }
    settle(true);
    view.update(N, settled, lost, rtt);
    const got = [...rtt].filter(ok); // в порядке отправки
    return { sent: N, received: got.length, loss: (N - got.length) / N * 100, rtt: median(got), jitter: jitterOf(got) };
  } finally {
    pc.close();
  }
}

// ---------- загрузка ----------
function speedTracker(onTick) {
  const t0 = now();
  let bytes = 0, peak = 0;
  const samples = [[0, 0]];
  const iv = setInterval(() => {
    const t = now() - t0;
    samples.push([t, bytes]);
    // мгновенная скорость по окну ~1 с
    let j = samples.length - 1;
    while (j > 0 && t - samples[j - 1][0] <= 1000) j--;
    const [tw, bw] = samples[j];
    const mbps = t > tw ? (bytes - bw) * 8 / (t - tw) / 1000 : 0;
    if (t >= CFG.graceMs + 1000) peak = Math.max(peak, mbps); // окно целиком после разгона
    onTick(mbps, t);
  }, 100);
  return {
    add(n) { bytes += n; },
    finish() {
      clearInterval(iv);
      const tEnd = now() - t0;
      samples.push([tEnd, bytes]);
      const g = samples.find(s => s[0] >= CFG.graceMs) || samples[0];
      const avg = tEnd > g[0] ? (bytes - g[1]) * 8 / (tEnd - g[0]) / 1000 : 0;
      return { mbps: avg, peak: Math.max(peak, avg), bytes };
    },
  };
}

async function measureDownload(onTick) {
  const ctrl = new AbortController();
  const tr = speedTracker(onTick);
  const ttfb = [];
  let errStatus = 0, okCount = 0;
  const worker = async () => {
    while (!ctrl.signal.aborted) {
      try {
        const t0 = now();
        const r = await fetch(`/api/download?size=${CFG.downChunk}&n=${Math.random()}`, { signal: ctrl.signal, cache: 'no-store' });
        if (!r.ok) { errStatus = r.status; r.body?.cancel(); throw new Error('HTTP ' + r.status); }
        okCount++;
        ttfb.push(now() - t0);
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          tr.add(value.byteLength);
        }
      } catch {
        if (!ctrl.signal.aborted) await sleep(200);
      }
    }
  };
  const workers = Array.from({ length: CFG.downStreams }, worker);
  await sleep(CFG.phaseMs);
  ctrl.abort();
  await Promise.allSettled(workers);
  if (!okCount) throw new Error(`загрузка не удалась${errStatus ? ' (HTTP ' + errStatus + ')' : ''}`);
  return { ...tr.finish(), ttfb: median(ttfb) };
}

let uploadBlob;
function getUploadBlob() {
  if (!uploadBlob) {
    const buf = new Uint8Array(CFG.upChunk);
    for (let i = 0; i < buf.length; i += 65536) crypto.getRandomValues(buf.subarray(i, i + 65536));
    uploadBlob = new Blob([buf]);
  }
  return uploadBlob;
}

async function measureUpload(onTick) {
  const blob = getUploadBlob();
  const tr = speedTracker(onTick);
  const live = new Set();
  let stop = false, errStatus = 0, okCount = 0;
  const worker = () => new Promise(resolve => {
    const next = () => {
      if (stop) return resolve();
      const xhr = new XMLHttpRequest();
      let last = 0;
      xhr.upload.onprogress = e => { tr.add(e.loaded - last); last = e.loaded; };
      xhr.onloadend = () => {
        live.delete(xhr);
        if (stop) return resolve();
        if (xhr.status === 200) { okCount++; tr.add(blob.size - last); return next(); }
        errStatus = xhr.status || errStatus;
        tr.add(-last); // отвергнутый запрос — не трафик
        setTimeout(next, 200);
      };
      xhr.open('POST', `/api/upload?n=${Math.random()}`);
      live.add(xhr);
      xhr.send(blob);
    };
    next();
  });
  const workers = Array.from({ length: CFG.upStreams }, worker);
  await sleep(CFG.phaseMs);
  stop = true;
  const res = tr.finish();
  live.forEach(x => x.abort());
  await Promise.allSettled(workers);
  // медленный канал может не успеть завершить ни одного запроса — это не ошибка
  if (errStatus && !okCount) throw new Error(`отдача не удалась (HTTP ${errStatus})${errStatus === 413 ? ': на прокси нужен client_max_body_size 0' : ''}`);
  return res;
}

// протокол, по которому браузер ходит к серверу
function httpProto() {
  const e = performance.getEntriesByType('resource').find(r => r.name.includes('/api/info') && r.nextHopProtocol)
    || performance.getEntriesByType('navigation')[0];
  return { 'http/1.1': 'HTTP/1.1', h2: 'HTTP/2', h3: 'HTTP/3' }[e?.nextHopProtocol] || '';
}

// ---------- оценки ----------
function bloatGrade(delta) {
  if (!ok(delta)) return ['—', 0];
  if (delta < 5) return ['A+', 4];
  if (delta < 30) return ['A', 4];
  if (delta < 60) return ['B', 3];
  if (delta < 200) return ['C', 2];
  if (delta < 400) return ['D', 1];
  return ['F', 1];
}

const LEVEL_WORD = { 4: 'Отлично', 3: 'Хорошо', 2: 'Средне', 1: 'Плохо' };

// уровень 1…4 и пояснение для каждого сценария
function qualities(r) {
  const loss = ok(r.loss) ? r.loss : 0;
  const loaded = Math.max(r.loadedDown || 0, r.loadedUp || 0);
  const stream =
    r.down >= 25 && loaded < 150 && loss < 1 ? [4, '4K без буферизации'] :
    r.down >= 10 ? [3, 'Full HD без пауз'] :
    r.down >= 4 ? [2, 'SD/HD, возможна буферизация'] : [1, 'Видео будет прерываться'];
  if (!ok(r.ping)) return { stream, game: null, call: null };
  const game =
    r.ping < 30 && r.jitter < 5 && loss < 0.5 && r.bloat < 30 ? [4, 'Минимальная задержка'] :
    r.ping < 60 && r.jitter < 15 && loss < 1.5 ? [3, 'Комфортно для большинства игр'] :
    r.ping < 100 && loss < 3 ? [2, 'Заметные лаги в динамичных играх'] : [1, 'Высокая задержка'];
  const call =
    r.up >= 3 && r.down >= 3 && r.ping < 80 && r.jitter < 20 && loss < 1 ? [4, 'HD-видео без задержек'] :
    r.up >= 1.5 && r.ping < 150 && r.jitter < 40 && loss < 3 ? [3, 'Видео в обычном качестве'] :
    r.up >= 0.5 ? [2, 'Надёжно только голос'] : [1, 'Связь будет прерываться'];
  return { stream, game, call };
}

function setQuality(k, level, word, detail) {
  const el = $(`.q[data-q="${k}"]`);
  if (level) el.dataset.level = level; else el.removeAttribute('data-level');
  $('.q-word', el).textContent = word;
  $('.q-detail', el).textContent = detail;
}

// ---------- отображение ----------
const METRICS = [
  ['down', 'Загрузка', 'Мбит/с'],
  ['up', 'Отдача', 'Мбит/с'],
  ['ping', 'Пинг в покое', 'мс'],
  ['jitter', 'Джиттер', 'мс'],
  ['loadedDown', 'Задержка при загрузке', 'мс'],
  ['loadedUp', 'Задержка при отдаче', 'мс'],
  ['loss', 'Потери пакетов (UDP)', '%'],
  ['udpRtt', 'Задержка UDP', 'мс'],
  ['data', 'Передано данных', ''],
  ['ttfb', 'Время до первого байта', 'мс'],
  ['proto', 'Протокол', ''],
  ['duration', 'Длительность теста', 'с'],
];

function renderMetricsSkeleton() {
  $('#metrics').innerHTML = METRICS.map(([k, name, unit]) =>
    `<div class="m" data-m="${k}"><div class="label">${name}</div><div class="mv"><b class="mono">—</b><span>${unit}</span></div><div class="mh"></div></div>`).join('');
}

function setMetric(k, value, hint = '') {
  const el = $(`[data-m="${k}"]`);
  if (!el) return;
  $('b', el).textContent = value;
  $('.mh', el).textContent = hint;
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

const headline = {
  init() {
    this.down = new Tween(v => { $('#hmDown [data-v]').textContent = this.downSet ? fmtSpeed(v) : '—'; });
    this.up = new Tween(v => { $('#hmUp [data-v]').textContent = this.upSet ? fmtSpeed(v) : '—'; });
  },
  reset() {
    this.downSet = this.upSet = false;
    this.down.set(0, true); this.up.set(0, true);
    for (const id of ['#vPing', '#vJitter', '#vLoss']) $(id).textContent = '—';
  },
};

// phase: ping | udp | down | up
async function setPhase(phase) {
  if (phase === 'ping' || phase === 'udp') {
    latView.show(phase);
  } else {
    if (gauge.mode !== phase) await gauge.drop();
    latView.hide();
    $('#phase').textContent = phase === 'down' ? 'Загрузка' : 'Отдача';
    gauge.setMode(phase);
  }
  $('#hmDown').classList.toggle('active', phase === 'down');
  $('#hmUp').classList.toggle('active', phase === 'up');
}

const steps = {
  el: k => $(`#steps [data-step="${k}"]`),
  reset() {
    for (const li of document.querySelectorAll('#steps li')) { li.className = ''; $('i', li).style.width = '0'; }
  },
  set(k, f) {
    const li = this.el(k);
    li.classList.add('active');
    $('i', li).style.width = Math.min(100, f * 100) + '%';
  },
  done(k) { const li = this.el(k); li.classList.remove('active'); li.classList.add('done'); },
};

// пинг: столбик на каждый замер; потери: ячейка на каждый пакет
const latView = {
  init() {
    this.num = new Tween(v => { $('#latVal').textContent = this.kind === 'udp' ? fmtPct(v) : fmtMs(v); }, 200);
  },
  show(kind) {
    this.kind = kind;
    const viz = $('#latViz');
    this.num.set(0, true);
    $('#latVal').textContent = '—';
    if (kind === 'ping') {
      $('#latTitle').textContent = 'Пинг';
      $('#latUnit').textContent = 'мс';
      $('#latSub').textContent = 'медиана задержки';
      viz.className = 'lat-viz bars';
      viz.innerHTML = '<i></i>'.repeat(CFG.pingCount) + '<div class="med"></div>';
      this.rtts = [];
    } else {
      $('#latTitle').textContent = 'Потери пакетов';
      $('#latUnit').textContent = '%';
      $('#latSub').textContent = 'отправляем пакеты по UDP';
      viz.className = 'lat-viz cells';
      viz.innerHTML = '<i></i>'.repeat(CFG.udpPackets);
    }
    this.cells = viz.querySelectorAll('i');
    $('#gaugeWrap').classList.add('lat');
  },
  hide() { $('#gaugeWrap').classList.remove('lat'); },
  fail(text) { $('#latVal').textContent = 'н/д'; $('#latSub').textContent = text; },
  ping(rtt) {
    this.rtts.push(rtt);
    const max = Math.max(...this.rtts) * 1.15;
    this.rtts.forEach((v, i) => {
      this.cells[i].style.height = Math.max(6, v / max * 100) + '%';
      this.cells[i].classList.add('on');
    });
    const med = median(this.rtts);
    const line = $('#latViz .med');
    line.style.bottom = (med / max * 100) + '%';
    line.classList.add('on');
    this.num.set(med);
    $('#latSub').textContent = `медиана · ${this.rtts.length} из ${CFG.pingCount} замеров`;
  },
  // колбэки для measureUdp
  sent(i) { this.cells[i].classList.add('sent'); },
  echo(i) { this.cells[i].classList.add('ok'); },
  lost(i) { this.cells[i].classList.add('lost'); },
  update(sentN, settled, lost) {
    if (settled) this.num.set(lost / settled * 100);
    steps.set('udp', sentN / CFG.udpPackets);
    const got = this.cells.length ? [...this.cells].filter(c => c.classList.contains('ok')).length : 0;
    $('#latSub').textContent = `вернулось ${got} из ${sentN}`;
  },
};

// ---------- информация о подключении ----------
let info = null;
function flagEmoji(cc) {
  if (!/^[A-Z]{2}$/.test(cc || '')) return '';
  return String.fromCodePoint(...[...cc].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}
const regionNames = (() => { try { return new Intl.DisplayNames(['ru'], { type: 'region' }); } catch { return null; } })();

async function loadInfo() {
  try {
    const r = await fetch('/api/info', { cache: 'no-store' });
    info = await r.json();
  } catch {
    $('#ip').textContent = 'нет связи с сервером';
    $('#ip').classList.remove('skel');
    return;
  }
  $('#ip').textContent = info.ip;
  $('#ip').classList.remove('skel');
  const ver = $('#ipVer');
  ver.textContent = 'IPv' + info.version;
  ver.hidden = false;
  if (info.server?.name) { $('#brandName').textContent = info.server.name; document.title = info.server.name + ' — проверка скорости интернета'; }
  $('#server').innerHTML = esc(info.server?.name || '—') + (info.server?.location ? `<small>${esc(info.server.location)}</small>` : '');

  const g = info.geo || {};
  if (info.private) {
    $('#country').innerHTML = 'Локальная сеть<small>частный адрес</small>';
    $('#city').textContent = '—';
    $('#isp').textContent = '—';
  } else if (!info.geoReady && !g.countryCode) {
    for (const id of ['#country', '#city', '#isp']) $(id).innerHTML = '<span class="label">база загружается…</span>';
    setTimeout(loadInfo, 8000);
  } else {
    const cname = (g.countryCode && regionNames?.of(g.countryCode)) || g.country || '—';
    $('#country').innerHTML = `<span class="flag">${flagEmoji(g.countryCode)}</span>${esc(cname)}` + (g.countryCode ? `<small>${esc(g.countryCode)}</small>` : '');
    $('#city').innerHTML = esc(g.city || '—') + (g.region && g.region !== g.city ? `<small>${esc(g.region)}</small>` : '');
    $('#isp').innerHTML = esc(g.org || '—') + (g.asn ? `<small>AS${g.asn}</small>` : '');
  }
}

// ---------- история ----------
const HIST_KEY = 'st.history';
function loadHist() { try { return JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch { return []; } }
function saveHist(h) { try { localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, 30))); } catch {} }
function renderHist() {
  const h = loadHist();
  $('#hist tbody').innerHTML = h.map(r => `<tr>
    <td>${new Date(r.ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
    <td>${fmtSpeed(r.down)}</td><td>${fmtSpeed(r.up)}</td><td>${fmtMs(r.ping)} мс</td><td>${fmtMs(r.jitter)} мс</td>
    <td>${ok(r.loss) ? fmtPct(r.loss) + ' %' : '—'}</td><td>${esc(r.grade || '—')}</td><td class="mono">${esc(r.ip || '')}</td></tr>`).join('');
  $('#histEmpty').hidden = h.length > 0;
  $('#hist').hidden = !h.length;
  $('#clearHist').hidden = !h.length;
}

// ---------- сам тест ----------
let running = false, lastResult = null;

async function runTest() {
  if (running) return;
  running = true;
  const t0 = now();
  const res = { ts: Date.now(), ip: info?.ip };
  document.body.classList.add('testing');
  $('#startBtn').classList.add('out');
  $('#readout').hidden = false;
  $('#copyRes').hidden = true;
  headline.reset();
  chart.reset();
  renderMetricsSkeleton();
  for (const k of ['stream', 'game', 'call']) setQuality(k, 0, '—', 'Ожидание теста');
  setQuality('bloat', 0, '—', 'Рост задержки под нагрузкой');
  steps.reset();

  const pinger = new Pinger();
  try {
    // 1. задержка в покое
    await setPhase('ping');
    steps.set('ping', 0);
    let wsOk = true;
    try { await pinger.open(); } catch { wsOk = false; }
    if (wsOk) {
      const lat = await measureLatency(pinger, (rtt, f) => { latView.ping(rtt); $('#vPing').textContent = fmtMs(rtt); steps.set('ping', f); });
      Object.assign(res, { ping: lat.median, jitter: lat.jitter });
      $('#vPing').textContent = fmtMs(lat.median);
      $('#vJitter').textContent = fmtMs(lat.jitter);
      setMetric('ping', fmtMs(lat.median), `мин ${fmtMs(lat.min)} · ср ${fmtMs(lat.avg)} · макс ${fmtMs(lat.max)}`);
      setMetric('jitter', fmtMs(lat.jitter), `σ ${fmtMs(lat.stdev)} мс · ${CFG.pingCount} замеров`);
    } else {
      latView.fail('WebSocket недоступен — проверьте прокси');
      await sleep(1200);
      $('#vPing').textContent = $('#vJitter').textContent = 'н/д';
      setMetric('ping', 'н/д', 'WebSocket недоступен — проверьте прокси');
      setMetric('jitter', 'н/д', '');
    }
    await sleep(500); // дать рассмотреть итог
    steps.done('ping');

    // 2. потери пакетов
    await setPhase('udp');
    steps.set('udp', 0);
    try {
      if (!info?.udp || !window.RTCPeerConnection) throw new Error('UDP-тест недоступен');
      const udp = await measureUdp(latView);
      latView.num.set(udp.loss);
      $('#latSub').textContent = `вернулось ${udp.received} из ${udp.sent} · UDP ${fmtMs(udp.rtt)} мс`;
      Object.assign(res, { loss: udp.loss, udpRtt: udp.rtt, udpJitter: udp.jitter });
      $('#vLoss').textContent = fmtPct(udp.loss);
      setMetric('loss', fmtPct(udp.loss), `получено ${udp.received} из ${udp.sent} пакетов`);
      setMetric('udpRtt', fmtMs(udp.rtt), `джиттер UDP ${fmtMs(udp.jitter)} мс`);
    } catch (e) {
      latView.fail('UDP заблокирован или недоступен');
      $('#vLoss').textContent = 'н/д';
      setMetric('loss', 'н/д', 'UDP заблокирован или недоступен');
      setMetric('udpRtt', 'н/д', '');
    }
    await sleep(900);
    steps.done('udp');

    // 3. загрузка
    await setPhase('down');
    headline.downSet = true;
    const tDown = now();
    const stopDL = pinger.startLoaded(rtt => chart.push('ping', (now() - tDown) / 1000, rtt));
    const down = await measureDownload((mbps, t) => {
      gauge.set(mbps); headline.down.set(mbps);
      chart.push('down', t / 1000, mbps);
      steps.set('down', t / CFG.phaseMs);
    });
    const loadedDown = stopDL();
    res.down = down.mbps;
    res.loadedDown = median(loadedDown);
    headline.down.set(down.mbps);
    setMetric('down', fmtSpeed(down.mbps), `пик ${fmtSpeed(down.peak)} Мбит/с · ${CFG.downStreams} потоков`);
    setMetric('loadedDown', fmtMs(res.loadedDown), ok(res.loadedDown) ? `+${fmtMs(Math.max(0, res.loadedDown - res.ping))} мс к покою · джиттер ${fmtMs(jitterOf(loadedDown))}` : '');
    setMetric('ttfb', fmtMs(down.ttfb), 'медиана по запросам загрузки');
    steps.done('down');

    // 4. отдача
    await setPhase('up');
    headline.upSet = true;
    const tUp = now();
    const stopUL = pinger.startLoaded(rtt => chart.push('ping', (now() - tUp) / 1000, rtt));
    const up = await measureUpload((mbps, t) => {
      gauge.set(mbps); headline.up.set(mbps);
      chart.push('up', t / 1000, mbps);
      steps.set('up', t / CFG.phaseMs);
    });
    const loadedUp = stopUL();
    res.up = up.mbps;
    res.loadedUp = median(loadedUp);
    headline.up.set(up.mbps);
    setMetric('up', fmtSpeed(up.mbps), `пик ${fmtSpeed(up.peak)} Мбит/с · ${CFG.upStreams} потока`);
    setMetric('loadedUp', fmtMs(res.loadedUp), ok(res.loadedUp) ? `+${fmtMs(Math.max(0, res.loadedUp - res.ping))} мс к покою · джиттер ${fmtMs(jitterOf(loadedUp))}` : '');
    steps.done('up');

    // итоги
    res.duration = (now() - t0) / 1000;
    setMetric('data', fmtBytes(down.bytes + up.bytes), `↓ ${fmtBytes(down.bytes)} · ↑ ${fmtBytes(up.bytes)}`);
    const proto = httpProto();
    setMetric('proto', proto || '—', /HTTP\/[23]/.test(proto)
      ? 'одно соединение на все потоки — скорость может быть занижена'
      : `${location.protocol === 'https:' ? 'TLS · ' : ''}IPv${info?.version ?? '?'}`);
    setMetric('duration', res.duration.toFixed(1), 'пинг, UDP, загрузка, отдача');

    const loadedMax = Math.max(...[res.loadedDown, res.loadedUp].filter(ok));
    res.bloat = ok(loadedMax) && ok(res.ping) ? loadedMax - res.ping : NaN;
    const [grade, lvl] = bloatGrade(res.bloat);
    res.grade = grade;
    setQuality('bloat', lvl, lvl ? `${LEVEL_WORD[lvl]} · ${grade}` : '—',
      !ok(res.bloat) ? 'Нет данных' : res.bloat < 1 ? 'Задержка под нагрузкой не растёт' : `+${fmtMs(res.bloat)} мс к задержке под нагрузкой`);
    for (const [k, q] of Object.entries(qualities(res))) {
      q ? setQuality(k, q[0], LEVEL_WORD[q[0]], q[1]) : setQuality(k, 0, '—', 'Нет данных о задержке');
    }

    lastResult = res;
    const h = loadHist();
    h.unshift(res);
    saveHist(h);
    renderHist();
  } catch (e) {
    console.error(e);
    toast('Тест прерван: ' + (e.message || e));
    $('#phase').textContent = 'Ошибка';
  } finally {
    pinger.close();
    $('#hmDown').classList.remove('active');
    $('#hmUp').classList.remove('active');
    $('#copyRes').hidden = !lastResult;
    // итоги остаются в карточках и на графике, спидометр возвращается к кнопке
    await gauge.drop();
    document.body.classList.remove('testing');
    $('#readout').hidden = true;
    $('#startBtn span').textContent = 'Ещё раз';
    $('#startBtn').classList.remove('out');
    running = false;
  }
}

function resultText(r) {
  return [
    `Скорость интернета — ${new Date(r.ts).toLocaleString('ru-RU')}`,
    `Загрузка: ${fmtSpeed(r.down)} Мбит/с`,
    `Отдача: ${fmtSpeed(r.up)} Мбит/с`,
    `Пинг: ${fmtMs(r.ping)} мс, джиттер ${fmtMs(r.jitter)} мс`,
    `Потери: ${ok(r.loss) ? fmtPct(r.loss) + ' %' : 'н/д'}`,
    `Задержка под нагрузкой: ↓ ${fmtMs(r.loadedDown)} мс, ↑ ${fmtMs(r.loadedUp)} мс (bufferbloat ${r.grade})`,
    `IP: ${r.ip || '—'}`,
  ].join('\n');
}

// ---------- запуск ----------
document.addEventListener('DOMContentLoaded', () => {
  gauge.init();
  latView.init();
  chart.init();
  headline.init();
  renderMetricsSkeleton();
  renderHist();
  loadInfo();
  setTimeout(getUploadBlob, 1500); // подготовим данные для отдачи заранее

  $('#startBtn').addEventListener('click', runTest);
  $('#copyIp').addEventListener('click', () => info?.ip && copy(info.ip));
  $('#copyRes').addEventListener('click', () => lastResult && copy(resultText(lastResult)));
  $('#clearHist').addEventListener('click', () => { saveHist([]); renderHist(); });
});
