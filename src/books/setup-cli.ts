/** Entrada CLI del setup de libros: `pa books setup`.
 *
 * Espera a que el server este escuchando DE VERDAD y solo entonces imprime
 * la URL local con su token (anunciarla antes prometia un server que podia
 * no existir, p.ej. EADDRINUSE). El server queda escuchando solo en
 * 127.0.0.1 hasta Ctrl+C. El token viaja en la URL: quien no la vea en ESTA
 * terminal no puede ni abrir la pagina.
 */

import { startSetupServer } from './setup-page.js';

export async function booksSetupCommand(
  port = 8377,
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<{ close: () => void; url: string }> {
  const { server, url, ready } = startSetupServer(port);
  try {
    await ready;
  } catch {
    throw new Error(
      `No se pudo abrir el puerto ${port} en 127.0.0.1 (¿hay otro setup abierto?). Cierralo o usa otro puerto.`,
    );
  }
  write(
    `Setup de libros (solo en este PC):\n\n  ${url}\n\n` +
      'Abre esa direccion en el navegador de este PC. Ctrl+C para salir.\n',
  );
  const shutdown = () => server.close();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { close: () => server.close(), url };
}
