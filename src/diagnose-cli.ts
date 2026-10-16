import { type DiagnoseInput, diagnose } from './diagnose.js';

/** Local report only: no config/vault unlock, network, daemon start or restart. */
export async function diagnoseCommand(
  args: string[],
  deps: DiagnoseInput = {},
  write: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
  error: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    error('uso: pa diagnose [--json]\n');
    return 2;
  }
  const report = await diagnose(deps);
  write(`${args[0] === '--json' ? JSON.stringify(report.data, null, 2) : report.text}\n`);
  return 0;
}
