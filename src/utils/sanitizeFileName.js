/**
 * File name sanitization — mirrors the vault backend and frontend sanitizer so
 * a name the SDK sends is the same name the server would have derived itself.
 */

export const MAX_FILENAME_LENGTH = 255;

/** Windows rejects these as file names whatever the extension. */
const RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** Illegal in a Windows path, a URL path segment, or both. */
const ILLEGAL_CHARS = /[<>:"/\\|?*]/g;

const foldToAscii = (value) =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\x20-\x7E]/g, "");

/** Leading dots are stripped: hidden files and "../" are not names we store. */
const tidy = (value) =>
  foldToAscii(value)
    .replace(ILLEGAL_CHARS, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "");

/** Splits "report.final.pdf" into { base: "report.final", ext: "pdf" }. */
export const splitExtension = (name) => {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot + 1) };
};

/**
 * @param {string} name - Raw name as the caller supplied it
 * @param {string} [fallback="file"] - Used when nothing usable survives.
 * @returns {string} ASCII-safe name, at most MAX_FILENAME_LENGTH characters
 *
 */
export function sanitizeFileName(name, fallback = "file") {
  if (typeof name !== "string" || !name) return fallback;

  const segment = name.split(/[\\/]/).pop() ?? "";
  const { base, ext } = splitExtension(segment);

  let safeBase = tidy(base) || fallback;
  if (RESERVED_NAMES.has(safeBase.toUpperCase())) {
    safeBase = `_${safeBase}`;
  }

  const safeExt = tidy(ext).slice(0, 32);
  const suffix = safeExt ? `.${safeExt}` : "";

  const room = Math.max(1, MAX_FILENAME_LENGTH - suffix.length);
  const truncated = safeBase.slice(0, room).replace(/[\s.]+$/, "") || fallback;

  if (!truncated) return "";

  return `${truncated}${suffix}`;
}
