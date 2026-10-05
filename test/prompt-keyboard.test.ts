import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from '../src/core/prompt.js';

describe('prompt: teclado cuando falla el clic', () => {
  it('manda usar ArrowDown y Enter si el clic o choose fallan', () => {
    expect(SYSTEM_PROMPT).toContain('use the keyboard on the field');
    expect(SYSTEM_PROMPT).toContain('"ArrowDown"');
    expect(SYSTEM_PROMPT).toContain('The keyboard never replaces the payment guard');
  });
});
