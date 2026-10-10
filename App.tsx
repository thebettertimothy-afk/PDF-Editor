import { useEffect, useRef, useState } from 'react';
import { Page, Part, Src, build, makeParts, newId, openSrc, parseRanges, render, save, splitBySize, takeShared, verify, zip } from './engine';

function Canvas({ s, p, width, zoom = 1, lazy = false }: { s: Src; p: Page; width: number; zoom?: number; lazy?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [vis, setVis] = useState(!lazy);
  useEffect(() => {
    if (!lazy) return;
    const o = new IntersectionObserver(e => e[0].isIntersecting && setVis(true));
    o.observe(ref.current!); return () => o.disconnect();
  }, [lazy]);
  useEffect(() => {
    if (!vis || width < 10) return;
    let t: { cancel: () => void } | undefined, dead = false;
    render(ref.current!, s, p, width, zoom).then(r => { if (dead) r.cancel(); else t = r; return r.promise; }).catch(() => {});
    return () => { dead = true; t?.cancel(); };
  }, [vis, s, p.d, p.i, p.rot, width, zoom]);
  return <canvas ref={ref} style={{ minHeight: lazy ? 60 : 0 }} />;
}

export default function App() {
  const [srcs, setSrcs] = useState<Src[]>([]);
  const [pages, setPages] = useState<Page[]>([]);
  const [hist, setHist] = useState<Page[][]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [selMode, setSelMode] = useState(false);
  const [cur, setCur] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [side, setSide] = useState(true);
  const [tool, setTool] = useState(false);
  const [mode, setMode] = useState<'ranges' | 'fixed' | 'size'>('fixed');
  const [val, setVal] = useState('10');
  const [unit, setUnit] = useState(1e6);
  const [asZip, setAsZip] = useState(true);
  const [log, setLog] = useState('');
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [vw, setVw] = useState(600);
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const addRef = useRef(false);
  const st = useRef({ pages, srcs, zoom }); st.current = { pages, srcs, zoom };

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    addEventListener('online', on); addEventListener('offline', off);
    const ro = new ResizeObserver(e => setVw(e[0].contentRect.width - 16)); ro.observe(box.current!);
    // pinch to zoom
    const el = box.current!; let d0 = 0, r = 1;
    const dist = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    const ts = (e: TouchEvent) => { if (e.touches.length === 2) { d0 = dist(e); r = 1; } };
    const tm = (e: TouchEvent) => { if (e.touches.length === 2 && d0) { r = Math.min(4 / st.current.zoom, Math.max(.25 / st.current.zoom, dist(e) / d0)); if (inner.current) { inner.current.style.transformOrigin = 'top center'; inner.current.style.transform = `scale(${r})`; } } };
    const te = () => { if (d0) { d0 = 0; if (inner.current) inner.current.style.transform = ''; setZoom(z => Math.round(z * r * 100) / 100); r = 1; } };
    el.addEventListener('touchstart', ts, { passive: true }); el.addEventListener('touchmove', tm, { passive: true }); el.addEventListener('touchend', te);
    takeShared().then(f => { if (f.length) loadFiles(f, false); }).catch(() => {});
    return () => { removeEventListener('online', on); removeEventListener('offline', off); ro.disconnect(); el.removeEventListener('touchstart', ts); el.removeEventListener('touchmove', tm); el.removeEventListener('touchend', te); };
  }, []);

  const edit = (f: (p: Page[]) => Page[]) => { setHist(h => [...h, pages]); const n = f(pages); setPages(n); setCur(c => Math.min(c, Math.max(0, n.length - 1))); };
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try { await f(); } catch (e: any) { if (e?.name !== 'AbortError') setLog(l => l + '\nERROR: ' + (e?.message || e)); }
    setBusy(false);
  };
  const loadFiles = (files: File[], add: boolean) => run(async () => {
    const S = st.current, base = add ? S.srcs.length : 0, ns: Src[] = [];
    for (const f of files) { setLog(`Opening ${f.name}…`); ns.push(await openSrc(f)); }
    const np = ns.flatMap((s, k) => Array.from({ length: s.n }, (_, i) => ({ d: base + k, i, rot: 0, id: newId() })));
    if (add) { setHist(h => [...h, S.pages]); setSrcs([...S.srcs, ...ns]); setPages([...S.pages, ...np]); }
    else { setSrcs(ns); setPages(np); setHist([]); setCur(0); setSel([]); }
    setLog(`Loaded ${ns.map(s => `${s.name} (${s.n} p)`).join(', ')}`);
  });
  const pick = (add: boolean) => { addRef.current = add; if (fileRef.current) { fileRef.current.value = ''; fileRef.current.click(); } };
  const ids = new Set(sel);
  const target = () => (sel.length ? pages.filter(p => ids.has(p.id)) : pages.slice(cur, cur + 1));
  const rot = (d: number) => { const t = new Set(target().map(p => p.id)); edit(ps => ps.map(p => t.has(p.id) ? { ...p, rot: (p.rot + d + 360) % 360 } : p)); };
  const del = () => { const t = new Set(target().map(p => p.id)); if (t.size < pages.length) edit(ps => ps.filter(p => !t.has(p.id))); setSel([]); };
  const dup = () => { const t = new Set(target().map(p => p.id)); edit(ps => ps.flatMap(p => t.has(p.id) ? [p, { ...p, id: newId() }] : [p])); };
  const move = (d: number) => { const t = new Set(target().map(p => p.id)); edit(ps => {
    const a = [...ps]; const idx = d < 0 ? a.map((_, i) => i) : a.map((_, i) => a.length - 1 - i);
    for (const i of idx) { const j = i + d; if (t.has(a[i].id) && j >= 0 && j < a.length && !t.has(a[j].id)) [a[i], a[j]] = [a[j], a[i]]; }
    return a; }); };
  const base = (srcs[0]?.name || 'document').replace(/\.pdf$/i, '');
  const exportPages = (ps: Page[], suf: string) => run(async () => {
    setLog('Building…'); const b = await build(srcs, ps); await verify(b, ps.length);
    const n = `${base}-${suf}.pdf`; await save(n, b); setLog(`Saved ${n} — ${ps.length} pages, ${(b.length / 1e6).toFixed(2)} MB`);
  });
  const doSplit = () => run(async () => {
    let parts: Part[]; const say = (m: string) => setLog(m);
    if (mode === 'ranges') parts = await makeParts(srcs, pages, parseRanges(val, pages.length).map(r => r.map(i => pages[i])), say);
    else if (mode === 'fixed') {
      const n = Math.floor(+val); if (!(n >= 1)) throw new Error('Enter a page count ≥ 1');
      const g: Page[][] = []; for (let i = 0; i < pages.length; i += n) g.push(pages.slice(i, i + n));
      parts = await makeParts(srcs, pages, g, say);
    } else { const lim = +val * unit; if (!(lim > 0)) throw new Error('Enter a size'); parts = await splitBySize(srcs, pages, lim, say); }
    const files = parts.map((p, k) => ({ name: `${base}-part-${String(k + 1).padStart(2, '0')}.pdf`, data: p.bytes }));
    const lines = parts.map((p, k) => `${files[k].name}: ${p.pages.length} p, ${(p.bytes.length / 1e6).toFixed(2)} MB${p.over ? ' ⚠ one page exceeds target (kept oversized)' : ''}`);
    const tot = parts.reduce((a, p) => a + p.pages.length, 0);
    if (asZip && files.length > 1) { await save(`${base}-parts.zip`, zip(files)); }
    else for (const f of files) { await save(f.name, f.data); await new Promise(r => setTimeout(r, 500)); }
    setLog(`${parts.length} parts saved (${tot}/${pages.length} pages)${asZip && files.length > 1 ? ' in 1 ZIP' : ''}\n` + lines.join('\n'));
  });

  const has = pages.length > 0, c = pages[cur];
  const A = (i: string, l: string, f: () => void, dis = !has || busy, on = false) => <button className={on ? 'on' : ''} onClick={f} disabled={dis}><i>{i}</i>{l}</button>;
  const acting = sel.length ? `${sel.length} selected` : `page ${cur + 1}`;
  return <div className="app">
    <input ref={fileRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={e => loadFiles(Array.from(e.target.files || []), addRef.current)} />
    {has && <div className="bar">
      <button onClick={() => setSide(!side)}>☰</button>
      <button onClick={() => setCur(Math.max(0, cur - 1))}>‹</button>
      <input type="number" inputMode="numeric" style={{ width: 64, textAlign: 'center' }} value={cur + 1} onChange={e => setCur(Math.min(pages.length, Math.max(1, +e.target.value || 1)) - 1)} />
      <span>/ {pages.length}</span>
      <button onClick={() => setCur(Math.min(pages.length - 1, cur + 1))}>›</button>
      <button onClick={() => setZoom(Math.max(.25, zoom - .25))}>−</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom(Math.min(4, zoom + .25))}>+</button>
      <span style={{ fontSize: 12 }}>{hist.length ? '● unsaved ' : ''}{online ? '' : '· offline'}</span>
    </div>}
    {tool && has && <div className="panel">
      <select value={mode} onChange={e => { const m = e.target.value as any; setMode(m); setVal(m === 'ranges' ? '1-3,4-' : m === 'fixed' ? '10' : '5'); }}>
        <option value="fixed">Every N pages</option><option value="ranges">Page ranges</option><option value="size">Max size / file</option></select>
      <input value={val} onChange={e => setVal(e.target.value)} style={{ width: 120 }} />
      {mode === 'size' && <select value={unit} onChange={e => setUnit(+e.target.value)}><option value={1e6}>MB (10⁶)</option><option value={1048576}>MiB (2²⁰)</option></select>}
      <label><input type="checkbox" checked={asZip} onChange={e => setAsZip(e.target.checked)} style={{ minHeight: 0 }} /> one ZIP</label>
      <button className="on" disabled={busy} onClick={doSplit}>Run split</button>
    </div>}
    <div className="main">
      {side && has && <div className="side">{pages.map((p, k) => <div key={p.id} className={'th' + (ids.has(p.id) ? ' sel' : '') + (k === cur ? ' cur' : '')}
        onClick={() => selMode ? setSel(s => s.includes(p.id) ? s.filter(x => x !== p.id) : [...s, p.id]) : setCur(k)}>
        <b>{k + 1}</b><Canvas s={srcs[p.d]} p={p} width={110} lazy /></div>)}</div>}
      <div className="view" ref={box}><div ref={inner}>{c ? <Canvas s={srcs[c.d]} p={c} width={vw} zoom={zoom} /> :
        <div className="empty"><button onClick={() => pick(false)} disabled={busy}>Open PDF</button><span>Select several PDFs to merge them</span></div>}</div></div>
    </div>
    <div className={'status' + (log.includes('ERROR') ? ' err' : '')}>{busy ? '⏳ ' : ''}{log || 'Ready.'}{has ? `  ·  actions apply to: ${acting}` : ''}</div>
    <div className="abar">
      {A('📂', 'Open', () => pick(false), busy, false)}{A('➕', 'Add/Merge', () => pick(true))}
      {A('☑', selMode ? 'Select ON' : 'Select', () => setSelMode(!selMode), !has, selMode)}
      {A('☰', 'All', () => setSel(sel.length ? [] : pages.map(p => p.id)))}
      {A('⟲', 'Left', () => rot(-90))}{A('⟳', 'Right', () => rot(90))}{A('◀', 'Earlier', () => move(-1))}{A('▶', 'Later', () => move(1))}
      {A('⧉', 'Duplicate', dup)}{A('🗑', 'Delete', del)}{A('↩', 'Undo', () => { setPages(hist[hist.length - 1]); setHist(hist.slice(0, -1)); }, !hist.length || busy)}
      {A('✂', 'Extract', () => exportPages(target(), 'extract'))}{A('⫿', 'Split', () => setTool(!tool), !has, tool)}
      {A('💾', 'Save As', () => exportPages(pages, hist.length ? 'edited' : 'copy'))}
    </div>
  </div>;
}
