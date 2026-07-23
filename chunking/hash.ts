/**
 * Stable 64-bit-like hash made from two independently mixed 32-bit lanes over
 * UTF-16 code units. It is intended for change detection and deterministic
 * identifiers, not cryptographic security.
 */
export function stableHash(value: string): string {
  let primary = 0x811c9dc5;
  let secondary = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    primary ^= codeUnit;
    primary = Math.imul(primary, 0x01000193);

    secondary ^= codeUnit;
    secondary = Math.imul(secondary, 0x5bd1e995);
    secondary ^= secondary >>> 13;
  }
  return [primary, secondary]
    .map((lane) => (lane >>> 0).toString(16).padStart(8, "0"))
    .join("");
}
