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

// El logo de Asistenta (scripts/windows-app/icono.mjs: «A» blanca en placa grafito y punto azul).
const ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">',
  '<rect width="512" height="512" rx="112" fill="#111827"/>',
  '<rect x="4" y="4" width="504" height="504" rx="108" fill="none" stroke="#ffffff"',
  ' stroke-opacity=".16" stroke-width="8"/>',
  '<path d="M150 396 256 120l106 276" fill="none" stroke="#ffffff" stroke-width="58"',
  ' stroke-linejoin="round"/>',
  '<circle cx="256" cy="318" r="30" fill="#4f8cff"/>',
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
    table.tabla-pagina { border-collapse: collapse; width: 100%; font-size: 0.9em; }
    table.tabla-pagina th, table.tabla-pagina td { border: 1px solid var(--borde); padding: 2px 6px; text-align: left; }
    .modelo-selector { margin-top: 0.9rem; border-top: 1px solid var(--borde, #2a3340); padding-top: 0.7rem; }
    .modelo-selector h3 { margin: 0 0 0.5rem; font-size: 0.95rem; }
    .modelo-fila { display: flex; gap: 0.5rem; align-items: center; margin: 0 0 0.35rem; }
    .modelo-fila select { background: var(--fondo, #10151c); color: var(--texto, #e6edf3); border: 1px solid var(--borde, #2a3340); border-radius: 6px; padding: 0.3rem 0.45rem; font: inherit; max-width: 100%; }
    .modelo-resultado { margin: 0.35rem 0 0; }
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
    .copiable { user-select: all; cursor: pointer; }
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
    .captura { max-width: 100%; height: auto; border-radius: 8px; border: 1px solid var(--borde); }
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
    .ctx-hilo { border: 1px solid var(--borde); border-radius: 12px; padding: 10px 12px; background: var(--panel-2); margin: 0 0 10px; }
    .ctx-hilo h3 { margin: 0 0 6px; font-size: 15px; display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
    .ctx-hilo h3 .muted { font-size: 13px; font-weight: normal; }
    .ctx-barra { display: flex; height: 14px; border-radius: 7px; overflow: hidden; background: #1a2533; margin: 6px 0 8px; }
    .ctx-barra span { display: block; height: 100%; min-width: 0; }
    .ctx-partes { list-style: none; margin: 0 0 6px; padding: 0; display: grid; gap: 3px; }
    .ctx-partes li { display: grid; grid-template-columns: 12px 1fr auto; gap: 8px; align-items: baseline; font-size: 14px; }
    .ctx-partes .punto { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
    .ctx-partes .num { font-variant-numeric: tabular-nums; }
    .ctx-partes .muted { grid-column: 2 / 4; font-size: 13px; margin-top: -2px; }
    .ctx-linea { margin: 3px 0; font-size: 14px; }
    .ctx-umbral { height: 8px; border-radius: 4px; background: #1a2533; overflow: hidden; margin: 2px 0 6px; }
    .ctx-umbral span { display: block; height: 100%; background: var(--acento); }
    .ctx-umbral.cerca span { background: #f59e0b; }
    .ctx-hilo details { font-size: 13px; color: var(--suave); }
    .ctx-hilo details p { margin: 4px 0 0; word-break: break-word; }
    .tarjeta.ancha { grid-column: 1 / -1; }
    .mapa-info { margin: 0 0 8px; font-size: 14px; }
    .mapa-lienzo { display: block; width: 100%; height: auto; aspect-ratio: 1 / 1; max-height: 72vh; background: var(--panel-2); border: 1px solid var(--borde); border-radius: 12px; touch-action: manipulation; }
    .mapa-lienzo line { stroke-opacity: 0.55; }
    .mapa-lienzo .nodo { stroke: #0b0f14; stroke-width: 2; cursor: pointer; }
    .mapa-lienzo .toque { fill: transparent; cursor: pointer; }
    .mapa-lienzo .apagado { opacity: 0.12; }
    .mapa-lienzo .elegido .nodo { stroke: #ffffff; stroke-width: 6; }
    .mapa-lienzo line.resaltado { stroke-opacity: 1; stroke-width: 4; }
    .mapa-leyenda { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 8px 0 0; padding: 0; list-style: none; font-size: 13px; color: var(--suave); }
    .mapa-leyenda .raya { display: inline-block; width: 18px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 5px; }
    .mapa-resultados { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 0; }
    .mapa-resultados button, .mapa-detalle button { font-size: 13px; text-align: left; max-width: 100%; white-space: normal; }
    .mapa-detalle { margin-top: 10px; border: 1px solid var(--borde); border-radius: 12px; padding: 10px 12px; background: var(--panel-2); }
    .mapa-detalle .texto { margin: 0 0 4px; font-size: 15px; }
    .mapa-detalle ul { list-style: none; margin: 6px 0 0; padding: 0; display: grid; gap: 4px; }
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

      <article class="tarjeta" aria-labelledby="titulo-tareas">
        <header class="tarjeta-cabecera">
          <h2 id="titulo-tareas">Tareas de la semana</h2>
          <button class="mini" type="button" data-refrescar="tareas" aria-label="Refrescar Tareas de la semana">Refrescar</button>
        </header>
        <div id="panel-tareas" class="tarjeta-cuerpo">
          <p class="muted">Cargando…</p>
        </div>
      </article>

      <article class="tarjeta" aria-labelledby="titulo-repartos">
        <header class="tarjeta-cabecera">
          <h2 id="titulo-repartos">Paquetes</h2>
          <button class="mini" type="button" data-refrescar="repartos" aria-label="Refrescar Paquetes">Refrescar</button>
        </header>
        <div id="panel-repartos" class="tarjeta-cuerpo">
          <p class="muted">Cargando…</p>
        </div>
      </article>

      <article class="tarjeta" aria-labelledby="titulo-paginas">
        <header class="tarjeta-cabecera">
          <h2 id="titulo-paginas">Páginas</h2>
          <button class="mini" type="button" data-refrescar="paginas" aria-label="Refrescar Páginas">Refrescar</button>
        </header>
        <div id="panel-paginas" class="tarjeta-cuerpo">
          <p class="muted">Cargando…</p>
        </div>
        <div id="panel-pagina-vista" class="tarjeta-cuerpo" hidden></div>
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

      <article class="tarjeta" aria-labelledby="titulo-contexto">
        <header class="tarjeta-cabecera">
          <h2 id="titulo-contexto">Contexto</h2>
          <button class="mini" type="button" data-refrescar="contexto" aria-label="Refrescar Contexto">Refrescar</button>
        </header>
        <div id="panel-contexto" class="tarjeta-cuerpo">
          <p class="muted">Cargando…</p>
        </div>
      </article>

      <article class="tarjeta" aria-labelledby="titulo-sesiones">
        <header class="tarjeta-cabecera">
          <h2 id="titulo-sesiones">Conversaciones</h2>
          <div class="controles">
            <label class="buscador" for="buscar-sesiones">
              Buscar
              <input id="buscar-sesiones" type="search" placeholder="Texto…" autocomplete="off" spellcheck="false" />
            </label>
            <button class="mini" type="button" data-refrescar="sesiones" aria-label="Refrescar Conversaciones">Refrescar</button>
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

      <article class="tarjeta ancha" aria-labelledby="titulo-mapa">
        <header class="tarjeta-cabecera">
          <h2 id="titulo-mapa">Mapa de memoria</h2>
          <div class="controles">
            <label class="buscador" for="buscar-mapa">
              Buscar
              <input id="buscar-mapa" type="search" placeholder="Texto o etiqueta…" autocomplete="off" spellcheck="false" />
            </label>
            <button class="mini" type="button" data-refrescar="mapa" aria-label="Refrescar Mapa de memoria">Refrescar</button>
          </div>
        </header>
        <div id="panel-mapa" class="tarjeta-cuerpo sin-tope">
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
      // Sin espacios ni saltos de línea: el enlace copiado a veces los arrastra.
      var tokenDeUrl = (parametros.get('token') || '').trim();

      // El token de la URL se guarda una vez y desaparece de la barra de direcciones.
      if (parametros.has('token')) {
        if (tokenDeUrl) {
          try {
            window.localStorage.setItem(CLAVE_TOKEN, tokenDeUrl);
          } catch (error) {
            // Un navegador sin almacenamiento sigue pudiendo usar el panel en esta visita.
          }
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

      // El de la URL vale ya en esta visita aunque el navegador no deje guardarlo
      // (modo privado estricto, almacenamiento bloqueado).
      var token = tokenDeUrl;
      if (!token) {
        try {
          token = (window.localStorage.getItem(CLAVE_TOKEN) || '').trim();
        } catch (error) {}
      }

      var aviso = document.getElementById('aviso');

      function mostrarAviso(texto) {
        // role=alert: reescribir el mismo texto (p. ej. cada refresco de 15 s con el token
        // rechazado) haría que el lector lo anunciara otra vez. Solo se toca si cambia.
        if (aviso.textContent === texto && aviso.hidden === !texto) return;
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
            boton.disabled = true;
            // Al recargar, el bloque (y este botón) desaparece y el foco del teclado se iría
            // al principio de la página: pasa al nuevo «Reintentar» o al título de la tarjeta.
            Promise.resolve(reintentar()).then(function () {
              var tarjeta = contenedor.closest('.tarjeta');
              devolverFoco(
                contenedor.querySelector('.error-bloque button') ||
                  (tarjeta && tarjeta.querySelector('h2')) ||
                  contenedor
              );
            });
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
        // Sin respuesta en 30 s (un proceso viejo que dejó el panel abierto sin Asistenta
        // detrás, 2 nov) o sin conexión: se dice claro, no «Cargando…» para siempre.
        function errorNoEnMarcha() {
          var sinRed = new Error(
            'Asistenta no está en marcha: reiníciala (bandeja → Reiniciar o pa iniciar).'
          );
          sinRed.sinConexion = true;
          return sinRed;
        }
        var cabeceras = { Authorization: 'Bearer ' + token };
        if (opciones.cuerpo !== undefined) cabeceras['Content-Type'] = 'application/json';
        // Solo las lecturas tienen tope: una orden (POST) puede tardar lo que tarde.
        var corte =
          opciones.metodo === 'GET' && typeof AbortController === 'function'
            ? new AbortController()
            : null;
        var reloj = corte
          ? setTimeout(function () {
              corte.abort();
            }, 30000)
          : null;
        var respuesta;
        try {
          respuesta = await fetch(ruta, {
            method: opciones.metodo,
            headers: cabeceras,
            body: opciones.cuerpo === undefined ? undefined : JSON.stringify(opciones.cuerpo),
            cache: 'no-store',
            credentials: 'omit',
            signal: corte ? corte.signal : undefined
          });
        } catch (error) {
          if (reloj) clearTimeout(reloj);
          throw errorNoEnMarcha();
        }
        var datos = null;
        var esJson = true;
        try {
          datos = await respuesta.json();
        } catch (error) {
          esJson = false;
        }
        if (reloj) clearTimeout(reloj);
        if (corte && corte.signal.aborted) throw errorNoEnMarcha();
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
        if (!esJson) throw new Error('El panel ha contestado algo que no entiendo. Recarga la página.');
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
          contenedor.appendChild(nodo('p', 'muted', 'No hay conversaciones que coincidan.'));
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
        { id: 'session', texto: 'Permitir por ahora', clase: '', hecho: 'Permitido por ahora' },
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

      // Al repintar (p. ej. la recarga silenciosa) el aviso «Permitido…» ya no se borra si
      // el foco del teclado está en él, y si el foco estaba en la tarjeta no cae al principio.
      function pintarAprobaciones(contenedor, datos) {
        var foco = document.activeElement;
        var focoDentro = !!foco && foco !== contenedor && contenedor.contains(foco);
        if (focoDentro && !ultimaDecision && foco.classList && foco.classList.contains('resultado')) ultimaDecision = foco.textContent;
        pintarListaAprobaciones(contenedor, datos);
        if (focoDentro && !contenedor.contains(document.activeElement)) {
          var tarjetaAprobaciones = contenedor.closest ? contenedor.closest('.tarjeta') : null;
          devolverFoco(contenedor.querySelector('.resultado.chip') || (tarjetaAprobaciones && tarjetaAprobaciones.querySelector('h2')) || contenedor);
        }
      }

      function pintarListaAprobaciones(contenedor, datos) {
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
            // Lo que pide un especialista solo admite «una vez» o «denegar» (onceOnly).
            var soloUnaVez = !!(item && typeof item === 'object' && item.onceOnly === true);
            for (var j = 0; j < DECISIONES.length; j += 1) {
              if (soloUnaVez && DECISIONES[j].id !== 'once' && DECISIONES[j].id !== 'deny') continue;
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
        // Un mensaje nuevo manda: el reintento solo que hubiera pendiente sobra.
        if (typeof cancelarReintento === 'function') cancelarReintento();
        // En el móvil (≤ 780 px), tras pulsar «Enviar», enfocar el campo abre el teclado
        // y tapa la respuesta: allí solo vuelve al campo si ya lo tenía (Enter).
        var volverAlCampo = document.activeElement === campo || !pantallaPequena();
        boton.disabled = true;
        campo.value = '';
        anadirTurno('yo', 'Tú', texto);
        var espera = anadirTurno('asistente esperando', 'Asistenta', 'Pensando…');
        var cuerpo = espera.querySelector('.texto');
        // Los segundos cambian cada segundo dentro del registro vivo del chat: van aparte
        // y ocultos al lector de pantalla (si no, leería «Pensando… 1 s, 2 s…» sin parar).
        var segundos = nodo('span', 'segundos', '');
        segundos.setAttribute('aria-hidden', 'true');
        cuerpo.appendChild(segundos);
        var inicio = Date.now();
        var reloj = window.setInterval(function () {
          segundos.textContent = formato.textoEspera(Date.now() - inicio).replace('Pensando…', '');
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
          if (datos && datos.outage && typeof programarReintento === 'function') {
            programarReintento(espera, 0);
          }
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
          img.alt = 'Captura ' + (i + 1);
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

      // intentoAuto: número del reintento solo (sin red); sin él, lo pidió Nico.
      async function repetirUltimo(intentoAuto) {
        if (chatOcupado) return;
        chatOcupado = true;
        cancelarReintento();
        // Sin reloj: «Pensando… 0 s» se quedaba congelado hasta la respuesta.
        var espera = anadirTurno('asistente esperando', 'Asistenta', 'Pensando…');
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
          if (datos && datos.outage) {
            var auto = typeof intentoAuto === 'number';
            // Un reintento solo que vuelve a fallar no deja otro turno: cambia el aviso.
            if (auto && notaReintento && typeof espera.remove === 'function') espera.remove();
            programarReintento(espera, auto ? intentoAuto : 0);
          }
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

      // Sin internet o con el modelo caído el turno no llegaba al modelo y el panel se
      // quedaba ahí: como en Telegram, ahora lo reintenta solo (1, 2, 5, 10 y 15 min).
      // Un mensaje nuevo o «Reintentar» lo cancela; cerrar la página también.
      var ESPERAS_SIN_RED = [60, 120, 300, 600, 900];
      var reintentoSolo = null;
      var notaReintento = null;
      function cancelarReintento() {
        if (reintentoSolo === null) return;
        window.clearTimeout(reintentoSolo);
        reintentoSolo = null;
      }
      function programarReintento(turno, intento) {
        cancelarReintento();
        var segundos = ESPERAS_SIN_RED[intento];
        var texto =
          segundos === undefined
            ? 'Sigo sin poder hablar con el modelo, así que dejo de reintentarlo yo solo. Pulsa Reintentar o escríbemelo cuando vuelva la conexión.'
            : 'Lo reintento yo solo en ' +
              (segundos < 60 ? segundos + ' s' : segundos / 60 + ' min') +
              ' (si me escribes otra cosa, lo dejo).';
        if (intento > 0 && notaReintento) notaReintento.textContent = texto;
        else {
          notaReintento = nodo('p', 'muted reintento-solo', texto);
          notaReintento.setAttribute('role', 'status');
          turno.appendChild(notaReintento);
        }
        if (segundos === undefined) return;
        reintentoSolo = window.setTimeout(function () {
          reintentoSolo = null;
          repetirUltimo(intento + 1);
        }, segundos * 1000);
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
            // Un objetivo sin título o sin estado no debe dejar un encabezado vacío ni «undefined».
            var titulo = typeof objetivo.title === 'string' && objetivo.title.trim() ? objetivo.title : '(sin título)';
            tarjeta.appendChild(nodo('h3', null, titulo));
            var linea = nodo('p', 'meta-objetivo');
            linea.appendChild(insignia(claseEstado[objetivo.status] || '', estados[objetivo.status] || objetivo.status || 'Sin estado'));
            var progreso = formato.progresoPlan(objetivo.plan);
            linea.appendChild(nodo('span', 'muted', (progreso ? ' ' + progreso + ' · ' : ' ') + 'Hilo: ' + (objetivo.thread || '—')));
            tarjeta.appendChild(linea);
            if (objetivo.status === 'blocked' && objetivo.blockedReason) tarjeta.appendChild(nodo('p', 'error', 'Bloqueado: ' + objetivo.blockedReason));
                        var detalles = document.createElement('details');
            detalles.appendChild(nodo('summary', null, 'Plan y contexto'));
            detalles.appendChild(nodo('p', 'muted', 'ID: ' + (objetivo.id || '—') + ' · Ámbito: ' + (objetivo.scope || '—')));
            var lista = document.createElement('ul');
            // Un objetivo sin plan (o con un paso raro) no debe tumbar toda la tarjeta.
            var pasos = Array.isArray(objetivo.plan) ? objetivo.plan : [];
            pasos.forEach(function (paso) {
              if (!paso || typeof paso !== 'object') return;
              lista.appendChild(nodo('li', null, (paso.done ? '✓ Hecho: ' : '○ Pendiente: ') + (paso.text || '')));
            });
            if (lista.children.length) detalles.appendChild(lista);
            else detalles.appendChild(nodo('p', 'muted', 'Sin plan todavía.'));
            if (objetivo.blockedReason) detalles.appendChild(nodo('p', 'texto', 'Bloqueo: ' + objetivo.blockedReason));
            if (objetivo.lastOutcome) detalles.appendChild(nodo('p', 'texto', 'Último resultado: ' + objetivo.lastOutcome));
            detalles.appendChild(nodo('p', 'muted', 'Actualizado: ' + (formato.formatearCampo('updatedAt', objetivo.updatedAt) || objetivo.updatedAt)));
            tarjeta.appendChild(detalles);
            if (objetivo.panelChatAvailable) {
              var enlace = nodo('a', null, 'Ir al chat principal del panel');
              enlace.href = '#titulo-chat';
              // Lleva el foco al cuadro del chat, no solo la vista: así se escribe sin buscarlo.
              enlace.addEventListener('click', function (evento) {
                var campoChat = document.getElementById('texto-chat');
                if (!campoChat || typeof campoChat.focus !== 'function') return;
                evento.preventDefault();
                if (typeof campoChat.scrollIntoView === 'function') campoChat.scrollIntoView({ block: 'center' });
                campoChat.focus();
              });
              tarjeta.appendChild(enlace);
              tarjeta.appendChild(nodo('p', 'muted', 'El chat no modifica este objetivo automáticamente.'));
            } else tarjeta.appendChild(nodo('p', 'muted', 'Continúa en el hilo original de Telegram: ' + objetivo.thread + '. El chat del panel solo abre el principal.'));
            contenedor.appendChild(tarjeta);
          });
          finCarga(contenedor, true);
        } catch (error) { pintarError(contenedor, error, cargarObjetivos); return false; }
        return true;
      }

      // Selector de modelo (tarjeta Estado): solo opciones de coste cero
      // verificadas que llegan en /api/status como modelosDisponibles. Esa
      // clave no se pinta como dato: va al selector.
      function renderSelectorModelo(datos, opciones) {
        var bloque = nodo('section', 'modelo-selector');
        var titulo = nodo('h3', null, 'Modelo');
        bloque.appendChild(titulo);
        var actual = datos && typeof datos.model === 'string' ? datos.model : '';
        var fila = nodo('p', 'modelo-fila');
        var select = document.createElement('select');
        select.setAttribute('aria-label', 'Modelo de Asistenta (solo opciones de coste cero)');
        opciones.forEach(function (op) {
          var option = document.createElement('option');
          option.value = op.id;
          option.textContent = op.nombre;
          if (op.id === actual) option.selected = true;
          select.appendChild(option);
        });
        fila.appendChild(select);
        var boton = nodo('button', 'mini', 'Usar este modelo');
        boton.setAttribute('type', 'button');
        fila.appendChild(boton);
        bloque.appendChild(fila);
        var nota = nodo('p', 'muted', '');
        bloque.appendChild(nota);
        var resultado = nodo('p', 'modelo-resultado', '');
        resultado.setAttribute('role', 'status');
        bloque.appendChild(resultado);
        function pintarNota() {
          var elegida = opciones.find(function (op) { return op.id === select.value; });
          nota.textContent = elegida && elegida.nota ? elegida.nota + ' · OpenCode Go, coste 0' : 'OpenCode Go, coste 0';
        }
        select.addEventListener('change', pintarNota);
        pintarNota();
        // Clave de OpenCode Go: sin terminal; se comprueba en vivo al guardar.
        var filaClave = nodo('p', 'modelo-fila');
        var entradaClave = document.createElement('input');
        entradaClave.setAttribute('type', 'password');
        entradaClave.setAttribute('autocomplete', 'off');
        entradaClave.setAttribute('aria-label', 'Clave de OpenCode Go');
        entradaClave.setAttribute('placeholder', 'Clave de OpenCode Go');
        filaClave.appendChild(entradaClave);
        var botonClave = nodo('button', 'mini', 'Guardar clave');
        botonClave.setAttribute('type', 'button');
        filaClave.appendChild(botonClave);
        bloque.appendChild(filaClave);
        var resultadoClave = nodo('p', 'modelo-resultado', '');
        resultadoClave.setAttribute('role', 'status');
        bloque.appendChild(resultadoClave);
        botonClave.addEventListener('click', async function () {
          if (!entradaClave.value.trim()) {
            resultadoClave.textContent = 'Pega primero la clave de tu cuenta de OpenCode (apartado Go).';
            return;
          }
          botonClave.disabled = true;
          resultadoClave.textContent = 'Comprobando la clave con OpenCode Go…';
          try {
            var rc = await enviar('/api/clave', { clave: entradaClave.value });
            resultadoClave.textContent = (rc && rc.mensaje) || 'Clave guardada.';
            entradaClave.value = '';
          } catch (error) {
            resultadoClave.textContent = (error && error.message) || 'No pude guardar la clave.';
          }
          botonClave.disabled = false;
        });
        boton.addEventListener('click', async function () {
          if (select.value === actual) {
            resultado.textContent = 'Ya es el modelo en uso.';
            return;
          }
          boton.disabled = true;
          select.disabled = true;
          resultado.textContent = 'Cambiando…';
          try {
            var r = await enviar('/api/modelo', { model: select.value });
            actual = select.value;
            await cargarEstado();
            // El refresco repinta la tarjeta (y el selector): la confirmación se
            // vuelve a poner encima para que no parpadee y desaparezca.
            var nuevoResultado = document.querySelector('#panel-estado .modelo-resultado');
            if (nuevoResultado) nuevoResultado.textContent = (r && r.mensaje) || 'Listo.';
          } catch (error) {
            resultado.textContent = (error && error.message) || 'No pude cambiar el modelo.';
            boton.disabled = false;
            select.disabled = false;
          }
        });
        return bloque;
      }

      async function cargarEstado() {
        var contenedor = document.getElementById('panel-estado');
        pintarCarga(contenedor);
        try {
          var datos = await pedir('/api/status');
          var opciones = datos && Array.isArray(datos.modelosDisponibles) ? datos.modelosDisponibles : null;
          if (datos && typeof datos === 'object') delete datos.modelosDisponibles;
          contenedor.replaceChildren(renderValor(datos, 0));
          if (opciones && opciones.length) contenedor.appendChild(renderSelectorModelo(datos, opciones));
          finCarga(contenedor, true);
        } catch (error) {
          pintarError(contenedor, error, cargarEstado); return false;
        }
        return true;
      }

      var COLORES_CONTEXTO = {
        instrucciones: '#a78bfa',
        herramientas: '#f59e0b',
        adjuntos: '#34d399',
        resumen: '#f472b6',
        conversacion: '#7dd3fc'
      };

      function numeroEs(n) {
        return Number(n || 0).toLocaleString('es-ES');
      }

      function haceTiempo(iso) {
        var t = Date.parse(iso);
        if (!isFinite(t)) return '';
        var min = Math.max(0, Math.round((Date.now() - t) / 60000));
        if (min < 1) return 'hace un momento';
        if (min < 60) return 'hace ' + min + ' min';
        var h = Math.round(min / 60);
        if (h < 48) return 'hace ' + h + ' h';
        return 'hace ' + Math.round(h / 24) + ' días';
      }

      function pintarContexto(contenedor, datos) {
        contenedor.replaceChildren();
        var hilos = datos && Array.isArray(datos.hilos) ? datos.hilos : [];
        if (!hilos.length) {
          contenedor.appendChild(
            nodo('p', 'muted', 'No hay conversaciones abiertas ahora. Escribe por Telegram o en el chat del panel y aparecerá aquí.')
          );
        }
        hilos.forEach(function (h) {
          var bloque = nodo('section', 'ctx-hilo');
          var titulo = nodo('h3', null, h.titulo || 'conversación');
          titulo.appendChild(nodo('span', 'muted', (h.estado || '') + (h.modelo ? ' · ' + h.modelo : '')));
          bloque.appendChild(titulo);
          var partes = Array.isArray(h.partes) ? h.partes : [];
          var total = Number(h.total) || 0;
          var barra = nodo('div', 'ctx-barra');
          barra.setAttribute('role', 'img');
          barra.setAttribute(
            'aria-label',
            'Reparto del contexto: ' +
              partes.map(function (p) { return p.nombre + ' ' + numeroEs(p.tokens); }).join(', ')
          );
          partes.forEach(function (p) {
            if (!total || !p.tokens) return;
            var trozo = nodo('span');
            trozo.style.width = ((p.tokens / total) * 100).toFixed(2) + '%';
            trozo.style.background = COLORES_CONTEXTO[p.id] || '#93a1b3';
            trozo.title = p.nombre + ': ≈ ' + numeroEs(p.tokens) + ' tokens';
            barra.appendChild(trozo);
          });
          bloque.appendChild(barra);
          var lista = nodo('ul', 'ctx-partes');
          partes.forEach(function (p) {
            var li = nodo('li');
            var punto = nodo('span', 'punto');
            punto.style.background = COLORES_CONTEXTO[p.id] || '#93a1b3';
            li.appendChild(punto);
            li.appendChild(nodo('span', null, p.nombre));
            li.appendChild(nodo('span', 'num', '≈ ' + numeroEs(p.tokens)));
            if (p.detalle) li.appendChild(nodo('span', 'muted', p.detalle));
            lista.appendChild(li);
          });
          bloque.appendChild(lista);
          bloque.appendChild(
            nodo(
              'p',
              'ctx-linea',
              'Total ≈ ' + numeroEs(total) + ' tokens (aprox.)' +
                (h.ventana ? ' de ' + numeroEs(h.ventana) + ' de la ventana del modelo · ' + h.porcentaje + ' %' : '')
            )
          );
          if (h.resumenApagado) {
            bloque.appendChild(nodo('p', 'ctx-linea', 'Resumen automático: apagado (PA_COMPACT_TOKENS=0).'));
          } else {
            var umbral = Number(h.umbralResumen) || 0;
            var historial = Number(h.historial) || 0;
            bloque.appendChild(
              nodo(
                'p',
                'ctx-linea',
                'Resumen automático al llegar a ≈ ' + numeroEs(umbral) + ' del historial (ahora ≈ ' +
                  numeroEs(historial) + '): faltan ≈ ' + numeroEs(h.faltanParaResumen) + '.'
              )
            );
            var progreso = umbral ? Math.min(100, (historial / umbral) * 100) : 0;
            var medidor = nodo('div', 'ctx-umbral' + (progreso >= 80 ? ' cerca' : ''));
            medidor.setAttribute('role', 'progressbar');
            medidor.setAttribute('aria-label', 'Camino hasta el resumen automático');
            medidor.setAttribute('aria-valuemin', '0');
            medidor.setAttribute('aria-valuemax', '100');
            medidor.setAttribute('aria-valuenow', String(Math.round(progreso)));
            var lleno = nodo('span');
            lleno.style.width = progreso.toFixed(1) + '%';
            medidor.appendChild(lleno);
            bloque.appendChild(medidor);
          }
          var resumenes = Number(h.resumenes) || 0;
          bloque.appendChild(
            nodo(
              'p',
              'ctx-linea muted',
              h.ultimoResumen
                ? 'Último resumen: ' + haceTiempo(h.ultimoResumen) +
                    (resumenes ? ' · ' + resumenes + (resumenes === 1 ? ' resumen' : ' resúmenes') + ' desde que arrancó' : '')
                : 'Todavía no se ha resumido esta conversación.'
            )
          );
          var nombres = Array.isArray(h.herramientas) ? h.herramientas : [];
          if (nombres.length) {
            var detalles = document.createElement('details');
            var extra = Number(h.herramientasRecortadas) || 0;
            detalles.appendChild(nodo('summary', null, 'Herramientas cargadas (' + (nombres.length + extra) + ')'));
            detalles.appendChild(
              nodo('p', null, nombres.join(', ') + (extra ? ' y ' + extra + ' más' : ''))
            );
            bloque.appendChild(detalles);
          }
          contenedor.appendChild(bloque);
        });
        var otros = datos && Number(datos.otros) > 0 ? Number(datos.otros) : 0;
        if (otros) {
          contenedor.appendChild(
            nodo('p', 'muted', otros === 1 ? 'Y 1 conversación más de otro chat (no se detalla).' : 'Y ' + otros + ' conversaciones más de otros chats (no se detallan).')
          );
        }
        if (datos && datos.nota) contenedor.appendChild(nodo('p', 'muted', datos.nota));
      }

      async function cargarContexto() {
        var contenedor = document.getElementById('panel-contexto');
        pintarCarga(contenedor);
        try {
          pintarContexto(contenedor, await pedir('/api/contexto'));
          finCarga(contenedor, true);
        } catch (error) {
          pintarError(contenedor, error, cargarContexto); return false;
        }
        return true;
      }

      // Búsqueda y ámbito: si llega tarde la respuesta de una consulta anterior (escribir
      // rápido, cambiar de ámbito), no pinta encima de la última; solo cuenta la más nueva.
      var consultaSesiones = 0;
      async function cargarSesiones() {
        var contenedor = document.getElementById('panel-sesiones');
        var consulta = document.getElementById('buscar-sesiones').value.trim();
        var ruta = '/api/sessions' + (consulta ? '?q=' + encodeURIComponent(consulta) : '');
        var esta = ++consultaSesiones;
        pintarCarga(contenedor);
        try {
          var datos = await pedir(ruta);
          if (esta !== consultaSesiones) return true;
          pintarSesiones(contenedor, datos);
          finCarga(contenedor, true);
        } catch (error) {
          if (esta !== consultaSesiones) return true;
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

      var consultaMemoria = 0;
      async function cargarMemoria() {
        var contenedor = document.getElementById('panel-memoria');
        var ambito = document.getElementById('ambito-memoria').value.trim();
        var ruta = '/api/memory' + (ambito ? '?scope=' + encodeURIComponent(ambito) : '');
        var esta = ++consultaMemoria;
        pintarCarga(contenedor);
        try {
          var datos = await pedir(ruta);
          if (esta !== consultaMemoria) return true;
          pintarMemoria(contenedor, datos);
          finCarga(contenedor, true);
        } catch (error) {
          if (esta !== consultaMemoria) return true;
          pintarError(contenedor, error, cargarMemoria); return false;
        }
        return true;
      }

      var SVG_NS = 'http://www.w3.org/2000/svg';
      var COLORES_MAPA = ['#7dd3fc', '#a78bfa', '#34d399', '#f59e0b', '#f472b6', '#facc15', '#60a5fa', '#fb923c'];
      var COLOR_ENLACE = { enlace: '#f59e0b', reemplaza: '#f472b6', etiqueta: '#7dd3fc', mencion: '#64748b' };
      var NOMBRE_ENLACE = { enlace: 'enlace [[…]]', reemplaza: 'reemplaza a otro', etiqueta: 'misma etiqueta', mencion: 'nombran lo mismo' };
      var LADO_MAPA = 1000;
      var mapa = { datos: null, grupos: [], lineas: [], vecinos: [], elegido: -1 };

      function colorDeNodo(nodo) {
        var etiqueta = nodo && nodo.etiquetas && nodo.etiquetas[0];
        if (!etiqueta) return '#93a1b3';
        var h = 0;
        for (var i = 0; i < etiqueta.length; i += 1) h = (h * 31 + etiqueta.charCodeAt(i)) >>> 0;
        return COLORES_MAPA[h % COLORES_MAPA.length];
      }

      function sinTildes(texto) {
        return String(texto || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase();
      }

      // Disposición por fuerzas (Fruchterman-Reingold) en el propio navegador, sin librerías:
      // los nodos se repelen, los enlaces atraen y una gravedad suave los centra.
      function disponerMapa(n, enlaces) {
        var x = new Float64Array(n);
        var y = new Float64Array(n);
        var dx = new Float64Array(n);
        var dy = new Float64Array(n);
        var centro = LADO_MAPA / 2;
        var k = (LADO_MAPA / Math.sqrt(Math.max(n, 1))) * 0.45;
        for (var i = 0; i < n; i += 1) {
          var angulo = i * 2.399963;
          var radio = 18 * Math.sqrt(i + 1);
          x[i] = centro + radio * Math.cos(angulo);
          y[i] = centro + radio * Math.sin(angulo);
        }
        var alcance = 9 * k * k;
        var grados = new Float64Array(n).fill(1);
        enlaces.forEach(function (l) { grados[l.a] += 1; grados[l.b] += 1; });
        for (var g = 0; g < n; g += 1) grados[g] = Math.sqrt(grados[g]);
        var temperatura = LADO_MAPA / 8;
        var vueltas = n > 200 ? 150 : 250;
        for (var v = 0; v < vueltas; v += 1) {
          dx.fill(0);
          dy.fill(0);
          for (var a = 0; a < n; a += 1) {
            for (var b = a + 1; b < n; b += 1) {
              var ex = x[a] - x[b];
              var ey = y[a] - y[b];
              var d2 = ex * ex + ey * ey || 0.01;
              // Solo empujan los cercanos: si no, todo acaba apretado contra el borde.
              if (d2 > alcance) continue;
              var f = (k * k) / d2;
              dx[a] += ex * f; dy[a] += ey * f;
              dx[b] -= ex * f; dy[b] -= ey * f;
            }
          }
          for (var e = 0; e < enlaces.length; e += 1) {
            var l = enlaces[e];
            var lx = x[l.a] - x[l.b];
            var ly = y[l.a] - y[l.b];
            var dist = Math.sqrt(lx * lx + ly * ly) || 0.01;
            // Con muchos enlaces (una etiqueta común) la atracción se reparte: si no, el
            // grupo entero se aplasta en un punto.
            var fuerza = (dist / k) * (0.5 + 0.1 * Math.min(Number(l.peso) || 1, 6));
            dx[l.a] -= (lx * fuerza) / grados[l.a]; dy[l.a] -= (ly * fuerza) / grados[l.a];
            dx[l.b] += (lx * fuerza) / grados[l.b]; dy[l.b] += (ly * fuerza) / grados[l.b];
          }
          for (var c = 0; c < n; c += 1) {
            // Un recuerdo sin enlaces tira más hacia el centro: si no, acaba en una esquina.
            var gravedad = grados[c] <= 1 ? 0.12 : 0.04;
            dx[c] += (centro - x[c]) * gravedad;
            dy[c] += (centro - y[c]) * gravedad;
            var largo = Math.sqrt(dx[c] * dx[c] + dy[c] * dy[c]);
            if (largo > 0) {
              var paso = Math.min(largo, temperatura);
              x[c] += (dx[c] / largo) * paso;
              y[c] += (dy[c] / largo) * paso;
            }
            // Dentro del marco: un recuerdo suelto no se va lejos y deja el resto diminuto.
            x[c] = Math.min(LADO_MAPA - 20, Math.max(20, x[c]));
            y[c] = Math.min(LADO_MAPA - 20, Math.max(20, y[c]));
          }
          temperatura = Math.max(1, temperatura * 0.97);
        }
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (var m = 0; m < n; m += 1) {
          minX = Math.min(minX, x[m]); maxX = Math.max(maxX, x[m]);
          minY = Math.min(minY, y[m]); maxY = Math.max(maxY, y[m]);
        }
        var margen = 40;
        var escala = Math.min(
          (LADO_MAPA - 2 * margen) / Math.max(maxX - minX, 1),
          (LADO_MAPA - 2 * margen) / Math.max(maxY - minY, 1)
        );
        var puntos = [];
        for (var p = 0; p < n; p += 1) {
          puntos.push({
            x: n === 1 ? centro : margen + (x[p] - minX) * escala + ((LADO_MAPA - 2 * margen) - (maxX - minX) * escala) / 2,
            y: n === 1 ? centro : margen + (y[p] - minY) * escala + ((LADO_MAPA - 2 * margen) - (maxY - minY) * escala) / 2
          });
        }
        return puntos;
      }

      function elementoSvg(etiqueta, atributos) {
        var el = document.createElementNS(SVG_NS, etiqueta);
        Object.keys(atributos || {}).forEach(function (clave) { el.setAttribute(clave, String(atributos[clave])); });
        return el;
      }

      function textoCorto(texto, n) {
        var t = String(texto || '');
        return t.length > n ? t.slice(0, n - 1) + '…' : t;
      }

      function pintarMapa(contenedor, datos) {
        contenedor.replaceChildren();
        var nodos = datos && Array.isArray(datos.nodos) ? datos.nodos : [];
        var enlaces = datos && Array.isArray(datos.enlaces) ? datos.enlaces : [];
        enlaces = enlaces.filter(function (l) {
          return l && l.a >= 0 && l.b >= 0 && l.a < nodos.length && l.b < nodos.length;
        });
        mapa = { datos: { nodos: nodos, enlaces: enlaces }, grupos: [], lineas: [], vecinos: [], elegido: -1 };
        if (!nodos.length) {
          contenedor.appendChild(nodo('p', 'muted', 'No hay recuerdos en este ámbito todavía. Prueba otro en la tarjeta Memoria.'));
          return;
        }
        var info = nodos.length + (nodos.length === 1 ? ' recuerdo' : ' recuerdos') + ' · ' +
          enlaces.length + (enlaces.length === 1 ? ' enlace' : ' enlaces');
        if (datos.recortado) info += ' · Mostrando los ' + nodos.length + ' más recientes de ' + datos.total + '.';
        contenedor.appendChild(nodo('p', 'mapa-info', info));
        if (Number(datos.ocultos) > 0) {
          contenedor.appendChild(
            nodo('p', 'muted', datos.ocultos + (datos.ocultos === 1 ? ' recuerdo no se muestra' : ' recuerdos no se muestran') + ' por parecer una contraseña o una clave.')
          );
        }
        var puntos = disponerMapa(nodos.length, enlaces);
        var svg = elementoSvg('svg', {
          viewBox: '0 0 ' + LADO_MAPA + ' ' + LADO_MAPA,
          class: 'mapa-lienzo',
          role: 'img',
          'aria-label': 'Mapa de ' + info
        });
        var capaLineas = elementoSvg('g', {});
        var capaNodos = elementoSvg('g', {});
        nodos.forEach(function () { mapa.vecinos.push([]); });
        enlaces.forEach(function (l, i) {
          var linea = elementoSvg('line', {
            x1: puntos[l.a].x.toFixed(1), y1: puntos[l.a].y.toFixed(1),
            x2: puntos[l.b].x.toFixed(1), y2: puntos[l.b].y.toFixed(1),
            stroke: COLOR_ENLACE[l.tipo] || '#64748b',
            'stroke-width': Math.min(1 + (Number(l.peso) || 1) * 0.5, 4)
          });
          capaLineas.appendChild(linea);
          mapa.lineas.push(linea);
          mapa.vecinos[l.a].push(i);
          mapa.vecinos[l.b].push(i);
        });
        nodos.forEach(function (n, i) {
          var grupo = elementoSvg('g', {});
          var radio = 9 + Math.min(Number(n.grado) || 0, 6) * 2;
          grupo.appendChild(elementoSvg('circle', { class: 'toque', cx: puntos[i].x.toFixed(1), cy: puntos[i].y.toFixed(1), r: Math.max(radio, 26) }));
          var circulo = elementoSvg('circle', {
            class: 'nodo', cx: puntos[i].x.toFixed(1), cy: puntos[i].y.toFixed(1), r: radio, fill: colorDeNodo(n)
          });
          grupo.appendChild(circulo);
          var titulo = elementoSvg('title', {});
          titulo.textContent = textoCorto(n.texto, 120);
          grupo.appendChild(titulo);
          grupo.addEventListener('click', function () { elegirNodoMapa(i); });
          capaNodos.appendChild(grupo);
          mapa.grupos.push(grupo);
        });
        svg.appendChild(capaLineas);
        svg.appendChild(capaNodos);
        contenedor.appendChild(svg);
        var leyenda = nodo('ul', 'mapa-leyenda');
        ['etiqueta', 'enlace', 'mencion', 'reemplaza'].forEach(function (tipo) {
          var li = nodo('li');
          var raya = nodo('span', 'raya');
          raya.style.background = COLOR_ENLACE[tipo];
          li.appendChild(raya);
          li.appendChild(document.createTextNode(NOMBRE_ENLACE[tipo]));
          leyenda.appendChild(li);
        });
        contenedor.appendChild(leyenda);
        contenedor.appendChild(nodo('p', 'muted', 'Toca un punto o busca arriba para abrir un recuerdo. El color es su primera etiqueta.'));
        var resultados = nodo('div', 'mapa-resultados');
        resultados.id = 'mapa-resultados';
        contenedor.appendChild(resultados);
        var detalle = nodo('div', 'mapa-detalle');
        detalle.id = 'mapa-detalle';
        detalle.hidden = true;
        detalle.setAttribute('aria-live', 'polite');
        contenedor.appendChild(detalle);
        filtrarMapa();
      }

      function botonRecuerdo(i, extra) {
        var n = mapa.datos.nodos[i];
        var boton = nodo('button', 'mini', textoCorto(n.texto, 70) + (extra ? ' · ' + extra : ''));
        boton.type = 'button';
        boton.addEventListener('click', function () { elegirNodoMapa(i); });
        return boton;
      }

      function filtrarMapa() {
        if (!mapa.datos) return;
        var campo = document.getElementById('buscar-mapa');
        var consulta = sinTildes(campo ? campo.value.trim() : '');
        var resultados = document.getElementById('mapa-resultados');
        var coinciden = [];
        mapa.datos.nodos.forEach(function (n, i) {
          var si = !consulta ||
            sinTildes(n.texto).indexOf(consulta) >= 0 ||
            (n.etiquetas || []).some(function (t) { return sinTildes(t).indexOf(consulta) >= 0; });
          if (consulta && si) coinciden.push(i);
          mapa.grupos[i].classList.toggle('apagado', !si);
        });
        mapa.datos.enlaces.forEach(function (l, i) {
          var visible = !consulta || (coinciden.indexOf(l.a) >= 0 && coinciden.indexOf(l.b) >= 0);
          mapa.lineas[i].classList.toggle('apagado', !visible);
        });
        if (!resultados) return;
        resultados.replaceChildren();
        if (!consulta) return;
        resultados.appendChild(
          nodo('p', 'muted', coinciden.length ? coinciden.length + (coinciden.length === 1 ? ' coincidencia' : ' coincidencias') : 'Sin coincidencias.')
        );
        coinciden.slice(0, 10).forEach(function (i) { resultados.appendChild(botonRecuerdo(i)); });
      }

      function elegirNodoMapa(i) {
        if (!mapa.datos || !mapa.datos.nodos[i]) return;
        if (mapa.elegido >= 0 && mapa.grupos[mapa.elegido]) mapa.grupos[mapa.elegido].classList.remove('elegido');
        mapa.lineas.forEach(function (l) { l.classList.remove('resaltado'); });
        mapa.elegido = i;
        mapa.grupos[i].classList.add('elegido');
        var n = mapa.datos.nodos[i];
        var detalle = document.getElementById('mapa-detalle');
        detalle.replaceChildren();
        detalle.hidden = false;
        detalle.appendChild(nodo('p', 'texto', n.texto));
        var meta = [n.fecha].concat((n.etiquetas || []).map(function (t) { return '#' + t; })).filter(Boolean).join(' · ');
        if (meta) detalle.appendChild(nodo('p', 'muted', meta));
        var relacionados = mapa.vecinos[i] || [];
        if (!relacionados.length) {
          detalle.appendChild(nodo('p', 'muted', 'No está unido a otros recuerdos.'));
        } else {
          detalle.appendChild(nodo('p', 'muted', 'Relacionado con (' + relacionados.length + '):'));
          var lista = nodo('ul');
          relacionados.forEach(function (e) {
            var l = mapa.datos.enlaces[e];
            mapa.lineas[e].classList.add('resaltado');
            var otro = l.a === i ? l.b : l.a;
            var li = nodo('li');
            li.appendChild(botonRecuerdo(otro, l.motivo));
            lista.appendChild(li);
          });
          detalle.appendChild(lista);
        }
      }

      var consultaMapa = 0;
      async function cargarMapa() {
        var contenedor = document.getElementById('panel-mapa');
        var ambito = document.getElementById('ambito-memoria').value.trim();
        var ruta = '/api/mapa-memoria' + (ambito ? '?scope=' + encodeURIComponent(ambito) : '');
        var esta = ++consultaMapa;
        pintarCarga(contenedor);
        try {
          var datos = await pedir(ruta);
          if (esta !== consultaMapa) return true;
          pintarMapa(contenedor, datos);
          finCarga(contenedor, true);
        } catch (error) {
          if (esta !== consultaMapa) return true;
          pintarError(contenedor, error, cargarMapa); return false;
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
      function filaTarea(t) {
        var texto = t.dia + (t.hora ? ' ' + t.hora : '') + ' · ' + t.titulo + (t.repite ? ' (' + t.repite + ')' : '');
        var fila = nodo('li', 'texto', texto + ' ');
        fila.appendChild(insignia('', t.estado));
        return fila;
      }

      async function cargarTareas(silencio) {
        var contenedor = document.getElementById('panel-tareas');
        if (silencio !== true) pintarCarga(contenedor);
        try {
          var datos = await pedir('/api/tareas');
          if (!datos || !Array.isArray(datos.tareas) || !Array.isArray(datos.atrasadas)) throw new Error('Respuesta de tareas inválida');
          contenedor.replaceChildren(nodo('p', 'muted', 'Solo lectura: para apuntar o cambiar una tarea, pídelo en el chat.'));
          if (!datos.tareas.length && !datos.atrasadas.length) contenedor.appendChild(nodo('p', 'muted', 'No tienes tareas esta semana.'));
          if (datos.atrasadas.length) {
            contenedor.appendChild(nodo('h3', null, 'Atrasadas'));
            var lista1 = nodo('ul', 'tareas');
            datos.atrasadas.forEach(function (t) { lista1.appendChild(filaTarea(t)); });
            contenedor.appendChild(lista1);
          }
          if (datos.tareas.length) {
            var lista2 = nodo('ul', 'tareas');
            datos.tareas.forEach(function (t) { lista2.appendChild(filaTarea(t)); });
            contenedor.appendChild(lista2);
          }
          finCarga(contenedor, true);
        } catch (error) {
          if (silencio === true) return false;
          pintarError(contenedor, error, cargarTareas); return false;
        }
        return true;
      }

      function filaReparto(r) {
        var fila = nodo('li', 'texto', r.envio + ' ');
        if (r.seguimiento) {
          // El número va aparte: un toque lo selecciona entero y lo copia.
          var codigo = nodo('code', 'copiable', r.seguimiento);
          codigo.title = 'Toca para copiar';
          codigo.addEventListener('click', function () {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(r.seguimiento).then(function () { codigo.title = 'Copiado'; }, function () {});
            }
          });
          fila.appendChild(codigo);
          fila.appendChild(document.createTextNode(' '));
        }
        fila.appendChild(document.createTextNode('· ' + r.titulo + ' (' + r.cuando + ') '));
        fila.appendChild(insignia('', r.estado));
        return fila;
      }

      async function cargarRepartos(silencio) {
        var contenedor = document.getElementById('panel-repartos');
        if (silencio !== true) pintarCarga(contenedor);
        try {
          var datos = await pedir('/api/repartos');
          if (!datos || !Array.isArray(datos.repartos)) throw new Error('Respuesta de paquetes inválida');
          contenedor.replaceChildren(nodo('p', 'muted', 'Solo lectura: sale de tus correos de envío. Para preguntar, escribe en el chat.'));
          if (!datos.repartos.length) contenedor.appendChild(nodo('p', 'muted', 'No hay paquetes en camino.'));
          else {
            var lista = nodo('ul', 'tareas');
            datos.repartos.forEach(function (r) { lista.appendChild(filaReparto(r)); });
            contenedor.appendChild(lista);
          }
          finCarga(contenedor, true);
        } catch (error) {
          if (silencio === true) return false;
          pintarError(contenedor, error, cargarRepartos); return false;
        }
        return true;
      }

      function pintarBloques(contenedor, bloques) {
        (bloques || []).forEach(function (b) {
          if (b.t === 'h') contenedor.appendChild(nodo(b.n === 1 ? 'h3' : 'h4', '', b.texto));
          else if (b.t === 'p') contenedor.appendChild(nodo('p', 'texto', b.texto));
          else if (b.t === 'ul') {
            var lista = nodo('ul', 'lista');
            b.items.forEach(function (it) { lista.appendChild(nodo('li', 'texto', it)); });
            contenedor.appendChild(lista);
          } else if (b.t === 'tabla') {
            var tabla = nodo('table', 'tabla-pagina');
            if (b.cabecera && b.cabecera.length) {
              var cab = document.createElement('tr');
              b.cabecera.forEach(function (c) { cab.appendChild(nodo('th', '', c)); });
              tabla.appendChild(cab);
            }
            b.filas.forEach(function (f) {
              var fila = document.createElement('tr');
              f.forEach(function (c) { fila.appendChild(nodo('td', '', c)); });
              tabla.appendChild(fila);
            });
            contenedor.appendChild(tabla);
          }
        });
      }

      async function verPagina(id) {
        var vista = document.getElementById('panel-pagina-vista');
        vista.hidden = false;
        pintarCarga(vista);
        try {
          var p = await pedir('/api/paginas/' + encodeURIComponent(id));
          if (!p || !Array.isArray(p.bloques)) throw new Error('Respuesta de página inválida');
          vista.replaceChildren();
          var cerrar = nodo('button', 'mini', 'Cerrar');
          cerrar.type = 'button';
          cerrar.addEventListener('click', function () { vista.hidden = true; vista.replaceChildren(); });
          vista.appendChild(cerrar);
          vista.appendChild(nodo('h3', '', p.titulo));
          vista.appendChild(nodo('p', 'muted', 'Actualizada ' + p.actualizada + ' · ' + p.origen));
          pintarBloques(vista, p.bloques);
        } catch (error) {
          pintarError(vista, error, function () { return verPagina(id); });
        }
      }

      function filaPagina(p, detalle) {
        var fila = nodo('li', 'texto');
        var boton = nodo('button', 'mini', p.titulo);
        boton.type = 'button';
        boton.addEventListener('click', function () { verPagina(p.id); });
        fila.appendChild(boton);
        fila.appendChild(document.createTextNode(' ' + detalle));
        return fila;
      }

      // Bajar un archivo creado: la API pide la clave en la cabecera, así que va por fetch + blob.
      async function descargarCreado(f, boton) {
        if (!token) { pedirToken('Pon la clave del panel para bajar el archivo.'); return; }
        boton.disabled = true;
        try {
          var r = await fetch('/api/creados/' + encodeURIComponent(f.id), { headers: { Authorization: 'Bearer ' + token } });
          if (!r.ok) throw new Error(r.status === 404 ? 'Ese archivo ya no está (se guardan los 40 últimos).' : 'No se pudo bajar (' + r.status + ').');
          var url = URL.createObjectURL(await r.blob());
          var a = document.createElement('a');
          a.href = url;
          a.download = f.nombre;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        } catch (error) {
          mostrarAviso(error && error.message ? error.message : 'No se pudo bajar el archivo.');
        } finally {
          boton.disabled = false;
        }
      }

      async function cargarPaginas(silencio) {
        var contenedor = document.getElementById('panel-paginas');
        if (silencio !== true) pintarCarga(contenedor);
        try {
          var datos = await pedir('/api/paginas');
          if (!datos || !Array.isArray(datos.paginas) || !Array.isArray(datos.salidas)) throw new Error('Respuesta de páginas inválida');
          contenedor.replaceChildren(nodo('p', 'muted', 'Lo que he creado para ti. Pídeme en el chat «hazme una página con…» (y si quieres, que una rutina la rehaga cada mañana).'));
          if (!datos.paginas.length) contenedor.appendChild(nodo('p', 'muted', 'Aún no hay páginas.'));
          else {
            var lista = nodo('ul', 'tareas');
            datos.paginas.forEach(function (p) {
              lista.appendChild(filaPagina(p, '· ' + p.actualizada + ' · ' + p.origen));
            });
            contenedor.appendChild(lista);
          }
          if (Array.isArray(datos.archivos) && datos.archivos.length) {
            contenedor.appendChild(nodo('p', 'muted', 'Archivos que te he hecho (gráficas, Excel, PDF…):'));
            var lista3 = nodo('ul', 'tareas');
            datos.archivos.forEach(function (f) {
              var fila = nodo('li', 'texto');
              var boton = nodo('button', 'mini', f.nombre);
              boton.type = 'button';
              boton.addEventListener('click', function () { descargarCreado(f, boton); });
              fila.appendChild(boton);
              fila.appendChild(document.createTextNode(' · ' + f.creado + ' · ' + Math.max(1, Math.round(f.bytes / 1024)) + ' KB'));
              lista3.appendChild(fila);
            });
            contenedor.appendChild(lista3);
          }
          if (datos.salidas.length) {
            contenedor.appendChild(nodo('p', 'muted', 'Salidas de rutinas guardadas en fichero:'));
            var lista2 = nodo('ul', 'tareas');
            datos.salidas.forEach(function (s) {
              lista2.appendChild(filaPagina(s, '· ' + Math.max(1, Math.round(s.bytes / 1024)) + ' KB'));
            });
            contenedor.appendChild(lista2);
          }
          finCarga(contenedor, true);
        } catch (error) {
          if (silencio === true) return false;
          pintarError(contenedor, error, cargarPaginas); return false;
        }
        return true;
      }

      async function cargarRutinas(silencio) {
        var contenedor = document.getElementById('panel-rutinas');
        if (silencio !== true) pintarCarga(contenedor);
        try {
          var rutinas = await pedir('/api/routines');
          if (!Array.isArray(rutinas)) throw new Error('Respuesta de rutinas inválida');
          // Repintado en silencio (al volver a la pestaña): si el foco estaba en la tarjeta (p. ej. en
          // «Reintentar») y desaparece, va al título de la tarjeta y no al principio de la página.
          var foco = document.activeElement;
          var focoDentro = silencio === true && !!foco && foco !== contenedor && contenedor.contains(foco);
          contenedor.replaceChildren(nodo('p', 'muted', 'Solo lectura: para crear o cambiar una rutina, pídemelo en el chat, por ejemplo «cada mañana a las 8 el resumen del día».'));
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
            // Últimas ejecuciones: si fueron bien o fallaron y qué salió (la salida, al desplegar).
            if (Array.isArray(rutina.ejecuciones) && rutina.ejecuciones.length) {
              var historial = nodo('details', 'historial-rutina');
              var fallos = rutina.ejecuciones.filter(function (e) { return !e.ok; }).length;
              historial.appendChild(nodo('summary', null, 'Últimas ejecuciones: ' + rutina.ejecuciones.map(function (e) { return e.ok ? '✅' : '❌'; }).join(' ') + (fallos ? ' (' + fallos + ' con fallo)' : '')));
              var lista = nodo('ul', 'muted');
              rutina.ejecuciones.forEach(function (e) {
                lista.appendChild(nodo('li', null, (e.ok ? '✅ ' : '❌ ') + e.cuando + ' · ' + e.entrega + (e.salida ? ' — ' + e.salida : '')));
              });
              historial.appendChild(lista);
              tarjeta.appendChild(historial);
            }
            contenedor.appendChild(tarjeta);
          });
          finCarga(contenedor, true);
          if (focoDentro && !contenedor.contains(document.activeElement)) {
            var tarjetaRutinas = contenedor.closest ? contenedor.closest('.tarjeta') : null;
            devolverFoco((tarjetaRutinas && tarjetaRutinas.querySelector('h2')) || contenedor);
          }
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

      // «Lo que más usas» al pie de Funciones (lo mismo que /funciones uso). Si el
      // asistente aún no lo tiene (503) o falla, la tarjeta sigue sin ese bloque.
      async function pintarUso(contenedor) {
        var uso;
        try { uso = await pedir('/api/uso'); } catch (error) { return; }
        if (!uso || !Array.isArray(uso.masUsadas)) return;
        var bloque = nodo('section', 'sesion funcion uso');
        bloque.appendChild(nodo('h3', null, 'Lo que más usas (últimos ' + uso.dias + ' días)'));
        if (uso.masUsadas.length === 0) bloque.appendChild(nodo('p', 'muted', 'Todavía nada apuntado en este mes.'));
        else {
          var lista = nodo('ul', 'comandos');
          uso.masUsadas.forEach(function (u) { lista.appendChild(nodo('li', null, u.veces + '× ' + u.texto)); });
          bloque.appendChild(lista);
        }
        var hab = uso.habilidades || {};
        if (hab.total > 0) {
          bloque.appendChild(nodo('p', 'texto', 'Habilidades aprendidas: ' + hab.total));
          if (Array.isArray(hab.masUsadas) && hab.masUsadas.length > 0) {
            bloque.appendChild(nodo('p', 'muted', 'Más usadas: ' + hab.masUsadas.map(function (h) { return h.nombre + ' (' + h.veces + ')'; }).join(', ')));
          }
          if (Array.isArray(hab.sinUsar) && hab.sinUsar.length > 0) {
            bloque.appendChild(nodo('p', 'muted', 'Sin usar en ' + uso.dias + ' días: ' + hab.sinUsar.join(', ')));
            if (uso.archivar) bloque.appendChild(nodo('p', 'muted', 'Para archivarlas (se desactivan, no se borran), escríbeme ' + uso.archivar));
          }
        }
        contenedor.appendChild(bloque);
      }

      async function cargarFunciones() {
        var contenedor = document.getElementById('panel-funciones');
        pintarCarga(contenedor);
        try {
          var areas = await pedir('/api/funciones');
          if (!Array.isArray(areas)) throw new Error('Respuesta de funciones inválida');
          contenedor.replaceChildren(nodo('p', 'muted', 'Qué sé hacer, por áreas, con un ejemplo de cómo pedírmelo.'));
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
            var lineasHab = Array.isArray(area.habilidades) ? area.habilidades : [];
            if (lineasHab.length > 0) {
              var habilidades = nodo('ul', 'comandos habilidades');
              lineasHab.forEach(function (h) {
                habilidades.appendChild(nodo('li', null, h));
              });
              bloque.appendChild(nodo('p', 'muted', 'Pídemelo con tus palabras:'));
              bloque.appendChild(habilidades);
            }
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
          await pintarUso(contenedor);
          finCarga(contenedor, true);
        } catch (error) { pintarError(contenedor, error, cargarFunciones); return false; }
        return true;
      }

      var refrescos = {
        objetivos: cargarObjetivos,
        rutinas: cargarRutinas,
        tareas: cargarTareas,
        repartos: cargarRepartos,
        paginas: cargarPaginas,
        funciones: cargarFunciones,
        estado: cargarEstado,
        contexto: cargarContexto,
        sesiones: cargarSesiones,
        memoria: cargarMemoria,
        mapa: cargarMapa,
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
          cargarTareas(),
          cargarEstado(),
          cargarContexto(),
          cargarSesiones(),
          cargarMemoria(),
          cargarMapa(),
          cargarAmbitos(),
          cargarAuditoria(),
          cargarAprobaciones(),
          cargarRepartos(),
          cargarPaginas()
        ])
          .then(function (resultados) {
            var fallos = resultados.filter(function (ok) { return !ok; }).length;
            var hora = new Date().toLocaleTimeString('es-ES');
            if (!token) marca.textContent = 'Falta el token';
            else if (fallos === 0) marca.textContent = 'Actualizado · ' + hora;
            else marca.textContent = fallos + (fallos === 1 ? ' sección sin cargar · ' : ' secciones sin cargar · ') + hora;
          })
          .catch(function (error) {
            marca.textContent = 'No he podido actualizar';
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
        cargarMapa();
      });

      // Buscar en el mapa no vuelve a pedir nada: resalta lo que ya está dibujado.
      document.getElementById('buscar-mapa').addEventListener('input', filtrarMapa);

      // Ámbitos conocidos (chats con memoria) en vez de escribir «telegram:dm:…» a mano.
      async function cargarAmbitos() {
        var lista = document.getElementById('ambito-memoria');
        var ambitos;
        try {
          ambitos = await pedir('/api/memory/scopes');
        } catch (error) {
          return false;
        }
        // Sin ámbito, /api/memory lee el ámbito por defecto (el privado del dueño si
        // está configurado): la primera opción lo dice en vez de «Local».
        var porDefecto = '';
        if (ambitos && !Array.isArray(ambitos) && typeof ambitos === 'object') {
          porDefecto = typeof ambitos.porDefecto === 'string' ? ambitos.porDefecto : '';
          ambitos = ambitos.ambitos;
        }
        if (!Array.isArray(ambitos)) return false;
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
        // «Actualizar» cuenta como sección sin cargar todo lo que no devuelva true.
        return true;
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
