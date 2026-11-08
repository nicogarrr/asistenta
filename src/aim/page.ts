/** Página que se abre en Safari del iPhone: manda el movimiento al PC por WebSocket. */
export function aimPage(): string {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover">
<title>Apuntar</title>
<style>
  html,body{margin:0;height:100%;background:#111;color:#eee;font:16px -apple-system,system-ui,sans-serif;touch-action:none;-webkit-user-select:none;user-select:none}
  #app{display:flex;flex-direction:column;height:100%;padding:12px;box-sizing:border-box;gap:10px}
  #estado{text-align:center;font-size:14px;opacity:.8}
  #pad{flex:1;border-radius:18px;background:#1f3a5f;display:flex;align-items:center;justify-content:center;font-size:20px;text-align:center}
  #pad.on{background:#2f6fb5}
  .fila{display:flex;gap:8px}
  button{flex:1;padding:14px 6px;border:0;border-radius:12px;background:#333;color:#eee;font-size:15px}
  button.act{background:#2f6fb5}
  #rueda{height:64px;border-radius:12px;background:#2a2a2a;display:flex;align-items:center;justify-content:center;font-size:13px;opacity:.9}
  #empezar{background:#1f8a4c;font-size:18px;padding:18px}
</style></head><body><div id="app">
<div id="estado">Sin conectar</div>
<button id="empezar">Empezar</button>
<div id="pad">Sujeta el móvil como un mando (casi horizontal) y apunta con el borde de arriba.<br>Toca aquí para hacer clic.<br>Mantén para arrastrar.</div>
<div id="rueda">Desliza aquí para el scroll</div>
<div class="fila"><button id="centrar">Centrar</button><button id="derecho">Clic derecho</button><button id="pausa">Pausa</button></div>
<div class="fila"><button id="invel">Invertir ↑↓</button><button id="invaz">Invertir ←→</button></div>
</div>
<script>
(function(){
  var q = new URLSearchParams(location.search), tk = q.get('t') || '';
  var ws = null, corriendo = false, pausa = false, invel = false, invaz = false;
  var estado = document.getElementById('estado');
  var now = function(){ return performance.now() / 1000; };
  function enviar(o){ if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function conectar(){
    ws = new WebSocket('wss://' + location.host + '/ws?t=' + encodeURIComponent(tk));
    ws.onopen = function(){ estado.textContent = 'Conectado. Apunta a la pantalla y pulsa Centrar.'; };
    ws.onclose = function(){ estado.textContent = 'Desconectado'; corriendo = false; };
    ws.onerror = function(){ estado.textContent = 'Error de conexión'; };
  }
  function movimiento(e){
    var a = e.accelerationIncludingGravity, r = e.rotationRate;
    if (!a || !r || a.x === null) return;
    enviar({k:'m', t: now(), g:[a.x, a.y, a.z], r:[r.beta || 0, r.gamma || 0, r.alpha || 0]});
  }
  document.getElementById('empezar').onclick = function(){
    var iniciar = function(){ conectar(); window.addEventListener('devicemotion', movimiento); corriendo = true; document.getElementById('empezar').style.display = 'none'; };
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      DeviceMotionEvent.requestPermission().then(function(s){
        if (s === 'granted') iniciar(); else estado.textContent = 'Sin permiso de movimiento (Ajustes > Safari > Movimiento y orientación).';
      }).catch(function(){ estado.textContent = 'No se pudo pedir el permiso de movimiento.'; });
    } else iniciar();
  };
  var pad = document.getElementById('pad');
  pad.addEventListener('touchstart', function(e){ e.preventDefault(); pad.classList.add('on'); enviar({k:'down', t: now()}); }, {passive:false});
  var soltar = function(e){ e.preventDefault(); pad.classList.remove('on'); enviar({k:'up', t: now()}); };
  pad.addEventListener('touchend', soltar, {passive:false});
  pad.addEventListener('touchcancel', soltar, {passive:false});
  var yPrev = null, rueda = document.getElementById('rueda');
  rueda.addEventListener('touchstart', function(e){ e.preventDefault(); yPrev = e.touches[0].clientY; }, {passive:false});
  rueda.addEventListener('touchmove', function(e){ e.preventDefault(); var y = e.touches[0].clientY; if (yPrev !== null) enviar({k:'scroll', dy: y - yPrev}); yPrev = y; }, {passive:false});
  document.getElementById('centrar').onclick = function(){ enviar({k:'center'}); };
  document.getElementById('derecho').onclick = function(){ enviar({k:'right'}); };
  var bp = document.getElementById('pausa');
  bp.onclick = function(){ pausa = !pausa; bp.classList.toggle('act', pausa); bp.textContent = pausa ? 'Seguir' : 'Pausa'; enviar({k:'pause', on: pausa}); };
  var be = document.getElementById('invel'), ba = document.getElementById('invaz');
  be.onclick = function(){ invel = !invel; be.classList.toggle('act', invel); enviar({k:'invert', el: invel}); };
  ba.onclick = function(){ invaz = !invaz; ba.classList.toggle('act', invaz); enviar({k:'invert', az: invaz}); };
})();
</script></body></html>`;
}
