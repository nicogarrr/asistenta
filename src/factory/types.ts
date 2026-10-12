/**
 * Factory-built tools: code the agent writes for itself when it does not know
 * how to do something, tests in a subprocess, and only then proposes for
 * installation. Installation always asks the human through the Gate - like a
 * purchase confirm, no scope, memo or window covers it (see permissions.ts).
 */
export type FactoryToolStatus = 'built' | 'tested' | 'installed' | 'disabled';

export interface FactoryToolMeta {
  /** Slug id; doubles as the directory name. */
  id: string;
  /** Short human name shown as the tool label. */
  name: string;
  /** One line: what the tool accomplishes. */
  description: string;
  /** The request or situation that should trigger it, phrased as the user would ask. */
  whenToUse: string;
  /** Bumped on every improve; the tested hash must match the current code to install. */
  version: number;
  status: FactoryToolStatus;
  createdAt: string;
  updatedAt: string;
  /** sha256 of tool.js as last written. */
  codeSha256: string;
  /** sha256 of the tool.js that last passed the subprocess test. */
  testedSha256: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean;
}

export const FACTORY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_FACTORY_ID_LENGTH = 64;
/** Cap on authored code: a tool is a helper, not an application. */
export const MAX_FACTORY_CODE_BYTES = 64 * 1024;
