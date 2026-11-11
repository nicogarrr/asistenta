import { readFileSync } from 'node:fs';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import {
  countUnverifiedInSummaries,
  SUMMARY_MARKER,
  UNVERIFIED_WARNING,
} from '../src/core/history.js';
import { conversationStatus, formatStatus } from '../src/status.js';

const resumen = (texto: string): AgentMessage =>
  ({
    role: 'user',
    content: [{ type: 'text', text: `${SUMMARY_MARKER}\n${UNVERIFIED_WARNING}\n${texto}` }],
    timestamp: 1,
  }) as unknown as AgentMessage;
const usuario = (texto: string): AgentMessage =>
  ({ role: 'user', content: texto, timestamp: 2 }) as unknown as AgentMessage;

describe('gaps-13: «SIN VERIFICAR» también en /estado de Telegram', () => {
  it('cuenta solo las marcas de los resúmenes, sin contar el aviso que las nombra', () => {
    const msgs = [
      resumen(
        '- Vive en Gijón.\n- SIN VERIFICAR: la reunión es el jueves.\n- UNVERIFIED: el PDF pesa 3 MB.',
      ),
      usuario('SIN VERIFICAR: esto lo escribió Nico, no es un resumen'),
    ];
    expect(countUnverifiedInSummaries(msgs)).toBe(2);
    expect(countUnverifiedInSummaries([usuario('hola')])).toBe(0);
    expect(countUnverifiedInSummaries([resumen('- todo comprobado')])).toBe(0);
  });

  it('/estado avisa con el número (singular y plural) y nada si no hay', () => {
    const base = { model: 'm', primaryModel: 'm' };
    expect(conversationStatus(base)).toHaveLength(2);
    expect(conversationStatus({ ...base, sinVerificar: 0 })).toHaveLength(2);
    expect(conversationStatus({ ...base, sinVerificar: 1 })[2]).toBe(
      '⚠️ 1 dato del resumen va marcado SIN VERIFICAR: no lo des por hecho sin comprobarlo.',
    );
    const lineas = conversationStatus({ ...base, sinVerificar: 3 });
    expect(lineas[2]).toContain('⚠️ 3 datos del resumen van marcados SIN VERIFICAR');
    const texto = formatStatus({
      version: 'dev',
      node: 'v24',
      uptimeMs: 1000,
      tools: [],
      log: null,
      pageWatches: 0,
      conversation: lineas,
    });
    expect(texto).toContain('Esta conversación:\n');
    expect(texto).toContain('- ⚠️ 3 datos del resumen van marcados SIN VERIFICAR');
  });

  it('cmdEstado le pasa el recuento del hilo (solo el número, nunca el texto)', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const i = cli.indexOf('const cmdEstado = async');
    expect(i).toBeGreaterThan(0);
    const cuerpo = cli.slice(i, i + 3000);
    expect(cuerpo).toContain('sinVerificar: countUnverifiedInSummaries(thread.agent.messages)');
  });
});
