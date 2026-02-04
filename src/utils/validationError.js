import FormDataNode from 'form-data';
export class ValidationError extends Error {
  constructor(operation, param, expectedType, message) {
    super(
      message ||
        `InvalidParameter: The parameter '${param}' is invalid. Expected a non-empty ${expectedType}.`
    );
    this.name = "ValidationError";
    this.code = "InvalidParameter";
    this.operation = operation;
    this.param = param;
    this.expectedType = expectedType;

    Error.captureStackTrace(this, ValidationError);
  }
}

export const validator = {
  types: {
    string: (value) => typeof value === "string" && value.trim() !== "",
    object: (value) => typeof value === "object" && value !== null,
    array: (value) => Array.isArray(value),
    number: (value) => typeof value === "number" && !isNaN(value),
    boolean: (value) => typeof value === "boolean",
    function: (value) => typeof value === "function",
    formData: (value) =>
      (typeof FormData !== "undefined" && value instanceof FormData) ||
      value instanceof FormDataNode ||
      (value &&
        typeof value.append === "function" &&
        typeof value.getHeaders === "function"),
  },

  validate: function (params, operation) {
    if (!operation) {
      const stack = new Error().stack;
      const stackLine = stack.split("\n")[2];

      const methodMatch = stackLine.match(/at\s+(?:\w+\.)?(\w+)\s*\(/);
      operation = methodMatch ? methodMatch[1] : "Unknown";
    }

    Object.entries(params).forEach(([param, config]) => {
      const { value, type, required = true, custom } = config;

      if ((value === undefined || value === null) && !required) {
        return;
      }

      if ((value === undefined || value === null) && required) {
        throw new ValidationError(
          operation,
          param,
          type,
          `InvalidParameter: The parameter '${param}' is required.`
        );
      }

      const typeValidator = this.types[type];
      if (typeValidator && !typeValidator(value)) {
        throw new ValidationError(operation, param, type);
      }

      if (custom && typeof custom === "function" && !custom(value)) {
        throw new ValidationError(
          operation,
          param,
          type,
          `InvalidParameter: The parameter '${param}' failed custom validation.`
        );
      }
    });
  },
};
