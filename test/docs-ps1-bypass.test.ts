import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ocrInstallHint } from '../src/tools/ocr-local.js';

// En un Windows recién instalado la política de ejecución de PowerShell bloquea los
// .ps1 («la ejecución de scripts está deshabilitada»). Toda orden que mandemos
// copiar para lanzar un .ps1 lleva `powershell -ExecutionPolicy Bypass -File …`.
const root = join(import.meta.dirname, '..');
const dirs = ['docs', 'deploy', 'scripts', 'src'];
const saltar = new Set(['node_modules', 'dist', 'coverage', '.venv', '.git']);

function ficheros(dir: string): string[] {
  const out: string[] = [];
  let nombres: string[] = [];
  try {
    nombres = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of nombres) {
    if (saltar.has(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...ficheros(p));
    else if (/\.(md|bat|cmd|ts)$/.test(n)) out.push(p);
  }
  return out;
}

/** ¿Este trozo de orden lanza un .ps1 sin saltarse la política de ejecución? */
function lanzaPs1SinBypass(seg: string, enBloque: boolean): boolean {
  const s = seg.trim();
  if (/-ExecutionPolicy\s+Bypass/i.test(s)) return false;
  if (/\b(powershell|pwsh)(\.exe)?\b/i.test(s) && /(-File\b|\.ps1\b)/i.test(s)) return true;
  const m = /^(?:&\s*)?["']?((?:\.\\|\.\/)?[\w\\/.:%~-]*\.ps1)["']?(\s+.*)?$/i.exec(s);
  if (!m) return false;
  return enBloque || Boolean(m[2]?.trim()) || /^\.[\\/]/.test(m[1] ?? '');
}

function malosEn(f: string): string[] {
  const rel = f.slice(root.length + 1);
  const malos: string[] = [];
  const lineas = readFileSync(f, 'utf8').split('\n');
  let bloque = false;
  lineas.forEach((l, i) => {
    if (!/ps1|powershell|pwsh/i.test(l) && !/^\s*```/.test(l)) return;
    let segs: Array<[string, boolean]> = [];
    if (f.endsWith('.md')) {
      if (/^\s*```/.test(l)) {
        bloque = !bloque;
        return;
      }
      segs = bloque ? [[l, true]] : [...l.matchAll(/`([^`]+)`/g)].map((m) => [m[1] ?? '', false]);
    } else if (/\.(bat|cmd)$/.test(f)) {
      segs = [[l.replace(/^\s*@?/, ''), false]];
    } else {
      // .ts: solo pistas de texto con argumentos («setup.ps1 -Model …»).
      if (/\.ps1 -[A-Za-z]/.test(l) && !/-ExecutionPolicy\s+Bypass/i.test(l))
        malos.push(`${rel}:${i + 1}`);
      return;
    }
    if (segs.some(([s, b]) => lanzaPs1SinBypass(s, b))) malos.push(`${rel}:${i + 1}`);
  });
  return malos;
}

describe('órdenes .ps1 con -ExecutionPolicy Bypass', () => {
  it('README, docs, deploy, scripts y .bat no mandan lanzar un .ps1 a pelo', () => {
    const todos = [
      ...dirs.flatMap((d) => ficheros(join(root, d))),
      ...readdirSync(root)
        .filter((n) => /^README\.md$|\.(bat|cmd)$/i.test(n))
        .map((n) => join(root, n)),
    ];
    expect(todos.length).toBeGreaterThan(10);
    expect(todos.flatMap(malosEn)).toEqual([]);
  });

  it('la regla distingue una orden de una simple mención', () => {
    expect(lanzaPs1SinBypass('scripts\\ocr-sidecar\\setup.ps1 -Model glm', false)).toBe(true);
    expect(lanzaPs1SinBypass('scripts\\ocr-sidecar\\setup.ps1', true)).toBe(true);
    expect(lanzaPs1SinBypass('.\\instalar.ps1', false)).toBe(true);
    expect(lanzaPs1SinBypass('powershell -File deploy\\x.ps1', false)).toBe(true);
    expect(lanzaPs1SinBypass('pwsh -File ...', false)).toBe(true);
    expect(
      lanzaPs1SinBypass('powershell -ExecutionPolicy Bypass -File deploy\\x.ps1 -Start', false),
    ).toBe(false);
    expect(lanzaPs1SinBypass('deploy/browserd/setup-browserd.ps1', false)).toBe(false);
    expect(lanzaPs1SinBypass('tv-install.ps1', false)).toBe(false);
  });

  it('la pista del OCR local en el chat también lleva el Bypass', () => {
    const pista = ocrInstallHint('glm');
    expect(pista).toContain(
      'powershell -ExecutionPolicy Bypass -File scripts\\ocr-sidecar\\setup.ps1 -Model glm',
    );
  });
});
