import { describe, it } from 'vitest';

/**
 * Las pruebas que abren un Chromium de verdad (Playwright directo o BrowserService
 * sin simular) solo corren con PA_TEST_REAL_BROWSER=1. CI lo pone; en el PC de Nico
 * y en un `npm test` normal nunca se lanza un navegador real: salen como «skipped».
 */
export const realBrowser = process.env.PA_TEST_REAL_BROWSER === '1';

/** `describe` que solo corre con PA_TEST_REAL_BROWSER=1. */
export const describeBrowser = describe.skipIf(!realBrowser);

/** `it` que solo corre con PA_TEST_REAL_BROWSER=1. */
export const itBrowser = it.skipIf(!realBrowser);
