/**
 * Shared iteration budget for one agent run tree.
 *
 * A run that keeps finding "one more useful step" never ends on its own, and the
 * existing hard ceiling (`maxToolCalls`) only fires after the fact. The budget is
 * the soft version: every tool call spends one iteration, the model is told how
 * much is left while there is still room to wrap up, and subagents spend from the
 * same counter instead of getting a fresh allowance each (a "delegating" agent
 * must not multiply its budget by spawning helpers).
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
   * pasted into user-facing runs and read by the model as an instruction.
   */
  pressure(): string | null {
    const left = this.#counter.left;
    const fraction = this.#max === 0 ? 0 : left / this.#max;
    if (fraction > 0.3) return null;
    if (left <= 0) {
      return `Se ha agotado el presupuesto de ${this.#max} iteraciones. Cierra la tarea con lo que tengas.`;
    }
    const unit = left === 1 ? 'iteración' : 'iteraciones';
    if (fraction < 0.1) {
      return `¡Atención! Quedan solo ${left} ${unit} de ${this.#max}. Cierra la tarea ya con lo que tengas.`;
    }
    return `Quedan ${left} ${unit} de ${this.#max}. Cierra la tarea con lo que tengas.`;
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

  /** Restore the shared counter to the full budget (children see the reset too). */
  reset(): void {
    this.#counter.left = this.#max;
  }
}
