import assert from "node:assert/strict";
import test from "node:test";
import { checkImageProviderConnectivity, requireImageProviderConnectivity } from "../scripts/image-provider-connectivity.mjs";

test("provider connectivity accepts any HTTP response without submitting an image", async () => {
  let observedUrl = "";
  let observedMethod = "";
  const result = await checkImageProviderConnectivity({
    environment: { IMAGE_PROVIDER: "openai", OPENAI_BASE_URL: "https://gateway.example/v1", OPENAI_API_KEY: "secret" },
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      observedUrl = String(url);
      observedMethod = String(init?.method);
      return new Response("", { status: 401 });
    },
  });
  assert.deepEqual(result, { available: true, provider: "openai", host: "gateway.example", status: 401 });
  assert.equal(observedUrl, "https://gateway.example/v1/models");
  assert.equal(observedMethod, "GET");
});

test("provider connectivity turns connection failures into a safe preflight error", async () => {
  const failure = Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" });
  await assert.rejects(
    () => requireImageProviderConnectivity({
      environment: { IMAGE_PROVIDER: "openai", OPENAI_BASE_URL: "https://gateway.example/v1", OPENAI_API_KEY: "secret" },
      fetchImpl: async () => { throw new Error("fetch failed", { cause: failure }); },
    }),
    (error: unknown) => {
      const failure = error as { code?: string; message?: string };
      return failure.code === "IMAGE_PROVIDER_UNAVAILABLE"
        && /gateway\.example/.test(String(failure.message))
        && !/secret/.test(String(failure.message));
    },
  );
});
