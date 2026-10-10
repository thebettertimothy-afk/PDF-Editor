import { PDFDocument, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
export { workerUrl };
export type Page = { d: number; i: number; rot: number; id: string };
export type Src = { name: string; bytes: Uint8Array; js: pdfjs.PDFDocumentProxy; n: number };
export type Part = { pages: Page[]; bytes: Uint8Array; over: boolean };
let uid = 0;
export const newId = () => String(++uid);

export async function openSrc(f: File): Promise<Src> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  const js = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  return { name: f.name, bytes, js, n: js.numPages };
}
export async function render(canvas: HTMLCanvasElement, s: Src, p: Page, width: number, zoom = 1) {
  const pg = await s.js.getPage(p.i + 1);
  const rotation = (pg.rotate + p.rot) % 360;
  const w1 = pg.getViewport({ scale: 1, rotation }).width;
  const scale = (width / w1) * zoom;
  const dpr = window.devicePixelRatio || 1;
  const v = pg.getViewport({ scale: scale * dpr, rotation });
  canvas.width = v.width; canvas.height = v.height;
  canvas.style.width = v.width / dpr + 'px';
  const task = pg.render({ canvasContext: canvas.getContext('2d')!, viewport: v });
  return task;
}
// Builds a PDF from page refs. Consecutive same-source pages are copied in one call so shared resources stay shared.
export async function build(srcs: Src[], pages: Page[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const docs = new Map<number, PDFDocument>();
  let k = 0;
  while (k < pages.length) {
    const d = pages[k].d, run: Page[] = [], seen = new Set<number>();
    while (k < pages.length && pages[k].d === d && !seen.has(pages[k].i)) { seen.add(pages[k].i); run.push(pages[k++]); }
    let doc = docs.get(d);
    if (!doc) { doc = await PDFDocument.load(srcs[d].bytes); docs.set(d, doc); }
    const cps = await out.copyPages(doc, run.map(r => r.i));
    cps.forEach((cp, j) => {
      if (run[j].rot) cp.setRotation(degrees((cp.getRotation().angle + run[j].rot) % 360));
      out.addPage(cp);
    });
  }
  return out.save();
}
export async function verify(bytes: Uint8Array, expected: number) {
  const n = (await PDFDocument.load(bytes)).getPageCount();
  if (n !== expected) throw new Error(`Validation failed: ${n} pages, expected ${expected}`);
}
export function parseRanges(s: string, n: number): number[][] {
  return s.split(',').map(t => t.trim()).filter(Boolean).map(t => {
    const m = t.match(/^(\d*)\s*-?\s*(\d*)$/);
    if (!m || (!m[1] && !m[2])) throw new Error(`Bad range "${t}"`);
    const a = m[1] ? +m[1] : 1;
    const b = t.includes('-') ? (m[2] ? +m[2] : n) : a;
    if (a < 1 || b > n || a > b) throw new Error(`Range "${t}" outside 1-${n}`);
    return Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i);
  });
}
export async function makeParts(srcs: Src[], pages: Page[], groups: Page[][], onP: (m: string) => void): Promise<Part[]> {
  const out: Part[] = [];
  for (const g of groups) {
    onP(`Building part ${out.length + 1}/${groups.length}`);
    const bytes = await build(srcs, g); await verify(bytes, g.length);
    out.push({ pages: g, bytes, over: false });
  }
  return out;
}
// Greedy target-size split: for each part, measure real serialized size and binary-search the largest page count under the limit.
// Assumes size grows with page count (usually true). Outputs are held in memory until saved.
export async function splitBySize(srcs: Src[], pages: Page[], limit: number, onP: (m: string) => void): Promise<Part[]> {
  const out: Part[] = [];
  let i = 0;
  while (i < pages.length) {
    onP(`Measuring part ${out.length + 1} (page ${i + 1}/${pages.length})`);
    let best = await build(srcs, pages.slice(i, i + 1)), bn = 1;
    if (best.length > limit) { out.push({ pages: pages.slice(i, i + 1), bytes: best, over: true }); i++; continue; }
    let lo = 2, hi = pages.length - i;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, b = await build(srcs, pages.slice(i, i + mid));
      if (b.length <= limit) { best = b; bn = mid; lo = mid + 1; } else hi = mid - 1;
    }
    await verify(best, bn);
    out.push({ pages: pages.slice(i, i + bn), bytes: best, over: false });
    i += bn;
  }
  return out;
}
const T = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Uint8Array) => { let c = ~0; for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8); return ~c >>> 0; };
// Store-only ZIP (PDFs are already compressed), so many parts can be saved as ONE download.
export function zip(files: { name: string; data: Uint8Array }[]): Blob {
  const enc = new TextEncoder(), parts: BlobPart[] = [], cd: BlobPart[] = []; let off = 0, cs = 0;
  for (const f of files) {
    const n = enc.encode(f.name), c = crc(f.data), L = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true); h.setUint32(14, c, true);
    h.setUint32(18, L, true); h.setUint32(22, L, true); h.setUint16(26, n.length, true);
    parts.push(h.buffer, n, f.data as BlobPart);
    const d = new DataView(new ArrayBuffer(46));
    d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x800, true);
    d.setUint32(16, c, true); d.setUint32(20, L, true); d.setUint32(24, L, true); d.setUint16(28, n.length, true); d.setUint32(42, off, true);
    cd.push(d.buffer, n); off += 30 + n.length + L; cs += 46 + n.length;
  }
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cs, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cd, e.buffer], { type: 'application/zip' });
}
export async function save(name: string, data: Uint8Array | Blob) {
  const type = name.endsWith('.zip') ? 'application/zip' : 'application/pdf';
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const w = window as any;
  if (w.showSaveFilePicker) {
    try {
      const h = await w.showSaveFilePicker({ suggestedName: name, types: [{ accept: { [type]: [name.slice(name.lastIndexOf('.'))] } }] });
      const s = await h.createWritable(); await s.write(blob); await s.close(); return;
    } catch (e: any) { if (e.name === 'AbortError') throw e; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
export async function takeShared(): Promise<File[]> {
  if (!/[?&]shared=/.test(location.search)) return [];
  const c = await caches.open('pdfws-share'), fs: File[] = [];
  for (const r of await c.keys()) { const x = await c.match(r); if (x) fs.push(new File([await x.blob()], decodeURIComponent(x.headers.get('x-name') || 'shared.pdf'), { type: 'application/pdf' })); await c.delete(r); }
  history.replaceState(null, '', location.pathname);
  return fs;
}
