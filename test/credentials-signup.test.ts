import { describe, expect, it } from 'vitest';
import { formatApproval } from '../src/approval-text.js';
import type { VaultOps } from '../src/credentials/store.js';
import { Gate } from '../src/permissions.js';
import { createAccountsTool } from '../src/tools/accounts.js';

function memVault(): VaultOps & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => map.get(k),
    set: async (k, v) => {
      map.set(k, v);
    },
    delete: async (k) => map.delete(k),
    list: async () => [...map.keys()],
  };
}

const ME = { name: 'Nico García', email: 'nico@example.com' };

function setup(owner: typeof ME | null = ME) {
  const v = memVault();
  const tool = createAccountsTool(v, async () => owner);
  const outs: string[] = [];
  const run = async (args: Record<string, unknown>) => {
    const r = await tool.execute('t', args as never);
    const s = JSON.stringify(r);
    outs.push(s);
    return s;
  };
  return { v, run, outs };
}

describe('«créame una cuenta en X»: preparar → confirmar → guardar', () => {
  it('flujo completo: la contraseña queda en el vault y no sale en ninguna respuesta', async () => {
    const { v, run, outs } = setup();
    const prep = await run({
      action: 'preparar_registro',
      sitio: 'https://www.wallapop.es/signup',
    });
    expect(prep).toContain('secret_key=site:wallapop.es:password');
    expect(prep).toContain('Nico García');
    expect(prep).toContain('NO pulses');
    expect(await run({ action: 'listar' })).toContain('sin terminar');
    // guardar antes del sí del dueño no vale
    expect(await run({ action: 'guardar', sitio: 'wallapop.es' })).toContain('no está aprobado');
    // un correo distinto del preparado no se aprueba
    expect(
      await run({ action: 'confirmar_registro', sitio: 'wallapop.es', correo: 'otro@x.com' }),
    ).toContain('no sigo');
    expect(
      await run({ action: 'confirmar_registro', sitio: 'wallapop.es', correo: 'nico@example.com' }),
    ).toContain('pulsa ya');
    expect(await run({ action: 'guardar', sitio: 'wallapop.es' })).toContain('creada y guardada');
    expect(await run({ action: 'listar' })).not.toContain('sin terminar');
    const pw = v.map.get('site:wallapop.es:password') ?? '';
    expect(pw.length).toBeGreaterThanOrEqual(20);
    for (const o of outs) expect(o).not.toContain(pw);
  });

  it('no crea otra cuenta si ya hay una activa, y descartar nunca borra una activa', async () => {
    const { run, v } = setup();
    await run({ action: 'preparar_registro', sitio: 'wallapop.es' });
    await run({ action: 'confirmar_registro', sitio: 'wallapop.es', correo: 'nico@example.com' });
    await run({ action: 'guardar', sitio: 'wallapop.es' });
    const pw = v.map.get('site:wallapop.es:password');
    expect(await run({ action: 'preparar_registro', sitio: 'wallapop.es' })).toContain(
      'Ya tienes cuenta',
    );
    expect(await run({ action: 'descartar', sitio: 'wallapop.es' })).toContain('No había');
    expect(v.map.get('site:wallapop.es:password')).toBe(pw);
  });

  it('descartar un registro a medias no deja nada en el vault', async () => {
    const { run, v } = setup();
    await run({
      action: 'preparar_registro',
      sitio: 'ejemplo.com',
      sin_simbolos: true,
      max_largo: 16,
    });
    expect(v.map.get('site:ejemplo.com:password')).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(await run({ action: 'descartar', sitio: 'ejemplo.com' })).toContain('descartado');
    expect(v.map.size).toBe(0);
  });

  it('sin nombre y correo del dueño no inventa nada', async () => {
    const { run, v } = setup(null);
    expect(await run({ action: 'preparar_registro', sitio: 'wallapop.es' })).toContain(
      'PA_OWNER_EMAIL',
    );
    expect(v.map.size).toBe(0);
  });
});

describe('Gate: crear una cuenta se pregunta cada vez, con la frase exacta', () => {
  it('confirmar_registro pregunta siempre, aunque se aprobara justo antes', async () => {
    let asked = 0;
    const gate = new Gate({
      approver: () => {
        asked += 1;
        return true;
      },
    });
    const go = {
      tool: 'cuentas',
      args: { action: 'confirmar_registro', sitio: 'wallapop.es', correo: 'nico@example.com' },
      actor: 'local',
    } as const;
    await gate.check('s', go);
    gate.settle('s', go, false);
    await gate.check('s', go);
    expect(asked).toBe(2);
  });

  it('la pregunta es una línea clara con el correo enmascarado', () => {
    const t = formatApproval(
      {
        tool: 'cuentas',
        args: { action: 'confirmar_registro', sitio: 'wallapop.es', correo: 'nico@example.com' },
        actor: 'local',
      },
      "creates an account on a website in the owner's name",
    );
    expect(t.question).toContain(
      'Voy a crear tu cuenta en wallapop.es con tu correo n…@example.com. ¿Confirmo?',
    );
  });
});
