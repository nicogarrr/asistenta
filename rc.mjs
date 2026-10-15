import net from 'node:net';

const cmd = process.argv[2];
const sock = net.connect({ host: '192.168.1.237', port: 23 }, () => {});
let buf = Buffer.alloc(0);
let stage = 0;
sock.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  const s = buf.toString('latin1').replace(/\[[0-9;?]*[a-zA-Z]/g, '');
  if (stage === 0 && /[$#]\s*$/.test(s)) { stage = 1; buf = Buffer.alloc(0); sock.write(cmd + '\n'); }
  else if (stage === 1 && /\$\s*#\s*[$#]?\s*$/.test(s)) {
    setTimeout(() => { console.log(s); sock.end(); }, 1200);
  }
});
sock.on('error', (e) => console.log('ERR', e.message));
setTimeout(() => { console.log('timeout\n' + buf.toString('latin1').slice(-400)); sock.end(); }, 30000);