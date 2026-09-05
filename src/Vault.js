import crypto from "crypto";
import axios from "axios";
import WebSocket from "ws";
import EventEmitter from "events";
import { validator, VaultError, HTTP_ERROR_MAP } from "./utils/validationError.js";
import { sanitizeFileName } from "./utils/sanitizeFileName.js";
import {
  MAX_FILE_SIZE,
  baseName,
  contentTypeFor,
  formatFileSize,
  resolveFile,
} from "./utils/file.js";

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
    this.botChatWs = null;

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

  /**
   * Internal: For bulk-style SDK operations, surface a real SDK error when the
   * server processed the request but every requested item failed.
   *
   * @private
   */
  assertNotAllItemsFailed(responseData, operation, itemLabel) {
    const bulkData = responseData?.data;
    const results = Array.isArray(bulkData?.results) ? bulkData.results : null;
    const successCount = Number(bulkData?.successCount ?? 0);
    const failureCount = Number(bulkData?.failureCount ?? 0);

    if (!results || results.length === 0) {
      return;
    }

    if (successCount > 0 || failureCount !== results.length) {
      return;
    }

    const message =
      responseData?.message ||
      `All requested ${itemLabel} failed to be added to the bot`;

    throw new VaultError(`[Vault SDK] ${operation}: ${message}`, {
      code: "BAD_REQUEST",
      operation,
      data: responseData,
    });
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

  /**
   * Internal: Resolve the payload body from the standard API response wrapper.
   * @private
   */
  getResponseData(responseData) {
    if (responseData && typeof responseData === "object" && "data" in responseData) {
      return responseData.data;
    }
    return responseData;
  }

  /**
   * Internal: Normalize a user-provided base URL into an absolute URL object.
   * Accepts http(s), ws(s), protocol-relative, root-relative, and bare host forms.
   * @private
   */
  normalizeAbsoluteUrl(rawUrl, fallbackProtocol = "http:") {
    const value = typeof rawUrl === "string" ? rawUrl.trim() : "";
    if (!value) {
      throw new VaultError(
        "[Vault SDK] Invalid URL configuration. Expected an absolute base URL.",
        { code: "INVALID_PARAMETER", operation: "normalizeAbsoluteUrl" }
      );
    }

    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value)) {
      return new URL(value);
    }

    if (value.startsWith("//")) {
      return new URL(`${fallbackProtocol}${value}`);
    }

    if (value.startsWith("/")) {
      if (typeof window !== "undefined" && window.location?.origin) {
        return new URL(value, window.location.origin);
      }

      throw new VaultError(
        `[Vault SDK] Cannot resolve relative URL "${value}" without a browser origin.`,
        { code: "INVALID_PARAMETER", operation: "normalizeAbsoluteUrl" }
      );
    }

    return new URL(`${fallbackProtocol}//${value}`);
  }

  /**
   * Internal: Build the bot chat WebSocket URL.
   * @private
   */
  getBotChatWebSocketUrl(token, overrideUrl) {
    validator.validate(
      {
        token: { value: token, type: "string" },
      },
      "getBotChatWebSocketUrl"
    );

    const base = overrideUrl || this.wsUrl || this.baseUrl;
    if (!base) {
      throw new VaultError(
        "[Vault SDK] 'connectToBotChat': VAULT_BASE_URL or VAULT_WS_URL is required to build the bot chat WebSocket URL.",
        { code: "MISSING_CONFIG", operation: "connectToBotChat" }
      );
    }

    const normalizedBase = this.normalizeAbsoluteUrl(
      base,
      typeof base === "string" && base.trim().startsWith("ws") ? "ws:" : "http:"
    );

    const url = new URL(normalizedBase.toString());
    const path = url.pathname.replace(/\/+$/, "");

    if (path !== "/ws/bot-chat") {
      url.pathname = "/ws/bot-chat";
    }

    if (url.protocol === "https:") {
      url.protocol = "wss:";
    } else if (url.protocol === "http:") {
      url.protocol = "ws:";
    } else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      url.protocol = "ws:";
    }

    url.searchParams.set("token", token);
    return url.toString();
  }

  /**
   * Create a short-lived launch token that can be redeemed into a vault JWT.
   *
   * @param {string} vaultId - The vault ID to create the token for
   * @param {Object} [options] - Optional launch context
   * @returns {Promise<Object>} Standard API response containing launchToken and launchUrl
   */
  async createVaultLaunchToken(vaultId, options = {}) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        options: { value: options, type: "object", required: false },
      },
      "createVaultLaunchToken"
    );

    const payload = { vaultId };
    for (const key of ["returnTo", "clientId", "adminId", "sourceUserId"]) {
      if (typeof options[key] === "string" && options[key].trim()) {
        payload[key] = options[key].trim();
      }
    }

    const response = await this.request(
      "POST",
      "/v1/vault-sdk/launch-token",
      payload,
      { operation: "createVaultLaunchToken" }
    );
    return response.data;
  }

  /**
   * Redeem a launch token into a normal vault access token.
   *
   * @param {string} launchToken - One-time launch token from createVaultLaunchToken()
   * @returns {Promise<Object>} Standard API response containing user.accessToken
   */
  async redeemVaultLaunchToken(launchToken) {
    validator.validate(
      {
        launchToken: { value: launchToken, type: "string" },
      },
      "redeemVaultLaunchToken"
    );

    const response = await this.request(
      "POST",
      "/v1/auth/launch/redeem",
      { token: launchToken.trim() },
      { operation: "redeemVaultLaunchToken" }
    );
    return response.data;
  }

  /**
   * Create and redeem a launch token into the JWT required by the bot chat socket.
   *
   * @param {string} vaultId - The vault ID to authenticate for chat
   * @param {Object} [options] - Optional launch context
   * @returns {Promise<string>} Vault access token for bot chat
   */
  async createBotChatAccessToken(vaultId, options = {}) {
    const launchResponse = await this.createVaultLaunchToken(vaultId, options);
    const launchData = this.getResponseData(launchResponse);
    const launchToken = launchData?.launchToken;

    if (!launchToken) {
      throw new VaultError(
        "[Vault SDK] 'createBotChatAccessToken': Launch token was not returned by the server.",
        { code: "BAD_RESPONSE", operation: "createBotChatAccessToken", data: launchResponse }
      );
    }

    const redeemResponse = await this.redeemVaultLaunchToken(launchToken);
    const redeemData = this.getResponseData(redeemResponse);
    const accessToken = redeemData?.user?.accessToken;

    if (!accessToken) {
      throw new VaultError(
        "[Vault SDK] 'createBotChatAccessToken': Access token was not returned by the server.",
        { code: "BAD_RESPONSE", operation: "createBotChatAccessToken", data: redeemResponse }
      );
    }

    return accessToken;
  }

  /**
   * Open a WebSocket connection to the live bot chat service.
   *
   * If `token` is omitted, the SDK will mint one from the vault SDK auth flow.
   * Pass `botId` to automatically join a bot chat once the socket opens.
   *
   * @param {string} vaultId - The vault ID to authenticate for chat
   * @param {Object} [options]
   * @param {string} [options.token] - Existing vault access token
   * @param {string} [options.launchToken] - Existing launch token to redeem
   * @param {string} [options.botId] - Bot ID to auto-join after connect
   * @param {string} [options.sessionId] - Existing chat session ID to resume
   * @param {string} [options.wsUrl] - Optional explicit WebSocket base URL
   * @returns {Promise<Object>} Connection metadata
   */
  async connectToBotChat(vaultId, options = {}) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        options: { value: options, type: "object", required: false },
      },
      "connectToBotChat"
    );

    const {
      token,
      launchToken,
      botId,
      sessionId,
      wsUrl,
      ...launchOptions
    } = options;

    let accessToken = typeof token === "string" && token.trim() ? token.trim() : null;

    if (!accessToken && typeof launchToken === "string" && launchToken.trim()) {
      const redeemResponse = await this.redeemVaultLaunchToken(launchToken.trim());
      const redeemData = this.getResponseData(redeemResponse);
      accessToken = redeemData?.user?.accessToken || null;
    }

    if (!accessToken) {
      accessToken = await this.createBotChatAccessToken(vaultId, launchOptions);
    }

    if (this.botChatWs && this.botChatWs.readyState < WebSocket.CLOSING) {
      this.botChatWs.close();
    }

    const socketUrl = this.getBotChatWebSocketUrl(accessToken, wsUrl);

    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(socketUrl);
      this.botChatWs = socket;

      socket.onopen = () => {
        this.emit("bot_chat_open");

        if (botId) {
          this.joinBotChat(botId, sessionId);
        }

        settled = true;
        resolve({
          token: accessToken,
          url: socketUrl,
          botId: botId || null,
          sessionId: sessionId || null,
        });
      };

      socket.onmessage = this.botChatOnMessage.bind(this);

      socket.onclose = (event) => {
        if (this.botChatWs === socket) {
          this.botChatWs = null;
        }

        this.emit("bot_chat_close", event);

        if (!settled) {
          reject(
            new VaultError(
              "[Vault SDK] 'connectToBotChat': Bot chat socket closed before the connection was established.",
              { code: "WEBSOCKET_CLOSED", operation: "connectToBotChat" }
            )
          );
        }
      };

      socket.onerror = (error) => {
        const wrapped = new VaultError(
          `[Vault SDK] 'connectToBotChat': WebSocket connection failed — ${error.message || "Unknown error"}`,
          { code: "WEBSOCKET_ERROR", operation: "connectToBotChat" }
        );

        this.emit("bot_chat_stream_error", wrapped);

        if (!settled) {
          settled = true;
          reject(wrapped);
        }
      };
    });
  }

  /**
   * Internal: Parse and emit bot chat messages.
   * @private
   */
  botChatOnMessage(event) {
    try {
      const response = JSON.parse(event.data);
      this.emit("bot_chat_message", response);

      if (response?.type) {
        this.emit(`bot_chat_${response.type}`, response.payload);
      }

      return response;
    } catch (error) {
      this.emit(
        "bot_chat_stream_error",
        new VaultError(
          `[Vault SDK] Failed to parse bot chat WebSocket message: ${error.message}`,
          { code: "BAD_RESPONSE", operation: "botChatOnMessage" }
        )
      );
    }
  }

  /**
   * Internal: Send an event through the bot chat socket.
   * @private
   */
  sendBotChatEvent(type, payload = {}) {
    if (!this.botChatWs || this.botChatWs.readyState !== WebSocket.OPEN) {
      throw new VaultError(
        `[Vault SDK] '${type}': Bot chat socket is not connected.`,
        { code: "WEBSOCKET_NOT_CONNECTED", operation: type }
      );
    }

    this.botChatWs.send(JSON.stringify({ type, payload }));
  }

  /**
   * Join a bot's live chat stream.
   *
   * @param {string} botId - Target bot ID
   * @param {string} [sessionId] - Optional existing session to resume
   */
  joinBotChat(botId, sessionId = null) {
    validator.validate(
      {
        botId: { value: botId, type: "string" },
        sessionId: { value: sessionId, type: "string", required: false },
      },
      "joinBotChat"
    );

    const payload = { botId: botId.trim() };
    if (typeof sessionId === "string" && sessionId.trim()) {
      payload.sessionId = sessionId.trim();
    }

    this.sendBotChatEvent("join_chat", payload);
  }

  /**
   * Send a chat message to the currently joined bot.
   *
   * @param {string} message - User message content
   * @param {Array<{role: string, content: string}>} [history] - Optional recent message history
   */
  sendBotChatMessage(message, history = []) {
    validator.validate(
      {
        message: { value: message, type: "string" },
      },
      "sendBotChatMessage"
    );

    if (!Array.isArray(history)) {
      throw new VaultError(
        "[Vault SDK] 'sendBotChatMessage': history must be an array when provided.",
        { code: "INVALID_PARAMETER", operation: "sendBotChatMessage" }
      );
    }

    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      throw new VaultError(
        "[Vault SDK] 'sendBotChatMessage': Message cannot be empty.",
        { code: "INVALID_PARAMETER", operation: "sendBotChatMessage" }
      );
    }

    const normalizedHistory = Array.isArray(history)
      ? history
          .filter(
            (entry) =>
              entry &&
              (entry.role === "user" || entry.role === "assistant") &&
              typeof entry.content === "string" &&
              entry.content.trim()
          )
          .map((entry) => ({
            role: entry.role,
            content: entry.content.trim(),
          }))
      : [];

    this.sendBotChatEvent("send_message", {
      message: trimmedMessage,
      history: normalizedHistory,
    });
  }

  /**
   * Broadcast a typing indicator to the user's other active chat tabs.
   */
  sendBotChatTyping() {
    this.sendBotChatEvent("typing", { isTyping: true });
  }

  /**
   * Close the bot chat socket if it is open.
   *
   * @param {number} [code=1000] - WebSocket close code
   * @param {string} [reason="Bot chat closed by client"] - Close reason
   */
  disconnectBotChat(code = 1000, reason = "Bot chat closed by client") {
    if (!this.botChatWs) {
      return;
    }

    this.botChatWs.close(code, reason);
    this.botChatWs = null;
  }

  // ─── File Upload ──────────────────────────────────────────────

  /**
   * Upload a file to the vault.
   *
   * @param {string|Object|Blob} file - A path on disk, a File/Blob, or an
   *   object with the content — { buffer, name } / { path } / { data, name }.
   *   `type` (or `mimeType`/`contentType`) is optional; it is derived from the
   *   file extension when omitted.
   * @param {string} vaultId - The vault ID to upload to
   * @param {string} [parentId] - Parent folder ID (omit or null for root)
   * @returns {Promise<Object>} Registration response with the stored file details
   *
   * @throws {VaultError} If the file is unreadable, invalid, or the upload fails at any step
   * @throws {ValidationError} If required parameters are missing/invalid
   */
  async uploadFile(file, vaultId, parentId = null) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
      },
      "uploadFile"
    );

    // Read the file and derive everything the upload needs from it.
    const { buffer, name, type } = await resolveFile(file, "uploadFile");
    const fileSize = buffer.length;

    if (fileSize === 0) {
      throw new VaultError(
        `[Vault SDK] 'uploadFile': "${name}" is empty. Cannot upload a zero-byte file.`,
        { code: "INVALID_PARAMETER", operation: "uploadFile" }
      );
    }

    if (fileSize > MAX_FILE_SIZE) {
      throw new VaultError(
        `[Vault SDK] 'uploadFile': "${name}" is ${formatFileSize(fileSize)}, ` +
          `which exceeds the maximum upload size of ${formatFileSize(MAX_FILE_SIZE)}.`,
        { code: "FILE_TOO_LARGE", operation: "uploadFile" }
      );
    }

    const fileName = sanitizeFileName(name);
    const fileType = type || contentTypeFor(fileName);
    const contentHash = crypto
      .createHash("sha256")
      .update(buffer)
      .digest("hex");

    // Step 1: Get the presigned storage URL
    let presign;
    try {
      const response = await this.request(
        "POST",
        "/v1/vault-sdk/get-presigned-url",
        {
          vaultId,
          fileName,
          fileType,
          fileSize,
          contentHash,
          folderId: parentId,
        },
        { operation: "uploadFile" }
      );
      presign = response.data?.data ?? response.data;
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError(
        `[Vault SDK] 'uploadFile': Failed to get an upload URL for "${fileName}" — ${error.message}`,
        { code: "PRESIGN_FAILED", operation: "uploadFile" }
      );
    }

    const { url, key, contentType, sanitizedName, userId, metadata } =
      presign || {};

    if (!url || !key) {
      throw new VaultError(
        `[Vault SDK] 'uploadFile': The server did not return an upload URL for "${fileName}".`,
        { code: "PRESIGN_FAILED", operation: "uploadFile", data: presign }
      );
    }

    // Step 2: Upload the bytes to storage.
    const metaHeaders = metadata
      ? Object.fromEntries(
          Object.entries(metadata).map(([metaKey, value]) => [
            `x-amz-meta-${metaKey}`,
            String(value),
          ])
        )
      : {
          "x-amz-meta-original-filename": sanitizedName || fileName,
          "x-amz-meta-content-hash": contentHash,
          "x-amz-meta-user-id": String(userId ?? ""),
          "x-amz-meta-folder-id": parentId || "root",
          "x-amz-meta-file-size": fileSize.toString(),
        };

    try {
      await axios.put(url, buffer, {
        headers: {
          "Content-Type": contentType || fileType,
          ...metaHeaders,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
    } catch (error) {
      const status = error.response?.status;
      let detail = error.message;
      if (status === 403)
        detail =
          "The presigned URL has expired or required signing headers are missing. Please try uploading again.";
      if (status === 413)
        detail = `File "${fileName}" exceeds the maximum allowed upload size.`;

      throw new VaultError(
        `[Vault SDK] 'uploadFile': Failed to upload "${fileName}" to storage — ${detail}`,
        {
          status,
          code: "STORAGE_UPLOAD_FAILED",
          operation: "uploadFile",
        }
      );
    }

    // Step 3: Register the upload 
    try {
      const response = await this.request(
        "POST",
        "/v1/vault-sdk/register-upload",
        {
          vaultId,
          fileName: sanitizedName || fileName,
          filebaseKey: key,
          fileSize,
          contentHash,
          folderId: parentId,
        },
        { operation: "uploadFile" }
      );
      return response.data;
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError(
        `[Vault SDK] 'uploadFile': File "${fileName}" was uploaded to storage but failed to register. ` +
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
   * @param {Array<string|Object|Blob>} files - Array of files, in any form uploadFile() accepts
   * @param {string} vaultId - The vault ID to upload to
   * @param {string} [parentId] - Parent folder ID (omit or null for root)
   * @returns {Promise<Array<Object>>} Array of results, each with status "success" or "failed"
   *
   * @example
   * const results = await vault.uploadFiles(
   *   ["./file1.pdf", { buffer: buf2, name: "file2.jpg" }],
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
      const label =
        baseName(
          typeof file === "string" ? file : file?.name || file?.path || ""
        ) || `file[${index}]`;

      try {
        const result = await this.uploadFile(file, vaultId, parentId);
        return { ...result, status: "success", fileName: label };
      } catch (error) {
        return {
          status: "failed",
          fileName: label,
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

  /**
   * Get the wallet summary for the authenticated vault user.
   *
   * @param {string} vaultId - The vault ID
   * @returns {Promise<Object>} Wallet summary including points and status
   *
   * @example
   * const wallet = await vault.getWalletInfo("your-vault-id");
   */
  async getWalletInfo(vaultId) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
      },
      "getWalletInfo"
    );

    const queryString = `?vaultId=${encodeURIComponent(vaultId)}`;
    const response = await this.request(
      "GET",
      `/v1/vault-sdk/wallet/info${queryString}`,
      undefined,
      { operation: "getWalletInfo" }
    );
    return response.data;
  }

  /**
   * Get paginated wallet transaction history for the authenticated vault user.
   *
   * @param {string} vaultId - The vault ID
   * @param {Object} [query]
   * @param {number} [query.page] - Page number (defaults to 1)
   * @param {number} [query.limit] - Page size (defaults to 20)
   * @param {string} [query.category] - Optional transaction category filter
   * @returns {Promise<Object>} Transaction history and pagination metadata
   *
   * @example
   * const history = await vault.getTransactionHistory("your-vault-id");
   * const filtered = await vault.getTransactionHistory("your-vault-id", {
   *   page: 2,
   *   limit: 10,
   *   category: "credit",
   * });
   */
  async getTransactionHistory(vaultId, query = {}) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        query: { value: query, type: "object", required: false },
      },
      "getTransactionHistory"
    );

    const params = new URLSearchParams({ vaultId });

    if (query.page !== undefined) {
      params.set("page", String(query.page));
    }
    if (query.limit !== undefined) {
      params.set("limit", String(query.limit));
    }
    if (typeof query.category === "string" && query.category.trim()) {
      params.set("category", query.category.trim());
    }

    const response = await this.request(
      "GET",
      `/v1/vault-sdk/wallet/transactions?${params.toString()}`,
      undefined,
      { operation: "getTransactionHistory" }
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

  /**
   * Create a bot for the given vault.
   *
   * @param {string} vaultId - The vault ID that owns the bot
   * @param {Object} bot
   * @param {string} bot.name - Bot display name
   * @param {string} [bot.description] - Optional bot personality/description
   * @param {string} [bot.profession] - Optional profession label
   * @returns {Promise<Object>} Created bot details, including its dedicated folder
   *
   * @example
   * const bot = await vault.createBot("your-vault-id", {
   *   name: "Support Bot",
   *   description: "Answers customer questions clearly",
   *   profession: "Customer Support",
   * });
   */
  async createBot(vaultId, bot) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        bot: { value: bot, type: "object" },
        name: {
          value: bot?.name,
          type: "string",
          message:
            "[Vault SDK] 'createBot' requires bot.name to be a non-empty string.",
        },
        description: {
          value: bot?.description,
          type: "string",
          required: false,
        },
        profession: {
          value: bot?.profession,
          type: "string",
          required: false,
        },
      },
      "createBot"
    );

    const payload = {
      vaultId,
      name: bot.name.trim(),
    };

    if (typeof bot.description === "string" && bot.description.trim()) {
      payload.description = bot.description.trim();
    }

    if (typeof bot.profession === "string" && bot.profession.trim()) {
      payload.profession = bot.profession.trim();
    }

    const response = await this.request(
      "POST",
      "/v1/vault-sdk/bots",
      payload,
      { operation: "createBot" }
    );
    return response.data;
  }

  /**
   * Update a bot through the Vault SDK.
   *
   * Any supported field may be omitted for a partial update.
   *
   * @param {string} vaultId - The vault ID that owns the bot
   * @param {string} botId - The bot ID to update
   * @param {Object} updates
   * @returns {Promise<Object>} Updated bot response
   */
  async updateBot(vaultId, botId, updates) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        botId: { value: botId, type: "string" },
        updates: { value: updates, type: "object" },
        name: { value: updates?.name, type: "string", required: false },
        description: { value: updates?.description, type: "string", required: false },
        profession: { value: updates?.profession, type: "string", required: false },
        useLLMFallback: { value: updates?.useLLMFallback, type: "boolean", required: false },
        wordLimit: { value: updates?.wordLimit, type: "number", required: false },
      },
      "updateBot"
    );

    const payload = { vaultId };

    if (updates?.name !== undefined) payload.name = updates.name.trim();
    if (updates?.description !== undefined) payload.description = updates.description;
    if (updates?.profession !== undefined) payload.profession = updates.profession;
    if (updates?.useLLMFallback !== undefined) {
      payload.useLLMFallback = updates.useLLMFallback;
    }
    if (updates?.wordLimit !== undefined) payload.wordLimit = updates.wordLimit;

    const response = await this.request(
      "PATCH",
      `/v1/vault-sdk/bots/${encodeURIComponent(botId)}`,
      payload,
      { operation: "updateBot" }
    );
    return response.data;
  }

  /**
   * Delete a bot owned by the authenticated vault user.
   *
   * This mirrors the Twin Vault backend `DELETE /bots/:botId` behavior.
   *
   * @param {string} botId - The bot ID to delete
   * @param {string} vaultId - The vault ID that owns the bot
   * @returns {Promise<Object>} Standard API response from the backend
   *
   * @example
   * await vault.deleteBot("bot-id", "your-vault-id");
   */
  async deleteBot(botId, vaultId) {
    validator.validate(
      {
        botId: { value: botId, type: "string" },
        vaultId: { value: vaultId, type: "string" },
      },
      "deleteBot"
    );

    const response = await this.request(
      "DELETE",
      `/v1/vault-sdk/bots/${encodeURIComponent(botId)}?vaultId=${encodeURIComponent(vaultId)}`,
      undefined,
      { operation: "deleteBot" }
    );

    return response.data;
  }

  /**
   * Get the extracted text content for a bot file.
   *
   * This mirrors the Twin Vault backend `GET /bots/:botId/files/:fileId/text`
   * behavior through the Vault SDK route chain.
   *
   * @param {string} vaultId - The vault ID that owns the bot
   * @param {string} botId - The bot ID
   * @param {string} fileId - The bot file ID
   * @returns {Promise<string>} Extracted text content for the file
   *
   * @example
   * const text = await vault.getBotFileText("your-vault-id", "bot-id", "file-id");
   */
  async getBotFileText(vaultId, botId, fileId) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        botId: { value: botId, type: "string" },
        fileId: { value: fileId, type: "string" },
      },
      "getBotFileText"
    );

    const response = await this.request(
      "GET",
      `/v1/vault-sdk/bots/${encodeURIComponent(botId)}/files/${encodeURIComponent(fileId)}/text?vaultId=${encodeURIComponent(vaultId)}`,
      undefined,
      { operation: "getBotFileText" }
    );

    return response.data;
  }

  /**
   * Internal helper for bot file actions that share the same route shape.
   *
   * @private
   */
  async updateBotFileAction(vaultId, botId, fileId, action) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        botId: { value: botId, type: "string" },
        fileId: { value: fileId, type: "string" },
        action: { value: action, type: "string" },
      },
      "updateBotFileAction"
    );

    if (action !== "cancel" && action !== "retry") {
      throw new VaultError(
        `[Vault SDK] 'updateBotFileAction': Unsupported action "${action}".`,
        { code: "INVALID_PARAMETER", operation: "updateBotFileAction" }
      );
    }

    const response = await this.request(
      "POST",
      `/v1/vault-sdk/bots/${encodeURIComponent(botId)}/files/${encodeURIComponent(fileId)}/${action}?vaultId=${encodeURIComponent(vaultId)}`,
      undefined,
      { operation: action === "cancel" ? "cancelBotFile" : "retryBotFile" }
    );

    return response.data;
  }

  /**
   * Cancel a processing bot file.
   *
   * @param {string} vaultId - The vault ID that owns the bot
   * @param {string} botId - The bot ID
   * @param {string} fileId - The bot file ID
   * @returns {Promise<Object>} Standard API response from the backend
   */
  async cancelBotFile(vaultId, botId, fileId) {
    return this.updateBotFileAction(vaultId, botId, fileId, "cancel");
  }

  /**
   * Retry a failed bot file.
   *
   * @param {string} vaultId - The vault ID that owns the bot
   * @param {string} botId - The bot ID
   * @param {string} fileId - The bot file ID
   * @returns {Promise<Object>} Standard API response from the backend
   */
  async retryBotFile(vaultId, botId, fileId) {
    return this.updateBotFileAction(vaultId, botId, fileId, "retry");
  }

  /**
   * Quote the Twin Points cost of transcribing media before uploading or linking it.
   *
   * Pass direct file metadata in `payload.files`, folder IDs in `payload.folderIds`,
   * or both. Each file accepts `{ name, size, fileId?, durationSeconds? }`.
   *
   * @param {string} vaultId - The vault ID that owns the bot
   * @param {string} botId - The target bot ID
   * @param {Object} [payload]
   * @param {Array<Object>} [payload.files] - Files to quote
   * @param {string[]} [payload.folderIds] - Existing storage folders to inspect
   * @returns {Promise<Object>} Quote response from the bot endpoint
   */
  async quoteTranscription(vaultId, botId, payload = {}) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        botId: { value: botId, type: "string" },
        payload: { value: payload, type: "object", required: false },
      },
      "quoteTranscription"
    );

    const files = Array.isArray(payload.files)
      ? payload.files
          .filter((file) => file && typeof file === "object")
          .map((file) => ({
            name: typeof file.name === "string" ? file.name.trim() : "",
            size: Number(file.size || 0),
            ...(typeof file.fileId === "string" && file.fileId.trim()
              ? { fileId: file.fileId.trim() }
              : {}),
            ...(Number.isFinite(Number(file.durationSeconds))
              ? { durationSeconds: Number(file.durationSeconds) }
              : {}),
          }))
          .filter((file) => file.name)
      : [];

    const folderIds = Array.isArray(payload.folderIds)
      ? [...new Set(payload.folderIds.map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean))]
      : [];

    if (!files.length && !folderIds.length) {
      throw new VaultError(
        "[Vault SDK] 'quoteTranscription': At least one file or folder ID is required.",
        { code: "INVALID_PARAMETER", operation: "quoteTranscription" }
      );
    }

    const response = await this.request(
      "POST",
      `/v1/vault-sdk/bots/${encodeURIComponent(botId)}/files/quote`,
      {
        vaultId,
        files,
        folderIds,
      },
      { operation: "quoteTranscription" }
    );

    return response.data;
  }

  /**
   * Internal helper for bot uploads that now use the same presign -> upload
   * -> register flow as regular drive uploads.
   *
   * @private
   */
  async uploadSingleFileToBot(file, vaultId, botId) {
    const resolved = await resolveFile(file, "uploadFilesToBot");
    const fileSize = resolved.buffer.length;

    if (fileSize > MAX_FILE_SIZE) {
      throw new VaultError(
        `[Vault SDK] 'uploadFilesToBot': "${resolved.name}" is ${formatFileSize(fileSize)}, ` +
          `which exceeds the maximum upload size of ${formatFileSize(MAX_FILE_SIZE)}.`,
        { code: "FILE_TOO_LARGE", operation: "uploadFilesToBot" }
      );
    }

    const fileName = sanitizeFileName(resolved.name);
    const fileType = resolved.type || contentTypeFor(fileName);
    const contentHash = crypto
      .createHash("sha256")
      .update(resolved.buffer)
      .digest("hex");

    let presign;
    try {
      const response = await this.request(
        "POST",
        `/v1/vault-sdk/bots/${encodeURIComponent(botId)}/files/presign`,
        {
          vaultId,
          fileName,
          fileType,
          fileSize,
          contentHash,
        },
        { operation: "uploadFilesToBot" }
      );
      presign = response.data?.data ?? response.data;
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError(
        `[Vault SDK] 'uploadFilesToBot': Failed to get an upload URL for "${fileName}" — ${error.message}`,
        { code: "PRESIGN_FAILED", operation: "uploadFilesToBot" }
      );
    }

    const { url, key, contentType, sanitizedName, userId, metadata } = presign || {};

    if (!url || !key) {
      throw new VaultError(
        `[Vault SDK] 'uploadFilesToBot': The server did not return an upload URL for "${fileName}".`,
        { code: "PRESIGN_FAILED", operation: "uploadFilesToBot", data: presign }
      );
    }

    const metaHeaders = metadata
      ? Object.fromEntries(
          Object.entries(metadata).map(([metaKey, value]) => [
            `x-amz-meta-${metaKey}`,
            String(value),
          ])
        )
      : {
          "x-amz-meta-original-filename": sanitizedName || fileName,
          "x-amz-meta-content-hash": contentHash,
          "x-amz-meta-user-id": String(userId ?? ""),
          "x-amz-meta-file-size": fileSize.toString(),
        };

    try {
      await axios.put(url, resolved.buffer, {
        headers: {
          "Content-Type": contentType || fileType,
          ...metaHeaders,
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
    } catch (error) {
      const status = error.response?.status;
      let detail = error.message;
      if (status === 403) {
        detail =
          "The presigned URL has expired or required signing headers are missing. Please try uploading again.";
      }
      if (status === 413) {
        detail = `File "${fileName}" exceeds the maximum allowed upload size.`;
      }

      throw new VaultError(
        `[Vault SDK] 'uploadFilesToBot': Failed to upload "${fileName}" to storage — ${detail}`,
        {
          status,
          code: "STORAGE_UPLOAD_FAILED",
          operation: "uploadFilesToBot",
        }
      );
    }

    const rawDurationSeconds =
      typeof file === "object" && file !== null ? file.durationSeconds : undefined;
    const durationSeconds = Number(rawDurationSeconds);

    try {
      const response = await this.request(
        "POST",
        `/v1/vault-sdk/bots/${encodeURIComponent(botId)}/files/register`,
        {
          vaultId,
          fileName: sanitizedName || fileName,
          filebaseKey: key,
          fileSize,
          contentHash,
          ...(Number.isFinite(durationSeconds) && durationSeconds >= 0
            ? { durationSeconds }
            : {}),
        },
        { operation: "uploadFilesToBot" }
      );
      return response.data;
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError(
        `[Vault SDK] 'uploadFilesToBot': File "${fileName}" was uploaded to storage but failed to register. ` +
          `Please contact support if this persists — ${error.message}`,
        { code: "REGISTER_FAILED", operation: "uploadFilesToBot" }
      );
    }
  }

  /**
   * Delete one or more bot chat sessions through the bulk-delete route.
   *
   * A single session ID is accepted and normalized into a one-item array.
   *
   * @param {string} vaultId - The vault ID that owns the bot
   * @param {string} botId - The bot ID
   * @param {string|string[]} sessionIds - One session ID or multiple session IDs
   * @returns {Promise<Object>} Standard API response from the backend
   *
   * @example
   * await vault.deleteBotSessions("your-vault-id", "bot-id", "session-id");
   * await vault.deleteBotSessions("your-vault-id", "bot-id", ["session-a", "session-b"]);
   */
  async deleteBotSessions(vaultId, botId, sessionIds) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        botId: { value: botId, type: "string" },
      },
      "deleteBotSessions"
    );

    const normalizedSessionIds = Array.isArray(sessionIds)
      ? [...new Set(sessionIds.map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean))]
      : typeof sessionIds === "string" && sessionIds.trim()
        ? [sessionIds.trim()]
        : [];

    if (!normalizedSessionIds.length) {
      throw new VaultError(
        "[Vault SDK] 'deleteBotSessions': At least one session ID is required.",
        { code: "INVALID_PARAMETER", operation: "deleteBotSessions" }
      );
    }

    const response = await this.request(
      "POST",
      `/v1/vault-sdk/bots/${encodeURIComponent(botId)}/sessions/bulk-delete`,
      {
        vaultId,
        sessionIds: normalizedSessionIds,
      },
      { operation: "deleteBotSessions" }
    );

    return response.data;
  }

  /**
   * Export one or more bot chat sessions through the bulk-export route.
   *
   * A single session ID is accepted and normalized into a one-item array.
   *
   * @param {string} vaultId - The vault ID that owns the bot
   * @param {string} botId - The bot ID
   * @param {string|string[]} sessionIds - One session ID or multiple session IDs
   * @param {"drive"|"brain"} saveOption - Where to export the session data
   * @param {string} [targetBotId] - Optional target bot ID when exporting to brain
   * @returns {Promise<Object>} Standard API response from the backend
   *
   * @example
   * await vault.exportBotSessions("your-vault-id", "bot-id", "session-id", "drive");
   * await vault.exportBotSessions("your-vault-id", "bot-id", ["session-a", "session-b"], "brain", "target-bot-id");
   */
  async exportBotSessions(vaultId, botId, sessionIds, saveOption, targetBotId) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        botId: { value: botId, type: "string" },
        saveOption: { value: saveOption, type: "string" },
        targetBotId: { value: targetBotId, type: "string", required: false },
      },
      "exportBotSessions"
    );

    const normalizedSessionIds = Array.isArray(sessionIds)
      ? [...new Set(sessionIds.map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean))]
      : typeof sessionIds === "string" && sessionIds.trim()
        ? [sessionIds.trim()]
        : [];

    if (!normalizedSessionIds.length) {
      throw new VaultError(
        "[Vault SDK] 'exportBotSessions': At least one session ID is required.",
        { code: "INVALID_PARAMETER", operation: "exportBotSessions" }
      );
    }

    if (saveOption !== "drive" && saveOption !== "brain") {
      throw new VaultError(
        "[Vault SDK] 'exportBotSessions': saveOption must be either \"drive\" or \"brain\".",
        { code: "INVALID_PARAMETER", operation: "exportBotSessions" }
      );
    }

    const payload = {
      vaultId,
      sessionIds: normalizedSessionIds,
      saveOption,
    };

    if (typeof targetBotId === "string" && targetBotId.trim()) {
      payload.targetBotId = targetBotId.trim();
    }

    const response = await this.request(
      "POST",
      `/v1/vault-sdk/bots/${encodeURIComponent(botId)}/sessions/bulk-export`,
      payload,
      { operation: "exportBotSessions" }
    );

    return response.data;
  }

  /**
   * Remove either a bot file or a linked storage folder from a bot.
   *
   * @param {string} vaultId - The vault ID that owns the bot
   * @param {string} botId - The bot ID
   * @param {"file"|"folder"} assetType - The asset type to remove
   * @param {string} assetId - The file ID or folder ID to remove
   * @param {{ permanent?: boolean, keepTranscript?: boolean }} [options] - Optional file-removal flags
   * @returns {Promise<Object>} Standard API response from the backend
   *
   * @example
   * await vault.removeBotAsset("your-vault-id", "bot-id", "file", "file-id", {
   *   permanent: true,
   *   keepTranscript: false,
   * });
   * await vault.removeBotAsset("your-vault-id", "bot-id", "folder", "folder-id");
   */
  async removeBotAsset(vaultId, botId, assetType, assetId, options = {}) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        botId: { value: botId, type: "string" },
        assetType: { value: assetType, type: "string" },
        assetId: { value: assetId, type: "string" },
        options: { value: options, type: "object", required: false },
      },
      "removeBotAsset"
    );

    const normalizedType =
      typeof assetType === "string" ? assetType.trim().toLowerCase() : "";

    if (normalizedType !== "file" && normalizedType !== "folder") {
      throw new VaultError(
        "[Vault SDK] 'removeBotAsset': assetType must be either \"file\" or \"folder\".",
        { code: "INVALID_PARAMETER", operation: "removeBotAsset" }
      );
    }

    const { permanent, keepTranscript } = options || {};
    const params = new URLSearchParams({
      vaultId: vaultId.trim(),
    });

    if (normalizedType === "folder" && (permanent !== undefined || keepTranscript !== undefined)) {
      throw new VaultError(
        "[Vault SDK] 'removeBotAsset': permanent and keepTranscript are supported only for assetType \"file\".",
        { code: "INVALID_PARAMETER", operation: "removeBotAsset" }
      );
    }

    if (permanent !== undefined) {
      if (typeof permanent !== "boolean") {
        throw new VaultError(
          "[Vault SDK] 'removeBotAsset': options.permanent must be a boolean when provided.",
          { code: "INVALID_PARAMETER", operation: "removeBotAsset" }
        );
      }
      params.set("permanent", String(permanent));
    }

    if (keepTranscript !== undefined) {
      if (typeof keepTranscript !== "boolean") {
        throw new VaultError(
          "[Vault SDK] 'removeBotAsset': options.keepTranscript must be a boolean when provided.",
          { code: "INVALID_PARAMETER", operation: "removeBotAsset" }
        );
      }
      params.set("keepTranscript", String(keepTranscript));
    }

    const response = await this.request(
      "DELETE",
      `/v1/vault-sdk/bots/${encodeURIComponent(botId)}/assets/${encodeURIComponent(
        normalizedType
      )}/${encodeURIComponent(assetId)}?${params.toString()}`,
      undefined,
      { operation: "removeBotAsset" }
    );

    return response.data;
  }

  /**
   * Fetch one bot's full details, or all bots with their associated files and folders.
   *
   * When `botId` is omitted, the SDK returns the detailed view for every bot
   * owned by the vault user.
   *
   * @param {string} vaultId - The vault ID that owns the bot(s)
   * @param {string} [botId] - Optional bot ID
   * @returns {Promise<Object|Object[]>} One detailed bot or an array of detailed bots
   *
   * @example
   * const oneBot = await vault.getBotDetails("your-vault-id", "bot-id");
   * const allBots = await vault.getBotDetails("your-vault-id");
   */
  async getBotDetails(vaultId, botId) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        botId: { value: botId, type: "string", required: false },
      },
      "getBotDetails"
    );

    const encodedVaultId = encodeURIComponent(vaultId);
    const endpoint = botId
      ? `/v1/vault-sdk/bots/${encodeURIComponent(botId)}?vaultId=${encodedVaultId}`
      : `/v1/vault-sdk/bots?vaultId=${encodedVaultId}`;

    const response = await this.request("GET", endpoint, undefined, {
      operation: "getBotDetails",
    });
    return response.data;
  }

  /**
   * Fetch all chat sessions for a bot, or all messages for one session.
   *
   * When `sessionId` is omitted, the SDK returns the bot's session list.
   * When `sessionId` is provided, it returns that session's full message history.
   *
   * @param {string} vaultId - The vault ID that owns the bot
   * @param {string} botId - The bot ID
   * @param {string} [sessionId] - Optional session ID
   * @returns {Promise<Object[]|Object>} Session list or session messages response
   *
   * @example
   * const sessions = await vault.getBotSessions("your-vault-id", "bot-id");
   * const messages = await vault.getBotSessions("your-vault-id", "bot-id", "session-id");
   */
  async getBotSessions(vaultId, botId, sessionId) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        botId: { value: botId, type: "string" },
        sessionId: { value: sessionId, type: "string", required: false },
      },
      "getBotSessions"
    );

    const encodedVaultId = encodeURIComponent(vaultId);
    const normalizedBotId = botId.trim();
    const normalizedSessionId =
      typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;

    const endpoint = normalizedSessionId
      ? `/v1/vault-sdk/bots/${encodeURIComponent(normalizedBotId)}/sessions/${encodeURIComponent(
          normalizedSessionId
        )}/messages?vaultId=${encodedVaultId}`
      : `/v1/vault-sdk/bots/${encodeURIComponent(normalizedBotId)}/sessions?vaultId=${encodedVaultId}`;

    const response = await this.request("GET", endpoint, undefined, {
      operation: "getBotSessions",
    });
    return response.data;
  }

  /**
   * Attach an existing storage file to a bot without re-uploading it.
   *
   * The file stays in storage and is linked into the bot's knowledge set.
   *
   * @param {string} vaultId - The vault ID that owns the bot
   * @param {string} botId - The target bot ID
   * @param {string|string[]} fileIds - One file ID or multiple file IDs
   * @returns {Promise<Object>} Bulk link result from the bot endpoint
   *
   * @example
   * await vault.addDriveFilesToBot("your-vault-id", "bot-id", "file-id");
   * await vault.addDriveFilesToBot("your-vault-id", "bot-id", ["file-a", "file-b"]);
   */
  async addDriveFilesToBot(vaultId, botId, fileIds) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        botId: { value: botId, type: "string" },
      },
      "addDriveFilesToBot"
    );

    const normalizedFileIds = Array.isArray(fileIds)
      ? [...new Set(fileIds.map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean))]
      : typeof fileIds === "string" && fileIds.trim()
        ? [fileIds.trim()]
        : [];

    if (!normalizedFileIds.length) {
      throw new VaultError(
        "[Vault SDK] 'addDriveFilesToBot': At least one file ID is required.",
        { code: "INVALID_PARAMETER", operation: "addDriveFilesToBot" }
      );
    }

    const response = await this.request(
      "POST",
      `/v1/vault-sdk/bots/${encodeURIComponent(botId)}/add-drive-files`,
      {
        vaultId,
        fileIds: normalizedFileIds,
      },
      { operation: "addDriveFilesToBot" }
    );
    this.assertNotAllItemsFailed(response.data, "addDriveFilesToBot", "files");
    return response.data;
  }

  /**
   * Attach one or more existing storage folders to a bot without moving them.
   *
   * You can pass a single folder ID or an array of folder IDs. The SDK
   * normalizes the input and uses the bulk folder-link route.
   *
   * @param {string} vaultId - The vault ID that owns the bot
   * @param {string} botId - The target bot ID
   * @param {string|string[]} folderIds - One folder ID or multiple folder IDs
   * @returns {Promise<Object>} Bulk link result from the bot endpoint
   *
   * @example
   * await vault.addDriveFoldersToBot("your-vault-id", "bot-id", "folder-id");
   * await vault.addDriveFoldersToBot("your-vault-id", "bot-id", ["folder-a", "folder-b"]);
   */
  async addDriveFoldersToBot(vaultId, botId, folderIds) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        botId: { value: botId, type: "string" },
      },
      "addDriveFoldersToBot"
    );

    const normalizedFolderIds = Array.isArray(folderIds)
      ? [...new Set(folderIds.map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean))]
      : typeof folderIds === "string" && folderIds.trim()
        ? [folderIds.trim()]
        : [];

    if (!normalizedFolderIds.length) {
      throw new VaultError(
        "[Vault SDK] 'addDriveFoldersToBot': At least one folder ID is required.",
        { code: "INVALID_PARAMETER", operation: "addDriveFoldersToBot" }
      );
    }

    const response = await this.request(
      "POST",
      `/v1/vault-sdk/bots/${encodeURIComponent(botId)}/add-drive-folders`,
      {
        vaultId,
        folderIds: normalizedFolderIds,
      },
      { operation: "addDriveFoldersToBot" }
    );
    this.assertNotAllItemsFailed(
      response.data,
      "addDriveFoldersToBot",
      "folders"
    );
    return response.data;
  }

  /**
   * Upload one or more files directly to a bot for ingestion.
   *
   * This stores the files in the bot's dedicated folder and starts bot
   * knowledge processing in the background.
   *
   * @param {string|Object|Blob|Array<string|Object|Blob>} files
   * @param {string} vaultId - The vault ID that owns the bot
   * @param {string} botId - The target bot ID
   * @returns {Promise<Object>} Upload result from the bot ingestion endpoint
   *
   * @example
   * await vault.uploadFilesToBot("./faq.pdf", "your-vault-id", "bot-id");
   * await vault.uploadFilesToBot(
   *   ["./faq.pdf", { buffer: audioBuffer, name: "call.mp3" }],
   *   "your-vault-id",
   *   "bot-id"
   * );
   */
  async uploadFilesToBot(files, vaultId, botId) {
    validator.validate(
      {
        vaultId: { value: vaultId, type: "string" },
        botId: { value: botId, type: "string" },
      },
      "uploadFilesToBot"
    );

    const normalizedFiles = Array.isArray(files) ? files : [files];
    if (!normalizedFiles.length) {
      throw new VaultError(
        "[Vault SDK] 'uploadFilesToBot': At least one file is required.",
        { code: "INVALID_PARAMETER", operation: "uploadFilesToBot" }
      );
    }

    const results = await Promise.all(
      normalizedFiles.map(async (file, index) => {
        const label =
          baseName(
            typeof file === "string" ? file : file?.name || file?.path || ""
          ) || `file[${index}]`;

        try {
          const response = await this.uploadSingleFileToBot(file, vaultId, botId);
          return { status: "success", fileName: label, response };
        } catch (error) {
          return {
            status: "failed",
            fileName: label,
            error: error.message,
            code: error.code || "UPLOAD_FAILED",
          };
        }
      })
    );

    const successful = results.filter((result) => result.status === "success");
    if (!successful.length) {
      throw new VaultError(
        "[Vault SDK] 'uploadFilesToBot': All files failed to upload.",
        { code: "UPLOAD_FAILED", operation: "uploadFilesToBot", data: { results } }
      );
    }

    const filesOut = [];
    const skipped = [];

    for (const result of successful) {
      const payload = result.response?.data || {};
      if (payload.file) filesOut.push(payload.file);
      if (Array.isArray(payload.skipped)) skipped.push(...payload.skipped);
    }

    for (const result of results) {
      if (result.status === "failed") {
        skipped.push({
          name: result.fileName,
          reason: result.error,
          code: result.code,
        });
      }
    }

    const successCount = successful.length;
    const failureCount = results.length - successCount;
    const messageParts = [];
    if (filesOut.length) {
      messageParts.push(
        `${filesOut.length} file${filesOut.length === 1 ? "" : "s"} sent for ingestion`
      );
    }
    if (skipped.length) {
      messageParts.push(`${skipped.length} skipped`);
    }

    return {
      success: true,
      message: messageParts.length
        ? `${messageParts.join(", ")}. Processing happens in the background.`
        : "Nothing to upload.",
      data: {
        files: filesOut,
        skipped,
        results,
        successCount,
        failureCount,
      },
    };
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

}

export default Vault;
