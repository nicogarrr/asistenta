/** A completed timeout is failure, never evidence that active work drained. */
export const THREAD_DRAIN_MS = 10_000;
export async function drainThreadTails(
  pending: Promise<unknown>[],
  budgetMs = THREAD_DRAIN_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error('Los turnos no terminaron dentro del límite de cierre; apagado no limpio.'),
            ),
          budgetMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
