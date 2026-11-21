// Types for the parts of the vendored server the tests call.
export function tools(data: unknown, env?: Record<string, unknown>): { name: string; description: string }[];
export function filters(data: unknown): unknown;
export function jobQuestions(
  data: unknown,
  args: Record<string, unknown>,
  env: Record<string, unknown>,
): Promise<unknown>;
