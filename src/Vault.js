import crypto from "crypto";
import axios from "axios";
import WebSocket from "ws";
import EventEmitter from "events";
import { validator } from "./utils/validationError.js";

class Vault extends EventEmitter {
  constructor({
    VAULT_ACCESS_KEY,
    VAULT_SECRET_KEY,
    VAULT_CLIENT_API_KEY,
    VAULT_BASE_URL,
    VAULT_WS_URL,
  }) {
    super();
    this.apiKey = VAULT_ACCESS_KEY;
    this.apiSecret = VAULT_SECRET_KEY;
    this.baseUrl = VAULT_BASE_URL;
    this.clientApiKey = VAULT_CLIENT_API_KEY;
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

  // request calls the respective API
  async request(method, endpoint, payload, options = {}) {
    const timestamp = Date.now().toString();
    const signature = this.sign(timestamp, {
      apikey: this.apiKey,
      clientApiKey: this.clientApiKey,
    });

    const headers = {
      timestamp: timestamp,
      signature: signature,
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
      throw error;
    }
  }

  // sign generates the signature
  sign(timestamp, data) {
    const message = this.apiKey + timestamp;
    return crypto
      .createHmac("sha256", this.apiSecret)
      .update(message)
      .digest("hex");
  }

  // connectToWebsocket creates connection to ws backend
  async connectToWebsocket() {
    let timestamp = Date.now().toString();
    
    // Using the same signing data structure as request() for consistency
    const signData = {
      apikey: this.apiKey,
      clientApiKey: this.clientApiKey
    };
   
    const signature = this.sign(timestamp, signData);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(
        `${this.wsUrl}?apikey=${this.apiKey}&signature=${signature}&timestamp=${timestamp}&clientApiKey=${this.clientApiKey}`,
      );

      this.ws.onopen = () => {
        console.log("WebSocket connection established");
        resolve();
      };
      
      this.ws.onmessage = this.wsOnMessage.bind(this);
      this.ws.onclose = () => {};

      this.ws.onerror = (error) => {
        console.error("WebSocket error:", error);
        reject(error);
      };
    });
  }

  // returns the response from message event
  wsOnMessage(event) {
    const response = JSON.parse(event.data);
    this.emit("message", JSON.parse(event.data));
    return response;
  }

  // returns the errors coming from ws
  wsOnError(error) {
    this.emit("stream_error", error.message);
    return error;
  }

  async getMedia(vaultId) {
    validator.validate({
      vaultId: { value: vaultId, type: "string", required: true },
    });

    try {
      const response = await this.request(
        "GET",
        `v1/vault/get-media?vaultId=${vaultId}`,
      );
      return response.data;
    } catch (error) {
      if (error.response && error.response.data) {
        throw error.response.data;
      }
      throw error;
    }
  }
  async createPlatformUser(email, platformId) {
     if (!email || !platformId) {
         throw new Error("Email and Platform ID are required");
     }
     try {
         const response = await this.request(
             "POST",
             "/v1/vault-sdk/create-user",
             { email, platformId }
         );
         return response.data;
     } catch (error) {
         throw error;
     }
  }

  async importVault(vaultId, platformId) {
      if (!vaultId || !platformId) {
          throw new Error("Vault ID and Platform ID are required");
      }
      try {
          const response = await this.request(
              "POST",
              "/v1/vault-sdk/import-vault",
              { vaultId, platformId }
          );
          return response.data;
      } catch (error) {
          throw error;
      }
  }

  async getPresignedUrl({ vaultId, fileName, fileType, fileSize, contentHash, folderId }) {
    validator.validate({
      vaultId: { value: vaultId, type: "string", required: true },
      fileName: { value: fileName, type: "string", required: true },
      fileSize: { value: fileSize, type: "number", required: true },
      contentHash: { value: contentHash, type: "string", required: true },
    });

    try {
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
        }
      );
      return response.data;
    } catch (error) {
       if (error.response && error.response.data) {
        throw error.response.data;
      }
      throw error;
    }
  }

  async registerUpload({ vaultId, fileName, filebaseKey, fileSize, contentHash, folderId }) {
    validator.validate({
      vaultId: { value: vaultId, type: "string", required: true },
      fileName: { value: fileName, type: "string", required: true },
      filebaseKey: { value: filebaseKey, type: "string", required: true },
      fileSize: { value: fileSize, type: "number", required: true },
      contentHash: { value: contentHash, type: "string", required: true },
    });

    try {
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
        }
      );
      return response.data;
    } catch (error) {
       if (error.response && error.response.data) {
        throw error.response.data;
      }
      throw error;
    }
  }

  async uploadFile(file, vaultId, parentId) {
    const { buffer, name, type } = file;
    const size = buffer.length;
    
    // 1. Calculate Hash
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');

    try {
      // 2. Get Presigned URL
      const presignedRes = await this.getPresignedUrl({
        vaultId,
        fileName: name,
        fileType: type,
        fileSize: size,
        contentHash: hash,
        folderId: parentId
      });

      const { url, key, contentType, sanitizedName } = presignedRes.data;

      // 3. Upload to Storage
      await axios.put(url, buffer, {
          headers: {
              "Content-Type": contentType,
              "x-amz-meta-original-filename": sanitizedName,
              "x-amz-meta-content-hash": hash,
              "x-amz-meta-user-id": vaultId,
              "x-amz-meta-folder-id": parentId || "root",
              "x-amz-meta-file-size": size.toString(),
          }
      });

      // 4. Register Upload
      return await this.registerUpload({
        vaultId,
        fileName: name,
        filebaseKey: key,
        fileSize: size,
        contentHash: hash,
        folderId: parentId
      });

    } catch (error) {
      throw error;
    }
  }

  async uploadFiles(files, vaultId, parentId = null) {
    validator.validate({
      files: { value: files, type: "array", required: true },
      vaultId: { value: vaultId, type: "string", required: true },
    });

    const uploadPromises = files.map(async (file) => {
      try {
        const result = await this.uploadFile(file, vaultId, parentId);
        return { ...result, status: "success", fileName: file.name };
      } catch (error) {
        return {
          status: "failed",
          fileName: file.name,
          error: error.message || error,
        };
      }
    });

    return await Promise.all(uploadPromises);
  }

  async getFiles(vaultId, query = "") {
    validator.validate({
      vaultId: { value: vaultId, type: "string", required: true },
      query: { value: query, type: "string", required: false },
    });

    try {
      const queryString = `?vaultId=${encodeURIComponent(vaultId)}&query=${encodeURIComponent(query)}`;
      const response = await this.request(
        "GET",
        `/v1/vault-sdk/get-files${queryString}`
      );
      return response.data;
    } catch (error) {
      if (error.response && error.response.data) {
        throw error.response.data;
      }
      throw error;
    }
  }

  async getAllFiles(vaultId) {
    validator.validate({
      vaultId: { value: vaultId, type: "string", required: true },
    });

    try {
      const queryString = `?vaultId=${encodeURIComponent(vaultId)}`;
      const response = await this.request(
        "GET",
        `/v1/vault-sdk/all-files${queryString}`
      );
      return response.data;
    } catch (error) {
      if (error.response && error.response.data) {
        throw error.response.data;
      }
      throw error;
    }
  }

  async getAllPlans(vaultId) {
    validator.validate({
      vaultId: { value: vaultId, type: "string", required: true },
    });

    try {
      const queryString = `?vaultId=${encodeURIComponent(vaultId)}`;
      const response = await this.request(
        "GET",
        `/v1/vault-sdk/all-plans${queryString}`
      );
      return response.data;
    } catch (error) {
      if (error.response && error.response.data) {
        throw error.response.data;
      }
      throw error;
    }
  }

  async getStorageDetails(vaultId) {
    validator.validate({
      vaultId: { value: vaultId, type: "string", required: true },
    });

    try {
      const queryString = `?vaultId=${encodeURIComponent(vaultId)}`;
      const response = await this.request(
        "GET",
        `/v1/vault-sdk/storage-details${queryString}`
      );
      return response.data;
    } catch (error) {
      if (error.response && error.response.data) {
        throw error.response.data;
      }
      throw error;
    }
  }

  async buyPlan(vaultId, priceId) {
    validator.validate({
      vaultId: { value: vaultId, type: "string", required: true },
      priceId: { value: priceId, type: "string", required: true },
    });

    try {
      const response = await this.request(
        "POST",
        "/v1/vault-sdk/buy-plan",
        { vaultId, priceId }
      );
      return response.data;
    } catch (error) {
      if (error.response && error.response.data) {
        throw error.response.data;
      }
      throw error;
    }
  }

  async createFolder(vaultId, folderName, parentId = null) {
    validator.validate({
      vaultId: { value: vaultId, type: "string", required: true },
      folderName: { value: folderName, type: "string", required: true },
    });

    try {
      const response = await this.request(
        "POST",
        "/v1/vault-sdk/create-folder",
        { vaultId, folderName, parentId }
      );
      return response.data;
    } catch (error) {
      if (error.response && error.response.data) {
        throw error.response.data;
      }
      throw error;
    }
  }

  async deleteFolder(vaultId, folderId) {
    validator.validate({
      vaultId: { value: vaultId, type: "string", required: true },
      folderId: { value: folderId, type: "string", required: true },
    });

    try {
      const response = await this.request(
        "DELETE",
        "/v1/vault-sdk/delete-folder",
        { vaultId, folderId }
      );
      return response.data;
    } catch (error) {
      if (error.response && error.response.data) {
        throw error.response.data;
      }
      throw error;
    }
  }

  async deleteFile(vaultId, fileId) {
    validator.validate({
      vaultId: { value: vaultId, type: "string", required: true },
      fileId: { value: fileId, type: "string", required: true },
    });

    try {
      const response = await this.request(
        "DELETE",
        "/v1/vault-sdk/delete-file",
        { vaultId, fileId }
      );
      return response.data;
    } catch (error) {
      if (error.response && error.response.data) {
        throw error.response.data;
      }
      throw error;
    }
  }

  async renameFile(vaultId, itemId, newName) {
    validator.validate({
      vaultId: { value: vaultId, type: "string", required: true },
      itemId: { value: itemId, type: "string", required: true },
      newName: { value: newName, type: "string", required: true },
    });

    try {
      const response = await this.request(
        "POST",
        "/v1/vault-sdk/rename",
        { vaultId, itemId, newName }
      );
      return response.data;
    } catch (error) {
      if (error.response && error.response.data) {
        throw error.response.data;
      }
      throw error;
    }
  }

  async addToStarred(vaultId, fileId, isStarred) {
    validator.validate({
      vaultId: { value: vaultId, type: "string", required: true },
      fileId: { value: fileId, type: "string", required: true },
      isStarred: { value: isStarred, type: "boolean", required: true },
    });

    try {
      const response = await this.request(
        "POST",
        "/v1/vault-sdk/add-to-starred",
        { vaultId, fileId, isStarred }
      );
      return response.data;
    } catch (error) {
      if (error.response && error.response.data) {
        throw error.response.data;
      }
      throw error;
    }
  }

  async getStarredFiles(vaultId) {
    validator.validate({
      vaultId: { value: vaultId, type: "string", required: true },
    });

    try {
      const queryString = `?vaultId=${encodeURIComponent(vaultId)}`;
      const response = await this.request(
        "GET",
        `/v1/vault-sdk/get-starred-files${queryString}`
      );
      return response.data;
    } catch (error) {
      if (error.response && error.response.data) {
        throw error.response.data;
      }
      throw error;
    }
  }

  async getSubscriptions(vaultId) {
     validator.validate({
      vaultId: { value: vaultId, type: "string", required: true },
    });

    try {
      const queryString = `?vaultId=${encodeURIComponent(vaultId)}`;
      const response = await this.request(
        "GET",
        `/v1/vault-sdk/subscriptions${queryString}`
      );
      return response.data;
    } catch (error) {
      if (error.response && error.response.data) {
        throw error.response.data;
      }
      throw error;
    }
  }
}

export default Vault;
