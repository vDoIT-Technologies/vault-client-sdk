/**
 * Custom error class for validation errors in the Vault SDK.
 * Thrown when method parameters fail type or presence checks.
 */
export class ValidationError extends Error {
  constructor(operation, param, expectedType, message) {
    super(
      message ||
        `[Vault SDK] Validation failed in '${operation}': Parameter '${param}' must be a non-empty ${expectedType}.`
    );
    this.name = "ValidationError";
    this.code = "INVALID_PARAMETER";
    this.operation = operation;
    this.param = param;
    this.expectedType = expectedType;

    Error.captureStackTrace(this, ValidationError);
  }
}

/**
 * Custom error class for API/network errors from the Vault SDK.
 * Wraps HTTP errors with status codes and structured error data.
 */
export class VaultError extends Error {
  constructor(message, { status, code, operation, data } = {}) {
    super(message);
    this.name = "VaultError";
    this.status = status || null;
    this.code = code || "VAULT_ERROR";
    this.operation = operation || null;
    this.data = data || null;

    Error.captureStackTrace(this, VaultError);
  }
}

/**
 * Maps HTTP status codes to user-friendly error descriptions.
 */
export const HTTP_ERROR_MAP = {
  400: { code: "BAD_REQUEST", description: "The request was invalid. Check your parameters." },
  401: { code: "UNAUTHORIZED", description: "Authentication failed. Verify your VAULT_ACCESS_KEY and VAULT_SECRET_KEY." },
  403: { code: "FORBIDDEN", description: "Access denied. Your API key may not have permission for this operation." },
  404: { code: "NOT_FOUND", description: "The requested resource was not found." },
  409: { code: "CONFLICT", description: "A conflict occurred. The resource may already exist." },
  413: { code: "FILE_TOO_LARGE", description: "The file exceeds the maximum allowed size." },
  429: { code: "RATE_LIMITED", description: "Too many requests. Please wait and try again." },
  500: { code: "SERVER_ERROR", description: "An internal server error occurred. Please try again later." },
  502: { code: "BAD_GATEWAY", description: "The server is temporarily unavailable. Please try again later." },
  503: { code: "SERVICE_UNAVAILABLE", description: "The service is temporarily unavailable. Please try again later." },
};

export const validator = {
  types: {
    string: (value) => typeof value === "string" && value.trim() !== "",
    object: (value) => typeof value === "object" && value !== null,
    array: (value) => Array.isArray(value) && value.length > 0,
    number: (value) => typeof value === "number" && !isNaN(value) && value >= 0,
    boolean: (value) => typeof value === "boolean",
    function: (value) => typeof value === "function",
    buffer: (value) => Buffer.isBuffer(value) || (value instanceof Uint8Array),
  },

  validate: function (params, operation) {
    if (!operation) {
      const stack = new Error().stack;
      const stackLine = stack.split("\n")[2];
      const methodMatch = stackLine.match(/at\s+(?:\w+\.)?(\w+)\s*\(/);
      operation = methodMatch ? methodMatch[1] : "Unknown";
    }

    Object.entries(params).forEach(([param, config]) => {
      const { value, type, required = true, custom, message } = config;

      if ((value === undefined || value === null) && !required) {
        return;
      }

      if ((value === undefined || value === null) && required) {
        throw new ValidationError(
          operation,
          param,
          type,
          message || `[Vault SDK] '${operation}' requires the '${param}' parameter.`
        );
      }

      const typeValidator = this.types[type];
      if (typeValidator && !typeValidator(value)) {
        throw new ValidationError(
          operation,
          param,
          type,
          message || `[Vault SDK] '${operation}': Parameter '${param}' must be a valid ${type}. Received: ${typeof value}.`
        );
      }

      if (custom && typeof custom === "function" && !custom(value)) {
        throw new ValidationError(
          operation,
          param,
          type,
          message || `[Vault SDK] '${operation}': Parameter '${param}' failed validation.`
        );
      }
    });
  },
};
