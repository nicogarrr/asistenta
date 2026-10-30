import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as http from '../src/mcp/http-client.js';

// `pa doctor` debe decir qué servidores MCP por HTTP están configurados y cuáles se
// omiten y por qué, sin conectar con nadie y sin enseñar nunca el token.
const TOKEN = 'tok-super-secreto-123';
const servers = JSON.stringify([
  { name: 'stdio', command: 'node', args: ['x.js'] },
  { name: 'notas', url: 'https://mcp.example.com/mcp?key=abc' },
  { name: 'local', url: 'http://127.0.0.1:9000/mcp' },
  { name: 'fuera', url: 'http://10.0.0.5/mcp' },
  { name: 'con-pass', url: 'https://user:pw@mcp.example.com/' },
  { name: 'notas', url: 'https://otra.example.com/' },
  { name: 'mal nombre', url: 'https://x.example.com/' },
]);
const secrets = (key: string) => Promise.resolve(key === 'mcp:notas:token' ? TOKEN : undefined);
const doctor = () =>
  (http as unknown as Record<string, unknown>).mcpHttpDoctorLines as
    | ((env: NodeJS.ProcessEnv, get: http.SecretGetter) => Promise<string[]>)
    | undefined;

describe('pa doctor: servidores MCP por HTTP', () => {
  it('existe mcpHttpDoctorLines y pa doctor la usa', () => {
    expect(typeof doctor()).toBe('function');
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const body = cli.slice(cli.indexOf('async function doctorCommand'));
    expect(body.slice(0, body.indexOf('\nfunction '))).toMatch(/await mcpHttpDoctorLines\(\)/);
  });

  it('activado: configurados con origen y si hay token; omitidos con motivo', async () => {
    const text =
      (await doctor()?.({ PA_MCP_HTTP: '1', PA_MCP_SERVERS: servers }, secrets))?.join('\n') ?? '';
    expect(text).toContain('activado (PA_MCP_HTTP=1)');
    expect(text).toContain('notas: configurado (https://mcp.example.com; token guardado)');
    expect(text).toContain(
      'local: configurado (http://127.0.0.1:9000; token sin guardar (mcp:local:token))',
    );
    expect(text).toMatch(/fuera: omitido: URL no permitida/);
    expect(text).toMatch(/con-pass: omitido: URL no permitida/);
    expect(text).toContain('notas: omitido: nombre repetido');
    expect(text).toMatch(/mal nombre: omitido: nombre no válido/);
    expect(text).not.toContain('stdio');
  });

  it('nunca muestra el token, credenciales de la URL ni su ruta o parámetros', async () => {
    const text =
      (await doctor()?.({ PA_MCP_HTTP: '1', PA_MCP_SERVERS: servers }, secrets))?.join('\n') ?? '';
    expect(text).not.toBe('');
    for (const secret of [
      TOKEN,
      'key=abc',
      '.com/mcp',
      ':9000/mcp',
      'user:pw',
      'pw@',
      '10.0.0.5',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('apagado por defecto: los servidores salen como omitidos y no se lee el almacén', async () => {
    let reads = 0;
    const lines = await doctor()?.({ PA_MCP_SERVERS: servers }, (key) => {
      reads++;
      return secrets(key);
    });
    const text = lines?.join('\n') ?? '';
    expect(text).toContain('apagado (PA_MCP_HTTP=1 para activarlo)');
    expect(text).toContain('notas: omitido: PA_MCP_HTTP no es 1 (apagado por defecto)');
    expect(reads).toBe(0);
  });

  it('sin servidores HTTP o con JSON roto: una sola línea clara', async () => {
    expect(await doctor()?.({}, secrets)).toEqual([
      'mcp http        apagado (PA_MCP_HTTP=1), sin servidores con "url" en PA_MCP_SERVERS',
    ]);
    expect(await doctor()?.({ PA_MCP_HTTP: '1', PA_MCP_SERVERS: '{no' }, secrets)).toEqual([
      'mcp http        PA_MCP_SERVERS no es una lista JSON válida',
    ]);
  });

  it('parseMcpHttpServers sigue devolviendo lo mismo', () => {
    expect(http.parseMcpHttpServers(servers).map((s) => s.name)).toEqual(['notas', 'local']);
  });
});
