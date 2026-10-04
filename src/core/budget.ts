/**
 * Iteration budget for ONE task, shared by the agents working on that task.
 *
 * A run that keeps finding "one more useful step" never ends on its own, and the
 * existing hard ceiling (`maxToolCalls`) only fires after the fact. The budget is
 * the soft version: every tool call spends one iteration and the model is told how
 * much is left while there is still room to wrap up.
 *
 * Two scopes, and the distinction is the whole point:
 *
 * - Sharing (`child()`) is only within a task: a subagent delegated to by its
 *   parent spends the parent's iterations, because delegation must not buy extra
 *   allowance.
 * - Across tasks there is NO sharing. The counter is a per-request safety ceiling
 *   that the caller refills via `reset()`; a counter that carries leftovers from
 *   the previous request turns a safety net into a late punishment — a user who
 *   chatted all morning would start every afternoon task already at "quedan 2
 *   pasos" for work that had not begun yet.
 */
export class IterationBudget {
  readonly #max: number;
  /**
   * The counter is a shared object rather than a plain field so `child()` can hand
   * the very same reference to a subagent: both see every consumption immediately.
   */
  #counter: { left: number };

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 0) {
      throw new RangeError(`iteration budget must be a non-negative integer, got ${max}`);
    }
    this.#max = max;
    this.#counter = { left: max };
  }

  /** Spend `n` iterations. Overdraft floors at zero: an exhausted budget is a state, not an error. */
  consume(n = 1): void {
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError(`consumption must be a non-negative integer, got ${n}`);
    }
    this.#counter.left = Math.max(0, this.#counter.left - n);
  }

  remaining(): number {
    return this.#counter.left;
  }

  isExhausted(): boolean {
    return this.#counter.left <= 0;
  }

  /**
   * Human-readable pressure, or null while there is plenty left.
   *
   * Three tramos, measured as the fraction of the original budget still available:
   * above 30% the agent is fine and must not be distracted; 10-30% it should start
   * closing; below 10% it must close now. The wording is Spanish because it is
   * pasted into user-facing runs and read by the model as an instruction, and it
   * says "de esta tarea" on purpose: the count describes the task in flight, and a
   * model that reads it as a daily allowance gives up on a two-step request it
   * could have finished easily.
   */
  pressure(): string | null {
    const left = this.#counter.left;
    const fraction = this.#max === 0 ? 0 : left / this.#max;
    if (fraction > 0.3) return null;
    if (left <= 0) {
      return `Se ha agotado el presupuesto de esta tarea: ${this.#max} pasos. Cierra con lo que tengas.`;
    }
    const noun = left === 1 ? 'queda 1 paso' : `quedan ${left} pasos`;
    if (fraction < 0.1) {
      const urgent = left === 1 ? 'queda solo 1 paso' : `quedan solo ${left} pasos`;
      return `¡Atención! De esta tarea ${urgent} de ${this.#max}. Cierra ya con lo que tengas.`;
    }
    return `De esta tarea ${noun} de ${this.#max}. Cierra con lo que tengas.`;
  }

  /**
   * Budget for a subagent. It shares the parent's counter on purpose: delegated
   * work is still this task's work, so it must not buy extra iterations.
   */
  child(): IterationBudget {
    const c = new IterationBudget(this.#max);
    c.#counter = this.#counter;
    return c;
  }

  /**
   * Refill to the full budget (children see the reset too).
   *
   * Called at the start of every request, never mid-task: mid-task a refill would
   * hand the model a fresh allowance for the same loop it was being squeezed out
   * of.
   */
  reset(): void {
    this.#counter.left = this.#max;
  }
}
