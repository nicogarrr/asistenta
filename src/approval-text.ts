import type { ToolCall } from './permissions.js';

/**
 * What the user sees when the gate asks. For a browser action on a payment, the page's
 * own words (button, address, totals) go in the question, so the one tap is an informed
 * one: "Pagar 11,40 € a calle Y", not "¿Permito browser?".
 *
 * The same honesty applies to the desktop tools: an approval that only says
 * "¿Permito shell?" hides the one thing the user is actually approving — the command
 * itself. Shell shows the command; computer shows the action (and, for batch, the
 * steps inside it).
 */
export function formatApprovalQuestion(call: ToolCall, reason: string): string {
  const target = typeof call.args._target === 'string' ? call.args._target : '';
  if (call.tool === 'browser' && target) {
    const [element = '', ...rest] = target.split('\nRESUMEN DE LA PÁGINA:\n');
    const summary = rest.join('\n').trim();
    const shown = element.split(' | ').filter(Boolean).slice(0, 6).join(' · ').slice(0, 300);
    return [
      `¿Permito esta acción en el navegador?`,
      `Elemento: ${shown}`,
      summary ? `Datos de la página:\n${summary.slice(0, 700)}` : '',
      `Motivo: ${reason}`,
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (call.tool === 'shell') {
    const command = typeof call.args.command === 'string' ? call.args.command.trim() : '';
    return [
      '¿Permito ejecutar este comando?',
      command ? `Comando:\n${command.slice(0, 700)}` : '',
      `Motivo: ${reason}`,
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (call.tool === 'computer') {
    const lines = ['¿Permito esta acción en el escritorio?'];
    if (call.args.action === 'batch' && Array.isArray(call.args.actions)) {
      const steps = call.args.actions as Array<Record<string, unknown>>;
      lines.push(`Lote de ${steps.length} acciones:`);
      for (const [i, step] of steps.slice(0, 10).entries()) {
        lines.push(`  ${i + 1}. ${describeComputerAction(step)}`);
      }
      if (steps.length > 10) lines.push(`  … y ${steps.length - 10} más`);
    } else {
      lines.push(`Acción: ${describeComputerAction(call.args)}`);
    }
    lines.push(`Motivo: ${reason}`);
    return lines.join('\n');
  }
  return `¿Permito ${call.tool}?\n${reason}`;
}

function describeComputerAction(args: Record<string, unknown>): string {
  const action = typeof args.action === 'string' ? args.action : '?';
  if (action === 'type') return `escribir "${String(args.text ?? '').slice(0, 120)}"`;
  if (action === 'key') return `pulsar ${String(args.key ?? '?')}`;
  if (action === 'click' || action === 'move' || action === 'drag') {
    const pos = [args.x, args.y].every((v) => typeof v === 'number') ? ` en (${args.x}, ${args.y})` : '';
    return `${action}${pos}`;
  }
  return action;
}
