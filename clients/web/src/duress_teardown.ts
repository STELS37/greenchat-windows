// T-526: duress teardown ordering. Local crypto-erasure starts immediately; bounded network work may
// continue behind the already-rendered auth gate, but the hard page navigation must not cancel it.
export async function finishDuressTeardown(
  localWipe: Promise<unknown>,
  network: Promise<unknown>,
  navigate: () => void,
): Promise<void> {
  await Promise.allSettled([localWipe, network]);
  try { navigate(); } catch { /* native shell may already have replaced the view */ }
}
