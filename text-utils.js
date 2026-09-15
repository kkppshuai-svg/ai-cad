/**
 * Collapse control characters and runs of whitespace, then clamp the length.
 * Used on every piece of free text that reaches a prompt, a filename, or an
 * archived record, so a pasted newline can never reshape the surrounding
 * structure.
 */
export function sanitizeText(value, maxLength) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** Coerce to an integer inside [min, max], falling back when not finite. */
export function boundedInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}
