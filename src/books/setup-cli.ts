/** Entrada CLI del setup de libros: `pa books setup`.
 *
 * Imprime la URL local con su token y deja el server escuchando solo en
 * 127.0.0.1 hasta Ctrl+C. El token viaja en la URL: quien no la vea en ESTA
 * terminal no puede ni abrir la pagina.
 */

import { startSetupServer } from './setup-page.js';

export function booksSetupCommand(
  port = 8377,
  write: (text: string) => void = (text) => process.stdout.write(text),
): { close: () => void; url: string } {
  const { server, url } = startSetupServer(port);
  write(
    `Setup de libros (solo en este PC):\n\n  ${url}\n\n` +
      'Abre esa direccion en el navegador de este PC. Ctrl+C para salir.\n',
  );
  const shutdown = () => server.close();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { close: () => server.close(), url };
}
