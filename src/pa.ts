#!/usr/bin/env node
/**
 * Entrada de `pa` (package.json bin), del arranque con Windows (run-hidden.ps1),
 * de levantar.bat y de la bandeja. Es mínima a propósito: con módulos ESM, Node
 * compila TODO el grafo estático antes de ejecutar una sola línea, así que la
 * caché de compilación que activa envfile.ts solo sirve para lo que se cargue
 * DESPUÉS. Aquí el grafo estático es envfile.ts (lee el .env y activa la caché
 * en la carpeta de estado) y el resto de Asistenta llega por import(): sus ~900
 * módulos salen ya compilados de la caché desde el segundo arranque.
 *
 * `node dist/cli.js` sigue funcionando igual (tareas de Windows antiguas, tests,
 * documentación): es el mismo programa, solo que sin aprovechar la caché.
 */
import './envfile.js';

const { runCli } = await import('./cli.js');
runCli(process.argv.slice(2));
