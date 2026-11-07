// A confirmation that must outlive the screen that made it: the timing board is rebuilt after a reassignment (it is keyed by its rotations,
// and a reassignment gives them new ids), so the new instance picks the message up here. Module memory only: nothing on a first load,
// which keeps the first render identical on the server and in the browser.
let carried: string | null = null;

export function carryMessage(text: string): void {
  carried = text;
}

export function takeCarriedMessage(): string | null {
  const kept = carried;
  carried = null;
  return kept;
}
