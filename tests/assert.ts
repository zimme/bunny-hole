export function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertEquals(actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right}, received ${left}`);
}

export function assertThrows(fn: () => unknown, pattern?: RegExp): void {
  try {
    fn();
  } catch (error) {
    if (
      pattern &&
      !pattern.test(error instanceof Error ? error.message : String(error))
    ) throw error;
    return;
  }
  throw new Error("expected function to throw");
}

export async function assertRejects(
  fn: () => Promise<unknown>,
  pattern?: RegExp,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (
      pattern &&
      !pattern.test(error instanceof Error ? error.message : String(error))
    ) throw error;
    return;
  }
  throw new Error("expected promise to reject");
}
