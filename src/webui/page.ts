/**
 * HTML, manifest y service worker del panel local.
 *
 * La página es estática a propósito: no hay build de frontend ni CDN. El token
 * llega por `?token=` una sola vez, se guarda en localStorage y se envía como
 * Bearer; el HTML nunca lo incrusta. Todo lo que devuelve la API se pinta con
 * textContent, nunca con innerHTML.
 */

import {
  anuncioPendientes,
  etiquetaAmbito,
  etiquetaAmbitoPorDefecto,
  etiquetaCampo,
  formatearCampo,
  mensajeDeError,
  progresoPlan,
  resumenAprobacion,
  resumenMemoria,
  resumenSesion,
  textoEspera,
  tiempoRestante,
  tituloPestana,
} from './client-format.js';

const ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">',
  '<rect width="180" height="180" rx="40" fill="#0b0f14"/>',
  '<circle cx="90" cy="90" r="54" fill="none" stroke="#7dd3fc" stroke-width="9"/>',
  '<path d="M66 116 90 64l24 52M74 101h32" fill="none" stroke="#e6edf3" stroke-width="9"',
  ' stroke-linecap="round" stroke-linejoin="round"/>',
  '</svg>',
].join('');

const ICON_DATA_URI = `data:image/svg+xml,${encodeURIComponent(ICON_SVG)}`;

/**
 * Script con las funciones puras de client-format.ts, copiadas tal cual al
 * navegador. Va aparte del script principal para poder probarlo en un vm.
 */
export function renderFormatScript(): string {
  return `var asistentaFormato = (function () {
  'use strict';
  var resumenAprobacion = ${resumenAprobacion.toString()};
  var tiempoRestante = ${tiempoRestante.toString()};
  var etiquetaCampo = ${etiquetaCampo.toString()};
  var formatearCampo = ${formatearCampo.toString()};
  var mensajeDeError = ${mensajeDeError.toString()};
  var resumenMemoria = ${resumenMemoria.toString()};
  var progresoPlan = ${progresoPlan.toString()};
  var textoEspera = ${textoEspera.toString()};
  var tituloPestana = ${tituloPestana.toString()};
  var resumenSesion = ${resumenSesion.toString()};
  var anuncioPendientes = ${anuncioPendientes.toString()};
  var etiquetaAmbito = ${etiquetaAmbito.toString()};
  var etiquetaAmbitoPorDefecto = ${etiquetaAmbitoPorDefecto.toString()};
  return {
    etiquetaAmbito: etiquetaAmbito,
    etiquetaAmbitoPorDefecto: etiquetaAmbitoPorDefecto,
    anuncioPendientes: anuncioPendientes,
    resumenSesion: resumenSesion,
    tituloPestana: tituloPestana,
    textoEspera: textoEspera,
    resumenMemoria: resumenMemoria,
    progresoPlan: progresoPlan,
    mensajeDeError: mensajeDeError,
    resumenAprobacion: resumenAprobacion,
    tiempoRestante: tiempoRestante,
    etiquetaCampo: etiquetaCampo,
    formatearCampo: formatearCampo
  };
})();`;
}

export function renderPage(): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <meta name="theme-color" content="#0b0f14" />
  <meta name="description" content="Panel local de Asistenta: chat, aprobaciones y estado." />
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
    .skip:focus { left: 16px; top: 16px; color: var(--texto); }
    .solo-lector {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
    }
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
    .subtitulo { margin: 1px 0 0; color: var(--suave); font-size: 13px; }
    .acciones { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .actualizado {
      color: var(--suave);
      font-size: 13px;
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
    /* Anillo claro con halo oscuro: se ve igual sobre botones oscuros, verdes, rojos o ámbar. */
    button:focus-visible,
    a:focus-visible,
    summary:focus-visible {
      outline: 2px solid var(--acento);
      outline-offset: 2px;
      box-shadow: 0 0 0 4px var(--fondo);
    }
    main:focus { outline: none; }
    button:disabled { opacity: 0.55; cursor: progress; }
    button.mini {
      padding: 4px 8px;
      font-size: 13px;
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
    .aviso-conexion {
      margin: 0 16px 10px;
      padding: 7px 11px;
      border: 1px solid #7f1d1d;
      border-radius: 10px;
      background: #2a1215;
      color: var(--aviso);
      font-size: 14px;
    }
    .aviso-conexion[hidden] { display: none; }
    .token { display: grid; gap: 8px; border-color: #264357; background: var(--panel); color: var(--texto); }
    .token .token-fila { display: flex; gap: 8px; flex-wrap: wrap; }
    .token input { flex: 1 1 200px; min-width: 0; font: inherit; color: var(--texto); background: var(--panel-2); border: 1px solid var(--borde); border-radius: 10px; padding: 8px 10px; }
    .token p { margin: 0; font-size: 13px; }
    .error-bloque { display: grid; gap: 8px; justify-items: start; }
    .error-bloque p { margin: 0; }
    .recuerdos { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    .recuerdo { border: 1px solid var(--borde); border-radius: 10px; padding: 8px 10px; background: var(--panel-2); }
    .recuerdo p { margin: 0; }
    .recuerdo .muted { font-size: 13px; margin-top: 3px; }
    .meta-objetivo { margin: 6px 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .turno { margin: 0 0 10px; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--borde); }
    .turno p { margin: 0; white-space: pre-wrap; word-break: break-word; }
    .turno .quien { font-size: 13px; color: var(--suave); margin-bottom: 2px; }
    .turno.yo { background: #13202c; border-color: #264357; margin-left: 12%; }
    .turno.asistente { background: var(--panel-2); margin-right: 12%; }
    .turno.esperando .texto { color: var(--suave); font-variant-numeric: tabular-nums; }
    .turno button { margin-top: 6px; }
    .rejilla {
      display: grid;
      align-items: start;
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
      font-size: 13px;
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
      font-size: 13px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--suave);
    }
    .buscador input,
    .buscador select {
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
    .buscador input::placeholder { color: #8191a5; }
    .buscador input:focus-visible,
    .buscador select:focus-visible { outline: 2px solid var(--acento); outline-offset: 1px; }
    .buscador textarea {
      width: 100%;
      min-height: 82px;
      resize: vertical;
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
    .buscador textarea::placeholder { color: #8191a5; }
    .buscador textarea:focus-visible { outline: 2px solid var(--acento); outline-offset: 1px; }
    .chat-form { display: flex; flex-direction: column; gap: 9px; }
    .chat-acciones { display: flex; justify-content: flex-end; }
    .chat-respuesta { margin-top: 12px; }
    .chat-respuesta:empty { margin-top: 0; }
    .datos {
      display: grid;
      grid-template-columns: minmax(96px, auto) minmax(0, 1fr);
      gap: 6px 14px;
      margin: 0;
    }
    .datos dt {
      color: var(--suave);
      font-size: 13px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      padding-top: 2px;
    }
    .datos dd { margin: 0; min-width: 0; }
    .lista { margin: 0; padding-left: 18px; }
    .lista li { margin: 3px 0; }
    .texto { white-space: pre-wrap; word-break: break-word; }
    .archivos { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; margin-top: 8px; max-width: 100%; }
    .archivo { display: inline-block; max-width: 100%; padding: 10px 0; overflow-wrap: anywhere; word-break: break-word; }
    .funcion-titulo { color: var(--texto); font-size: 15px; }
    .funcion-titulo h3 { display: inline; font-size: inherit; margin: 0; }
    .capturas { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .captura { max-width: 100%; height: auto; border-radius: 8px; border: 1px solid var(--borde, #ccc); }
    .nulo { color: var(--suave); font-style: italic; }
    .muted { color: var(--suave); }
    [aria-busy='true'] { opacity: 0.6; transition: opacity 0.2s; }
    .error { color: var(--mal); }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 9px;
      border: 1px solid #2a3a4d;
      border-radius: 999px;
      background: #16202b;
      font-size: 13px;
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
    .aprobacion {
      margin-bottom: 9px;
      padding: 10px 12px;
      border: 1px solid var(--borde);
      border-radius: 12px;
      background: var(--panel-2);
    }
    .aprobacion:last-child { margin-bottom: 0; }
    .aprobacion h3 { margin: 0; font-size: 14px; word-break: break-word; }
    /* Rejilla de columnas iguales: 2×2 en escritorio, una columna en el móvil; nunca un botón suelto en su fila. */
    .aprobacion .botones {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(11.5rem, 1fr));
      gap: 6px; margin-top: 9px;
    }
    .aprobacion .pregunta { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.4; word-break: break-word; }
    .aprobacion .meta { margin: 6px 0 0; color: var(--suave); font-size: 13px; word-break: break-word; }
    .aprobacion .caduca { margin: 6px 0 0; font-size: 13px; color: var(--texto); font-variant-numeric: tabular-nums; }
    .aprobacion .caduca.urgente { color: var(--mal); }
    .aprobacion .botones button { padding: 8px 12px; font-size: 14px; min-height: 40px; }
    .aprobacion .botones button.permitir { border-color: #1d4f35; background: #0f241a; color: var(--ok); }
    .aprobacion .botones button.siempre { border-color: #6b4f1d; color: #fcd34d; background: transparent; }
    .aprobacion .botones button.denegar { border-color: #5b2424; background: #241111; color: var(--mal); }
    .aprobacion .resultado { margin: 8px 0 0; font-size: 13px; }
    /* Caducada: atenuada con color, no con opacidad, para que el texto siga legible (≥4,5:1). */
    .aprobacion.caducada { border-style: dashed; background: var(--panel-2); }
    .aprobacion.caducada .pregunta { color: var(--suave); }
    .aprobacion.caducada .caduca { color: var(--mal); font-weight: 600; }
    .aprobacion.caducada .botones button:disabled { opacity: 1; color: var(--suave); border-color: var(--borde); border-style: dashed; background: transparent; cursor: not-allowed; }
    .sesion .muted { margin: 2px 0 0; font-size: 13px; }
    .sesion .extracto { margin: 6px 0 0; font-size: 13px; line-height: 1.4; word-break: break-word; }
    .aprobacion .botones button { white-space: nowrap; }
    .tarjeta-cuerpo.sin-tope { max-height: none; }
    .tarjeta.pendiente { border-color: #6b4f1d; box-shadow: 0 0 0 1px #6b4f1d55, 0 14px 40px #0004; }
    .contador {
      display: inline-block;
      min-width: 20px;
      margin-left: 6px;
      padding: 1px 7px;
      border-radius: 999px;
      background: #fcd34d;
      color: #1a1405;
      font-size: 13px;
      letter-spacing: normal;
      text-align: center;
    }
    details { margin-top: 8px; }
    summary { cursor: pointer; color: var(--suave); font-size: 13px; }
    summary:hover { color: var(--texto); }
    .veredicto { margin-bottom: 10px; }
    [hidden] { display: none !important; }
    @media (max-width: 780px) {
      body { padding: 14px; }
      .rejilla { grid-template-columns: 1fr; }
      .tarjeta-cuerpo { max-height: none; }
      .buscador input,
      .buscador select { width: 100%; }
      /* iPhone amplía la página al tocar un campo con letra de menos de 16 px. */
      .buscador input,
      .buscador select,
      .buscador textarea,
      .token input { font-size: 16px; }
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
        <p class="subtitulo">Panel local · chat y control</p>
      </div>
    </div>
    <div class="acciones">
      <span id="actualizado" class="actualizado" role="status" aria-live="polite">Sin actualizar</span>
      <button id="refrescar" type="button">Actualizar todo</button>
    </div>
  </header>

  <main id="contenido" tabindex="-1">
    <p id="aviso" class="aviso" role="alert" hidden></p>
    <p id="anuncio" class="solo-lector" role="status" aria-live="polite"></p>
    <form id="form-token" class="aviso token" hidden>
      <label for="campo-token">Token del panel (PA_WEB_TOKEN)</label>
      <div class="token-fila">
        <input id="campo-token" type="password" autocomplete="off" spellcheck="false" required />
        <button type="submit">Guardar y cargar</button>
      </div>
      <p class="muted">Se guarda solo en este navegador.</p>
    </form>
    <noscript>
      <p class="aviso">Este panel necesita JavaScript para consultar el estado local.</p>
    </noscript>
    <div class="rejilla">
      <article id="tarjeta-aprobaciones" class="tarjeta" aria-labelledby="titulo-aprobaciones">
        <header class="tarjeta-cabecera">
          <h2 id="titulo-aprobaciones">Aprobaciones <span id="contador-aprobaciones" class="contador" hidden></span></h2>
          <button class="mini" type="button" data-refrescar="aprobaciones" aria-label="Refrescar Aprobaciones">Refrescar</button>
        </header>
        <p id="conexion-aprobaciones" class="aviso-conexion" role="status" hidden>Sin conexión con el asistente. Reintento cada 15 s; lo que ves puede estar desactualizado.</p>
        <div id="panel-aprobaciones" class="tarjeta-cuerpo sin-tope">
          <p class="muted">Cargando…</p>
        </div>
      </article>

      <article class="tarjeta" aria-labelledby="titulo-chat">
        <header class="tarjeta-cabecera">
          <h2 id="titulo-chat">Chat</h2>
        </header>
        <div class="tarjeta-cuerpo">
          <form id="form-chat" class="chat-form">
            <label class="buscador" for="texto-chat">
              Mensaje
              <textarea
                id="texto-chat"
                name="text"
                rows="3"
                placeholder="Escribe un mensaje… (Enter envía; Mayús+Enter salta de línea)"
                autocomplete="off"
                required
              ></textarea>
            </label>
            <div class="chat-acciones">
              <button id="enviar-chat" type="submit">Enviar</button>
            </div>
          </form>
          <p id="conexion-chat" class="aviso-conexion" role="status" hidden>Sin conexión con el asistente: tu mensaje no se ha enviado. Pulsa Reintentar cuando vuelva.</p>
          <div id="panel-chat" class="chat-respuesta" role="log" aria-live="polite" aria-label="Conversación"></div>
        </div>
      </article>

      <article class="tarjeta" aria-labelledby="titulo-objetivos">
        <header class="tarjeta-cabecera">
          <h2 id="titulo-objetivos">Objetivos</h2>
          <button class="mini" type="button" data-refrescar="objetivos" aria-label="Refrescar Objetivos">Refrescar</button>
        </header>
        <div id="panel-objetivos" class="tarjeta-cuerpo sin-tope">
          <p class="muted">Cargando…</p>
        </div>
      </article>

      <article class="tarjeta" aria-labelledby="titulo-rutinas">
        <header class="tarjeta-cabecera">
          <h2 id="titulo-rutinas">Rutinas</h2>
          <button class="mini" type="button" data-refrescar="rutinas" aria-label="Refrescar Rutinas">Refrescar</button>
        </header>
        <div id="panel-rutinas" class="tarjeta-cuerpo">
          <p class="muted">Cargando…</p>
        </div>
      </article>

      <article class="tarjeta" aria-labelledby="titulo-funciones">
        <header class="tarjeta-cabecera">
          <h2 id="titulo-funciones">Funciones</h2>
          <button class="mini" type="button" data-refrescar="funciones" aria-label="Refrescar Funciones">Refrescar</button>
        </header>
        <div id="panel-funciones" class="tarjeta-cuerpo">
          <p class="muted">Cargando…</p>
        </div>
      </article>

      <article class="tarjeta" aria-labelledby="titulo-estado">
        <header class="tarjeta-cabecera">
          <h2 id="titulo-estado">Estado</h2>
          <button class="mini" type="button" data-refrescar="estado" aria-label="Refrescar Estado">Refrescar</button>
        </header>
        <div id="panel-estado" class="tarjeta-cuerpo">
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
            <button class="mini" type="button" data-refrescar="sesiones" aria-label="Refrescar Sesiones">Refrescar</button>
          </div>
        </header>
        <div id="panel-sesiones" class="tarjeta-cuerpo">
          <p class="muted">Cargando…</p>
        </div>
      </article>

      <article class="tarjeta" aria-labelledby="titulo-memoria">
        <header class="tarjeta-cabecera">
          <h2 id="titulo-memoria">Memoria</h2>
          <div class="controles">
            <label class="buscador" for="ambito-memoria">
              Ámbito
              <select id="ambito-memoria"><option value="">Por defecto</option></select>
            </label>
            <button class="mini" type="button" data-refrescar="memoria" aria-label="Refrescar Memoria">Refrescar</button>
          </div>
        </header>
        <div id="panel-memoria" class="tarjeta-cuerpo">
          <p class="muted">Cargando…</p>
        </div>
      </article>

      <article class="tarjeta" aria-labelledby="titulo-auditoria">
        <header class="tarjeta-cabecera">
          <h2 id="titulo-auditoria">Auditoría</h2>
          <button class="mini" type="button" data-refrescar="auditoria" aria-label="Refrescar Auditoría">Refrescar</button>
        </header>
        <div id="panel-auditoria" class="tarjeta-cuerpo">
          <p class="muted">Cargando…</p>
        </div>
      </article>
    </div>
  </main>

  <script>
${renderFormatScript()}
  </script>
  <script>
    (function () {
      'use strict';
      var formato = window.asistentaFormato;

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
        return formato.etiquetaCampo(clave);
      }

      function renderValor(valor, profundidad, clave) {
        var nivel = profundidad || 0;
        if (nivel > 6) return nodo('span', 'muted', '…');
        if (clave) {
          var formateado = formato.formatearCampo(clave, valor);
          if (formateado !== null) {
            var marca = nodo('span', 'texto', formateado);
            marca.title = String(valor);
            return marca;
          }
        }
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
            definicion.appendChild(renderValor(valor[clave], nivel + 1, clave));
            datos.appendChild(definicion);
          }
          return datos;
        }
        if (typeof valor === 'boolean') {
          return nodo('span', 'chip' + (valor ? ' ok' : ' mal'), valor ? 'sí' : 'no');
        }
        return nodo('span', 'texto', String(valor));
      }

      // Recarga manual: si ya hay datos a la vista se quedan (atenuados) hasta que llega la
      // respuesta, sin parpadeo de «Cargando…». Solo la primera carga muestra el aviso.
      function pintarCarga(contenedor) {
        contenedor.setAttribute('aria-busy', 'true');
        if (contenedor.getAttribute('data-cargado') === 'si') return;
        contenedor.replaceChildren(nodo('p', 'muted', 'Cargando…'));
      }

      function finCarga(contenedor, ok) {
        contenedor.removeAttribute('aria-busy');
        if (ok) contenedor.setAttribute('data-cargado', 'si');
        else contenedor.removeAttribute('data-cargado');
      }

      function pintarError(contenedor, error, reintentar) {
        finCarga(contenedor, false);
        var mensaje =
          error && error.message ? error.message : 'No se pudo cargar la información.';
        var bloque = nodo('div', 'error-bloque');
        bloque.appendChild(nodo('p', 'error', mensaje));
        if (reintentar && !(error && error.sinToken)) {
          var boton = nodo('button', 'mini', 'Reintentar');
          boton.type = 'button';
          boton.addEventListener('click', function () {
            reintentar();
          });
          bloque.appendChild(boton);
        }
        contenedor.replaceChildren(bloque);
      }

      function errorSinToken() {
        var error = new Error('Falta el token: pégalo arriba para cargar esta sección.');
        error.sinToken = true;
        return error;
      }

      function pedirToken(texto) {
        mostrarAviso(texto);
        document.getElementById('form-token').hidden = false;
      }

      async function llamar(ruta, opciones) {
        if (!token) throw errorSinToken();
        var cabeceras = { Authorization: 'Bearer ' + token };
        if (opciones.cuerpo !== undefined) cabeceras['Content-Type'] = 'application/json';
        var respuesta;
        try {
          respuesta = await fetch(ruta, {
            method: opciones.metodo,
            headers: cabeceras,
            body: opciones.cuerpo === undefined ? undefined : JSON.stringify(opciones.cuerpo),
            cache: 'no-store',
            credentials: 'omit'
          });
        } catch (error) {
          var sinRed = new Error('No se pudo conectar con el asistente. ¿Está encendido?');
          sinRed.sinConexion = true;
          throw sinRed;
        }
        var datos = null;
        var esJson = true;
        try {
          datos = await respuesta.json();
        } catch (error) {
          esJson = false;
        }
        if (respuesta.status === 401) {
          pedirToken('Token rechazado: pega el token correcto (PA_WEB_TOKEN).');
          var rechazo = new Error(formato.mensajeDeError(401, datos));
          rechazo.sinToken = true;
          throw rechazo;
        }
        if (!respuesta.ok) {
          var fallo = new Error(formato.mensajeDeError(respuesta.status, datos));
          fallo.estado = respuesta.status;
          throw fallo;
        }
        if (!esJson) throw new Error('La respuesta del panel no es JSON válido.');
        return datos;
      }

      function pedir(ruta) {
        return llamar(ruta, { metodo: 'GET' });
      }

      function enviar(ruta, cuerpo) {
        return llamar(ruta, { metodo: 'POST', cuerpo: cuerpo });
      }

      function listaDeSesiones(datos) {
        if (Array.isArray(datos)) return datos;
        if (datos && typeof datos === 'object') {
          if (Array.isArray(datos.sessions)) return datos.sessions;
          if (Array.isArray(datos.items)) return datos.items;
        }
        return null;
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
          var resumen = formato.resumenSesion(sesion, i, Date.now());
          tarjeta.appendChild(nodo('h3', null, resumen.titulo));
          if (resumen.meta) tarjeta.appendChild(nodo('p', 'muted', resumen.meta));
          if (resumen.extracto) tarjeta.appendChild(nodo('p', 'extracto', resumen.extracto));
          if (sesion && typeof sesion === 'object') {
            var detalles = document.createElement('details');
            detalles.appendChild(nodo('summary', null, 'Detalles técnicos'));
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

      var DECISIONES = [
        { id: 'once', texto: 'Permitir una vez', clase: 'permitir', hecho: 'Permitido una vez' },
        { id: 'session', texto: 'Permitir en esta sesión', clase: '', hecho: 'Permitido en esta sesión' },
        { id: 'always', texto: 'Permitir siempre', clase: 'siempre', hecho: 'Permitido siempre' },
        { id: 'deny', texto: 'Denegar', clase: 'denegar', hecho: 'Denegado' }
      ];

      function listaDeAprobaciones(datos) {
        if (Array.isArray(datos)) return datos;
        if (datos && typeof datos === 'object') {
          var claves = ['approvals', 'pending', 'requests', 'items'];
          for (var i = 0; i < claves.length; i += 1) {
            if (Array.isArray(datos[claves[i]])) return datos[claves[i]];
          }
        }
        return null;
      }

      function idAprobacion(item) {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          var claves = ['id', 'approvalId', 'requestId', 'toolCallId', 'callId'];
          for (var i = 0; i < claves.length; i += 1) {
            var valor = item[claves[i]];
            if (valor !== undefined && valor !== null && String(valor) !== '') {
              return String(valor);
            }
          }
        }
        return '';
      }

      // Mensaje de la última decisión, para que sobreviva al repintado de la lista.
      var ultimaDecision = '';

      async function aprobar(id, decision, tarjeta) {
        if (
          decision.id === 'always' &&
          !window.confirm(
            '«Permitir siempre» deja de preguntarte por esta acción en el futuro. ¿Seguro?'
          )
        ) {
          return;
        }
        var botones = tarjeta.querySelectorAll('button');
        for (var i = 0; i < botones.length; i += 1) botones[i].disabled = true;
        try {
          await enviar('/api/approvals/' + encodeURIComponent(id), { decision: decision.id });
          mostrarAviso('');
          ultimaDecision = decision.hecho + ': «' + tarjeta.getAttribute('data-titulo') + '».';
          await cargarAprobaciones();
          // La tarjeta decidida desaparece y el foco del teclado con ella: pasa al aviso
          // «Aprobado: …», nunca al botón de otra aprobación (no se decide dos veces).
          var contenedor = document.getElementById('panel-aprobaciones');
          devolverFoco(contenedor.querySelector('.resultado.chip') || contenedor);
        } catch (error) {
          var pulsado = null;
          for (var j = 0; j < botones.length; j += 1) {
            botones[j].disabled = false;
            if (botones[j].textContent === decision.texto) pulsado = botones[j];
          }
          var resultado = tarjeta.querySelector('.resultado');
          resultado.className = 'resultado error';
          resultado.textContent =
            error && error.message ? error.message : 'No se pudo aplicar la decisión.';
          // El botón pulsado se desactivó y perdió el foco: vuelve a él para reintentar.
          devolverFoco(pulsado);
        }
      }

      // Cuenta atrás de cada aprobación; al caducar se desactivan sus botones.
      function actualizarCaducidades() {
        var ahora = Date.now();
        var marcas = document.querySelectorAll('#panel-aprobaciones [data-caduca]');
        for (var i = 0; i < marcas.length; i += 1) {
          var caduca = Number(marcas[i].getAttribute('data-caduca'));
          var texto = formato.tiempoRestante(caduca, ahora);
          if (marcas[i].textContent !== texto) marcas[i].textContent = texto;
          marcas[i].className = 'caduca' + (caduca - ahora < 60000 ? ' urgente' : '');
          if (texto === 'Caducada') {
            var tarjeta = marcas[i].closest('.aprobacion');
            if (tarjeta && !tarjeta.classList.contains('caducada')) {
              tarjeta.classList.add('caducada');
              var botones = tarjeta.querySelectorAll('.botones button');
              for (var j = 0; j < botones.length; j += 1) botones[j].disabled = true;
            }
          }
        }
      }
      window.setInterval(actualizarCaducidades, 1000);

      // Las aprobaciones esperando se ven sin buscarlas: contador en la tarjeta y en la pestaña.
      // Las tarjetas se repintan enteras (y la cuenta atrás cambia cada segundo),
      // así que no son regiones vivas: solo se anuncia lo nuevo, una vez.
      var pendientesPrevios = null;
      function anunciar(texto) {
        if (!texto) return;
        var region = document.getElementById('anuncio');
        region.textContent = '';
        window.setTimeout(function () { region.textContent = texto; }, 50);
      }

      function marcarPendientes(n) {
        anunciar(formato.anuncioPendientes(pendientesPrevios, n));
        pendientesPrevios = n;
        var contador = document.getElementById('contador-aprobaciones');
        var tarjeta = document.getElementById('tarjeta-aprobaciones');
        contador.textContent = n > 0 ? String(n) : '';
        contador.hidden = !(n > 0);
        contador.setAttribute('aria-label', n === 1 ? '1 pendiente' : n + ' pendientes');
        tarjeta.classList.toggle('pendiente', n > 0);
        document.title = formato.tituloPestana(n);
      }

      function pintarAprobaciones(contenedor, datos) {
        contenedor.replaceChildren();
        if (ultimaDecision) {
          contenedor.appendChild(nodo('p', 'resultado chip ok', ultimaDecision));
          ultimaDecision = '';
        }
        var lista = listaDeAprobaciones(datos);
        marcarPendientes(lista ? lista.length : 0);
        if (!lista) {
          contenedor.appendChild(renderValor(datos, 0));
          return;
        }
        if (lista.length === 0) {
          contenedor.appendChild(nodo('p', 'muted', 'No hay aprobaciones pendientes.'));
          return;
        }
        contenedor.appendChild(
          nodo(
            'p',
            'muted',
            lista.length + (lista.length === 1 ? ' aprobación pendiente' : ' aprobaciones pendientes')
          )
        );
        for (var i = 0; i < lista.length; i += 1) {
          var item = lista[i];
          var id = idAprobacion(item);
          var resumen = formato.resumenAprobacion(item, i);
          var tarjeta = document.createElement('article');
          tarjeta.className = 'aprobacion';
          tarjeta.setAttribute('data-titulo', resumen.titulo);
          var tituloId = 'aprobacion-' + i;
          tarjeta.setAttribute('aria-labelledby', tituloId);
          var titulo = nodo('h3', 'pregunta', resumen.titulo);
          titulo.id = tituloId;
          tarjeta.appendChild(titulo);
          var meta = [];
          if (resumen.motivo) meta.push(resumen.motivo);
          if (resumen.herramienta) meta.push('Herramienta: ' + resumen.herramienta);
          if (meta.length) tarjeta.appendChild(nodo('p', 'meta', meta.join(' · ')));
          if (resumen.caduca !== null) {
            var caduca = nodo('p', 'caduca', formato.tiempoRestante(resumen.caduca, Date.now()));
            caduca.setAttribute('data-caduca', String(resumen.caduca));
            tarjeta.appendChild(caduca);
          }
          if (item && typeof item === 'object') {
            var detalles = document.createElement('details');
            detalles.appendChild(nodo('summary', null, 'Detalles técnicos'));
            detalles.appendChild(renderValor(item, 1));
            tarjeta.appendChild(detalles);
          }
          var botones = document.createElement('div');
          botones.className = 'botones';
          botones.setAttribute('role', 'group');
          botones.setAttribute('aria-label', 'Decisión');
          if (id) {
            for (var j = 0; j < DECISIONES.length; j += 1) {
              (function (identificador, decision, tarjetaActual) {
                var boton = nodo('button', decision.clase, decision.texto);
                boton.type = 'button';
                boton.addEventListener('click', function () {
                  aprobar(identificador, decision, tarjetaActual);
                });
                botones.appendChild(boton);
              })(id, DECISIONES[j], tarjeta);
            }
          } else {
            botones.appendChild(nodo('span', 'muted', 'Sin identificador: decide desde Telegram.'));
          }
          tarjeta.appendChild(botones);
          var resultado = nodo('p', 'resultado');
          resultado.setAttribute('role', 'status');
          tarjeta.appendChild(resultado);
          contenedor.appendChild(tarjeta);
        }
        actualizarCaducidades();
      }

      async function cargarAprobaciones() {
        var contenedor = document.getElementById('panel-aprobaciones');
        pintarCarga(contenedor);
        try {
          pintarAprobaciones(contenedor, await pedir('/api/approvals'));
          finCarga(contenedor, true);
        } catch (error) {
          avisoConexion(false);
          pintarError(contenedor, error, cargarAprobaciones); return false;
        }
        avisoConexion(false);
        return true;
      }

      // Recarga periódica: sin «Cargando…» y sin repintar si el usuario está pulsando un botón.
      async function cargarAprobacionesEnSilencio() {
        var contenedor = document.getElementById('panel-aprobaciones');
        if (contenedor.contains(document.activeElement) && document.activeElement.tagName === 'BUTTON') return;
        try {
          pintarAprobaciones(contenedor, await pedir('/api/approvals'));
          finCarga(contenedor, true);
        } catch (error) {
          if (!(error && error.sinToken)) avisoConexion(true);
          return;
        }
        avisoConexion(false);
      }

      // Si el asistente deja de responder, la recarga automática lo dice y lo quita al volver.
      // desdeChat = true: un envío del chat no llegó; el aviso del chat se quita al volver la conexión.
      function avisoConexion(caido, desdeChat) {
        var aviso = document.getElementById('conexion-aprobaciones');
        if (aviso && aviso.hidden !== !caido) {
          aviso.hidden = !caido;
          if (!caido) anunciar('Conexión con el asistente recuperada.');
        }
        var avisoChat = document.getElementById('conexion-chat');
        if (!avisoChat || avisoChat === aviso) return;
        if (!caido) avisoChat.hidden = true;
        else if (desdeChat) avisoChat.hidden = false;
      }


      // Conversación de esta pestaña: el panel no guarda historial en el servidor.
      var MAX_TURNOS_CHAT = 20;

      function anadirTurno(clase, quien, texto) {
        var panel = document.getElementById('panel-chat');
        var turno = nodo('div', 'turno ' + clase);
        turno.appendChild(nodo('p', 'quien', quien));
        var cuerpo = nodo('p', 'texto', texto);
        turno.appendChild(cuerpo);
        panel.appendChild(turno);
        while (panel.children.length > MAX_TURNOS_CHAT * 2) panel.removeChild(panel.firstChild);
        turno.scrollIntoView({ block: 'nearest' });
        return turno;
      }

      async function enviarChat(evento, textoForzado) {
        if (evento) evento.preventDefault();
        var campo = document.getElementById('texto-chat');
        var boton = document.getElementById('enviar-chat');
        var texto = textoForzado !== undefined ? textoForzado : campo.value;
        if (!texto.trim()) {
          campo.focus();
          return;
        }
        // Un mensaje cada vez: con Enter el formulario se envía aunque «Enviar» esté
        // desactivado. Mientras Asistenta responde, el texto se queda en el campo.
        if (chatOcupado) return;
        chatOcupado = true;
        // En el móvil (≤ 780 px), tras pulsar «Enviar», enfocar el campo abre el teclado
        // y tapa la respuesta: allí solo vuelve al campo si ya lo tenía (Enter).
        var volverAlCampo = document.activeElement === campo || !pantallaPequena();
        boton.disabled = true;
        campo.value = '';
        anadirTurno('yo', 'Tú', texto);
        var espera = anadirTurno('asistente esperando', 'Asistenta', formato.textoEspera(0));
        var cuerpo = espera.querySelector('.texto');
        var inicio = Date.now();
        var reloj = window.setInterval(function () {
          cuerpo.textContent = formato.textoEspera(Date.now() - inicio);
        }, 1000);
        try {
          var datos = await enviar('/api/chat', { text: texto });
          var respuesta =
            datos && typeof datos === 'object' && typeof datos.text === 'string'
              ? datos.text
              : JSON.stringify(datos);
          espera.className = 'turno asistente';
          cuerpo.textContent = respuesta.trim() ? respuesta : '(Sin respuesta de texto.)';
          if (typeof pintarArchivos === 'function') pintarArchivos(espera, datos);
          avisoConexion(false);
        } catch (error) {
          if (error && error.sinConexion) avisoConexion(true, true);
          espera.className = 'turno asistente fallo';
          cuerpo.className = 'texto error';
          cuerpo.textContent =
            error && error.message ? error.message : 'No se pudo enviar el mensaje.';
          var reintentar = nodo('button', 'mini', 'Reintentar');
          reintentar.type = 'button';
          reintentar.addEventListener('click', function () {
            if (chatOcupado) return;
            reintentar.disabled = true;
            // Sin conexión el mensaje no llegó: se manda otra vez. Si llegó y falló el
            // turno, se repite sin la respuesta anterior (como /reintentar).
            if (error && error.sinConexion) enviarChat(null, texto);
            else repetirUltimo();
          });
          espera.appendChild(reintentar);
          if (!campo.value) campo.value = texto;
          if (!volverAlCampo) devolverFoco(reintentar);
        } finally {
          chatOcupado = false;
          window.clearInterval(reloj);
          boton.disabled = false;
          if (volverAlCampo) campo.focus();
          else devolverFoco(espera);
        }
      }

      // Archivos que devuelve un turno del panel (documentos, vídeo, nota de voz…):
      // enlaces de descarga. Solo «data:» en base64 de tipos que no ejecutan nada
      // (ni HTML ni SVG); el nombre va como texto, nunca como HTML.
      var ARCHIVO_PROHIBIDO = ['text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/javascript', 'application/javascript'];
      function archivoValido(url) {
        if (typeof url !== 'string' || url.slice(0, 5) !== 'data:') return false;
        var coma = url.indexOf(',');
        var cabecera = coma > 5 ? url.slice(5, coma).toLowerCase() : '';
        if (cabecera.slice(-7) !== ';base64') return false;
        var tipo = cabecera.slice(0, -7);
        var partes = tipo.split('/');
        if (partes.length !== 2 || !partes.every(function (p) { return /^[a-z0-9.+-]+$/.test(p); })) return false;
        if (ARCHIVO_PROHIBIDO.indexOf(tipo) !== -1) return false;
        var datos = url.slice(coma + 1);
        return datos.length > 0 && datos.split('/').every(function (p) { return /^[A-Za-z0-9+=]*$/.test(p); });
      }
      // Capturas de un turno (chat o «Reintentar»): solo PNG/JPEG en «data:» base64, máx. 4.
      function pintarImagenes(turno, datos) {
        var lista = datos && Array.isArray(datos.images) ? datos.images : [];
        var validas = lista.filter(function (u) {
          return typeof u === 'string' && /^data:image\\/(png|jpeg);base64,[A-Za-z0-9+\\/]+=*$/.test(u);
        }).slice(0, 4);
        if (!validas.length) return;
        var caja = nodo('div', 'capturas');
        caja.setAttribute('data-capturas', String(validas.length));
        validas.forEach(function (u, i) {
          var img = nodo('img', 'captura');
          img.src = u;
          img.alt = 'Captura ' + (i + 1) + ' del turno';
          caja.appendChild(img);
        });
        turno.appendChild(caja);
      }
      function pintarArchivos(turno, datos) {
        pintarImagenes(turno, datos);
        var lista = datos && Array.isArray(datos.files) ? datos.files : [];
        var validos = lista.filter(function (f) {
          return f && typeof f.name === 'string' && f.name.trim() && archivoValido(f.url);
        }).slice(0, 4);
        if (!validos.length) return;
        var caja = nodo('div', 'archivos');
        caja.setAttribute('data-archivos', String(validos.length));
        validos.forEach(function (f) {
          var nombre = f.name.split('/').join('_').split('\\\\').join('_').slice(0, 120);
          var enlace = nodo('a', 'archivo', '📎 ' + nombre);
          enlace.href = f.url;
          enlace.setAttribute('download', nombre);
          enlace.setAttribute('rel', 'noopener');
          caja.appendChild(enlace);
        });
        turno.appendChild(caja);
      }

      async function repetirUltimo() {
        if (chatOcupado) return;
        chatOcupado = true;
        var espera = anadirTurno('asistente esperando', 'Asistenta', formato.textoEspera(0));
        espera.setAttribute('data-reintento', 'true');
        var cuerpo = espera.querySelector('.texto');
        try {
          var datos = await enviar('/api/chat/retry', {});
          var respuesta = datos && typeof datos.text === 'string' ? datos.text : '';
          espera.className = 'turno asistente';
          cuerpo.textContent = respuesta.trim() ? respuesta : '(Sin respuesta de texto.)';
          if (typeof pintarArchivos === 'function') pintarArchivos(espera, datos);
          avisoConexion(false);
          chatOcupado = false;
          devolverFoco(espera);
        } catch (error) {
          chatOcupado = false;
          espera.className = 'turno asistente fallo';
          cuerpo.className = 'texto error';
          cuerpo.textContent = error && error.message ? error.message : 'No se pudo repetir el mensaje.';
          if (error && error.sinConexion) avisoConexion(true, true);
          // Si la repetición también falla, se puede volver a intentar (sin conexión o
          // turno fallido). No si no hay nada que repetir (409) o falta el token.
          if (error && (error.estado === 409 || error.sinToken)) {
            devolverFoco(espera);
            return;
          }
          var otraVez = nodo('button', 'mini', 'Reintentar');
          otraVez.type = 'button';
          otraVez.addEventListener('click', function () {
            if (chatOcupado) return;
            otraVez.disabled = true;
            repetirUltimo();
          });
          espera.appendChild(otraVez);
          devolverFoco(otraVez);
        }
      }

      // Al pulsar «Reintentar» el botón se desactiva y el foco del teclado se pierde
      // (vuelve al principio de la página). Si nadie lo ha movido entretanto, se lleva
      // al nuevo «Reintentar» o al turno nuevo; si Nico ya está escribiendo, no se toca.
      function devolverFoco(destino) {
        var activo = document.activeElement;
        if (activo && activo !== document.body && !activo.disabled) return;
        if (!destino || typeof destino.focus !== 'function') return;
        if (destino.tagName !== 'BUTTON') destino.setAttribute('tabindex', '-1');
        destino.focus();
      }

      // true mientras un mensaje o un «Reintentar» del chat espera respuesta.
      var chatOcupado = false;

      async function cargarObjetivos() {
        var contenedor = document.getElementById('panel-objetivos');
        pintarCarga(contenedor);
        try {
          var objetivos = await pedir('/api/goals');
          if (!Array.isArray(objetivos)) throw new Error('Respuesta de objetivos inválida');
          contenedor.replaceChildren(nodo('p', 'muted', 'Solo lectura: para cambiar un objetivo, pídelo en el chat o en Telegram.'));
          if (!objetivos.length) contenedor.appendChild(nodo('p', 'muted', 'No hay objetivos del propietario.'));
          var claseEstado = { active: 'ok', done: 'ok', blocked: 'mal', cancelled: 'mal' };
          var estados = { proposed: 'Propuesto', active: 'Activo', paused: 'Pausado', blocked: 'Bloqueado', done: 'Terminado', cancelled: 'Cancelado' };
          objetivos.forEach(function (objetivo) {
            var tarjeta = nodo('section', 'sesion');
            tarjeta.appendChild(nodo('h3', null, objetivo.title));
            var linea = nodo('p', 'meta-objetivo');
            linea.appendChild(insignia(claseEstado[objetivo.status] || '', estados[objetivo.status] || objetivo.status));
            var progreso = formato.progresoPlan(objetivo.plan);
            linea.appendChild(nodo('span', 'muted', (progreso ? ' ' + progreso + ' · ' : ' ') + 'Hilo: ' + objetivo.thread));
            tarjeta.appendChild(linea);
            if (objetivo.status === 'blocked' && objetivo.blockedReason) tarjeta.appendChild(nodo('p', 'error', 'Bloqueado: ' + objetivo.blockedReason));
                        var detalles = document.createElement('details');
            detalles.appendChild(nodo('summary', null, 'Plan y contexto'));
            detalles.appendChild(nodo('p', 'muted', 'ID: ' + objetivo.id + ' · Ámbito: ' + objetivo.scope));
            var lista = document.createElement('ul');
            objetivo.plan.forEach(function (paso) { lista.appendChild(nodo('li', null, (paso.done ? '✓ Hecho: ' : '○ Pendiente: ') + paso.text)); });
            detalles.appendChild(lista);
            if (objetivo.blockedReason) detalles.appendChild(nodo('p', 'texto', 'Bloqueo: ' + objetivo.blockedReason));
            if (objetivo.lastOutcome) detalles.appendChild(nodo('p', 'texto', 'Último resultado: ' + objetivo.lastOutcome));
            detalles.appendChild(nodo('p', 'muted', 'Actualizado: ' + (formato.formatearCampo('updatedAt', objetivo.updatedAt) || objetivo.updatedAt)));
            tarjeta.appendChild(detalles);
            if (objetivo.panelChatAvailable) {
              var enlace = nodo('a', null, 'Ir al chat principal del panel');
              enlace.href = '#titulo-chat';
              tarjeta.appendChild(enlace);
              tarjeta.appendChild(nodo('p', 'muted', 'El chat no modifica este objetivo automáticamente.'));
            } else tarjeta.appendChild(nodo('p', 'muted', 'Continúa en el hilo original de Telegram: ' + objetivo.thread + '. El chat del panel solo abre el principal.'));
            contenedor.appendChild(tarjeta);
          });
          finCarga(contenedor, true);
        } catch (error) { pintarError(contenedor, error, cargarObjetivos); return false; }
        return true;
      }

      async function cargarEstado() {
        var contenedor = document.getElementById('panel-estado');
        pintarCarga(contenedor);
        try {
          contenedor.replaceChildren(renderValor(await pedir('/api/status'), 0));
          finCarga(contenedor, true);
        } catch (error) {
          pintarError(contenedor, error, cargarEstado); return false;
        }
        return true;
      }

      async function cargarSesiones() {
        var contenedor = document.getElementById('panel-sesiones');
        var consulta = document.getElementById('buscar-sesiones').value.trim();
        var ruta = '/api/sessions' + (consulta ? '?q=' + encodeURIComponent(consulta) : '');
        pintarCarga(contenedor);
        try {
          pintarSesiones(contenedor, await pedir(ruta));
          finCarga(contenedor, true);
        } catch (error) {
          pintarError(contenedor, error, cargarSesiones); return false;
        }
        return true;
      }

      function pintarMemoria(contenedor, datos) {
        var memoria = formato.resumenMemoria(datos);
        if (!memoria) {
          contenedor.replaceChildren(renderValor(datos, 0));
          return;
        }
        contenedor.replaceChildren();
        if (!memoria.vigentes.length) {
          contenedor.appendChild(
            nodo('p', 'muted', 'No hay recuerdos en este ámbito. Prueba otro (por ejemplo «local»).')
          );
        } else {
          contenedor.appendChild(
            nodo('p', 'muted', memoria.vigentes.length + (memoria.vigentes.length === 1 ? ' recuerdo' : ' recuerdos'))
          );
        }
        function lista(entradas) {
          var ul = nodo('ul', 'recuerdos');
          entradas.forEach(function (entrada) {
            var li = nodo('li', 'recuerdo');
            li.appendChild(nodo('p', 'texto', entrada.texto));
            if (entrada.meta) li.appendChild(nodo('p', 'muted', entrada.meta));
            ul.appendChild(li);
          });
          return ul;
        }
        if (memoria.vigentes.length) contenedor.appendChild(lista(memoria.vigentes));
        if (memoria.sustituidas.length) {
          var historial = document.createElement('details');
          historial.appendChild(
            nodo('summary', null, 'Historial: ' + memoria.sustituidas.length + ' sustituidos')
          );
          historial.appendChild(lista(memoria.sustituidas));
          contenedor.appendChild(historial);
        }
      }

      async function cargarMemoria() {
        var contenedor = document.getElementById('panel-memoria');
        var ambito = document.getElementById('ambito-memoria').value.trim();
        var ruta = '/api/memory' + (ambito ? '?scope=' + encodeURIComponent(ambito) : '');
        pintarCarga(contenedor);
        try {
          pintarMemoria(contenedor, await pedir(ruta));
          finCarga(contenedor, true);
        } catch (error) {
          pintarError(contenedor, error, cargarMemoria); return false;
        }
        return true;
      }

      async function cargarAuditoria() {
        var contenedor = document.getElementById('panel-auditoria');
        pintarCarga(contenedor);
        try {
          pintarAuditoria(contenedor, await pedir('/api/audit/verify'));
          finCarga(contenedor, true);
        } catch (error) {
          pintarError(contenedor, error, cargarAuditoria); return false;
        }
        return true;
      }

      // silencio = true: recarga al volver a la pestaña, sin «Cargando…» y sin tapar lo que ya se ve si falla.
      async function cargarRutinas(silencio) {
        var contenedor = document.getElementById('panel-rutinas');
        if (silencio !== true) pintarCarga(contenedor);
        try {
          var rutinas = await pedir('/api/routines');
          if (!Array.isArray(rutinas)) throw new Error('Respuesta de rutinas inválida');
          contenedor.replaceChildren(nodo('p', 'muted', 'Solo lectura: para crear o cambiar una rutina, usa /cron en Telegram o pídelo en el chat.'));
          if (!rutinas.length) contenedor.appendChild(nodo('p', 'muted', 'No hay rutinas programadas.'));
          rutinas.forEach(function (rutina) {
            var tarjeta = nodo('section', 'sesion rutina');
            tarjeta.setAttribute('data-rutina', rutina.nombre);
            var titulo = nodo('h3', null, rutina.nombre + ' ');
            if (rutina.comando) titulo.appendChild(insignia('', 'comando'));
            if (!rutina.activa) titulo.appendChild(insignia('mal', 'Pausada'));
            tarjeta.appendChild(titulo);
            if (rutina.activa) tarjeta.appendChild(nodo('p', 'texto', 'Próxima: ' + rutina.proxima));
            tarjeta.appendChild(nodo('p', 'muted', 'Horario: ' + rutina.horario));
            tarjeta.appendChild(nodo('p', 'muted', 'Última: ' + (rutina.ultima || 'todavía no se ha ejecutado')));
            if (rutina.comando) tarjeta.appendChild(nodo('p', 'muted', rutina.comando));
            contenedor.appendChild(tarjeta);
          });
          finCarga(contenedor, true);
        } catch (error) {
          if (silencio === true) return false;
          pintarError(contenedor, error, cargarRutinas); return false;
        }
        return true;
      }

      function pantallaPequena() {
        return !!(window.matchMedia && window.matchMedia('(max-width: 780px)').matches);
      }

      // Qué áreas de Funciones dejó Nico abiertas o cerradas a mano: { id: true|false }.
      // Solo se guarda al pulsar un título; sin elección guardada manda el ancho de pantalla.
      var CLAVE_FUNCIONES = 'asistenta.webui.funciones';
      function funcionesGuardadas() {
        try {
          var valor = JSON.parse(window.localStorage.getItem(CLAVE_FUNCIONES) || '{}');
          return valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : {};
        } catch (error) { return {}; }
      }
      function guardarFuncion(id, abierta) {
        try {
          var valor = funcionesGuardadas();
          valor[id] = abierta === true;
          window.localStorage.setItem(CLAVE_FUNCIONES, JSON.stringify(valor));
        } catch (error) { /* almacén bloqueado: no se recuerda, sin romper */ }
      }

      async function cargarFunciones() {
        var contenedor = document.getElementById('panel-funciones');
        pintarCarga(contenedor);
        try {
          var areas = await pedir('/api/funciones');
          if (!Array.isArray(areas)) throw new Error('Respuesta de funciones inválida');
          contenedor.replaceChildren(nodo('p', 'muted', 'Lo mismo que /funciones en Telegram: qué sé hacer, por áreas, con un ejemplo de cómo pedirlo.'));
          var guardadas = funcionesGuardadas();
          areas.forEach(function (area) {
            // Cada área se pliega (details/summary): en el móvil (≤ 780 px) empiezan
            // cerradas para que la tarjeta no ocupe varias pantallas.
            var bloque = document.createElement('details');
            bloque.className = 'sesion funcion';
            var elegida = guardadas[area.id];
            bloque.open = typeof elegida === 'boolean' ? elegida : !pantallaPequena();
            bloque.setAttribute('data-funcion', area.id);
            var cabeza = nodo('summary', 'funcion-titulo');
            // «click» en el <summary> llega también con Enter/Espacio; corre antes de que
            // el navegador cambie .open, así que se guarda lo contrario de lo que hay.
            cabeza.addEventListener('click', function () { guardarFuncion(area.id, !bloque.open); });
            cabeza.appendChild(nodo('h3', null, area.titulo));
            bloque.appendChild(cabeza);
            bloque.appendChild(nodo('p', 'texto', area.resumen));
            bloque.appendChild(nodo('p', 'muted', 'Ejemplo: «' + area.ejemplo + '»'));
            var lista = nodo('ul', 'comandos');
            (Array.isArray(area.comandos) ? area.comandos : []).forEach(function (c) {
              var fila = nodo('li', null);
              fila.appendChild(nodo('code', null, c.comando));
              fila.appendChild(document.createTextNode(' — ' + c.descripcion));
              lista.appendChild(fila);
            });
            bloque.appendChild(lista);
            contenedor.appendChild(bloque);
          });
          finCarga(contenedor, true);
        } catch (error) { pintarError(contenedor, error, cargarFunciones); return false; }
        return true;
      }

      var refrescos = {
        objetivos: cargarObjetivos,
        rutinas: cargarRutinas,
        funciones: cargarFunciones,
        estado: cargarEstado,
        sesiones: cargarSesiones,
        memoria: cargarMemoria,
        auditoria: cargarAuditoria,
        aprobaciones: cargarAprobaciones
      };

      function refrescarTodo() {
        var boton = document.getElementById('refrescar');
        var marca = document.getElementById('actualizado');
        boton.disabled = true;
        marca.textContent = 'Actualizando…';
        document.body.setAttribute('aria-busy', 'true');
        Promise.all([
          cargarObjetivos(),
          cargarRutinas(),
          cargarFunciones(),
          cargarEstado(),
          cargarSesiones(),
          cargarMemoria(),
          cargarAmbitos(),
          cargarAuditoria(),
          cargarAprobaciones()
        ])
          .then(function (resultados) {
            var fallos = resultados.filter(function (ok) { return !ok; }).length;
            var hora = new Date().toLocaleTimeString('es-ES');
            if (!token) marca.textContent = 'Sin token';
            else if (fallos === 0) marca.textContent = 'Actualizado · ' + hora;
            else marca.textContent = fallos + (fallos === 1 ? ' sección' : ' secciones') + ' con error · ' + hora;
          })
          .catch(function (error) {
            marca.textContent = 'Error al actualizar';
          })
          .finally(function () {
            boton.disabled = false;
            document.body.removeAttribute('aria-busy');
          });
      }

      document.getElementById('form-token').addEventListener('submit', function (evento) {
        evento.preventDefault();
        var campo = document.getElementById('campo-token');
        var valor = campo.value.trim();
        if (!valor) return;
        token = valor;
        try {
          window.localStorage.setItem(CLAVE_TOKEN, valor);
        } catch (error) {}
        campo.value = '';
        evento.currentTarget.hidden = true;
        mostrarAviso('');
        // El formulario se oculta con el foco dentro: pasa al contenido principal.
        document.getElementById('contenido').focus();
        refrescarTodo();
      });

      var temporizadorSesiones = 0;
      document.getElementById('buscar-sesiones').addEventListener('input', function () {
        window.clearTimeout(temporizadorSesiones);
        temporizadorSesiones = window.setTimeout(cargarSesiones, 300);
      });

      var temporizadorMemoria = 0;
      document.getElementById('ambito-memoria').addEventListener('change', function () {
        window.clearTimeout(temporizadorMemoria);
        cargarMemoria();
      });

      // Ámbitos conocidos (chats con memoria) en vez de escribir «telegram:dm:…» a mano.
      async function cargarAmbitos() {
        var lista = document.getElementById('ambito-memoria');
        var ambitos;
        try {
          ambitos = await pedir('/api/memory/scopes');
        } catch (error) {
          return;
        }
        // Sin ámbito, /api/memory lee el ámbito por defecto (el privado del dueño si
        // está configurado): la primera opción lo dice en vez de «Local».
        var porDefecto = '';
        if (ambitos && !Array.isArray(ambitos) && typeof ambitos === 'object') {
          porDefecto = typeof ambitos.porDefecto === 'string' ? ambitos.porDefecto : '';
          ambitos = ambitos.ambitos;
        }
        if (!Array.isArray(ambitos)) return;
        var elegido = lista.value;
        var opciones = [nodo('option', null, formato.etiquetaAmbitoPorDefecto(porDefecto))];
        opciones[0].value = '';
        ambitos.forEach(function (ambito) {
          if (typeof ambito !== 'string' || !ambito || ambito === 'local' || ambito === porDefecto) return;
          var opcion = nodo('option', null, formato.etiquetaAmbito(ambito));
          opcion.value = ambito;
          opciones.push(opcion);
        });
        lista.replaceChildren.apply(lista, opciones);
        lista.value = elegido;
        if (lista.value !== elegido) lista.value = '';
      }

      var formularioChat = document.getElementById('form-chat');
      formularioChat.addEventListener('submit', enviarChat);
      document.getElementById('texto-chat').addEventListener('keydown', function (evento) {
        if (evento.key === 'Enter' && !evento.shiftKey && !evento.isComposing) {
          evento.preventDefault();
          formularioChat.requestSubmit();
        }
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
        pedirToken('Falta el token de acceso: pégalo aquí o abre /?token=TU_TOKEN una vez.');
      }

      if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
          navigator.serviceWorker.register('/sw.js').catch(function (error) {});
        });
      }

      // Las aprobaciones caducan en minutos: se consultan solas mientras el panel está a la vista.
      window.setInterval(function () {
        if (document.visibilityState === 'visible' && token) cargarAprobacionesEnSilencio();
      }, 15000);

      // Al volver a la pestaña tras tenerla oculta, las aprobaciones se recargan ya (sin esperar hasta 15 s)
      // y las Rutinas también, para que «Próxima» y «Última» no se queden viejas.
      var ocultaDesde = 0;
      function alCambiarVisibilidad() {
        if (document.visibilityState !== 'visible') {
          if (!ocultaDesde) ocultaDesde = Date.now();
          return;
        }
        var volvio = ocultaDesde > 0;
        ocultaDesde = 0;
        if (volvio && token) {
          cargarAprobacionesEnSilencio();
          cargarRutinas(true);
        }
      }
      document.addEventListener('visibilitychange', alCambiarVisibilidad);

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
    description: 'Panel local de Asistenta: chat, aprobaciones y estado.',
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
