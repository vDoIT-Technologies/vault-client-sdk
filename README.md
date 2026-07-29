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

Upload a single file to the vault.

```javascript
import fs from "fs";

const result = await vault.uploadFile(
  {
    buffer: fs.readFileSync("./photo.jpg"),
    name: "photo.jpg",
    type: "image/jpeg", // optional, defaults to "application/octet-stream"
  },
  "your-vault-id"
);

// Upload into a specific folder
const inFolder = await vault.uploadFile(
  { buffer: fileBuffer, name: "report.pdf", type: "application/pdf" },
  "your-vault-id",
  "parent-folder-id"
);
```

#### `uploadFiles(files, vaultId, parentId?)`

Upload multiple files in parallel. Each file is handled independently — one failure won't block the others.

```javascript
const results = await vault.uploadFiles(
  [
    { buffer: buf1, name: "file1.pdf", type: "application/pdf" },
    { buffer: buf2, name: "file2.jpg", type: "image/jpeg" },
  ],
  "your-vault-id"
);

// Each result has a status:
// { status: "success", fileName: "file1.pdf", ... }
// { status: "failed", fileName: "file2.jpg", error: "...", code: "..." }
```

### Manual File Upload

`uploadFile()` runs the whole flow for you. Do it manually when you need progress reporting, streaming, or custom handling of very large files.

#### Step 1: `getPresignedUrl({ vaultId, fileName, fileType, fileSize, contentHash, folderId })`

Get an upload URL. `contentHash` must be a 64-character hex SHA-256 of the exact bytes you're going to upload.

```javascript
import crypto from "crypto";
import fs from "fs";

const fileBuffer = fs.readFileSync("./large-video.mp4");
const fileSize = fileBuffer.length;
const contentHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

const presign = await vault.getPresignedUrl({
  vaultId: "your-vault-id",
  fileName: "large-video.mp4",
  fileType: "video/mp4",
  fileSize,
  contentHash,
  folderId: null, // or a folder ID
});

const { url, key, contentType, metadata } = presign.data;
```

#### Step 2: Upload to storage

The URL is valid for one hour and is signed together with its metadata. Send back exactly the `metadata` object you were given, prefixed with `x-amz-meta-` — adding, dropping, or renaming a key invalidates the signature and the upload fails with a 403.

```javascript
import axios from "axios";

await axios.put(url, fileBuffer, {
  headers: {
    "Content-Type": contentType,
    ...Object.fromEntries(
      Object.entries(metadata).map(([k, v]) => [`x-amz-meta-${k}`, v])
    ),
  },
});
```

#### Step 3: `registerUpload({ vaultId, fileName, filebaseKey, fileSize, contentHash, folderId })`

Confirm the upload with the backend. A file uploaded in step 2 but never registered here won't appear in the vault.

```javascript
const registered = await vault.registerUpload({
  vaultId: "your-vault-id",
  fileName: "large-video.mp4",
  filebaseKey: key, // the `key` from step 1
  fileSize,
  contentHash,
  folderId: null,
});
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

### Platform Operations

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

### Media

#### `getMedia(vaultId)`

Fetch media associated with a vault.

```javascript
const media = await vault.getMedia("your-vault-id");
```

### WebSocket

#### `connectToWebsocket()`

Establish a real-time WebSocket connection. Requires `VAULT_WS_URL` in the constructor.

```javascript
await vault.connectToWebsocket();

vault.on("message", (data) => {
  console.log("Received:", data);
});

vault.on("stream_error", (error) => {
  console.error("WebSocket error:", error);
});
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
