import test from "node:test";
import assert from "node:assert/strict";
import Vault from "../src/Vault.js";

const call = (request, ...args) => Vault.prototype.setBotLlm.call({ request }, ...args);
const getProviders = (request, ...args) => Vault.prototype.getLlmProviders.call({ request }, ...args);
const testLlm = (request, ...args) => Vault.prototype.testBotLlm.call({ request }, ...args);

test("tests an LLM configuration without saving it", async () => {
  const response = { data: { valid: true } };
  const result = await testLlm(async (...args) => {
    assert.deepEqual(args, ["POST", "/v1/vault-sdk/bots/bot%2F1/llm/test", {
      vaultId: "vault-1", provider: "OPENAI", model: "gpt-5.6-terra", apiKey: "test-key",
    }, { operation: "testBotLlm" }]);
    return { data: response };
  }, "vault-1", "bot/1", { provider: "OPENAI", model: "gpt-5.6-terra", apiKey: "test-key" });
  assert.equal(result, response);
});

test("gets the provider catalog for an associated vault", async () => {
  const response = { data: { providers: [{ id: "OPENAI" }] } };
  const result = await getProviders(async (...args) => {
    assert.deepEqual(args, ["GET", "/v1/vault-sdk/bots/llm-providers?vaultId=vault%2F1", undefined, { operation: "getLlmProviders" }]);
    return { data: response };
  }, "vault/1");
  assert.equal(result, response);
});

test("requires a vault ID to get the provider catalog", async () => {
  await assert.rejects(getProviders(() => assert.fail("unexpected request"), ""), { name: "ValidationError" });
});

test("sends the custom LLM configuration to the encoded bot route and preserves the response", async () => {
  const response = { data: { llm: { enabled: true, apiKeyHint: "***1234" } } };
  const result = await call(async (...args) => {
    assert.deepEqual(args, ["PUT", "/v1/vault-sdk/bots/bot%2F1/llm", {
      vaultId: "vault-1", provider: "CUSTOM", model: "my-model",
      baseUrl: "https://provider.example/v1", apiKey: "test-key",
    }, { operation: "setBotLlm" }]);
    return { data: response };
  }, "vault-1", "bot/1", {
    provider: "CUSTOM", model: "my-model", baseUrl: "https://provider.example/v1",
    apiKey: "test-key", vaultId: "must-not-override", ignored: true,
  });
  assert.equal(result, response);
});

test("omits the provider key when reusing saved credentials", async () => {
  await call(async (_method, _path, body) => {
    assert.deepEqual(body, { vaultId: "vault-1", provider: "OPENAI", model: "my-model" });
    return { data: {} };
  }, "vault-1", "bot-1", { provider: "OPENAI", model: "my-model" });
});

test("rejects missing identifiers and invalid configuration before making a request", async () => {
  for (const args of [
    ["", "bot", { provider: "OPENAI", model: "model" }],
    ["vault", "", { provider: "OPENAI", model: "model" }],
    ["vault", "bot", undefined],
    ["vault", "bot", { provider: "OPENAI" }],
    ["vault", "bot", { provider: "OPENAI", model: "  " }],
    ["vault", "bot", { provider: "OPENAI", model: "model", apiKey: 123 }],
  ]) {
    await assert.rejects(call(() => assert.fail("unexpected request"), ...args), { name: "ValidationError" });
  }
});

test("propagates verification and ownership failures", async () => {
  const failure = new Error("Provider verification failed");
  await assert.rejects(call(async () => { throw failure; }, "vault", "bot", {
    provider: "OPENAI", model: "model",
  }), (error) => error === failure);
});
