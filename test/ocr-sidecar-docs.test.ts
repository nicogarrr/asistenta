import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('sidecar y documentación', () => {
  it('trae el script, los requisitos de cada motor y la instalación para Windows y Linux', () => {
    const dir = 'scripts/ocr-sidecar';
    const py = readFileSync(`${dir}/ocr_sidecar.py`, 'utf8');
    expect(py).toMatch(/"missing_engine"/);
    expect(py).toMatch(/zai-org\/GLM-OCR/);
    expect(readFileSync(`${dir}/requirements-ppocr.txt`, 'utf8')).toMatch(/^rapidocr/m);
    expect(readFileSync(`${dir}/requirements-glm.txt`, 'utf8')).toMatch(/^transformers/m);
    expect(readFileSync(`${dir}/setup.ps1`, 'utf8')).toMatch(/ValidateSet\('ppocr', 'glm'\)/);
    expect(readFileSync(`${dir}/setup.sh`, 'utf8')).toMatch(/ppocr\|glm/);
  });

  it('el README explica el OCR local con sus licencias y .env.example sus variables', () => {
    const readme = readFileSync('README.md', 'utf8');
    const sec = readme.slice(readme.indexOf('## OCR local (opcional)'));
    expect(sec).toMatch(/Apache-2\.0/);
    expect(sec).toMatch(/MIT/);
    expect(sec).toMatch(/94,5 %.*1,3.*0,8 GB/);
    const env = readFileSync('.env.example', 'utf8');
    expect(env).toMatch(/^# PA_OCR_LOCAL=1/m);
    expect(env).toMatch(/^# PA_OCR_MODEL=ppocr/m);
  });
});
