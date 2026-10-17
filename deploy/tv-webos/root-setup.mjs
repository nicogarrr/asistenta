import net from 'node:net';

// BLOQUEADO (ver README): inseguro tal cual. No corre salvo TV_ROOT_SETUP_ACK=yes.
if (process.env.TV_ROOT_SETUP_ACK !== 'yes') {
  console.error('root-setup.mjs esta BLOQUEADO: hay que rehacerlo antes de usarlo (ver deploy/tv-webos/README.md). Sale salvo TV_ROOT_SETUP_ACK=yes.');
  process.exit(1);
}

const NEWPASS = process.argv[2];

const commands = [
  `echo "root:${NEWPASS}" | chpasswd`,
  'mkdir -p /home/root/.ssh && chmod 700 /home/root/.ssh',
  `echo "${process.argv[3] ?? ''}" > /home/root/.ssh/authorized_keys && chmod 600 /home/root/.ssh/authorized_keys`,
  'mkdir -p /var/lib/webosbrew/init.d',
  'id; echo SSHKEYS:; ls -l /home/root/.ssh/ 2>&1',
].join(' && ');

const sock = net.connect({ host: '192.168.1.237', port: 23 }, () => {});
let buf = Buffer.alloc(0);
let stage = 0;

sock.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  const s = buf.toString('latin1').replace(/\[[0-9;?]*[a-zA-Z]/g, '');
  if (stage === 0 && /[$#]\s*$/.test(s)) {
    stage = 1; buf = Buffer.alloc(0);
    sock.write(commands + '\n');
  } else if (stage === 1 && /SSHKEYS:/.test(s)) {
    setTimeout(() => { console.log(s); sock.end(); }, 1500);
  }
});
sock.on('error', (e) => console.log('ERR', e.message));
setTimeout(() => { console.log('timeout:', buf.toString('latin1').slice(-500)); sock.end(); }, 40000);