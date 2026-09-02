# Vault SDK

A lightweight Node.js SDK for the Vault service. Upload, organize, and manage files and folders, handle storage plans, and connect via WebSocket for real-time events.

## Install

```bash
npm install vault-sdk-dev
```

## Quick Start

```javascript
import Vault from "vault-sdk-dev";

const vault = new Vault({
  VAULT_ACCESS_KEY: "your-access-key",
  VAULT_SECRET_KEY: "your-secret-key",
  VAULT_CLIENT_API_KEY: "your-client-api-key",
  VAULT_BASE_URL: "https://api.your-service.com",
  VAULT_WS_URL: "wss://api.your-service.com/ws", // optional, for WebSocket
});
```

All configuration parameters except `VAULT_WS_URL` are required. The SDK will throw a clear error listing any missing ones.

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
| Path on disk | `"./photo.jpg"` |
| Bytes + name | `{ buffer: fileBuffer, name: "report.pdf" }` |
| Path in an object | `{ path: "./photo.jpg" }` |
| `File` / `Blob` | `new File([bytes], "photo.jpg", { type: "image/jpeg" })` |

`type` (or `mimeType` / `contentType`) is optional — it's derived from the file extension when omitted. Names are sanitized to ASCII before upload, so `héllo wörld🤣.PNG` is stored as `hello world.PNG`.

The call throws a `VaultError` if the file can't be read, is empty, exceeds the 10 GB limit, or if any upload step fails — the `code` tells you which step (`FILE_READ_FAILED`, `INVALID_PARAMETER`, `FILE_TOO_LARGE`, `PRESIGN_FAILED`, `STORAGE_UPLOAD_FAILED`, `REGISTER_FAILED`).

#### `uploadFiles(files, vaultId, parentId?)`

Upload multiple files in parallel. Each file is handled independently — one failure won't block the others. Every entry accepts the same forms as `uploadFile()`.

```javascript
const results = await vault.uploadFiles(
  ["./file1.pdf", { buffer: buf2, name: "file2.jpg" }],
  "your-vault-id"
);

// Each result has a status:
// { status: "success", fileName: "file1.pdf", ... }
// { status: "failed", fileName: "file2.jpg", error: "...", code: "..." }
```

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

```javascript
await vault.uploadFilesToBot("./faq.pdf", "your-vault-id", "bot-id");

await vault.uploadFilesToBot(
  ["./faq.pdf", { buffer: audioBuffer, name: "call.mp3" }],
  "your-vault-id",
  "bot-id"
);
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
| `sendBotChatMessage(message, history?)` | Send a message to the joined bot |
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

```javascript
import Vault, { VaultError, ValidationError } from "vault-sdk-dev";

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
    console.error(error.message); // "[Vault SDK] 'uploadFile': Authentication failed..."
    console.error(error.code);    // "UNAUTHORIZED"
    console.error(error.status);  // 401
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
| `WEBSOCKET_ERROR` | WebSocket connection failed |
| `STORAGE_UPLOAD_FAILED` | File failed to upload to storage |
| `PRESIGN_FAILED` | Could not get upload URL |
| `REGISTER_FAILED` | File uploaded but registration failed |

## License

vDoIT Technologies Ltd 2025
