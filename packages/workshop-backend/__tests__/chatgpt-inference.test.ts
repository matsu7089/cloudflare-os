import { describe, expect, it, vi } from "vitest";
import { chatGptFetch } from "../src/chatgpt-inference.js";
import { getModel } from "../src/ai-models.js";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { makeUserStorage } from "../src/storage-schema/user-storage.js";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

describe("ChatGPT Responses transport", () => {
  it("completes a streamed inference through a real User DO's private grant reference", async () => {
    const user = env.TEST_USER.getByName(`chatgpt-stream-${crypto.randomUUID()}`);
    const config = await runInDurableObject(user, async (instance, state) => {
      makeUserStorage(state.storage).chatGptAccounts.put({ account: {
        id: "account", clientId: "oaiapp_test", subject: "subject", label: "user@example.test",
        accessToken: "plan-access-token", refreshToken: "plan-refresh-token", idToken: "plan-id-token",
        scopes: ["chatgpt.tokens.use.direct"], expiresAt: Date.now() + 3600_000,
        connectedAt: Date.now(), needsReauthentication: false,
        models: [{ id: "gpt-test", name: "GPT Test" }],
      } });
      return (await instance.getChatContext("chatgpt/account/gpt-test")).aiModel!.config;
    });
    const handle = getModel({} as Cloudflare.Env, config, { type: "user", id: "user", name: "User" });
    const message = { id: "msg-1", type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "Hello", annotations: [] }] };
    const response = { id: "resp-1", status: "completed", output: [message],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } };
    const events = [
      { type: "response.created", response: { id: "resp-1" } },
      { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
      { type: "response.output_text.delta", output_index: 0, delta: "Hello" },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response },
    ];
    const result = await handle.stream(handle.model, {
      messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
    }, { maxRetries: 0, fetch: async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://api.openai.com/v1/responses");
      expect(request.headers.get("Authorization")).toBe("Bearer plan-access-token");
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      });
    } }).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content[0]).toMatchObject({ type: "text", text: "Hello" });
    expect(result.usage.totalTokens).toBe(3);
    expect(result.usage.cost.total).toBe(0);
  });

  it("renews auth per request, strips unsupported fields and preserves namespaced tool history", async () => {
    const bodies: Record<string, unknown>[] = [];
    const credentials: string[] = [];
    const accessToken = vi.fn().mockResolvedValueOnce("access-one").mockResolvedValueOnce("access-two");
    const transport: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      credentials.push(request.headers.get("Authorization")!);
      expect(request.headers.has("cf-aig-authorization")).toBe(false);
      expect(request.redirect).toBe("manual");
      bodies.push(await request.json());
      return new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    };
    const send = chatGptFetch(accessToken, transport);
    const body = {
      model: "gpt-test", input: [
        { role: "system", content: "Instructions" },
        { type: "function_call", name: "executeCode", call_id: "call-1", arguments: "{}" },
        { type: "function_call_output", call_id: "call-1", output: "done" },
      ], tools: [{ type: "function", name: "executeCode", parameters: {} }],
      max_output_tokens: 200, temperature: 1, top_p: 0.9, metadata: { user: "private" },
      previous_response_id: "old-response", prompt_cache_retention: "24h", store: true, stream: false,
    };
    for (let i = 0; i < 2; i++) await send("https://api.openai.com/v1/responses", {
      method: "POST", headers: { Authorization: "Bearer wrong", "cf-aig-authorization": "gateway" },
      body: JSON.stringify(body),
    });
    expect(credentials).toEqual(["Bearer access-one", "Bearer access-two"]);
    expect(bodies[0]).toEqual({ model: "gpt-test", store: false, stream: true, input: [
      { role: "developer", content: "Instructions" },
      { type: "function_call", name: "executeCode", call_id: "call-1", arguments: "{}", namespace: "cloudflare_os" },
      { type: "function_call_output", call_id: "call-1", output: "done" },
    ], tools: [{ type: "namespace", name: "cloudflare_os", description: "Cloudflare OS workspace tools",
      tools: [{ type: "function", name: "executeCode", parameters: {} }] }] });
  });

  it("refuses other endpoints and unsupported hosted tools before retrieving credentials", async () => {
    const accessToken = vi.fn();
    const transport = vi.fn();
    const send = chatGptFetch(accessToken, transport);
    await expect(send("https://evil.example/v1/responses", { method: "POST" })).rejects.toThrow("official");
    await expect(send("https://api.openai.com/v1/responses", { method: "POST",
      body: JSON.stringify({ input: [], tools: [{ type: "tool_search" }] }),
    })).rejects.toThrow("unavailable");
    expect(accessToken).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("bypasses both platform and user gateways and records no API-key price for plan usage", () => {
    const handle = getModel({
      CF_AI_GATEWAY: "platform", CF_AI_GATEWAY_ACCOUNT_ID: "platform-account",
      CF_AI_GATEWAY_API_TOKEN: "platform-token",
    } as Cloudflare.Env, {
      provider: "openai", model: "gpt-5.4", apiToken: "", apiUrl: "https://ignored.example/v1",
      chatGptPlan: { userId: "a".repeat(64), accountId: "account-1" },
    }, { type: "user", id: "user", name: "User" }, {
      userGateway: { accountId: "paid-cloudflare-account", apiKey: "cloudflare-token" },
    });
    expect(handle.model.baseUrl).toBe("https://api.openai.com/v1");
    expect(handle.aiGatewayLogRoute).toBeUndefined();
    expect(handle.model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});
