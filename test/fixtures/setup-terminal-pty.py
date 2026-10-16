"""Local synthetic PTY probes. Never opens the real vault or sends network traffic."""
import json
import os
import pty
import select
import signal
import subprocess
import sys
import termios
import time

node, module = sys.argv[1:]
secret = 'private-SYNTHETIC-token'
scenarios = {
    'success': (secret.encode() + b'\r', secret, None),
    'backspace': (b'private-SYNTHETIC-tokeX\x7fn\r', secret, None),
    'arrows': (b'private-SYNTHETIC-toke\x1b[D\x1b[Cn\r', secret, None),
    'paste': (b'\x1b[200~' + secret.encode() + b'\x1b[201~\r', secret, None),
    'multiline': (b'key-first\nkey-second\r', None, None),
    'cr-multiline': (b'key-first\rkey-second\r', None, None),
    'paste-multiline': (b'\x1b[200~key-first\nkey-second\x1b[201~\r', None, None),
    'nul': (b'key-\0-rest\r', None, None),
    'invalid-utf8': (b'key-\xff\r', None, None),
    'oversize': (b'x' * 20000, None, None),
    'ctrlc': (b'\x03', None, None),
    'eof': (b'\x04', None, None),
    'sigterm': (b'', None, signal.SIGTERM),
    'sighup': (b'', None, signal.SIGHUP),
}
results = []
for name, (payload, expected, sig) in scenarios.items():
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    source = '''import {terminalQuestion} from MODULE;
import {setupCommand} from SETUP;
let commits=0;
const expected=EXPECTED;
const code=await setupCommand([],{
 platform:'linux',desktop:false,interactive:true,nodeMajor:24,built:true,
 prerequisites:()=>true, inspect:()=>{}, acquire:()=>({assert(){},release(){}}),
 config:()=>({provider:'openai'}),write:()=>{},
 question:(p,secret)=>secret?terminalQuestion('SECRET',true):Promise.resolve('sí'),
 configure:async(_keys,review)=>{
  const changes=await review([{key:'provider:apiKey',source:'missing'}]);
  if(!changes)return false;
  if(changes['provider:apiKey']!==expected)throw new Error('unexpected secret');
  commits++;return true;
 }
});
if(code===0 && commits===1 && expected!==null)process.stdout.write('ANSWER_OK');
else if(code===1 && commits===0 && expected===null)process.stdout.write('CANCELLED');
else process.exitCode=3;
if(!process.exitCode)process.exitCode=code;
'''.replace('MODULE', json.dumps(module)).replace('SETUP', json.dumps(module.replace('setup-terminal.js','setup.js'))).replace('EXPECTED', json.dumps(expected))
    proc = subprocess.Popen([node, '--input-type=module', '-e', source], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    output = b''
    deadline = time.monotonic()+10
    while b'entrada oculta' not in output and time.monotonic()<deadline:
        if select.select([master], [], [], .1)[0]:
            output += os.read(master, 8192)
    assert b'entrada oculta' in output, (name, 'no prompt')
    if sig:
        os.kill(proc.pid, sig)
    else:
        os.write(master, payload)
    while proc.poll() is None and time.monotonic()<deadline:
        if select.select([master], [], [], .1)[0]:
            output += os.read(master, 8192)
    if proc.poll() is None:
        proc.kill()
        raise AssertionError((name, 'child hung'))
    while select.select([master], [], [], 0)[0]:
        output += os.read(master, 8192)
    after = termios.tcgetattr(slave)
    mask = termios.ECHO | termios.ICANON | termios.ISIG
    assert original[3] & mask == after[3] & mask, (name, 'terminal not restored')
    assert all(x not in output for x in [b'private-SYNTHETIC', b'key-first', b'key-', b'x' * 24]), (name, 'secret echoed')
    assert proc.returncode == (0 if expected else 1), (name, proc.returncode, output)
    assert (b'ANSWER_OK' if expected else b'CANCELLED') in output
    results.append({'scenario': name, 'no_echo': True, 'modes_restored': True, 'expected_result': True})
    os.close(master)
    os.close(slave)
print(json.dumps(results))
