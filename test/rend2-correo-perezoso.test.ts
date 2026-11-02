import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// imapflow y nodemailer (con pino, libmime, mailsplit, socks…) son ~150 módulos que
// `pa` y el demonio cargaban al arrancar aunque no hubiera cuenta de correo. Ahora
// se cargan la primera vez que se abre una conexión IMAP o se envía un correo.
const cargados = vi.hoisted(() => [] as string[]);
const opciones = vi.hoisted(() => [] as unknown[]);
vi.mock('imapflow', () => {
  cargados.push('imapflow');
  return {
    ImapFlow: class {
      constructor(o: unknown) {
        opciones.push(o);
      }
    },
  };
});
vi.mock('nodemailer', () => {
  cargados.push('nodemailer');
  return { createTransport: () => ({}) };
});

const PESADOS = ['imapflow', 'nodemailer'];

function ficheros(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? ficheros(join(dir, e.name))
      : e.name.endsWith('.ts')
        ? [join(dir, e.name)]
        : [],
  );
}

describe('carga perezosa del correo', () => {
  it('importar los módulos de correo no carga imapflow ni nodemailer', async () => {
    await import('../src/mail/client.js');
    await import('../src/mail/scan.js');
    await import('../src/mail/idle.js');
    await import('../src/mail/reader.js');
    await import('../src/mail/command-inbox.js');
    await import('../src/books/setup-gmail.js');
    await import('../src/tools/mail-rules.js');
    expect(cargados).toEqual([]);
  });

  it('imapFor carga imapflow al usarse y abre la conexión con las mismas opciones', async () => {
    const { imapFor } = await import('../src/mail/scan.js');
    const cuenta = {
      address: 'yo@example.com',
      password: 'x',
      imapHost: 'imap.example.com',
      imapPort: 993,
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
    };
    await imapFor(cuenta as never);
    expect(cargados).toEqual(['imapflow']);
    expect(opciones).toEqual([
      {
        host: 'imap.example.com',
        port: 993,
        secure: true,
        auth: { user: 'yo@example.com', pass: 'x' },
        logger: false,
        socketTimeout: 30_000,
      },
    ]);
  });

  it('ningún fichero de src importa imapflow o nodemailer con import de valor arriba del todo', () => {
    const malos: string[] = [];
    for (const f of ficheros(join(process.cwd(), 'src'))) {
      for (const linea of readFileSync(f, 'utf8').split('\n')) {
        const m = /^import\s+(?!type\b)[^'"]*from\s+['"]([^'"]+)['"]/.exec(linea);
        const mod = m?.[1];
        if (mod && PESADOS.some((p) => mod === p || mod.startsWith(`${p}/`)))
          malos.push(`${f}: ${linea}`);
      }
    }
    expect(malos).toEqual([]);
  });
});
