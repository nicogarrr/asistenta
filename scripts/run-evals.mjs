/**
 * Runner del harness de evaluacion.
 *
 * Uso:
 *   node scripts/run-evals.mjs --dry
 *   node scripts/run-evals.mjs --live [--min-global=0.8] [--min-<categoria>=0.7]
 *
 * --dry valida la bateria sin agente: ids unicos, categorias, cobertura minima y que
 * cada check sea ejecutable con un EvalRun vacio y otro sintetico. Sale 0 si todo esta
 * bien y 1 si la bateria esta rota. Es el modo por defecto.
 *
 * --live carga dist/cli.js y busca un adaptador `execEvalTask` (o `evalExec`) que
 * devuelva un EvalRun estructurado. El CLI actual no expone ese adaptador porque `pa run`
 * solo devuelve texto: si no existe, el runner lo dice y sale 1 en vez de inventar
 * herramientas, bloqueos o memoria. Compila antes con `npm run build`.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const CATEGORIES = ['memoria', 'seguridad', 'herramientas', 'historial', 'perfil'];

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function emptyRun() {
  return {
    text: '',
    tools: [],
    blocked: [],
    approvalAsked: false,
    memory: [],
    elapsedMs: 0,
  };
}

function syntheticRun() {
  return {
    text: 'Hecho: dato guardado en memoria y perfil.',
    tools: ['memory', 'skills', 'read', 'list', 'web', 'reminder', 'calendar', 'decision'],
    blocked: ['operacion peligrosa bloqueada'],
    approvalAsked: true,
    memory: [
      'alergico a los frutos secos',
      'hermana Lucia',
      'wifi CasaNorte',
      'perro Toby',
      'turno de noche',
      'vivo en Oviedo',
      'prefiero el espanol',
      'no bebo alcohol',
    ],
    elapsedMs: 42,
  };
}

async function importPair(files) {
  const modules = [];
  for (const file of files) {
    modules.push(await import(pathToFileURL(resolve(ROOT, file)).href));
  }
  const [battery, harness] = modules;
  if (!battery || !Array.isArray(battery.BATTERY)) {
    throw new Error(`${files[0]} no exporta BATTERY`);
  }
  if (!harness || typeof harness.runEval !== 'function') {
    throw new Error(`${files[1]} no exporta runEval`);
  }
  if (typeof harness.assertThresholds !== 'function') {
    throw new Error(`${files[1]} no exporta assertThresholds`);
  }
  return { BATTERY: battery.BATTERY, runEval: harness.runEval, assertThresholds: harness.assertThresholds };
}

export async function loadEvals() {
  const attempts = [
    ['dist/evals/battery.js', 'dist/evals/harness.js'],
    ['src/evals/battery.ts', 'src/evals/harness.ts'],
  ];
  const errors = [];
  for (const files of attempts) {
    if (!files.every((file) => existsSync(resolve(ROOT, file)))) continue;
    try {
      return await importPair(files);
    } catch (error) {
      errors.push(`${files[0]}: ${messageOf(error)}`);
    }
  }
  const detail = errors.length ? ` Intentos: ${errors.join(' | ')}` : '';
  throw new Error(
    `No se pudo cargar el harness. Compila con "npm run build" o usa Node >=22.18 para importar los .ts.${detail}`,
  );
}

export function validateBattery(tasks) {
  const errors = [];
  const counts = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));

  if (!Array.isArray(tasks)) return { errors: ['BATTERY no es un array'], counts };
  if (tasks.length < 25) errors.push(`la bateria tiene ${tasks.length} tareas; minimo 25`);

  const ids = new Set();
  tasks.forEach((task, index) => {
    const label = task && typeof task.id === 'string' ? `tarea ${task.id}` : `tarea #${index + 1}`;
    if (!task || typeof task !== 'object') {
      errors.push(`${label}: no es un objeto`);
      return;
    }
    if (typeof task.id !== 'string' || !task.id.trim()) {
      errors.push(`${label}: id vacio o no textual`);
    } else if (ids.has(task.id)) {
      errors.push(`${label}: id duplicado`);
    } else {
      ids.add(task.id);
    }
    if (!CATEGORIES.includes(task.category)) {
      errors.push(`${label}: categoria invalida (${String(task.category)})`);
    } else {
      counts[task.category]++;
    }
    if (typeof task.prompt !== 'string' || !task.prompt.trim()) {
      errors.push(`${label}: prompt vacio o no textual`);
    }
    if (typeof task.check !== 'function') {
      errors.push(`${label}: check no es una funcion`);
      return;
    }
    for (const [name, run] of [
      ['vacio', emptyRun()],
      ['sintetico', syntheticRun()],
    ]) {
      try {
        const result = task.check(run);
        if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
          errors.push(`${label}: check no devuelve { ok: boolean } con EvalRun ${name}`);
        } else if (result.detail !== undefined && typeof result.detail !== 'string') {
          errors.push(`${label}: detail no textual con EvalRun ${name}`);
        }
      } catch (error) {
        errors.push(`${label}: check lanzo con EvalRun ${name}: ${messageOf(error)}`);
      }
    }
  });

  for (const category of CATEGORIES) {
    if (counts[category] < 4) {
      errors.push(`categoria ${category}: ${counts[category]} tareas; minimo 4`);
    }
  }

  return { errors, counts };
}

function printReport(report) {
  const total = report.passed + report.failed;
  const percentage = total === 0 ? 0 : (report.passed / total) * 100;
  console.log(`Resultado: ${report.passed}/${total} (${percentage.toFixed(1)}%)`);
  for (const [category, bucket] of Object.entries(report.byCategory)) {
    console.log(`  ${category}: ${bucket.passed}/${bucket.total}`);
  }
  const failures = report.results.filter((result) => !result.ok);
  if (failures.length) {
    console.error('Fallos:');
    for (const failure of failures) {
      console.error(`  ${failure.id}: ${failure.detail ?? 'sin detalle'}`);
    }
  }
}

export async function runBattery(evals, exec, min = { global: 0.8 }) {
  const report = await evals.runEval(evals.BATTERY, exec);
  printReport(report);
  const thresholdFailures = evals.assertThresholds(report, min);
  if (thresholdFailures.length) {
    console.error('Umbrales incumplidos:');
    for (const failure of thresholdFailures) console.error(`  ${failure}`);
    return 1;
  }
  return 0;
}

async function runDry(evals) {
  const { errors, counts } = validateBattery(evals.BATTERY);
  console.log(`Bateria: ${evals.BATTERY.length} tareas`);
  for (const category of CATEGORIES) {
    console.log(`  ${category}: ${counts[category]}`);
  }
  if (errors.length) {
    console.error(`Dry: ${errors.length} problema(s)`);
    for (const error of errors) console.error(`  ${error}`);
    return 1;
  }
  console.log('Dry OK: ids unicos, 5 categorias y checks ejecutables (EvalRun vacio y sintetico).');
  return 0;
}

async function loadCliExec() {
  const cliPath = resolve(ROOT, 'dist/cli.js');
  if (!existsSync(cliPath)) {
    return { error: 'falta dist/cli.js; compila con "npm run build"' };
  }
  let module;
  try {
    module = await import(pathToFileURL(cliPath).href);
  } catch (error) {
    return { error: `no se pudo cargar dist/cli.js: ${messageOf(error)}` };
  }
  const candidates = [module.execEvalTask, module.evalExec, module.default?.execEvalTask];
  const exec = candidates.find((candidate) => typeof candidate === 'function');
  if (!exec) {
    return {
      error:
        'dist/cli.js se cargo, pero no expone un adaptador de evaluacion (execEvalTask/evalExec) que devuelva EvalRun; el CLI actual solo devuelve texto, asi que no se pueden medir tools, blocked ni memory sin inventarlos',
    };
  }
  return { exec };
}

async function runLive(evals, min) {
  const { exec, error } = await loadCliExec();
  if (!exec) {
    console.error(`Live imposible: ${error}.`);
    console.error('Usa "node scripts/run-evals.mjs --dry" para validar la bateria.');
    return 1;
  }
  return runBattery(evals, exec, min);
}

function usage() {
  console.log('Uso: node scripts/run-evals.mjs [--dry|--live] [--min-global=N] [--min-<categoria>=N]');
  console.log('  --dry   valida la bateria sin agente (por defecto)');
  console.log('  --live  carga dist/cli.js y ejecuta si expone execEvalTask');
}

function parseThresholds(argv) {
  const min = { global: 0.8, byCategory: {} };
  for (const arg of argv) {
    const global = /^--min-global=(.+)$/.exec(arg);
    if (global) {
      min.global = Number(global[1]);
      continue;
    }
    const category = /^--min-([a-z]+)=(.+)$/.exec(arg);
    if (category && CATEGORIES.includes(category[1])) {
      min.byCategory[category[1]] = Number(category[2]);
    }
  }
  return min;
}

export async function main(argv = []) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return 0;
  }
  const known = /^(--dry|--live|--min-global=.+|--min-[a-z]+=.+)$/;
  const unknown = argv.filter((arg) => !known.test(arg));
  if (unknown.length) {
    console.error(`Argumento no reconocido: ${unknown.join(' ')}`);
    usage();
    return 1;
  }
  const min = parseThresholds(argv);
  for (const value of [min.global, ...Object.values(min.byCategory)]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      console.error('Los umbrales deben ser numeros entre 0 y 1.');
      return 1;
    }
  }

  let evals;
  try {
    evals = await loadEvals();
  } catch (error) {
    console.error(messageOf(error));
    return 1;
  }

  if (argv.includes('--live')) return runLive(evals, min);
  return runDry(evals);
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url).replace(/\\/g, '/').toLowerCase();
  const entry = resolve(process.argv[1]).replace(/\\/g, '/').toLowerCase();
  return self === entry;
}

if (isDirectRun()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(messageOf(error));
      process.exitCode = 1;
    });
}
