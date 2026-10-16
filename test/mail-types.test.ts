import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../src/mail/types.js';

// redactSecrets lives in src/mail/types.ts and is LIVE: sendMail sanitizes
// errors with it (client.ts). The tool that shared this test file is gone;
// the coverage of the living function stays.
describe('redactSecrets', () => {
  it('removes addresses, credential-shaped tokens and key=value pairs', () => {
    const out = redactSecrets(
      'fallo al conectar como nico@ejemplo.com con password: abcdef1234 token=xyz',
    );
    expect(out).not.toContain('nico@ejemplo.com');
    expect(out).not.toContain('abcdef1234');
    expect(out).toContain('[email]');
    expect(out).toContain('[redactado]');
  });
});
