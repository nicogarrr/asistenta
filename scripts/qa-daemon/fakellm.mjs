// Modelo falso con API de chat completions (OpenAI). Guion: array JSON; cada paso es
// {text} o {tool, args}, en orden, entre todos los casos. Cada petición va a requests.jsonl.
import { createServer } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
const [,, port, scriptFile, logFile] = process.argv;
let i = 0;
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    appendFileSync(logFile, body.replace(/\n/g, ' ') + '\n');
    if (!req.url.includes('chat/completions')) { res.writeHead(404); res.end(); return; }
    const script = JSON.parse(readFileSync(scriptFile, 'utf8'));
    const step = script[i++] ?? { text: 'FIN_GUION' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'c' + i, object: 'chat.completion.chunk', created: 1, model: 'test' };
    const send = (o) => res.write(`data: ${JSON.stringify({ ...base, ...o })}\n\n`);
    if (step.tool) {
      send({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call' + i, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) } }] }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ choices: [{ index: 0, delta: { role: 'assistant', content: step.text }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    res.write('data: [DONE]\n\n'); res.end();
  });
}).listen(Number(port), '127.0.0.1', () => process.stderr.write(`[fakellm] ${port}\n`));
