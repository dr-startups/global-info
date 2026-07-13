/**
 * Guard against accidental Arsenkin HTTP during --rerender-only.
 */

let networkCalls = 0;

export function resetArsenkinNetworkCallCount(): void {
  networkCalls = 0;
}

export function getArsenkinNetworkCallCount(): number {
  return networkCalls;
}

export function isArsenkinRerenderOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARSENKIN_RERENDER_ONLY === "1";
}

/** Count and optionally forbid Arsenkin HTTP. */
export function noteArsenkinNetworkCall(kind: string, env: NodeJS.ProcessEnv = process.env): void {
  if (isArsenkinRerenderOnly(env)) {
    throw new Error(`ARSENKIN_RERENDER_ONLY forbids network call: ${kind}`);
  }
  networkCalls += 1;
}
