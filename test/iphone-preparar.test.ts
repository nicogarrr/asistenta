import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = 'deploy/iphone';
const run = (key: string, env: string) =>
  spawnSync('bash', [`${DIR}/set-key.sh`, env], { input: key, encoding: 'utf8' });

describe('set-key.sh: la clave de Gemini entra por stdin', () => {
  it('sustituye LLM_API_KEY sin tocar el resto, con permisos 600 y sin imprimir la clave', () => {
    const env = join(mkdtempSync(join(tmpdir(), 'pk-')), '.env');
    writeFileSync(env, "A=1\nLLM_API_KEY=\nPORT=8890\nLLM_MODEL='x'\n");
    chmodSync(env, 0o644);
    const secreto = 'AIza$&\\/weird"key';
    const r = run(`${secreto}\n`, env);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toContain('AIza');
    expect(readFileSync(env, 'utf8')).toBe(
      `A=1\nLLM_API_KEY=${secreto}\nPORT=8890\nLLM_MODEL='x'\n`,
    );
    expect(statSync(env).mode & 0o777).toBe(0o600);
  });

  it('con clave vacía no guarda nada y lo dice', () => {
    const env = join(mkdtempSync(join(tmpdir(), 'pk-')), '.env');
    writeFileSync(env, 'LLM_API_KEY=vieja\n');
    const r = run('\n', env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Clave vacia');
    expect(readFileSync(env, 'utf8')).toBe('LLM_API_KEY=vieja\n');
  });
});

describe('preparar-iphone: el asistente no filtra secretos', () => {
  const ps1 = readFileSync(`${DIR}/preparar-iphone.ps1`, 'utf8');
  it('pide la clave sin eco y no la imprime ni la pasa por argumento', () => {
    expect(ps1).toContain('Read-Host -AsSecureString');
    expect(ps1).not.toMatch(/Write-Host[^\r\n]*\$key/);
    expect(ps1).toMatch(/\$key \| & wsl\.exe[^\r\n]*set-key\.sh/);
  });
  it('el .bat lanza el .ps1 y ambos van en CRLF (Windows)', () => {
    const bat = readFileSync(`${DIR}/preparar-iphone.bat`, 'utf8');
    expect(bat).toContain('preparar-iphone.ps1');
    expect(bat.split('\n').every((l) => l === '' || l.endsWith('\r'))).toBe(true);
    expect(ps1.split('\n').every((l) => l === '' || l.endsWith('\r'))).toBe(true);
  });
});
