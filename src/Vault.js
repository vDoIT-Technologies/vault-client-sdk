import crypto from "crypto";
import axios from "axios";
import WebSocket from "ws";
import EventEmitter from "events";
import { validator, VaultError, HTTP_ERROR_MAP } from "./utils/validationError.js";

class Vault extends EventEmitter {
  /**
   * Create a new Vault SDK instance.
   *
   * @param {Object} config
   * @param {string} config.VAULT_ACCESS_KEY - Your API access key
   * @param {string} config.VAULT_SECRET_KEY - Your API secret key (used for HMAC signing)
   * @param {string} config.VAULT_CLIENT_API_KEY - Your client-specific API key
   * @param {string} config.VAULT_BASE_URL - Base URL of the Vault API (e.g. "https://api.example.com")
   * @param {string} [config.VAULT_WS_URL] - WebSocket URL for real-time events (e.g. "wss://api.example.com/ws")
   *
   * @throws {VaultError} If any required configuration parameter is missing
   *
   * @example
   * const vault = new Vault({
   *   VAULT_ACCESS_KEY: "your-access-key",
   *   VAULT_SECRET_KEY: "your-secret-key",
   *   VAULT_CLIENT_API_KEY: "your-client-api-key",
   *   VAULT_BASE_URL: "https://api.example.com",
   *   VAULT_WS_URL: "wss://api.example.com/ws",
   * });
   */
  constructor({
    VAULT_ACCESS_KEY,
    VAULT_SECRET_KEY,
    VAULT_CLIENT_API_KEY,
    VAULT_BASE_URL,
    VAULT_WS_URL,
  } = {}) {
    super();

    const missing = [];
    if (!VAULT_ACCESS_KEY) missing.push("VAULT_ACCESS_KEY");
    if (!VAULT_SECRET_KEY) missing.push("VAULT_SECRET_KEY");
    if (!VAULT_CLIENT_API_KEY) missing.push("VAULT_CLIENT_API_KEY");
    if (!VAULT_BASE_URL) missing.push("VAULT_BASE_URL");

    if (missing.length > 0) {
      throw new VaultError(
        `[Vault SDK] Missing required configuration: ${missing.join(", ")}. ` +
          `All of VAULT_ACCESS_KEY, VAULT_SECRET_KEY, VAULT_CLIENT_API_KEY, and VAULT_BASE_URL must be provided.`,
        { code: "MISSING_CONFIG", operation: "constructor" }
      );
    }

    this.apiKey = VAULT_ACCESS_KEY;
    this.apiSecret = VAULT_SECRET_KEY;
    this.clientApiKey = VAULT_CLIENT_API_KEY;
    this.baseUrl = VAULT_BASE_URL;
    this.wsUrl = VAULT_WS_URL;
    this.ws = null;

    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      headers: {
        "Content-Type": "application/json",
        "API-Key": this.apiKey,
      },
    });
  }

  /**
   * Internal: Make an authenticated HTTP request to the Vault API.
   * Automatically generates HMAC-SHA256 signature for each request.
   *
   * @param {string} method - HTTP method (GET, POST, PUT, DELETE)
   * @param {string} endpoint - API endpoint path
   * @param {Object} [payload] - Request body
   * @param {Object} [options] - Additional options (e.g. extra headers)
   * @returns {Promise<Object>} Response from the API
   * @throws {VaultError} On API or network errors
   */
  async request(method, endpoint, payload, options = {}) {
    const timestamp = Date.now().toString();
    const signature = this.sign(timestamp);

    const headers = {
      timestamp,
      signature,
      apikey: this.apiKey,
      "x-client-api-key": this.clientApiKey,
      ...options.headers,
    };

    try {
      const response = await this.httpClient.request({
        method,
        url: endpoint,
        headers,
        data: payload,
      });
      return response;
    } catch (error) {
      const operation = options.operation || endpoint;

      if (error.response) {
        const status = error.response.status;
        const data = error.response.data;
        const serverMessage = data?.message || data?.error || "";
        const errorInfo = HTTP_ERROR_MAP[status] || {
          code: "UNKNOWN_ERROR",
          description: "An unexpected error occurred.",
        };

        const message = serverMessage
          ? `[Vault SDK] ${operation}: ${serverMessage}`
          : `[Vault SDK] ${operation}: ${errorInfo.description}`;

        throw new VaultError(message, {
          status,
          code: errorInfo.code,
          operation,
          data,
        });
      } else if (error.request) {
        throw new VaultError(
          `[Vault SDK] ${operation}: No response received from the server. ` +
            `Please check your network connection and ensure VAULT_BASE_URL ("${this.baseUrl}") is correct.`,
          { code: "NETWORK_ERROR", operation }
        );
      } else {
        throw new VaultError(
          `[Vault SDK] ${operation}: Request failed — ${error.message}`,
          { code: "REQUEST_SETUP_ERROR", operation }
        );
      }
    }
  }

  /**
   * Internal: Generate HMAC-SHA256 signature for request authentication.
   *
   * @param {string} timestamp - Current timestamp string
   * @returns {string} Hex-encoded HMAC signature
   */
  sign(timestamp) {
    const message = this.apiKey + timestamp;
    return crypto
      .createHmac("sha256", this.apiSecret)
      .update(message)
      .digest("hex");
  }

  // ─── WebSocket ────────────────────────────────────────────────

  /**
   * Establish a WebSocket connection for real-time vault events.
   *
   * @returns {Promise<void>} Resolves when connection is established
   * @throws {VaultError} If VAULT_WS_URL is not configured or connection fails
   *
   * @example
   * await vault.connectToWebsocket();
   * vault.on("message", (data) => console.log("Received:", data));
   * vault.on("stream_error", (err) => console.error("WS error:", err));
   */
  async connectToWebsocket() {
    if (!this.wsUrl) {
      throw new VaultError(
        "[Vault SDK] 'connectToWebsocket': VAULT_WS_URL is not configured. " +
          "Provide it in the constructor to use WebSocket features.",
        { code: "MISSING_CONFIG", operation: "connectToWebsocket" }
      );
    }

    const timestamp = Date.now().toString();
    const signature = this.sign(timestamp);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(
        `${this.wsUrl}?apikey=${this.apiKey}&signature=${signature}&timestamp=${timestamp}&clientApiKey=${this.clientApiKey}`
      );

      this.ws.onopen = () => {
        resolve();
      };

      this.ws.onmessage = this.wsOnMessage.bind(this);
      this.ws.onclose = () => {};

      this.ws.onerror = (error) => {
        reject(
          new VaultError(
            `[Vault SDK] 'connectToWebsocket': WebSocket connection failed — ${error.message || "Unknown error"}`,
            { code: "WEBSOCKET_ERROR", operation: "connectToWebsocket" }
          )
        );
      };
    });
  }

  /**
   * Internal: Handle incoming WebSocket messages.
   * @private
   */
  wsOnMessage(event) {
    try {
      const response = JSON.parse(event.data);
      this.emit("message", response);
      return response;
    } catch (error) {
      this.emit(
        "stream_error",
        `[Vault SDK] Failed to parse WebSocket message: ${error.message}`
      );
    }
  }

  /**
   * Internal: Handle WebSocket errors.
   * @private
   */
  wsOnError(error) {
    this.emit("stream_error", error.message);
    return error;
  }

  // ─── File Upload ──────────────────────────────────────────────

  /**
   * Upload a single file to the vault.
   *
   * The upload is a 3-step process:
   * 1. Compute SHA-256 hash of the file content
   * 2. Get a presigned S3 URL from the server
   * 3. Upload directly to S3, then register the upload
   *
   * @param {Object} file - File object to upload
   * @param {Buffer|Uint8Array} file.buffer - File content as a buffer
   * @param {string} file.name - File name (e.g. "document.pdf")
   * @param {string} [file.type] - MIME type (e.g. "application/pdf"). Defaults to "application/octet-stream"
   * @param {string} vaultId - The vault ID to upload to
   * @param {string} [parentId] - Parent folder ID (omit or null for root)
   * @returns {Promise<Object>} Upload result with file details
   *
   * @throws {VaultError} If upload fails at any step
   * @throws {ValidationError} If required parameters are missing/invalid
   *
   * @example
   * import fs from "fs";
   * const fileBuffer = fs.readFileSync("./photo.jpg");
   * const result = await vault.uploadFile(
   *   { buffer: fileBuffer, name: "photo.jpg", type: "image/jpeg" },
   *   "your-vault-id"
   * );
   */
  async uploadFile(file, vaultId, parentId) {
    validator.validate(
      {
        file: {
          value: file,
          type: "object",
          message:
            "[Vault SDK] 'uploadFile': The 'file' parameter must be an object with { buffer, name } properties.",
        },
        vaultId: { value: vaultId, type: "string" },
      },
      "uploadFile"
    );

    if (!file.buffer) {
      throw new VaultError(
        "[Vault SDK] 'uploadFile': file.buffer is required. Provide the file content as a Buffer or Uint8Array.",
        { code: "INVALID_PARAMETER", operation: "uploadFile" }
      );
    }

    if (!file.name || typeof file.name !== "string" || !file.name.trim()) {
      throw new VaultError(
        "[Vault SDK] 'uploadFile': file.name is required. Provide the file name as a non-empty string (e.g. 'document.pdf').",
        { code: "INVALID_PARAMETER", operation: "uploadFile" }
      );
    }

    const { buffer, name, type } = file;
    const size = buffer.length;

    if (size === 0) {
      throw new VaultError(
        "[Vault SDK] 'uploadFile': file.buffer is empty. Cannot upload a zero-byte file.",
        { code: "INVALID_PARAMETER", operation: "uploadFile" }
      );
    }

    // Step 1: Calculate SHA-256 hash
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");

    // Step 2: Get presigned URL
    let presignedRes;
    try {
      presignedRes = await this.getPresignedUrl({
        vaultId,
        fileName: name,
        fileType: type || "application/octet-stream",
        fileSize: size,
        contentHash: hash,
        folderId: parentId,
      });
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError(
        `[Vault SDK] 'uploadFile': Failed to get upload URL for "${name}" — ${error.message}`,
        { code: "PRESIGN_FAILED", operation: "uploadFile" }
      );
    }

    const { url, key, contentType, sanitizedName } = presignedRes;

    // Step 3: Upload to S3
    try {
      await axios.put(url, buffer, {
        headers: {
          "Content-Type": contentType,
          "x-amz-meta-original-filename": sanitizedName || name,
          "x-amz-meta-content-hash": hash,
          "x-amz-meta-vault-id": vaultId,
          "x-amz-meta-folder-id": parentId || "root",
          "x-amz-meta-file-size": size.toString(),
        },
      });
    } catch (error) {
      const status = error.response?.status;
      let detail = error.message;
      if (status === 403)
        detail =
          "The presigned URL has expired or required signing headers are missing. Please try uploading again.";
      if (status === 413)
        detail = `File "${name}" exceeds the maximum allowed upload size.`;

      throw new VaultError(
        `[Vault SDK] 'uploadFile': Failed to upload "${name}" to storage — ${detail}`,
        {
          status,
          code: "STORAGE_UPLOAD_FAILED",
          operation: "uploadFile",
        }
      );
    }

    // Step 4: Register the upload
    try {
      return await this.registerUpload({
        vaultId,
        fileName: name,
        filebaseKey: key,
        fileSize: size,
        contentHash: hash,
        folderId: parentId,
      });
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError(
        `[Vault SDK] 'uploadFile': File "${name}" was uploaded to storage but failed to register. ` +
          `Please contact support if this persists — ${error.message}`,
        { code: "REGISTER_FAILED", operation: "uploadFile" }
      );
    }
  }

  /**
   * Upload multiple files to the vault in parallel.
   *
   * Each file is uploaded independently. Failed uploads do not block others.
   *
   * @param {Array<Object>} files - Array of file objects, each with { buffer, name, type? }
   * @param {string} vaultId - The vault ID to upload to
   * @param {string} [parentId] - Parent folder ID (omit or null for root)
   * @returns {Promise<Array<Object>>} Array of results, each with status "success" or "failed"
   *
   * @example
   * const results = await vault.uploadFiles(
   *   [
   *     { buffer: buf1, name: "file1.pdf", type: "application/pdf" },
   *     { buffer: buf2, name: "file2.jpg", type: "image/jpeg" },
   *   ],
   *   "your-vault-id"
   * );
   */
  async uploadFiles(files, vaultId, parentId = null) {
    validator.validate(
      {
        files: {
          value: files,
          type: "array",
          message:
            "[Vault SDK] 'uploadFiles': 'files' must be a non-empty array of file objects ({ buffer, name }).",
        },
        vaultId: { value: vaultId, type: "string" },
      },
      "uploadFiles"
    );

    const uploadPromises = files.map(async (file, index) => {
      try {
        if (!file || typeof file !== "object") {
          throw new VaultError(
            `File at index ${index} is not a valid object. Each file must have { buffer, name }.`,
            { code: "INVALID_PARAMETER", operation: "uploadFiles" }
          );
        }
        const result = await this.uploadFile(file, vaultId, parentId);
        return { ...result, status: "success", fileName: file.name };
      } catch (error) {
        return {
          status: "failed",
          fileName: file?.name || `file[${index}]`,
          error: error.message,
          code: error.code || "UPLOAD_FAILED",
        };
      }
    });

    return await Promise.all(uploadPromises);
  }

  // ─── File Retrieval ───────────────────────────────────────────

  /**
   * Search for files in the vault by name or query.
   *
   * @param {string} vaultId - The vault ID to search in
   * @param {string} [query=""] - Search query to filter files by name
   * @returns {Promise<Object>} Matching files
   *
   * @example
   * const files = await vault.getFiles("your-vault-id", "report");
   */
  async getFiles(vaultId, query = "") {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        query: { value: query, type: "string", required: false },
      },
      "getFiles"
    );

    const queryString = `?vaultId=${encodeURIComponent(vaultId)}&query=${encodeURIComponent(query)}`;
    const response = await this.request(
      "GET",
      `/v1/vault-sdk/get-files${queryString}`,
      undefined,
      { operation: "getFiles" }
    );
    return response.data;
  }

  /**
   * Get all files in the vault.
   *
   * @param {string} vaultId - The vault ID
   * @returns {Promise<Object>} All files in the vault
   *
   * @example
   * const allFiles = await vault.getAllFiles("your-vault-id");
   */
  async getAllFiles(vaultId) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
      },
      "getAllFiles"
    );

    const queryString = `?vaultId=${encodeURIComponent(vaultId)}`;
    const response = await this.request(
      "GET",
      `/v1/vault-sdk/all-files${queryString}`,
      undefined,
      { operation: "getAllFiles" }
    );
    return response.data;
  }

  // ─── Storage & Plans ──────────────────────────────────────────

  /**
   * Get storage usage details for the vault (used space, total space, etc.).
   *
   * @param {string} vaultId - The vault ID
   * @returns {Promise<Object>} Storage usage information
   *
   * @example
   * const storage = await vault.getStorageDetails("your-vault-id");
   */
  async getStorageDetails(vaultId) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
      },
      "getStorageDetails"
    );

    const queryString = `?vaultId=${encodeURIComponent(vaultId)}`;
    const response = await this.request(
      "GET",
      `/v1/vault-sdk/storage-details${queryString}`,
      undefined,
      { operation: "getStorageDetails" }
    );
    return response.data;
  }

  /**
   * Get all available storage plans.
   *
   * @param {string} vaultId - The vault ID
   * @returns {Promise<Object>} Available storage plans
   *
   * @example
   * const plans = await vault.getAllPlans("your-vault-id");
   */
  async getAllPlans(vaultId) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
      },
      "getAllPlans"
    );

    const queryString = `?vaultId=${encodeURIComponent(vaultId)}`;
    const response = await this.request(
      "GET",
      `/v1/vault-sdk/all-plans${queryString}`,
      undefined,
      { operation: "getAllPlans" }
    );
    return response.data;
  }

  /**
   * Purchase a storage plan.
   *
   * @param {string} vaultId - The vault ID
   * @param {string} priceId - The price ID of the plan to purchase
   * @returns {Promise<Object>} Purchase confirmation
   *
   * @example
   * const purchase = await vault.buyPlan("your-vault-id", "price-id");
   */
  async buyPlan(vaultId, priceId) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        priceId: { value: priceId, type: "string" },
      },
      "buyPlan"
    );

    const response = await this.request(
      "POST",
      "/v1/vault-sdk/buy-plan",
      { vaultId, priceId },
      { operation: "buyPlan" }
    );
    return response.data;
  }

  /**
   * Cancel the active subscription at period end.
   *
   * @param {string} vaultId - The vault ID
   * @returns {Promise<Object>} Cancellation scheduling details
   *
   * @example
   * const result = await vault.cancelSubscription("your-vault-id");
   */
  async cancelSubscription(vaultId) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
      },
      "cancelSubscription"
    );

    const response = await this.request(
      "POST",
      "/v1/vault-sdk/cancel-subscription",
      { vaultId },
      { operation: "cancelSubscription" }
    );
    return response.data;
  }

  /**
   * Schedule an upcoming plan to start after current plan expiry.
   *
   * @param {string} vaultId - The vault ID
   * @param {string} priceId - Stripe price ID for the upcoming plan
   * @returns {Promise<Object>} Upcoming plan scheduling result
   *
   * @example
   * const result = await vault.createUpcomingPlan("your-vault-id", "price-id");
   */
  async createUpcomingPlan(vaultId, priceId) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        priceId: { value: priceId, type: "string" },
      },
      "createUpcomingPlan"
    );

    const response = await this.request(
      "POST",
      "/v1/vault-sdk/upcoming",
      { vaultId, priceId },
      { operation: "createUpcomingPlan" }
    );
    return response.data;
  }

  /**
   * Cancel auto-renewal for a pending upcoming plan.
   *
   * @param {string} vaultId - The vault ID
   * @returns {Promise<Object>} Upcoming plan cancellation result
   *
   * @example
   * const result = await vault.cancelUpcomingPlan("your-vault-id");
   */
  async cancelUpcomingPlan(vaultId) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
      },
      "cancelUpcomingPlan"
    );

    const response = await this.request(
      "POST",
      "/v1/vault-sdk/upcoming/cancel",
      { vaultId },
      { operation: "cancelUpcomingPlan" }
    );
    return response.data;
  }

  /**
   * Get active subscriptions for the vault.
   *
   * @param {string} vaultId - The vault ID
   * @returns {Promise<Object>} Active subscriptions
   *
   * @example
   * const subs = await vault.getSubscriptions("your-vault-id");
   */
  async getSubscriptions(vaultId) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
      },
      "getSubscriptions"
    );

    const queryString = `?vaultId=${encodeURIComponent(vaultId)}`;
    const response = await this.request(
      "GET",
      `/v1/vault-sdk/subscriptions${queryString}`,
      undefined,
      { operation: "getSubscriptions" }
    );
    return response.data;
  }

  // ─── Folder Operations ────────────────────────────────────────

  /**
   * Create a new folder in the vault.
   *
   * @param {string} vaultId - The vault ID
   * @param {string} folderName - Name for the new folder
   * @param {string} [parentId] - Parent folder ID for nested folders (omit for root)
   * @returns {Promise<Object>} Created folder details
   *
   * @example
   * await vault.createFolder("your-vault-id", "Documents");
   * await vault.createFolder("your-vault-id", "Invoices", "parent-folder-id");
   */
  async createFolder(vaultId, folderName, parentId = null) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        folderName: { value: folderName, type: "string" },
      },
      "createFolder"
    );

    const response = await this.request(
      "POST",
      "/v1/vault-sdk/create-folder",
      { vaultId, folderName, parentId },
      { operation: "createFolder" }
    );
    return response.data;
  }

  /**
   * Rename a file or folder in the vault.
   *
   * @param {string} vaultId - The vault ID
   * @param {string} itemId - The ID of the file or folder to rename
   * @param {string} newName - The new name
   * @returns {Promise<Object>} Updated item details
   *
   * @example
   * await vault.renameItem("your-vault-id", "item-id", "New Name.pdf");
   */
  async renameItem(vaultId, itemId, newName) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        itemId: { value: itemId, type: "string" },
        newName: { value: newName, type: "string" },
      },
      "renameItem"
    );

    const response = await this.request(
      "POST",
      "/v1/vault-sdk/rename",
      { vaultId, itemId, newName },
      { operation: "renameItem" }
    );
    return response.data;
  }

  /**
   * Delete a folder from the vault.
   *
   * @param {string} vaultId - The vault ID
   * @param {string} folderId - The ID of the folder to delete
   * @returns {Promise<Object>} Deletion confirmation
   *
   * @example
   * await vault.deleteFolder("your-vault-id", "folder-id");
   */
  async deleteFolder(vaultId, folderId) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        folderId: { value: folderId, type: "string" },
      },
      "deleteFolder"
    );

    const response = await this.request(
      "DELETE",
      "/v1/vault-sdk/delete-folder",
      { vaultId, folderId },
      { operation: "deleteFolder" }
    );
    return response.data;
  }

  /**
   * Delete a file from the vault.
   *
   * @param {string} vaultId - The vault ID
   * @param {string} fileId - The ID of the file to delete
   * @returns {Promise<Object>} Deletion confirmation
   *
   * @example
   * await vault.deleteFile("your-vault-id", "file-id");
   */
  async deleteFile(vaultId, fileId) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        fileId: { value: fileId, type: "string" },
      },
      "deleteFile"
    );

    const response = await this.request(
      "DELETE",
      "/v1/vault-sdk/delete-file",
      { vaultId, fileId },
      { operation: "deleteFile" }
    );
    return response.data;
  }

  // ─── Starred Files ────────────────────────────────────────────

  /**
   * Mark or unmark a file as starred.
   *
   * @param {string} vaultId - The vault ID
   * @param {string} fileId - The file ID to star/unstar
   * @param {boolean} isStarred - true to star, false to unstar
   * @returns {Promise<Object>} Updated file details
   *
   * @example
   * await vault.addToStarred("your-vault-id", "file-id", true);
   */
  async addToStarred(vaultId, fileId, isStarred) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        fileId: { value: fileId, type: "string" },
        isStarred: { value: isStarred, type: "boolean" },
      },
      "addToStarred"
    );

    const response = await this.request(
      "POST",
      "/v1/vault-sdk/add-to-starred",
      { vaultId, fileId, isStarred },
      { operation: "addToStarred" }
    );
    return response.data;
  }

  /**
   * Get all starred files in the vault.
   *
   * @param {string} vaultId - The vault ID
   * @returns {Promise<Object>} Starred files
   *
   * @example
   * const starred = await vault.getStarredFiles("your-vault-id");
   */
  async getStarredFiles(vaultId) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
      },
      "getStarredFiles"
    );

    const queryString = `?vaultId=${encodeURIComponent(vaultId)}`;
    const response = await this.request(
      "GET",
      `/v1/vault-sdk/get-starred-files${queryString}`,
      undefined,
      { operation: "getStarredFiles" }
    );
    return response.data;
  }

  // ─── Platform Operations ──────────────────────────────────────

  /**
   * Create a vault for a user, or link an existing one to your client.
   *
   * Idempotent: if a user already exists for the email, they are linked to your
   * client API key and returned instead of erroring.
   *
   * @param {string} email - User's email address
   * @param {string} [platformId] - Optional platform ID to associate the user with
   * @returns {Promise<Object>} Created (or existing) user details, including vaultId
   *
   * @example
   * const user = await vault.createVault("user@example.com", "platform-id");
   * const sdkUser = await vault.createVault("user@example.com"); // platform-less SDK user link
   */
  async createVault(email, platformId) {
    const normalizedPlatformId =
      typeof platformId === "string" ? platformId.trim() : platformId;

    validator.validate(
      {
        email: { value: email, type: "string" },
        platformId: {
          value: normalizedPlatformId || undefined,
          type: "string",
          required: false,
        },
      },
      "createVault"
    );

    const payload = { email };
    if (normalizedPlatformId) {
      payload.platformId = normalizedPlatformId;
    }

    const response = await this.request(
      "POST",
      "/v1/vault-sdk/create-user",
      payload,
      { operation: "createVault" }
    );
    return response.data;
  }

  /**
   * Import an existing vault into a platform.
   *
   * @param {string} vaultId - The vault ID to import
   * @param {string} [platformId] - Optional target platform ID
   * @returns {Promise<Object>} Import result
   *
   * @example
   * const result = await vault.importVault("vault-id", "platform-id");
   * const result = await vault.importVault("vault-id"); // link client + enable SDK access without a platform
   */
  async importVault(vaultId, platformId) {
    const normalizedPlatformId =
      typeof platformId === "string" ? platformId.trim() : platformId;

    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        platformId: {
          value: normalizedPlatformId || undefined,
          type: "string",
          required: false,
        },
      },
      "importVault"
    );

    const payload = { vaultId };
    if (normalizedPlatformId) {
      payload.platformId = normalizedPlatformId;
    }

    const response = await this.request(
      "POST",
      "/v1/vault-sdk/import-vault",
      payload,
      { operation: "importVault" }
    );
    return response.data;
  }

  // ─── Media ────────────────────────────────────────────────────

  /**
   * Fetch media associated with a vault ID.
   *
   * @param {string} vaultId - The vault ID
   * @returns {Promise<Object>} Media data
   *
   * @example
   * const media = await vault.getMedia("your-vault-id");
   */
  async getMedia(vaultId) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
      },
      "getMedia"
    );

    const queryString = `?vaultId=${encodeURIComponent(vaultId)}`;
    const response = await this.request(
      "GET",
      `/v1/vault-sdk/get-media${queryString}`,
      undefined,
      { operation: "getMedia" }
    );
    return response.data;
  }

  /**
   * Alias for renameItem() — kept for backward compatibility.
   * @param {string} vaultId
   * @param {string} itemId
   * @param {string} newName
   * @returns {Promise<Object>}
   */
  async renameFile(vaultId, itemId, newName) {
    return this.renameItem(vaultId, itemId, newName);
  }

  // ─── Internal Helpers ─────────────────────────────────────────

  /**
   * Internal: Get a presigned S3 URL for file upload.
   * @private
   */
  async getPresignedUrl({
    vaultId,
    fileName,
    fileType,
    fileSize,
    contentHash,
    folderId,
  }) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        fileName: { value: fileName, type: "string" },
        fileSize: { value: fileSize, type: "number" },
        contentHash: { value: contentHash, type: "string" },
      },
      "getPresignedUrl"
    );

    const response = await this.request(
      "POST",
      "/v1/vault-sdk/get-presigned-url",
      {
        vaultId,
        fileName,
        fileType: fileType || "application/octet-stream",
        fileSize,
        contentHash,
        folderId,
      },
      { operation: "getPresignedUrl" }
    );
    return response.data;
  }

  /**
   * Internal: Register a completed file upload with the backend.
   * @private
   */
  async registerUpload({
    vaultId,
    fileName,
    filebaseKey,
    fileSize,
    contentHash,
    folderId,
  }) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        fileName: { value: fileName, type: "string" },
        filebaseKey: { value: filebaseKey, type: "string" },
        fileSize: { value: fileSize, type: "number" },
        contentHash: { value: contentHash, type: "string" },
      },
      "registerUpload"
    );

    const response = await this.request(
      "POST",
      "/v1/vault-sdk/register-upload",
      {
        vaultId,
        fileName,
        filebaseKey,
        fileSize,
        contentHash,
        folderId,
      },
      { operation: "registerUpload" }
    );
    return response.data;
  }
}

export default Vault;
