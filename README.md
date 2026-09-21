# Vault SDK

A lightweight Node.js SDK for the Vault service. Upload, organize, and manage files and folders, handle storage plans, and connect via WebSocket for real-time events.

## Install

```bash
npm install vault-sdk-staging
```

## Quick Start

```javascript
import Vault from "vault-sdk-staging";

const vault = new Vault({
  VAULT_ACCESS_KEY: "your-access-key",
  VAULT_SECRET_KEY: "your-secret-key",
  VAULT_CLIENT_API_KEY: "your-client-api-key",
  VAULT_BASE_URL: "https://api.your-service.com",
  VAULT_WS_URL: "wss://api.your-service.com/ws", // optional, for WebSocket
});
```

Only the first four are required. The SDK will throw a clear error listing any missing ones.

`VAULT_BASE_URL` and `VAULT_WS_URL` must be `https://` / `wss://`. An unencrypted URL is refused with `INSECURE_TRANSPORT`, because it would send your keys, signatures and file contents in the clear. Local addresses (`localhost`, `127.0.0.1`) are exempt, and `VAULT_ALLOW_INSECURE: true` lifts the rule for a test server you control.

Your keys are held as non-enumerable properties, so `console.log(vault)` and `JSON.stringify(vault)` print `[redacted]` rather than the secret.

These optional settings control uploads:

| Option | Default | What it does |
| --- | --- | --- |
| `VAULT_ALLOW_INSECURE` | `false` | Allow `http://` / `ws://` to a non-local host |
| `VAULT_UPLOAD_ROOT` | the working directory | Paths passed to `uploadFile()` must resolve inside this directory |
| `VAULT_UPLOAD_HOSTS` | Filebase storage + your API host | Extra hosts the SDK may upload files to |
| `VAULT_TIMEOUT` | `30000` | Timeout in ms for API requests |
| `VAULT_UPLOAD_TIMEOUT` | scaled to the file size | Timeout in ms for one file upload |
| `VAULT_UPLOAD_CONCURRENCY` | `3` | How many files upload at once in the batch methods |

## API Reference

### File Upload

#### `uploadFile(file, vaultId, parentId?)`

Upload a file to the vault. Hand over the file and nothing else — the SDK reads the bytes, sanitizes the name, resolves the MIME type, hashes the content, gets a presigned storage URL, uploads, and registers the file, all in this one call.

```javascript
// Straight from disk — name and type come from the file itself
const result = await vault.uploadFile("./photo.jpg", "your-vault-id");

// Upload into a specific folder
const inFolder = await vault.uploadFile(
  "./report.pdf",
  "your-vault-id",
  "parent-folder-id"
);
```

`file` can be any of:

| Form | Example |
| --- | --- |
| Path on disk | `"./photo.jpg"` (must be inside `VAULT_UPLOAD_ROOT`) |
| Bytes + name | `{ buffer: fileBuffer, name: "report.pdf" }` |
| Path in an object | `{ path: "./photo.jpg" }` |
| `File` / `Blob` | `new File([bytes], "photo.jpg", { type: "image/jpeg" })` |

`type` (or `mimeType` / `contentType`) is optional — it's derived from the file extension when omitted. Names are sanitized to ASCII before upload, so `héllo wörld🤣.PNG` is stored as `hello world.PNG`.

The call throws a `VaultError` if the file can't be read, is empty, exceeds the 10 GB limit, or if any upload step fails — the `code` tells you which step (`FILE_READ_FAILED`, `INVALID_PARAMETER`, `FILE_TOO_LARGE`, `PATH_NOT_ALLOWED`, `PRESIGN_FAILED`, `UPLOAD_URL_REJECTED`, `STORAGE_UPLOAD_FAILED`, `REGISTER_FAILED`).

`PATH_NOT_ALLOWED` means the path resolved outside `VAULT_UPLOAD_ROOT`; `UPLOAD_URL_REJECTED` means the server handed back an upload URL that is not HTTPS or not on an allowed storage host, so nothing was sent.

#### `uploadFiles(files, vaultId, parentId?)`

Upload multiple files, a few at a time (`VAULT_UPLOAD_CONCURRENCY`, 3 by default). Each file is handled independently — one failure won't block the others. Every entry accepts the same forms as `uploadFile()`.

```javascript
const results = await vault.uploadFiles(
  ["./file1.pdf", { buffer: buf2, name: "file2.jpg" }],
  "your-vault-id"
);

// Each result has a status:
// { status: "success", fileName: "file1.pdf", ... }
// { status: "failed", fileName: "file2.jpg", error: "...", code: "..." }
```

Partial failures are reported in the array. If **every** file fails, the call throws a `VaultError` with code `UPLOAD_FAILED` instead, carrying the same per-file results in `error.data.results`.

### File Retrieval

#### `getFiles(vaultId, query?)`

Search for files by name.

```javascript
const files = await vault.getFiles('vault-id', 'search-query');
```

#### `getAllFiles(vaultId)`

Get all files in the vault.

```javascript
const allFiles = await vault.getAllFiles("your-vault-id");
```

### File Management

#### `deleteFile(vaultId, fileId)`

Delete a file.

```javascript
await vault.deleteFile("your-vault-id", "file-id");
```

#### `renameItem(vaultId, itemId, newName)`

Rename a file or folder.

```javascript
await vault.renameItem("your-vault-id", "item-id", "New Name.pdf");
```

### Starred Files

#### `addToStarred(vaultId, fileId, isStarred)`

Star or unstar a file.

```javascript
await vault.addToStarred("your-vault-id", "file-id", true);
```

#### `getStarredFiles(vaultId)`

Get all starred files.

```javascript
const starred = await vault.getStarredFiles("your-vault-id");
```

### Folder Operations

#### `createFolder(vaultId, folderName, parentId?)`

Create a new folder. Omit `parentId` to create in root.

```javascript
await vault.createFolder("your-vault-id", "Documents");
await vault.createFolder("your-vault-id", "Invoices", "parent-folder-id");
```

#### `deleteFolder(vaultId, folderId)`

Delete a folder.

```javascript
await vault.deleteFolder("your-vault-id", "folder-id");
```

### Bot Operations

#### `createBot(vaultId, bot)`

Create a bot for the vault. This uses the Vault SDK auth flow and creates the bot's dedicated folder automatically.

```javascript
const bot = await vault.createBot("your-vault-id", {
  name: "Support Bot",
  description: "Answers customer questions clearly",
  profession: "Customer Support",
});
```

`bot` accepts:

| Field | Required | Description |
| --- | --- | --- |
| `name` | Yes | Bot display name |
| `description` | No | Bot personality / description |
| `profession` | No | Profession label for the bot |

#### `updateBot(vaultId, botId, updates)`

Update a bot through the Vault SDK. You can send any subset of the editable bot fields.

```javascript
const updated = await vault.updateBot("your-vault-id", "bot-id", {
  name: "Support Bot v2",
  description: "Helpful and concise",
  profession: "Customer Support",
  useLLMFallback: true,
  wordLimit: 200,
});
```

#### `getBotDetails(vaultId, botId?)`

Fetch one bot's full details, or all bots with their associated files and folders.

```javascript
const oneBot = await vault.getBotDetails("your-vault-id", "bot-id");
const allBots = await vault.getBotDetails("your-vault-id");
```

#### `addDriveFilesToBot(vaultId, botId, fileIds)`

Attach one or more existing storage files to a bot without re-uploading them. Accepts either a
single file ID string or an array of file IDs.

```javascript
await vault.addDriveFilesToBot("your-vault-id", "bot-id", "file-id");

await vault.addDriveFilesToBot(
  "your-vault-id",
  "bot-id",
  ["file-a", "file-b"]
);
```

#### `addDriveFoldersToBot(vaultId, botId, folderIds)`

Attach one or more existing storage folders to a bot without moving them. Accepts either a
single folder ID string or an array of folder IDs.

```javascript
await vault.addDriveFoldersToBot("your-vault-id", "bot-id", "folder-id");

await vault.addDriveFoldersToBot(
  "your-vault-id",
  "bot-id",
  ["folder-a", "folder-b"]
);
```

#### `uploadFilesToBot(files, vaultId, botId)`

Upload one or more files directly to a bot and start ingestion.

This method now uses the bot upload flow internally: it gets a presigned URL,
uploads each file straight to storage, and then registers it with the bot. The
same method works for both smaller and larger files.

```javascript
await vault.uploadFilesToBot("./faq.pdf", "your-vault-id", "bot-id");

await vault.uploadFilesToBot(
  ["./faq.pdf", { buffer: audioBuffer, name: "call.mp3" }],
  "your-vault-id",
  "bot-id"
);
```

#### `quoteTranscription(vaultId, botId, payload)`

Quote the Twin Points cost of transcribing media before uploading files or linking folders.

```javascript
const quote = await vault.quoteTranscription("your-vault-id", "bot-id", {
  files: [{ name: "call.mp3", size: 1048576 }],
});

const folderQuote = await vault.quoteTranscription("your-vault-id", "bot-id", {
  folderIds: ["folder-a", "folder-b"],
});
```

#### `deleteBot(botId, vaultId)`

Delete a bot using the same backend behavior as Twin Vault's `DELETE /bots/:botId`.

```javascript
const result = await vault.deleteBot("bot-id", "your-vault-id");
```

#### `getBotFileText(vaultId, botId, fileId)`

Fetch the extracted text content for a bot file through the SDK route.

```javascript
const text = await vault.getBotFileText("your-vault-id", "bot-id", "file-id");
```

#### `cancelBotFile(vaultId, botId, fileId)`

Cancel a processing bot file through the SDK route.

```javascript
const result = await vault.cancelBotFile("your-vault-id", "bot-id", "file-id");
```

#### `retryBotFile(vaultId, botId, fileId)`

Retry a failed bot file through the SDK route.

```javascript
const result = await vault.retryBotFile("your-vault-id", "bot-id", "file-id");
```

#### `deleteBotSessions(vaultId, botId, sessionIds)`

Delete one or more bot chat sessions through the bulk-delete route.

```javascript
await vault.deleteBotSessions("your-vault-id", "bot-id", "session-id");
await vault.deleteBotSessions("your-vault-id", "bot-id", ["session-a", "session-b"]);
```

#### `exportBotSessions(vaultId, botId, sessionIds, saveOption, targetBotId?)`

Export one or more bot chat sessions through the bulk-export route.

```javascript
await vault.exportBotSessions("your-vault-id", "bot-id", "session-id", "drive");
await vault.exportBotSessions(
  "your-vault-id",
  "bot-id",
  ["session-a", "session-b"],
  "brain",
  "target-bot-id"
);
```

#### `removeBotAsset(vaultId, botId, assetType, assetId)`

Remove either a bot file or a linked storage folder from a bot.

```javascript
await vault.removeBotAsset("your-vault-id", "bot-id", "file", "file-id", {
  permanent: true,
  keepTranscript: false,
});
await vault.removeBotAsset("your-vault-id", "bot-id", "folder", "folder-id");
```

#### `getBotSessions(vaultId, botId, sessionId?)`

Fetch all chat sessions for a bot, or fetch all messages for one session.

```javascript
const sessions = await vault.getBotSessions("your-vault-id", "bot-id");
const messages = await vault.getBotSessions("your-vault-id", "bot-id", "session-id");
```

#### `createVaultLaunchToken(vaultId, options?)`

Create a short-lived launch token for the vault user linked to your SDK credentials. This is mainly useful when you want to hand the auth off elsewhere.

```javascript
const launch = await vault.createVaultLaunchToken("your-vault-id");
const launchToken = launch.data.launchToken;
```

#### `redeemVaultLaunchToken(launchToken)`

Exchange a launch token for a normal vault access token.

```javascript
const redeemed = await vault.redeemVaultLaunchToken(launchToken);
const accessToken = redeemed.data.user.accessToken;
```

#### `connectToBotChat(vaultId, options?)`

Open the live bot chat WebSocket. If you do not pass `options.token`, the SDK will create and redeem a launch token automatically, then connect the socket for you.

```javascript
await vault.connectToBotChat("your-vault-id", {
  botId: "bot-id",
});

vault.on("bot_chat_chat_history", (payload) => {
  console.log("history", payload.history);
});

let streamed = "";
vault.on("bot_chat_token", ({ token }) => {
  streamed += token;
  process.stdout.write(token);
});

vault.on("bot_chat_message_complete", ({ content, sessionId }) => {
  console.log("\ncomplete", sessionId, content);
});

vault.sendBotChatMessage("Hello bot");
```

Bot chat connects through `/ws/bot-chat`, which is intended to stay separate from
legacy twin chat websocket traffic on `/ws/chat`.

You can also pass an existing token:

```javascript
await vault.connectToBotChat("your-vault-id", {
  token: "vault-jwt",
  botId: "bot-id",
  sessionId: "existing-session-id",
});
```

Available helpers:

| Method | Purpose |
| --- | --- |
| `joinBotChat(botId, sessionId?)` | Join or resume a bot chat |
| `sendBotChatMessage(message)` | Send a message to the joined bot. The server rebuilds the conversation from the stored session, so a `history` argument is accepted but ignored |
| `sendBotChatTyping()` | Emit typing state |
| `disconnectBotChat()` | Close the bot chat socket |

Useful emitted events:

| Event | Payload |
| --- | --- |
| `bot_chat_open` | none |
| `bot_chat_message` | Raw parsed socket message |
| `bot_chat_connected` | Server connected payload |
| `bot_chat_chat_history` | Bot/session/history payload |
| `bot_chat_session_info` | Session ID payload |
| `bot_chat_token` | Stream token payload |
| `bot_chat_message_complete` | Final assistant response payload |
| `bot_chat_points_update` | Updated points payload |
| `bot_chat_typing` | Typing payload |
| `bot_chat_error` | Server-side error payload |
| `bot_chat_close` | Native close event |
| `bot_chat_stream_error` | SDK parse/transport error |

### Storage & Plans

#### `getStorageDetails(vaultId)`

Check your vault's storage usage.

```javascript
const storage = await vault.getStorageDetails("your-vault-id");
```

#### `getAllPlans(vaultId)`

Get available storage plans.

```javascript
const plans = await vault.getAllPlans("your-vault-id");
```

#### `buyPlan(vaultId, priceId)`

Purchase a storage plan.

```javascript
const purchase = await vault.buyPlan("your-vault-id", "price-id");
```

#### `cancelSubscription(vaultId)`

Cancel the active subscription at period end.

```javascript
const result = await vault.cancelSubscription("your-vault-id");
```

#### `createUpcomingPlan(vaultId, priceId)`

Schedule an upcoming plan (starts after current active plan ends).

```javascript
const result = await vault.createUpcomingPlan("your-vault-id", "price-id");
```

#### `cancelUpcomingPlan(vaultId)`

Cancel auto-renewal for a pending upcoming plan.

```javascript
const result = await vault.cancelUpcomingPlan("your-vault-id");
```

#### `getSubscriptions(vaultId)`

Get active subscriptions.

```javascript
const subs = await vault.getSubscriptions("your-vault-id");
```

#### `getWalletInfo(vaultId)`

Get the wallet summary for the authenticated vault user.

```javascript
const wallet = await vault.getWalletInfo("your-vault-id");
```

#### `getTransactionHistory(vaultId, query?)`

Get paginated wallet transaction history. You can optionally filter by page, limit, and category.

`page` and `limit` must be numbers; anything else is rejected with `INVALID_PARAMETER`. Both are rounded down to whole numbers, `page` starts at 1, and `limit` is clamped to 1-100.

```javascript
const history = await vault.getTransactionHistory("your-vault-id");

const filtered = await vault.getTransactionHistory("your-vault-id", {
  page: 2,
  limit: 10,
  category: "credit",
});
```

### Vault Operations

#### `createVault(email, platformId?)`

Create a new SDK user link. `platformId` is optional.

```javascript
const user = await vault.createVault("user@example.com", "platform-id");
const sdkUser = await vault.createVault("user@example.com");
```

#### `importVault(vaultId, platformId?)`

Import an existing vault. When `platformId` is omitted, SDK access is enabled and the client is linked directly to the user.

```javascript
const result = await vault.importVault("vault-id", "platform-id");
const resultWithoutPlatform = await vault.importVault("vault-id");
```

## Error Handling

The SDK provides specific, actionable error messages. All errors include a `code` for programmatic handling.

A `VaultError` from the server also carries a `requestId`. Server errors deliberately carry only a message, a code and that id — quote the id when you contact support, and the full detail is in the server's own logs.

```javascript
import Vault, { VaultError, ValidationError } from "vault-sdk-staging";

try {
  await vault.uploadFile(file, vaultId);
} catch (error) {
  if (error instanceof ValidationError) {
    // Parameter validation failed
    console.error(error.message); // "[Vault SDK] 'uploadFile': Parameter 'vaultId' must be a valid string..."
    console.error(error.code);    // "INVALID_PARAMETER"
    console.error(error.param);   // "vaultId"
  } else if (error instanceof VaultError) {
    // API or network error
    console.error(error.message);   // "[Vault SDK] 'uploadFile': Authentication failed..."
    console.error(error.code);      // "UNAUTHORIZED"
    console.error(error.status);    // 401
    console.error(error.requestId); // "9f1c…" — quote this to support
  }
}
```

### Error Codes

| Code | Description |
|------|-------------|
| `MISSING_CONFIG` | Required configuration parameter not provided |
| `INVALID_PARAMETER` | Method parameter failed validation |
| `BAD_REQUEST` | Server rejected the request (400) |
| `UNAUTHORIZED` | Authentication failed — check your keys (401) |
| `FORBIDDEN` | API key lacks permission for this operation (403) |
| `NOT_FOUND` | Requested resource doesn't exist (404) |
| `CONFLICT` | Resource already exists (409) |
| `FILE_TOO_LARGE` | File exceeds max upload size (413) |
| `RATE_LIMITED` | Too many requests — slow down (429) |
| `SERVER_ERROR` | Server-side error (500) |
| `NETWORK_ERROR` | No response — check network/URL |
| `REQUEST_TIMEOUT` | No reply within `VAULT_TIMEOUT` |
| `INSECURE_TRANSPORT` | Base or WebSocket URL is not https/wss |
| `PATH_NOT_ALLOWED` | File path resolved outside `VAULT_UPLOAD_ROOT` |
| `UPLOAD_URL_REJECTED` | Presign returned an unexpected or unencrypted upload host |
| `WEBSOCKET_ERROR` | WebSocket connection failed |
| `STORAGE_UPLOAD_FAILED` | File failed to upload to storage |
| `PRESIGN_FAILED` | Could not get upload URL |
| `REGISTER_FAILED` | File uploaded but registration failed |

## License

vDoIT Technologies Ltd 2025
