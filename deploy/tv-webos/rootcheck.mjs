import net from 'node:net';

const sock = net.connect({ host: process.env.TV_IP ?? '192.168.1.237', port: 23 }, () => {});
let buf = Buffer.alloc(0);
let sent = false;

sock.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  const s = buf.toString('latin1').replace(/\[[0-9;?]*[a-zA-Z]/g, '');
  if (!sent && /[$#]\s*$/.test(s)) {
    sent = true;
    sock.write('id; uname -a; echo HOMEBREW; ls /var/lib/webosbrew 2>/dev/null | head -3\n');
  }
  if (sent && /uid=/.test(s)) {
    console.log('=== VERIFICACION ROOT ===');
    console.log(s);
    sock.end();
    process.exit(0);
  }
});
sock.on('error', (e) => { console.log('ERR', e.message); process.exit(1); });
setTimeout(() => { console.log('buffer:', buf.toString('latin1').slice(0, 600)); sock.end(); }, 25000);