import { renderMiniAppReadyScript } from './miniapp.js';
import { VOZ_WAV_JS } from './voz-wav.js';
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
  #tiempos { min-height: 1em; font-size: 12px; color: #6f8394; }
</style>
</head>
<body>
<main id="chat" aria-live="polite"></main>
<footer>
  <div id="estado">Pulsa el botón y habla.</div>
  <div id="tiempos"></div>
  <button id="boton" type="button">🎙️ Hablar</button>
  <label><input id="manos" type="checkbox"> Manos libres</label>
  <label><input id="leer" type="checkbox" checked> Leer respuestas en voz alta</label>
</footer>
<script>
${renderMiniAppReadyScript()}
</script>
<script>
(function () {
  var CLAVE = 'asistenta.webui.token';
  var token = '';
  try { token = (localStorage.getItem(CLAVE) || '').trim(); } catch (e) {}
  var chat = document.getElementById('chat');
  var estado = document.getElementById('estado');
  var tiempos = document.getElementById('tiempos');
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

  // iOS solo deja sonar audio que nace de un toque: el primer «Hablar» desbloquea este
  // reproductor con un instante de silencio y luego se reutiliza para la voz del PC.
  var reproductor = new Audio();
  var desbloqueado = false;
  var SILENCIO = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
  function desbloquear() {
    if (desbloqueado) return;
    desbloqueado = true;
    try { reproductor.src = SILENCIO; var p = reproductor.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
  }
  function vozSistema(t) {
    if (!window.speechSynthesis) { siguiente(); return; }
    var u = new SpeechSynthesisUtterance(t); u.lang = 'es-ES';
    u.onend = siguiente; u.onerror = siguiente;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }
  function sonar(audio, fin, falla) {
    try {
      var bin = atob(audio.data); var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      reproductor.src = URL.createObjectURL(new Blob([bytes], { type: audio.mime || 'audio/mpeg' }));
      reproductor.onended = fin; reproductor.onerror = falla;
      var p = reproductor.play(); if (p && p.catch) p.catch(falla);
    } catch (e) { falla(); }
  }
  // resto: promesa con el audio del resto de la respuesta (o null), pedida en cuanto llega
  // la primera frase para que suene seguido.
  function hablar(t, audio, resto) {
    if (!leer.checked) { siguiente(); return; }
    if (!audio || !audio.data) { vozSistema(t); return; }
    var hecho = false;
    function fin() { if (!hecho) { hecho = true; siguiente(); } }
    function falla() { if (!hecho) { hecho = true; vozSistema(t); } }
    sonar(audio, function () {
      if (!resto) { fin(); return; }
      resto.then(function (r) { if (r && r.data) sonar(r, fin, fin); else fin(); }, fin);
    }, falla);
  }
  function pedirResto(id) {
    if (!id) return null;
    return fetch('/api/voz/resto?id=' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }
  function seg(ms) { return (Math.round((ms || 0) / 100) / 10).toString().replace('.', ',') + ' s'; }
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

  ${VOZ_WAV_JS}

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
    // El móvil decodifica su propio mp4/webm y manda WAV: el PC no necesita ffmpeg.
    aWav(audio).then(function (wav) { mandar(wav, 'audio/wav'); }, function () { mandar(audio, tipo.split(';')[0]); });
  }

  function aWav(blob) {
    var C = window.AudioContext || window.webkitAudioContext;
    if (!C || !blob.arrayBuffer) return Promise.reject(new Error('sin WebAudio'));
    return blob.arrayBuffer().then(function (buf) {
      var ctx = new C();
      return new Promise(function (ok, ko) { ctx.decodeAudioData(buf, ok, ko); }).then(function (ab) {
        try { ctx.close(); } catch (e) {}
        var canales = [];
        for (var i = 0; i < ab.numberOfChannels; i++) canales.push(ab.getChannelData(i));
        return new Blob([wavMono16k(canales, ab.sampleRate)], { type: 'audio/wav' });
      });
    });
  }

  function mandar(audio, mime) {
    fetch('/api/voz', { method: 'POST', headers: { 'Content-Type': mime, Authorization: 'Bearer ' + token }, body: audio })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        boton.disabled = false;
        if (!x.ok) { decir((x.d && x.d.error) || 'No ha salido bien.'); return; }
        if (x.d.oido) linea('yo', x.d.oido);
        linea('ella', x.d.text || '');
        var tm = x.d.tiempos;
        if (tm) tiempos.textContent = 'oír ' + seg(tm.oirMs) + ' · pensar ' + seg(tm.pensarMs) + ' · voz ' + seg(tm.vozMs);
        hablar(x.d.text || '', x.d.audio, pedirResto(x.d.audioResto));
      })
      .catch(function () { boton.disabled = false; decir('No llego al PC. ¿Tailscale está conectado?'); });
  }

  boton.addEventListener('click', function () {
    desbloquear();
    if (grabador && grabador.state === 'recording') parar(); else empezar();
  });
})();
</script>
</body>
</html>`;
}
