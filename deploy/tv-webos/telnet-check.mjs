import net from 'node:net';

const host = process.argv[2] ?? '192.168.1.237';
const port = Number(process.argv[3] ?? 23);
const password = process.argv[4] ?? 'alpine';

const sock = net.connect({ host, port }, () => {
  // Suprimir negociación telnet: rechazo las opciones que proponga.
  sock.write(Buffer.from([0xff, 0xfb, 0x01, 0xff, 0xfb, 0x03, 0xff, 0xfc, 0x18, 0xff, 0xfc, 0x1f]));
});

let buf = Buffer.alloc(0);
let stage = 0;
const cmds = ['id', 'uname -a', 'ls /var/lib/webosbrew 2>&1 | head', 'cat /etc/issue'];

sock.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  const s = buf.toString('latin1');
  if (stage === 0 && /login:|ogin:/i.test(s)) {
    stage = 1; buf = Buffer.alloc(0);
    sock.write('root\n');
  } else if (stage === 1 && /assword:/i.test(s)) {
    stage = 2; buf = Buffer.alloc(0);
    sock.write(`${password}\n`);
  } else if (stage === 2 && /\$\s*#\s*[$#]?\s*$/.test(s.replace(/\[[0-9;?]*[a-zA-Z]/g, ''))) {
    stage = 3; buf = Buffer.alloc(0);
    sock.write(cmds.join('; ') + '\n');
  } else if (stage === 3) {
    setTimeout(() => { console.log('--- SALIDA ---'); console.log(s.replace(/\[[0-9;?]*[a-zA-Z]/g, '')); sock.end(); }, 1200);
  }
});
sock.on('error', (e) => console.log('ERR', e.message));
setTimeout(() => { console.log('--- TIMEOUT, buffer final ---'); console.log(buf.toString('latin1').replace(/\[[0-9;?]*[a-zA-Z]/g, '')); sock.end(); }, 20000);