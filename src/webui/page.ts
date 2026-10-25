/**
 * HTML, manifest y service worker del panel local.
 *
 * La página es estática a propósito: no hay build de frontend ni CDN. El token
 * llega por `?token=` una sola vez, se guarda en localStorage y se envía como
 * Bearer; el HTML nunca lo incrusta. Todo lo que devuelve la API se pinta con
 * textContent, nunca con innerHTML.
 */

const ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">',
  '<rect width="180" height="180" rx="40" fill="#0b0f14"/>',
  '<circle cx="90" cy="90" r="54" fill="none" stroke="#7dd3fc" stroke-width="9"/>',
  '<path d="M66 116 90 64l24 52M74 101h32" fill="none" stroke="#e6edf3" stroke-width="9"',
  ' stroke-linecap="round" stroke-linejoin="round"/>',
  '</svg>',
].join('');

const ICON_DATA_URI = `data:image/svg+xml,${encodeURIComponent(ICON_SVG)}`;

export function renderPage(): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <meta name="theme-color" content="#0b0f14" />
  <meta name="description" content="Panel local de solo lectura de Asistenta." />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-title" content="Asistenta" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <title>Asistenta · Panel local</title>
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" type="image/svg+xml" href="${ICON_DATA_URI}" />
  <link rel="apple-touch-icon" sizes="180x180" href="${ICON_DATA_URI}" />
  <style>
    :root {
      color-scheme: dark;
      --fondo: #0b0f14;
      --panel: #111821;
      --panel-2: #0e141c;
      --borde: #1f2a37;
      --texto: #e6edf3;
      --suave: #93a1b3;
      --acento: #7dd3fc;
      --ok: #4ade80;
      --mal: #f87171;
      --aviso: #fecaca;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }
    body {
      background:
        radial-gradient(1100px 520px at 12% -12%, #102433 0%, transparent 60%),
        var(--fondo);
      background-attachment: fixed;
      color: var(--texto);
      font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      padding: clamp(14px, 3vw, 30px);
    }
    a { color: var(--acento); }
    .skip {
      position: absolute;
      left: -9999px;
      top: 0;
      background: var(--panel);
      border: 1px solid var(--acento);
      border-radius: 10px;
      padding: 8px 12px;
      z-index: 20;
    }
    .skip:focus { left: 16px; top: 16px; }
    .cabecera {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 14px;
      max-width: 1240px;
      margin: 0 auto 18px;
    }
    .marca { display: flex; align-items: center; gap: 12px; }
    .marca-icono {
      width: 42px;
      height: 42px;
      border-radius: 13px;
      border: 1px solid #264357;
      background: linear-gradient(145deg, #102433, #0c131b);
      color: var(--acento);
      display: grid;
      place-items: center;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.04em;
      box-shadow: 0 8px 24px #0006;
    }
    h1 { margin: 0; font-size: 20px; letter-spacing: -0.02em; }
    .subtitulo { margin: 1px 0 0; color: var(--suave); font-size: 12px; }
    .acciones { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .actualizado {
      color: var(--suave);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    button {
      font: inherit;
      color: var(--texto);
      background: #1b2735;
      border: 1px solid #2a3a4d;
      border-radius: 10px;
      padding: 8px 13px;
      cursor: pointer;
      transition: border-color 120ms ease, background 120ms ease;
    }
    button:hover { border-color: var(--acento); background: #213143; }
    button:focus-visible { outline: 2px solid var(--acento); outline-offset: 2px; }
    button:disabled { opacity: 0.55; cursor: progress; }
    button.mini {
      padding: 4px 8px;
      font-size: 12px;
      background: transparent;
      color: var(--suave);
    }
    button.mini:hover { color: var(--texto); }
    .aviso {
      max-width: 1240px;
      margin: 0 auto 14px;
      padding: 11px 14px;
      border: 1px solid #7f1d1d;
      border-radius: 12px;
      background: #2a1215;
      color: var(--aviso);
    }
    .rejilla {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
      max-width: 1240px;
      margin: 0 auto;
    }
    .tarjeta {
      display: flex;
      flex-direction: column;
      min-width: 0;
      border: 1px solid var(--borde);
      border-radius: 16px;
      background: linear-gradient(180deg, #121a24 0%, var(--panel) 100%);
      box-shadow: 0 14px 40px #0004;
      overflow: hidden;
    }
    .tarjeta-cabecera {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px;
      padding: 13px 15px;
      border-bottom: 1px solid var(--borde);
      background: #0f1620;
    }
    .tarjeta-cabecera h2 {
      margin: 0;
      font-size: 12px;
      letter-spacing: 0.13em;
      text-transform: uppercase;
      color: var(--suave);
    }
    .tarjeta-cabecera .controles {
      display: flex;
      align-items: end;
      gap: 8px;
      flex-wrap: wrap;
    }
    .tarjeta-cuerpo {
      padding: 15px;
      max-height: 48vh;
      overflow: auto;
      scrollbar-color: #2a3a4d transparent;
    }
    .buscador {
      display: flex;
      flex-direction: column;
      gap: 3px;
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--suave);
    }
    .buscador input {
      width: min(210px, 52vw);
      padding: 7px 9px;
      border: 1px solid #2a3a4d;
      border-radius: 9px;
      background: #0b121a;
      color: var(--texto);
      font: inherit;
      font-size: 13px;
      letter-spacing: normal;
      text-transform: none;
    }
    .buscador input::placeholder { color: #667486; }
    .buscador input:focus-visible { outline: 2px solid var(--acento); outline-offset: 1px; }
    .datos {
      display: grid;
      grid-template-columns: minmax(96px, auto) minmax(0, 1fr);
      gap: 6px 14px;
      margin: 0;
    }
    .datos dt {
      color: var(--suave);
      font-size: 11px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      padding-top: 2px;
    }
    .datos dd { margin: 0; min-width: 0; }
    .lista { margin: 0; padding-left: 18px; }
    .lista li { margin: 3px 0; }
    .texto { white-space: pre-wrap; word-break: break-word; }
    .nulo { color: var(--suave); font-style: italic; }
    .muted { color: var(--suave); }
    .error { color: var(--mal); }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 9px;
      border: 1px solid #2a3a4d;
      border-radius: 999px;
      background: #16202b;
      font-size: 12px;
    }
    .chip.ok { color: var(--ok); border-color: #1d4f35; background: #0f241a; }
    .chip.mal { color: var(--mal); border-color: #5b2424; background: #241111; }
    .sesion {
      margin-bottom: 9px;
      padding: 10px 12px;
      border: 1px solid var(--borde);
      border-radius: 12px;
      background: var(--panel-2);
    }
    .sesion:last-child { margin-bottom: 0; }
    .sesion h3 { margin: 0; font-size: 14px; word-break: break-word; }
    details { margin-top: 8px; }
    summary { cursor: pointer; color: var(--suave); font-size: 12px; }
    summary:hover { color: var(--texto); }
    .veredicto { margin-bottom: 10px; }
    [hidden] { display: none !important; }
    @media (max-width: 780px) {
      body { padding: 14px; }
      .rejilla { grid-template-columns: 1fr; }
      .tarjeta-cuerpo { max-height: none; }
      .buscador input { width: 100%; }
      .cabecera { align-items: flex-start; }
    }
    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; }
    }
  </style>
</head>
<body>
  <a class="skip" href="#contenido">Saltar al contenido</a>
  <header class="cabecera">
    <div class="marca">
      <span class="marca-icono" aria-hidden="true">A</span>
      <div>
        <h1>Asistenta</h1>
        <p class="subtitulo">Panel local · solo lectura</p>
      </div>
    </div>
    <div class="acciones">
      <span id="actualizado" class="actualizado" role="status" aria-live="polite">Sin actualizar</span>
      <button id="refrescar" type="button">Actualizar todo</button>
    </div>
  </header>

  <main id="contenido">
    <p id="aviso" class="aviso" role="alert" hidden></p>
    <noscript>
      <p class="aviso">Este panel necesita JavaScript para consultar el estado local.</p>
    </noscript>
    <div class="rejilla">
      <article class="tarjeta" aria-labelledby="titulo-estado">
        <header class="tarjeta-cabecera">
          <h2 id="titulo-estado">Estado</h2>
          <button class="mini" type="button" data-refrescar="estado">Refrescar</button>
        </header>
        <div id="panel-estado" class="tarjeta-cuerpo" aria-live="polite">
          <p class="muted">Cargando…</p>
        </div>
      </article>

      <article class="tarjeta" aria-labelledby="titulo-sesiones">
        <header class="tarjeta-cabecera">
          <h2 id="titulo-sesiones">Sesiones</h2>
          <div class="controles">
            <label class="buscador" for="buscar-sesiones">
              Buscar
              <input id="buscar-sesiones" type="search" placeholder="Texto…" autocomplete="off" spellcheck="false" />
            </label>
            <button class="mini" type="button" data-refrescar="sesiones">Refrescar</button>
          </div>
        </header>
        <div id="panel-sesiones" class="tarjeta-cuerpo" aria-live="polite">
          <p class="muted">Cargando…</p>
        </div>
      </article>

      <article class="tarjeta" aria-labelledby="titulo-memoria">
        <header class="tarjeta-cabecera">
          <h2 id="titulo-memoria">Memoria</h2>
          <div class="controles">
            <label class="buscador" for="ambito-memoria">
              Ámbito
              <input id="ambito-memoria" type="text" placeholder="global" autocomplete="off" spellcheck="false" />
            </label>
            <button class="mini" type="button" data-refrescar="memoria">Refrescar</button>
          </div>
        </header>
        <div id="panel-memoria" class="tarjeta-cuerpo" aria-live="polite">
          <p class="muted">Cargando…</p>
        </div>
      </article>

      <article class="tarjeta" aria-labelledby="titulo-auditoria">
        <header class="tarjeta-cabecera">
          <h2 id="titulo-auditoria">Auditoría</h2>
          <button class="mini" type="button" data-refrescar="auditoria">Refrescar</button>
        </header>
        <div id="panel-auditoria" class="tarjeta-cuerpo" aria-live="polite">
          <p class="muted">Cargando…</p>
        </div>
      </article>
    </div>
  </main>

  <script>
    (function () {
      'use strict';

      var CLAVE_TOKEN = 'asistenta.webui.token';
      var parametros = new URLSearchParams(window.location.search);
      var tokenDeUrl = parametros.get('token');

      // El token de la URL se guarda una vez y desaparece de la barra de direcciones.
      if (tokenDeUrl) {
        try {
          window.localStorage.setItem(CLAVE_TOKEN, tokenDeUrl);
        } catch (error) {
          // Un navegador sin almacenamiento sigue pudiendo usar el panel en esta visita.
        }
        parametros.delete('token');
        var resto = parametros.toString();
        try {
          window.history.replaceState(
            null,
            '',
            window.location.pathname + (resto ? '?' + resto : '') + window.location.hash
          );
        } catch (error) {}
      }

      var token = '';
      try {
        token = window.localStorage.getItem(CLAVE_TOKEN) || '';
      } catch (error) {}

      var aviso = document.getElementById('aviso');

      function mostrarAviso(texto) {
        aviso.textContent = texto;
        aviso.hidden = !texto;
      }

      function nodo(etiqueta, clase, texto) {
        var elemento = document.createElement(etiqueta);
        if (clase) elemento.className = clase;
        if (texto !== undefined && texto !== null) elemento.textContent = String(texto);
        return elemento;
      }

      function nombreCampo(clave) {
        var mapa = {
          id: 'ID',
          chatId: 'Chat',
          sessionId: 'Sesión',
          createdAt: 'Creado',
          updatedAt: 'Actualizado',
          lastSeen: 'Visto por última vez',
          status: 'Estado',
          ok: 'Resultado',
          valid: 'Válido',
          verified: 'Verificado',
          count: 'Total',
          items: 'Elementos',
          sessions: 'Sesiones',
          scope: 'Ámbito',
          error: 'Error'
        };
        if (mapa[clave]) return mapa[clave];
        var limpio = clave.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
        return limpio.charAt(0).toUpperCase() + limpio.slice(1);
      }

      function renderValor(valor, profundidad) {
        var nivel = profundidad || 0;
        if (nivel > 6) return nodo('span', 'muted', '…');
        if (valor === undefined || valor === null) return nodo('span', 'nulo', 'Sin datos');
        if (Array.isArray(valor)) {
          if (valor.length === 0) return nodo('span', 'nulo', 'Lista vacía');
          var lista = nodo('ul', 'lista');
          var maximo = Math.min(valor.length, 100);
          for (var i = 0; i < maximo; i += 1) {
            var item = document.createElement('li');
            item.appendChild(renderValor(valor[i], nivel + 1));
            lista.appendChild(item);
          }
          if (valor.length > maximo) {
            var envoltorio = document.createElement('div');
            envoltorio.appendChild(lista);
            envoltorio.appendChild(
              nodo('p', 'muted', 'y ' + (valor.length - maximo) + ' elementos más…')
            );
            return envoltorio;
          }
          return lista;
        }
        if (typeof valor === 'object') {
          var claves = Object.keys(valor);
          if (claves.length === 0) return nodo('span', 'nulo', 'Objeto vacío');
          var datos = document.createElement('dl');
          datos.className = 'datos';
          var limite = Math.min(claves.length, 100);
          for (var j = 0; j < limite; j += 1) {
            var clave = claves[j];
            datos.appendChild(nodo('dt', null, nombreCampo(clave)));
            var definicion = document.createElement('dd');
            definicion.appendChild(renderValor(valor[clave], nivel + 1));
            datos.appendChild(definicion);
          }
          return datos;
        }
        if (typeof valor === 'boolean') {
          return nodo('span', 'chip' + (valor ? ' ok' : ' mal'), valor ? 'sí' : 'no');
        }
        return nodo('span', 'texto', String(valor));
      }

      function pintarCarga(contenedor) {
        contenedor.replaceChildren(nodo('p', 'muted', 'Cargando…'));
      }

      function pintarError(contenedor, error) {
        var mensaje =
          error && error.message ? error.message : 'No se pudo cargar la información.';
        contenedor.replaceChildren(nodo('p', 'error', mensaje));
      }

      async function pedir(ruta) {
        if (!token) {
          throw new Error(
            'Falta el token de acceso. Abre /?token=TU_TOKEN una vez para guardarlo en este navegador.'
          );
        }
        var respuesta;
        try {
          respuesta = await fetch(ruta, {
            method: 'GET',
            headers: { Authorization: 'Bearer ' + token },
            cache: 'no-store',
            credentials: 'omit'
          });
        } catch (error) {
          throw new Error('No se pudo conectar con el panel local.');
        }
        if (respuesta.status === 401) {
          throw new Error(
            'Token rechazado. Vuelve a abrir /?token=TU_TOKEN con el token correcto.'
          );
        }
        if (!respuesta.ok) {
          throw new Error('El panel respondió con el código ' + respuesta.status + '.');
        }
        try {
          return await respuesta.json();
        } catch (error) {
          throw new Error('La respuesta del panel no es JSON válido.');
        }
      }

      function listaDeSesiones(datos) {
        if (Array.isArray(datos)) return datos;
        if (datos && typeof datos === 'object') {
          if (Array.isArray(datos.sessions)) return datos.sessions;
          if (Array.isArray(datos.items)) return datos.items;
        }
        return null;
      }

      function tituloSesion(sesion, indice) {
        if (typeof sesion === 'string') return sesion;
        if (sesion && typeof sesion === 'object') {
          var claves = ['title', 'name', 'subject', 'label', 'chatId', 'sessionId', 'id'];
          for (var i = 0; i < claves.length; i += 1) {
            var valor = sesion[claves[i]];
            if (valor !== undefined && valor !== null && String(valor) !== '') {
              return String(valor);
            }
          }
        }
        return 'Sesión ' + (indice + 1);
      }

      function pintarSesiones(contenedor, datos) {
        contenedor.replaceChildren();
        var sesiones = listaDeSesiones(datos);
        if (!sesiones) {
          contenedor.appendChild(renderValor(datos, 0));
          return;
        }
        if (sesiones.length === 0) {
          contenedor.appendChild(nodo('p', 'muted', 'No hay sesiones que coincidan.'));
          return;
        }
        contenedor.appendChild(
          nodo(
            'p',
            'muted',
            sesiones.length + (sesiones.length === 1 ? ' sesión' : ' sesiones')
          )
        );
        for (var i = 0; i < sesiones.length; i += 1) {
          var sesion = sesiones[i];
          var tarjeta = document.createElement('article');
          tarjeta.className = 'sesion';
          tarjeta.appendChild(nodo('h3', null, tituloSesion(sesion, i)));
          if (sesion && typeof sesion === 'object') {
            var detalles = document.createElement('details');
            detalles.appendChild(nodo('summary', null, 'Detalles'));
            detalles.appendChild(renderValor(sesion, 1));
            tarjeta.appendChild(detalles);
          } else {
            tarjeta.appendChild(renderValor(sesion, 1));
          }
          contenedor.appendChild(tarjeta);
        }
      }

      function insignia(clase, texto) {
        return nodo('span', 'chip' + (clase ? ' ' + clase : ''), texto);
      }

      function pintarAuditoria(contenedor, datos) {
        contenedor.replaceChildren();
        var correcto = false;
        var fallido = false;
        if (datos && typeof datos === 'object' && !Array.isArray(datos)) {
          correcto =
            datos.ok === true ||
            datos.valid === true ||
            datos.verified === true ||
            datos.status === 'ok';
          fallido =
            datos.ok === false ||
            datos.valid === false ||
            datos.verified === false ||
            datos.status === 'error' ||
            datos.status === 'failed';
        }
        var veredicto = nodo('div', 'veredicto');
        if (correcto) veredicto.appendChild(insignia('ok', 'Verificación correcta'));
        else if (fallido) veredicto.appendChild(insignia('mal', 'Verificación fallida'));
        else veredicto.appendChild(insignia('', 'Sin veredicto explícito'));
        contenedor.appendChild(veredicto);

        var detalles = document.createElement('details');
        detalles.appendChild(nodo('summary', null, 'Resultado completo'));
        detalles.appendChild(renderValor(datos, 0));
        contenedor.appendChild(detalles);
      }

      async function cargarEstado() {
        var contenedor = document.getElementById('panel-estado');
        pintarCarga(contenedor);
        try {
          contenedor.replaceChildren(renderValor(await pedir('/api/status'), 0));
        } catch (error) {
          pintarError(contenedor, error);
        }
      }

      async function cargarSesiones() {
        var contenedor = document.getElementById('panel-sesiones');
        var consulta = document.getElementById('buscar-sesiones').value.trim();
        var ruta = '/api/sessions' + (consulta ? '?q=' + encodeURIComponent(consulta) : '');
        pintarCarga(contenedor);
        try {
          pintarSesiones(contenedor, await pedir(ruta));
        } catch (error) {
          pintarError(contenedor, error);
        }
      }

      async function cargarMemoria() {
        var contenedor = document.getElementById('panel-memoria');
        var ambito = document.getElementById('ambito-memoria').value.trim();
        var ruta = '/api/memory' + (ambito ? '?scope=' + encodeURIComponent(ambito) : '');
        pintarCarga(contenedor);
        try {
          contenedor.replaceChildren(renderValor(await pedir(ruta), 0));
        } catch (error) {
          pintarError(contenedor, error);
        }
      }

      async function cargarAuditoria() {
        var contenedor = document.getElementById('panel-auditoria');
        pintarCarga(contenedor);
        try {
          pintarAuditoria(contenedor, await pedir('/api/audit/verify'));
        } catch (error) {
          pintarError(contenedor, error);
        }
      }

      var refrescos = {
        estado: cargarEstado,
        sesiones: cargarSesiones,
        memoria: cargarMemoria,
        auditoria: cargarAuditoria
      };

      function refrescarTodo() {
        var boton = document.getElementById('refrescar');
        var marca = document.getElementById('actualizado');
        boton.disabled = true;
        document.body.setAttribute('aria-busy', 'true');
        Promise.all([cargarEstado(), cargarSesiones(), cargarMemoria(), cargarAuditoria()])
          .catch(function (error) {})
          .finally(function () {
            boton.disabled = false;
            document.body.removeAttribute('aria-busy');
            marca.textContent = 'Actualizado · ' + new Date().toLocaleTimeString('es-ES');
          });
      }

      var temporizadorSesiones = 0;
      document.getElementById('buscar-sesiones').addEventListener('input', function () {
        window.clearTimeout(temporizadorSesiones);
        temporizadorSesiones = window.setTimeout(cargarSesiones, 300);
      });

      var temporizadorMemoria = 0;
      document.getElementById('ambito-memoria').addEventListener('input', function () {
        window.clearTimeout(temporizadorMemoria);
        temporizadorMemoria = window.setTimeout(cargarMemoria, 300);
      });

      document.getElementById('refrescar').addEventListener('click', refrescarTodo);

      var botones = document.querySelectorAll('[data-refrescar]');
      for (var i = 0; i < botones.length; i += 1) {
        botones[i].addEventListener('click', function (evento) {
          var objetivo = evento.currentTarget;
          var clave = objetivo ? objetivo.getAttribute('data-refrescar') : null;
          if (clave && refrescos[clave]) refrescos[clave]();
        });
      }

      if (!token) {
        mostrarAviso(
          'Falta el token de acceso. Abre /?token=TU_TOKEN una vez; se guardará en este navegador.'
        );
      }

      if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
          navigator.serviceWorker.register('/sw.js').catch(function (error) {});
        });
      }

      refrescarTodo();
    })();
  </script>
</body>
</html>`;
}

export function renderManifest(): string {
  return JSON.stringify({
    name: 'Asistenta',
    short_name: 'Asistenta',
    description: 'Panel local de solo lectura de Asistenta.',
    lang: 'es',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0b0f14',
    theme_color: '#0b0f14',
    icons: [
      {
        src: ICON_DATA_URI,
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  });
}

export function renderServiceWorker(): string {
  return `'use strict';

const CACHE = 'asistenta-webui-v1';
const CORE = ['/', '/manifest.webmanifest'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(function (cache) {
        return cache.addAll(CORE);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (claves) {
        return Promise.all(
          claves
            .filter(function (clave) {
              return clave !== CACHE;
            })
            .map(function (clave) {
              return caches.delete(clave);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener('fetch', function (event) {
  var peticion = event.request;
  if (peticion.method !== 'GET') return;

  var url = new URL(peticion.url);
  if (url.origin !== self.location.origin) return;

  // La API siempre va a la red y nunca se cachea: puede contener datos privados.
  if (url.pathname.indexOf('/api/') === 0) {
    event.respondWith(
      fetch(peticion).catch(function () {
        return new Response(JSON.stringify({ error: 'Sin conexión con el panel.' }), {
          status: 503,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
          }
        });
      })
    );
    return;
  }

  // La pagina se intenta fresca; si no hay red, se sirve la copia del install.
  if (peticion.mode === 'navigate') {
    event.respondWith(
      fetch(peticion).catch(function () {
        return caches
          .match('/')
          .then(function (copia) {
            return copia || caches.match('/manifest.webmanifest');
          })
          .then(function (copia) {
            return (
              copia ||
              new Response('Sin conexión', {
                status: 503,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
              })
            );
          });
      })
    );
    return;
  }

  if (url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.match(peticion).then(function (copia) {
        return copia || fetch(peticion);
      })
    );
  }
});`;
}
