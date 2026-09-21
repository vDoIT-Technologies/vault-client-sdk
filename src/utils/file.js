/**
 * File helpers for uploads: reading whatever the caller passed as a file,
 * resolving its MIME type, and reporting sizes.
 */

import fs from "fs";
import { VaultError } from "./validationError.js";

export const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024;

/** Largest buffer this runtime can allocate; reading past it aborts the process. */
export const MAX_BUFFERABLE_SIZE =
  Buffer?.constants?.MAX_LENGTH ?? Buffer?.kMaxLength ?? 2 ** 31 - 1;

/** Extension → MIME type */
const CONTENT_TYPES = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  zip: "application/zip",
  json: "application/json",
  csv: "text/csv",
};

/**
 * MIME type for a file name, falling back to "application/octet-stream".
 *
 * @param {string} fileName
 * @returns {string}
 */
export function contentTypeFor(fileName) {
  const extension = String(fileName).split(".").pop()?.toLowerCase();
  return CONTENT_TYPES[extension] || "application/octet-stream";
}

/** Last path segment of a path or name, for both "/" and "\" separators. */
export const baseName = (filePath) =>
  String(filePath).split(/[\\/]/).pop() || "";

/** Human-readable byte count, e.g. "1.5 GB". Mirrors the backend formatter. */
export function formatFileSize(bytes) {
  if (!bytes) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Math.round((bytes / k ** i) * 100) / 100} ${sizes[i]}`;
}

/** Anything byte-shaped → a Buffer, or null when the value isn't bytes. */
export function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

/**
 * Reject a file that is too large, before its bytes are read into memory.
 *
 * @param {number} size - Size in bytes
 * @param {string} name - File name, used in the message
 * @param {string} operation - Calling method name
 * @throws {VaultError} With code FILE_TOO_LARGE
 */
export function assertNotTooLarge(size, name, operation) {
  if (!Number.isFinite(size)) return;

  const limit = Math.min(MAX_FILE_SIZE, MAX_BUFFERABLE_SIZE);
  if (size > limit) {
    const cap =
      limit === MAX_FILE_SIZE
        ? `the maximum upload size of ${formatFileSize(MAX_FILE_SIZE)}`
        : `what this runtime can hold in memory (${formatFileSize(limit)})`;
    throw new VaultError(
      `[Vault SDK] '${operation}': "${name}" is ${formatFileSize(size)}, which exceeds ${cap}.`,
      { code: "FILE_TOO_LARGE", operation }
    );
  }
}

/** The working directory, when the runtime has one. */
const defaultUploadRoot = () =>
  typeof process !== "undefined" && typeof process.cwd === "function"
    ? process.cwd()
    : null;

/**
 * Resolve a caller-supplied path and confirm it stays inside `root`.
 *
 * Both sides go through realpath first, so a symlink cannot step out of the
 * root. Messages name the file only, never the resolved path.
 */
async function resolveWithinRoot(filePath, root, fail) {
  if (
    typeof fs?.promises?.realpath !== "function" ||
    typeof fs?.promises?.stat !== "function"
  ) {
    fail(
      "Reading files from disk is not available here. Pass a File/Blob or { buffer, name } instead of a path.",
      "FILE_READ_FAILED"
    );
  }

  const configuredRoot = root || defaultUploadRoot();
  if (!configuredRoot) {
    fail(
      "No upload directory is configured, so paths on disk cannot be read. Set VAULT_UPLOAD_ROOT, or pass { buffer, name } instead.",
      "PATH_NOT_ALLOWED"
    );
  }

  let realRoot;
  try {
    realRoot = await fs.promises.realpath(configuredRoot);
  } catch {
    fail(
      "The configured upload directory does not exist. Check VAULT_UPLOAD_ROOT.",
      "PATH_NOT_ALLOWED"
    );
  }

  let realPath;
  try {
    realPath = await fs.promises.realpath(filePath);
  } catch (error) {
    fail(
      `Could not read "${baseName(filePath)}" — ${error.code || error.message}.`,
      "FILE_READ_FAILED"
    );
  }

  const separator = realRoot.includes("\\") ? "\\" : "/";
  const caseInsensitive = /^[A-Za-z]:/.test(realRoot);
  const normalize = (value) => (caseInsensitive ? value.toLowerCase() : value);
  const base = normalize(
    realRoot.endsWith(separator)
      ? realRoot.slice(0, -separator.length)
      : realRoot
  );
  const target = normalize(realPath);

  if (target !== base && !target.startsWith(base + separator)) {
    fail(
      `"${baseName(filePath)}" is outside the allowed upload directory. ` +
        `Pass a file inside it, set VAULT_UPLOAD_ROOT to the directory you upload from, or hand over { buffer, name } instead.`,
      "PATH_NOT_ALLOWED"
    );
  }

  return realPath;
}

/**
 * Turn whatever the caller passed as `file` into { buffer, name, type }.
 *
 * Accepts a path on disk, a File/Blob, or an object carrying the bytes under
 * any of the common property names, so callers only ever hand over a file.
 *
 * @param {string|Object|Blob} input - The file, in any supported form
 * @param {string} operation - Calling method name, used in error messages
 * @param {Object} [options] - { uploadRoot }: the directory paths must stay inside
 * @returns {Promise<{buffer: Buffer, name: string, type: string|undefined}>}
 * @throws {VaultError} If the file is unreadable, too large, or outside the upload root
 */
export async function resolveFile(input, operation, options = {}) {
  const fail = (message, code = "INVALID_PARAMETER") => {
    throw new VaultError(`[Vault SDK] '${operation}': ${message}`, {
      code,
      operation,
    });
  };

  if (input === undefined || input === null || input === "") {
    fail(
      "The 'file' parameter is required. Pass a path on disk, a File/Blob, or an object like { buffer, name }."
    );
  }

  const readPath = async (filePath) => {
    const realPath = await resolveWithinRoot(filePath, options.uploadRoot, fail);

    let stats;
    try {
      stats = await fs.promises.stat(realPath);
    } catch (error) {
      fail(
        `Could not read "${baseName(filePath)}" — ${error.code || error.message}.`,
        "FILE_READ_FAILED"
      );
    }

    if (!stats.isFile()) {
      fail(`"${baseName(filePath)}" is not a file.`, "FILE_READ_FAILED");
    }

    assertNotTooLarge(stats.size, baseName(filePath), operation);

    try {
      return await fs.promises.readFile(realPath);
    } catch (error) {
      fail(
        `Could not read "${baseName(filePath)}" — ${error.code || error.message}.`,
        "FILE_READ_FAILED"
      );
    }
  };

  // uploadFile("./photo.jpg", vaultId)
  if (typeof input === "string") {
    const buffer = await readPath(input);
    return { buffer, name: baseName(input), type: undefined };
  }

  // A bare Buffer carries no name, so there is nothing to store it under.
  if (toBuffer(input) && !input.name) {
    fail(
      "A raw buffer has no file name. Pass { buffer, name } instead, e.g. { buffer, name: 'document.pdf' }."
    );
  }

  if (typeof input !== "object") {
    fail(
      "The 'file' parameter must be a path, a File/Blob, or an object like { buffer, name }."
    );
  }

  const name =
    input.name || input.fileName || input.filename || baseName(input.path || "");
  const type = input.type || input.mimeType || input.contentType;

  // File / Blob (browser, or Node 20+ globals)
  if (typeof input.arrayBuffer === "function") {
    assertNotTooLarge(input.size, name || "file", operation);
    const buffer = Buffer.from(await input.arrayBuffer());
    assertNotTooLarge(buffer.length, name || "file", operation);
    return { buffer, name, type };
  }

  const raw = input.buffer ?? input.data ?? input.content ?? input.bytes;
  const buffer = raw
    ? toBuffer(raw)
    : input.path
      ? await readPath(input.path)
      : null;

  if (!buffer) {
    fail(
      "Could not read the file content. Provide file.buffer as a Buffer/Uint8Array, or file.path pointing at a file on disk."
    );
  }

  if (!name) {
    fail(
      "file.name is required. Provide the file name as a non-empty string (e.g. 'document.pdf')."
    );
  }

  assertNotTooLarge(buffer.length, name, operation);

  return { buffer, name, type };
}
