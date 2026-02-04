# Vault SDK

The Vault SDK is a Node.js library that provides seamless integration with the Vault Service. This SDK allows developers to easily manage files, folders, and storage plans, as well as interact with the Twin Protocol backend for secure vault operations.

## Table of Contents

- [Requirements](#requirements)
  - [Node](#node)
    - [Node installation on Windows](#node-installation-on-windows)
    - [Node installation on Ubuntu](#node-installation-on-ubuntu)
    - [Other Operating Systems](#other-operating-systems)
- [Install](#install)
- [Configure environment variables](#configure-environment-variables)
- [Usage](#usage)
  - [Initialization](#initialization)
  - [WebSocket Connection](#websocket-connection)
- [API Reference](#api-reference)
  - [File Operations](#file-operations)
  - [Folder Operations](#folder-operations)
  - [Storage & Plans](#storage--plans)
  - [Other Operations](#other-operations)
- [License](#license)

---

## Requirements

To use this SDK, you will need Node.js and npm installed in your environment.

### Node

- #### Node installation on Windows

  Just go on the [official Node.js website](https://nodejs.org/) and download the installer.
  Also, be sure to have `git` available in your PATH, as `npm` might need it (You can find git [here](https://git-scm.com/)).

- #### Node installation on Ubuntu

  You can install Node.js and npm easily with apt install, just run the following commands:

  ```bash
  $ sudo apt install nodejs
  $ sudo apt install npm
  ```

- #### Other Operating Systems

  You can find more information about the installation on the [official Node.js website](https://nodejs.org/) and the [official NPM website](https://npmjs.org/).

If the installation was successful, you should be able to run the following commands:

```bash
$ node --version
v20.13.1

$ npm --version
10.5.2
```

## Install

```bash
$ npm install vault-sdk-dev
```

## Configure environment variables

To use the SDK, you need to configure the following environment variables:

```bash
VAULT_ACCESS_KEY
VAULT_SECRET_KEY
VAULT_CLIENT_API_KEY
VAULT_BASE_URL
VAULT_WS_URL
```

## Usage

### Initialization

Steps to initialize the SDK:

```javascript
import Vault from "vault-sdk-dev";

const vault = new Vault({
  VAULT_ACCESS_KEY: "your-access-key",
  VAULT_SECRET_KEY: "your-secret-key",
  VAULT_CLIENT_API_KEY: "your-client-api-key",
  VAULT_BASE_URL: "https://api.your-service.com",
  VAULT_WS_URL: "wss://api.your-service.com/ws",
});
```

### WebSocket Connection

To establish a WebSocket connection for real-time updates:

```javascript
await vault.connectToWebsocket();

vault.on('message', (data) => {
  console.log('Received message:', data);
});

vault.on('stream_error', (error) => {
  console.error('WebSocket error:', error);
});
```

## API Reference

### File Operations

#### `uploadFiles(files, vaultId, parentId)`
Uploads multiple files to the vault.
```javascript
const files = [
  { name: 'file1.txt', buffer: Buffer.from('content'), type: 'text/plain' }
];
const response = await vault.uploadFiles(files, 'vault-id', 'optional-parent-folder-id');
```

#### `getFiles(vaultId, query)`
Searches or lists files in the vault.
```javascript
const files = await vault.getFiles('vault-id', 'search-query');
```

#### `getAllFiles(vaultId)`
Retrieves all files in the vault.
```javascript
const allFiles = await vault.getAllFiles('vault-id');
```

#### `deleteFile(vaultId, fileId)`
Deletes a specific file.
```javascript
await vault.deleteFile('vault-id', 'file-id');
```

#### `renameFile(vaultId, itemId, newName)`
Renames a file or folder.
```javascript
await vault.renameFile('vault-id', 'item-id', 'new-name');
```

#### `addToStarred(vaultId, fileId, isStarred)`
Marks or unmarks a file as starred.
```javascript
await vault.addToStarred('vault-id', 'file-id', true);
```

#### `getStarredFiles(vaultId)`
Retrieves all starred files.
```javascript
const starred = await vault.getStarredFiles('vault-id');
```

### Folder Operations

#### `createFolder(vaultId, folderName, parentId)`
Creates a new folder.
```javascript
const folder = await vault.createFolder('vault-id', 'New Folder', 'optional-parent-id');
```

#### `deleteFolder(vaultId, folderId)`
Deletes a specific folder.
```javascript
await vault.deleteFolder('vault-id', 'folder-id');
```

### Storage & Plans

#### `getAllPlans(vaultId)`
Retrieves available storage plans.
```javascript
const plans = await vault.getAllPlans('vault-id');
```

#### `getStorageDetails(vaultId)`
Gets current storage usage details.
```javascript
const storage = await vault.getStorageDetails('vault-id');
```

#### `buyPlan(vaultId, priceId)`
Purchases a storage plan.
```javascript
const purchase = await vault.buyPlan('vault-id', 'price-id');
```

#### `getSubscriptions(vaultId)`
Retrieves active subscriptions.
```javascript
const subs = await vault.getSubscriptions('vault-id');
```

### Other Operations

#### `getMedia(vaultId)`
Fetches media associated with a vault ID.
```javascript
const media = await vault.getMedia('vault-id');
```

## License

vDoIT Technologies Ltd 2025
