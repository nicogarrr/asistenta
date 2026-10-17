import { diagnoseTv } from '../../dist/tv/diagnostics.js';

const [host, port = '23', ...extra] = process.argv.slice(2);
if (!host || extra.length) {
  console.error('Uso: node deploy/tv-webos/diagnose.mjs <IPv4 privada> [puerto]');
  process.exitCode = 2;
} else {
  try {
    console.log(await diagnoseTv(host, Number(port)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
