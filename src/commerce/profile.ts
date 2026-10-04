import { log, redact } from '../log.js';
import { vaultGet, vaultSet } from '../vault.js';

/**
 * The buyer's details, kept in the vault and never handed to the model.
 *
 * This file exists because of one fact about how the agent runs: the model's context
 * is a transcript that gets logged, truncated, summarised and sent to a provider. A DNI
 * that entered that transcript would be in the provider's logs forever, in the agent's
 * own log files, and in any debug dump of the session. The vault is already the answer
 * to "where does a secret live"; this is that rule applied to a travel document, which
 * is not a secret in the crypto sense and behaves exactly like one.
 *
 * So the shape is deliberately lopsided:
 *
 * - Reading the values out of the vault is a function of *this* module, and the only
 *   thing allowed to do it is `fillPassengerForm`, which writes them into a form.
 * - Every other exported function reports field *names*. `loadPassenger` returns the
 *   values, so it is not exported to callers that build a model-facing tool result: the
 *   tool calls it, hands the record to `fillPassengerForm`, and returns the report.
 * - Nothing here ever puts a value into a log field. `redact` scrubs keys that look
 *   like secrets, and `travel:document` does not look like one, so the protection that
 *   matters is structural: the values are not passed to `log` at all.
 *
 * A tool that needs the buyer's name to compose an email also uses this, and for the
 * same reason: read the value, use it, do not print it.
 */

/** The buyer's details as a purchase form needs them. */
export interface Passenger {
  /** Name and surnames, exactly as they should appear on the ticket. */
  fullName: string;
  /** DNI or NIE, as typed into the form (no spaces, no dashes unless the site wants them). */
  document: string;
  email: string;
  phone: string;
}

export type PassengerField = keyof Passenger;

/**
 * Vault keys, named one per field.
 *
 * A mapping rather than four literals so `savePassenger` and `loadPassenger` cannot
 * disagree about a key, and so the full set can be enumerated for the completeness
 * report.
 */
export const PASSENGER_KEYS: Record<PassengerField, string> = {
  fullName: 'travel:fullName',
  document: 'travel:document',
  email: 'travel:email',
  phone: 'travel:phone',
};

/** Every field, in the order a form usually asks for them. */
export const PASSENGER_FIELDS: readonly PassengerField[] = [
  'fullName',
  'document',
  'email',
  'phone',
];

/** Spanish labels for the model-facing reports. Never the values. */
const FIELD_LABEL: Record<PassengerField, string> = {
  fullName: 'nombre',
  document: 'documento',
  email: 'email',
  phone: 'telefono',
};

/**
 * What the vault needs to look like to be a usable source.
 *
 * Injected rather than importing the vault functions directly everywhere, for the same
 * reason `GateOptions.dbPath` is: the tests must be able to exercise the empty-vault and
 * partial-vault paths without touching (or creating) the real secret store.
 */
export interface VaultReader {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

/** The real vault, used when the caller does not inject one. */
const defaultVault: VaultReader = {
  get: (key) => vaultGet(key),
  set: (key, value) => vaultSet(key, value),
};

function trim(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * The buyer's details, or null when the vault holds nothing at all.
 *
 * Null means "I have to ask", which is a different answer from "I have some of it": the
 * first is one question for all four fields, the second is a list of what is missing.
 * A record with empty strings is returned for the partial case, because a form can be
 * filled with three of four fields and a passenger with a phone number and no email is
 * still a passenger.
 */
export async function loadPassenger(vault: VaultReader = defaultVault): Promise<Passenger | null> {
  const values = await Promise.all(
    PASSENGER_FIELDS.map(async (field) => trim(await vault.get(PASSENGER_KEYS[field]))),
  );
  if (values.every((value) => value.length === 0)) return null;
  const [fullName, document, email, phone] = values;
  return {
    fullName: fullName ?? '',
    document: document ?? '',
    email: email ?? '',
    phone: phone ?? '',
  };
}

/** True only when all four fields are stored, i.e. no question is needed. */
export async function hasPassenger(vault: VaultReader = defaultVault): Promise<boolean> {
  const passenger = await loadPassenger(vault);
  return passenger !== null && missingPassengerFields(passenger).length === 0;
}

/** Fields with nothing stored, in form order. Names only. */
export function missingPassengerFields(passenger: Passenger | null): PassengerField[] {
  if (!passenger) return [...PASSENGER_FIELDS];
  return PASSENGER_FIELDS.filter((field) => passenger[field].trim().length === 0);
}

/**
 * Completeness, for the one thing the model is allowed to be told: whether it can fill
 * the form without interrupting the user, and if not, which piece is missing.
 *
 * This is the whole contract with the model. "Falta el documento" is enough to ask the
 * right question; "12345678Z" would put the number in the transcript, which is the one
 * thing this module exists to prevent.
 */
export function passengerCompleteness(passenger: Passenger | null): {
  known: boolean;
  complete: boolean;
  missing: PassengerField[];
} {
  const missing = missingPassengerFields(passenger);
  return {
    known: passenger !== null,
    complete: passenger !== null && missing.length === 0,
    missing,
  };
}

/**
 * Store one field. Separate from `savePassenger` because the normal path is one
 * question ("dame tu DNI"), one answer, one write: asking the user to supply four
 * fields together to cover a form that needs two would be asking for the wrong thing.
 */
export async function savePassengerField(
  field: PassengerField,
  value: string,
  vault: VaultReader = defaultVault,
): Promise<void> {
  const clean = value.trim();
  if (!clean) throw new Error(`el valor de ${FIELD_LABEL[field]} viene vacío`);
  await vault.set(PASSENGER_KEYS[field], clean);
  // Names and counts only. A write log that carries the document would put it in every
  // log file on the machine, which `redact` would not clean up because the key does
  // not look like a secret.
  log.info('passenger field saved', redact({ field, ok: true }));
}

/** Store several fields at once, e.g. the first time someone offers all four. */
export async function savePassenger(
  partial: Partial<Passenger>,
  vault: VaultReader = defaultVault,
): Promise<void> {
  for (const field of PASSENGER_FIELDS) {
    const value = partial[field];
    if (value !== undefined) await savePassengerField(field, value, vault);
  }
}

/** CSS selectors for the fields of one form. Every one is optional: sites differ. */
export interface PassengerSelectors {
  fullName?: string;
  document?: string;
  email?: string;
  phone?: string;
}

/** The only thing that may write a vault value anywhere. */
export interface FormFiller {
  fill(selector: string, value: string): Promise<void>;
}

/**
 * What a fill attempt achieved.
 *
 * There is no field here that could hold a value, and that is the point: the type is
 * the guarantee. A report that cannot express the document cannot leak the document
 * into a tool result, a log line, or a debug print of the object.
 */
export interface FillPassengerResult {
  /** Fields whose value reached the form. */
  filled: PassengerField[];
  /** Fields the form has no box for. */
  unmatched: PassengerField[];
  /** Fields the site refused, e.g. a validation error. Names and reasons only. */
  failed: Array<{ field: PassengerField; reason: string }>;
}

/**
 * Write the buyer's details into a form.
 *
 * The single point in the codebase where a vault value meets a web page, and the reason
 * it is a function rather than a getter is that "the model can ask for the fields and we
 * pass them along" is exactly the design that ends with the DNI in the transcript. Here
 * the values go from the vault to the DOM and nowhere else: the caller gets back names.
 *
 * Only fields with both a stored value and a selector are written, so a form with three
 * boxes is filled with three values and the fourth stays in the vault.
 */
export async function fillPassengerForm(
  filler: FormFiller,
  passenger: Passenger,
  selectors: PassengerSelectors,
): Promise<FillPassengerResult> {
  const filled: PassengerField[] = [];
  const unmatched: PassengerField[] = [];
  const failed: Array<{ field: PassengerField; reason: string }> = [];

  for (const field of PASSENGER_FIELDS) {
    const selector = selectors[field]?.trim();
    const value = passenger[field].trim();
    if (!selector) {
      unmatched.push(field);
      continue;
    }
    if (!value) {
      // Nothing to write. Not an error: the caller reports the gap and asks.
      unmatched.push(field);
      continue;
    }
    try {
      await filler.fill(selector, value);
      filled.push(field);
    } catch (err) {
      // The message is whatever the browser adapter raised, which is a selector and a
      // Playwright timeout. It never contains the value: the adapter never puts it in
      // the error, which is why this re-throw is safe to surface.
      failed.push({ field, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  log.info('passenger form filled', redact({ filled, unmatched, failed: failed.length }));
  return { filled, unmatched, failed };
}

/** One sentence about the state of the data, for the model. Names only. */
export function describePassengerCompleteness(passenger: Passenger | null): string {
  const state = passengerCompleteness(passenger);
  if (!state.known) return 'No tengo ningún dato de comprador guardado.';
  if (state.complete) return 'Tengo todos los datos de comprador guardados.';
  const missing = state.missing.map((field) => FIELD_LABEL[field]).join(', ');
  return `Me faltan estos datos de comprador: ${missing}.`;
}
