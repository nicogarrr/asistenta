import { sliceSafe } from '../text.js';

/**
 * Flatten a transcript into text for the /learn summariser.
 *
 * Only the turns that describe actions: tool names and the model's own words. The
 * user's messages are included because "haz la compra" is the intent the steps have
 * to serve, but the tool *arguments* are not, because a typed password would be
 * written into a routine that lives in the database forever.
 */
export function summarizeTranscript(messages: readonly unknown[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const m = message as {
      role?: string;
      content?: unknown;
      toolName?: string;
    };
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'user') {
      const text = textOf(m.content);
      if (text) lines.push(`usuario: ${sliceSafe(text, 300)}`);
    } else if (m.role === 'assistant') {
      const text = textOf(m.content);
      if (text) lines.push(`agente: ${sliceSafe(text, 300)}`);
    } else if (m.role === 'toolResult' || m.toolName) {
      const name = (m as { toolName?: string }).toolName;
      if (name) lines.push(`herramienta: ${name}`);
    }
  }
  return lines.slice(-80).join('\n') || '(no hubo actividad)';
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } => {
      const block = b as { type?: unknown; text?: unknown };
      return block?.type === 'text' && typeof block.text === 'string';
    })
    .map((b) => b.text)
    .join(' ');
}
