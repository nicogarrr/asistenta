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
try {const answer=await terminalQuestion('SECRET',true); if(answer!==EXPECTED)process.exitCode=3; else process.stdout.write('ANSWER_OK');}
catch {process.stdout.write('CANCELLED');process.exitCode=1;}
'''.replace('MODULE', json.dumps(module)).replace('EXPECTED', json.dumps(expected))
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
    assert b'private-SYNTHETIC' not in output, (name, 'secret echoed')
    assert proc.returncode == (0 if expected else 1), (name, proc.returncode, output)
    assert (b'ANSWER_OK' if expected else b'CANCELLED') in output
    results.append({'scenario': name, 'no_echo': True, 'modes_restored': True, 'expected_result': True})
    os.close(master)
    os.close(slave)
print(json.dumps(results))
