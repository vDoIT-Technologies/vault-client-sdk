/**
 * File helpers for uploads: reading whatever the caller passed as a file,
 * resolving its MIME type, and reporting sizes.
 */

import fs from "fs";
import { VaultError } from "./validationError.js";

export const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024;

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
 * Turn whatever the caller passed as `file` into { buffer, name, type }.
 *
 * Accepts a path on disk, a File/Blob, or an object carrying the bytes under
 * any of the common property names, so callers only ever hand over a file.
 *
 * @param {string|Object|Blob} input - The file, in any supported form
 * @param {string} operation - Calling method name, used in error messages
 * @returns {Promise<{buffer: Buffer, name: string, type: string|undefined}>}
 * @throws {VaultError} If the file is unreadable or carries no usable name
 */
export async function resolveFile(input, operation) {
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
    try {
      return await fs.promises.readFile(filePath);
    } catch (error) {
      fail(
        `Could not read the file at "${filePath}" — ${error.message}`,
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
    const buffer = Buffer.from(await input.arrayBuffer());
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

  return { buffer, name, type };
}
