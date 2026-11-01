import { expect, it } from 'vitest';
import { friendlyError } from '../src/channels/formatters.js';

// Error de fichero de Node tal cual: «CODE: descripción, syscall 'ruta'».
function fsError(code: string, desc: string, syscall: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${desc}, ${syscall} '${path}'`), {
    code,
    syscall,
    path,
  });
}

const DENIED = 'Windows no me deja abrir un fichero';
const AI_KEY = 'El proveedor de IA ha rechazado la clave';
const AI_LIMIT = 'El modelo de IA me está limitando';

it('permiso denegado en cualquier operación de fichero, no «clave del proveedor de IA»', () => {
  for (const syscall of ['stat', 'lstat', 'access', 'rmdir', 'open']) {
    const eacces = friendlyError(
      fsError('EACCES', 'permission denied', syscall, 'C:\\Users\\Nico\\OneDrive\\notas.md'),
    );
    expect(eacces, syscall).toContain(DENIED);
    const eperm = friendlyError(
      fsError('EPERM', 'operation not permitted', syscall, 'C:\\Users\\Nico\\Documents\\x.md'),
    );
    expect(eperm, syscall).toContain(DENIED);
    expect(eperm).not.toContain('operation not permitted');
  }
});

it('un número en la ruta (Factura 401.pdf, IMG 429.jpg) no se lee como fallo del modelo', () => {
  const r401 = friendlyError(
    fsError(
      'ENOENT',
      'no such file or directory',
      'open',
      'C:\\Users\\Nico\\Facturas\\Factura 401.pdf',
    ),
  );
  expect(r401).not.toContain(AI_KEY);
  const r429 = friendlyError(
    fsError('ENOENT', 'no such file or directory', 'open', 'C:\\Users\\Nico\\Fotos\\IMG 429.jpg'),
  );
  expect(r429).not.toContain(AI_LIMIT);
  const r503 = friendlyError(
    fsError('EISDIR', 'illegal operation on a directory', 'read', 'C:\\api\\status 503'),
  );
  expect(r503).not.toContain('servicio de IA');
});

it('los fallos del proveedor siguen igual', () => {
  expect(friendlyError(new Error('429 Too Many Requests'))).toContain(AI_LIMIT);
  expect(friendlyError(new Error('401 invalid_api_key'))).toContain(AI_KEY);
  expect(friendlyError(new Error('Request failed with status 503'))).toContain('servicio de IA');
});
