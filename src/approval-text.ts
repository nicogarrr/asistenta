import type { ToolCall } from './permissions.js';

/**
 * What the user sees when the gate asks. For a browser action on a payment, the page's
 * own words (button, address, totals) go in the question, so the one tap is an informed
 * one: "Pagar 11,40 € a calle Y", not "¿Permito browser?".
 */
export function formatApprovalQuestion(call: ToolCall, reason: string): string {
  const target = typeof call.args._target === 'string' ? call.args._target : '';
  if (call.tool !== 'browser' || !target) return `¿Permito ${call.tool}?\n${reason}`;
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
