/**
 * /voz: hablar con Asistenta desde el móvil (Mini App de Telegram con /voz, o el
 * navegador del móvil por Tailscale). Pulsas, hablas, la nota va al PC, el whisper local
 * la transcribe, responde el mismo hilo principal que Telegram y el móvil lo lee en voz
 * alta con su propia voz (speechSynthesis: sin coste ni servidor de voz). «Manos libres»
 * corta sola tras un silencio y vuelve a escuchar después de la respuesta.
 * Página estática sin CDN, como el panel; el micrófono exige https (Tailscale Serve).
 */
export function renderVozPage(): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Asistenta · Voz</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 17px/1.4 system-ui, sans-serif; background: #0f1720; color: #e8eef3; display: flex; flex-direction: column; min-height: 100vh; }
  main { flex: 1; padding: 16px; overflow-y: auto; }
  .yo, .ella { margin: 8px 0; padding: 10px 12px; border-radius: 12px; max-width: 90%; white-space: pre-wrap; }
  .yo { background: #1f3b52; margin-left: auto; }
  .ella { background: #1b2733; }
  footer { padding: 16px; display: grid; gap: 10px; justify-items: center; }
  #boton { width: 132px; height: 132px; border-radius: 50%; border: 0; font: inherit; font-weight: 600; background: #2b7bb9; color: #fff; }
  #boton.grabando { background: #c0392b; }
  #boton:disabled { opacity: .5; }
  #estado { min-height: 1.4em; font-size: 15px; color: #9fb3c4; text-align: center; }
  label { font-size: 15px; }
</style>
</head>
<body>
<main id="chat" aria-live="polite"></main>
<footer>
  <div id="estado">Pulsa el botón y habla.</div>
  <button id="boton" type="button">🎙️ Hablar</button>
  <label><input id="manos" type="checkbox"> Manos libres</label>
  <label><input id="leer" type="checkbox" checked> Leer respuestas en voz alta</label>
</footer>
<script>
(function () {
  var CLAVE = 'asistenta.webui.token';
  var token = '';
  try { token = (localStorage.getItem(CLAVE) || '').trim(); } catch (e) {}
  var chat = document.getElementById('chat');
  var estado = document.getElementById('estado');
  var boton = document.getElementById('boton');
  var manos = document.getElementById('manos');
  var leer = document.getElementById('leer');
  var grabador = null, trozos = [], flujo = null, vigia = null;

  function decir(t) { estado.textContent = t; }
  function linea(clase, t) {
    var p = document.createElement('p'); p.className = clase; p.textContent = t;
    chat.appendChild(p); chat.scrollTop = chat.scrollHeight;
  }

  var datos = new URLSearchParams((location.hash || '').slice(1)).get('tgWebAppData');
  if (!token && datos) {
    fetch('/api/miniapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: datos }) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.token) { token = d.token; try { localStorage.setItem(CLAVE, token); } catch (e) {} decir('Listo. Pulsa el botón y habla.'); }
        else decir('Telegram no ha confirmado que seas tú. Ábrelo desde tu chat con el bot (/voz).');
      })
      .catch(function () { decir('No llego al PC. ¿Tailscale está conectado en el móvil?'); });
  } else if (!token) {
    decir('Abre esto desde Telegram con /voz, o abre antes el panel con tu token en este navegador.');
  }

  function hablar(t) {
    if (!leer.checked || !window.speechSynthesis) { siguiente(); return; }
    var u = new SpeechSynthesisUtterance(t); u.lang = 'es-ES';
    u.onend = siguiente; u.onerror = siguiente;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }
  function siguiente() { if (manos.checked) empezar(); else decir('Pulsa el botón y habla.'); }

  function vigilarSilencio() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var fuente = ctx.createMediaStreamSource(flujo);
      var an = ctx.createAnalyser(); an.fftSize = 1024; fuente.connect(an);
      var buf = new Uint8Array(an.fftSize), habla = false, callado = 0, t0 = Date.now();
      vigia = setInterval(function () {
        an.getByteTimeDomainData(buf);
        var s = 0; for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; s += v * v; }
        var rms = Math.sqrt(s / buf.length);
        if (rms > 0.04) { habla = true; callado = 0; } else if (habla) { callado += 100; }
        if ((habla && callado >= 1400) || Date.now() - t0 > 60000) parar();
      }, 100);
      vigia.ctx = ctx;
    } catch (e) {}
  }

  function empezar() {
    if (!token) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) { decir('Este navegador no deja grabar. Prueba en Chrome o Safari.'); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
      flujo = s; trozos = [];
      grabador = new MediaRecorder(s);
      grabador.ondataavailable = function (e) { if (e.data && e.data.size) trozos.push(e.data); };
      grabador.onstop = enviar;
      grabador.start();
      boton.classList.add('grabando'); boton.textContent = '⏹ Enviar';
      decir(manos.checked ? 'Te escucho… (corto solo al callarte)' : 'Te escucho… pulsa para enviar.');
      if (manos.checked) vigilarSilencio();
    }).catch(function () { decir('Sin permiso para el micrófono. Actívalo para Telegram o el navegador en los ajustes del móvil.'); });
  }

  function parar() {
    if (vigia) { clearInterval(vigia); try { vigia.ctx.close(); } catch (e) {} vigia = null; }
    if (grabador && grabador.state !== 'inactive') grabador.stop();
    if (flujo) flujo.getTracks().forEach(function (t) { t.stop(); });
    boton.classList.remove('grabando'); boton.textContent = '🎙️ Hablar';
  }

  function enviar() {
    var tipo = (grabador && grabador.mimeType) || 'audio/webm';
    var audio = new Blob(trozos, { type: tipo });
    if (!audio.size) { decir('No ha llegado audio.'); return; }
    boton.disabled = true; decir('Pensando…');
    fetch('/api/voz', { method: 'POST', headers: { 'Content-Type': tipo.split(';')[0], Authorization: 'Bearer ' + token }, body: audio })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        boton.disabled = false;
        if (!x.ok) { decir((x.d && x.d.error) || 'No ha salido bien.'); return; }
        if (x.d.oido) linea('yo', x.d.oido);
        linea('ella', x.d.text || '');
        hablar(x.d.text || '');
      })
      .catch(function () { boton.disabled = false; decir('No llego al PC. ¿Tailscale está conectado?'); });
  }

  boton.addEventListener('click', function () {
    if (grabador && grabador.state === 'recording') parar(); else empezar();
  });
})();
</script>
</body>
</html>`;
}
