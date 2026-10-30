/**
 * Despacho de comandos de Telegram del daemon (antes un switch de ~60 casos en
 * onMessage de cli.ts). La tabla se construye en cli.ts, donde viven los
 * handlers; aquí solo está el registro y el enrutado, sin cambio de
 * comportamiento: nombre exacto → handler, desconocido → `onUnknown`.
 */

/** Handler de un comando: recibe el mensaje, el texto tras el comando y el nombre usado (alias). */
export type CommandHandler<I> = (inbound: I, args: string, name: string) => Promise<unknown>;

export interface CommandSpec<I> {
  /** Nombre y alias, en minúsculas y sin «/». */
  names: readonly string[];
  run: CommandHandler<I>;
}

export type CommandTable<I> = ReadonlyMap<string, CommandHandler<I>>;

/**
 * Construye la tabla nombre → handler. Un nombre repetido es un error de
 * programación (dos lanes registrando el mismo comando): se lanza en vez de que
 * uno tape al otro en silencio.
 */
export function buildCommandTable<I>(specs: readonly CommandSpec<I>[]): CommandTable<I> {
  const table = new Map<string, CommandHandler<I>>();
  for (const spec of specs) {
    for (const name of spec.names) {
      if (table.has(name)) throw new Error(`Comando /${name} registrado dos veces`);
      table.set(name, spec.run);
    }
  }
  return table;
}

/**
 * Enruta un comando ya parseado. Si no está en la tabla llama a `onUnknown`
 * con el nombre. Los errores del handler se propagan igual que antes.
 */
export async function dispatchCommand<I>(
  table: CommandTable<I>,
  inbound: I,
  command: { name: string; args: string },
  onUnknown: (name: string) => Promise<unknown>,
): Promise<void> {
  const run = table.get(command.name);
  if (!run) {
    await onUnknown(command.name);
    return;
  }
  await run(inbound, command.args, command.name);
}
