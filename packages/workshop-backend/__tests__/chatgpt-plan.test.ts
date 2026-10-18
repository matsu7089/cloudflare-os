import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ChatGptAccounts, chatGptConnectRequest, chatGptModelId, type ChatGptSession } from "../src/chatgpt-plan.js";
import { makeUserStorage } from "../src/storage-schema/user-storage.js";
import { makeMockStorage } from "./mock-storage.js";

const USER_ID = "a".repeat(64);
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;
beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  jwk = { ...await exportJWK(keys.publicKey), kid: "chatgpt-test", alg: "RS256", use: "sig" };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const fixture = () => {
  const storage = makeUserStorage(makeMockStorage());
  return { storage, accounts: new ChatGptAccounts(storage, USER_ID) };
};

const session = (changes: Partial<ChatGptSession> = {}): ChatGptSession => ({
  id: "account-1", clientId: "oaiapp_test", subject: "subject-1", label: "user@example.test",
  accessToken: "old-access", refreshToken: "old-refresh", idToken: "old-id", scopes: SCOPES.split(" "),
  expiresAt: Date.now() + 3600_000, needsReauthentication: false, connectedAt: Date.now(),
  models: [{ id: "gpt-test", name: "GPT Test" }], ...changes,
});

async function start(accounts: ChatGptAccounts, accountId?: string) {
  const { connectUrl } = await accounts.begin("https://workshop.example", accountId);
  const ticket = new URLSearchParams(new URL(connectUrl).hash.slice(1)).get("ticket")!;
  const authorize = new URL(await accounts.authorize(ticket, 1455));
  const callback = new URL(authorize.searchParams.get("redirect_uri")!);
  callback.search = new URLSearchParams({ state: authorize.searchParams.get("state")!,
    code: "test-code", client_id: "oaiapp_test" }).toString();
  return { ticket, authorize, callback };
}

async function identity(nonce: string, subject = "subject-1") {
  return new SignJWT({ nonce, email: "user@example.test" }).setProtectedHeader({ alg: "RS256", kid: "chatgpt-test" })
      .setIssuer("https://auth.openai.com").setAudience("oaiapp_test").setSubject(subject)
      .setIssuedAt().setExpirationTime("1h").sign(keys.privateKey);
}

function mockOpenAi(idToken: string, scope = SCOPES) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith("jwks.json")) return Response.json({ keys: [jwk] });
    if (request.url.endsWith("/oauth/token")) return Response.json({
      access_token: "new-access", refresh_token: "new-refresh", id_token: idToken,
      token_type: "Bearer", expires_in: 3600, scope,
    });
    if (request.url.endsWith("/models")) return Response.json({ models: [
      { slug: "gpt-test", display_name: "GPT Test", visibility: "list" },
      { visibility: "hidden" },
    ] });
    throw new Error("Unexpected OpenAI request");
  });
}

describe("ChatGPT registration", () => {
  it("uses PKCE and a stable host, verifies identity, and exposes no credentials", async () => {
    const { accounts, storage } = fixture();
    const { ticket, authorize, callback } = await start(accounts);
    expect(authorize.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(authorize.searchParams.get("scope")).toBe(SCOPES);
    expect(authorize.searchParams.get("agent_name_hint")).toBe("Cloudflare OS");
    const verifier = storage.pendingChatGptConnect.get()!.verifier;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    expect(authorize.searchParams.get("code_challenge")).toBe(btoa(String.fromCharCode(...digest))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
    const network = mockOpenAi(await identity(authorize.searchParams.get("nonce")!));
    await accounts.complete(ticket, callback.href);
    const [account] = accounts.list();
    expect(account).toMatchObject({ label: "user@example.test", planEnabled: true,
      models: [{ id: "gpt-test", name: "GPT Test" }] });
    expect(JSON.stringify(account)).not.toMatch(/new-access|new-refresh|idToken|clientId/);
    expect(accounts.resolve(chatGptModelId(account.id, "gpt-test"))?.config).toMatchObject({
      apiToken: "", chatGptPlan: { userId: USER_ID, accountId: account.id },
    });
    const calls = network.mock.calls.filter(([input]) => String(input).endsWith("/oauth/token"));
    expect(new URLSearchParams(calls[0][1]!.body as string).get("client_id")).toBe("oaiapp_test");
    await expect(accounts.complete(ticket, callback.href)).rejects.toThrow("already used");
    const returning = await start(accounts, account.id);
    expect(returning.authorize.searchParams.get("client_id")).toBe("oaiapp_test");
    expect(returning.authorize.searchParams.get("ext_agent_host_id"))
      .toBe(authorize.searchParams.get("ext_agent_host_id"));
    expect(returning.authorize.searchParams.has("agent_name_hint")).toBe(false);
  });

  it("rejects wrong state, expired tickets, and callbacks without an issued client ID before exchange", async () => {
    const { accounts, storage } = fixture();
    const { ticket, callback } = await start(accounts);
    const network = vi.spyOn(globalThis, "fetch");
    callback.searchParams.set("state", "wrong");
    await expect(accounts.complete(ticket, callback.href)).rejects.toThrow("verification");
    const pending = storage.pendingChatGptConnect.get()!;
    callback.searchParams.set("state", pending.state);
    callback.searchParams.delete("client_id");
    await expect(accounts.complete(ticket, callback.href)).rejects.toThrow("client ID");
    expect(network).not.toHaveBeenCalled();
    await accounts.begin("https://workshop.example");
    storage.pendingChatGptConnect.put({ ...storage.pendingChatGptConnect.get()!, expiresAt: 0 });
    await expect(accounts.authorize(ticket, 1455)).rejects.toThrow("expired");
  });

  it("retains identity-only sign-in but never lists models or allows plan inference", async () => {
    const { accounts } = fixture();
    const { ticket, authorize, callback } = await start(accounts);
    const network = mockOpenAi(await identity(authorize.searchParams.get("nonce")!), "openid profile email");
    await accounts.complete(ticket, callback.href);
    const [account] = accounts.list();
    expect(account.planEnabled).toBe(false);
    expect(account.models).toEqual([]);
    expect(network.mock.calls.some(([input]) => String(input).endsWith("/models"))).toBe(false);
    await expect(accounts.accessToken(account.id)).rejects.toThrow("unavailable");
  });

  it("accepts an identity-only exchange without access or refresh tokens", async () => {
    const { accounts } = fixture();
    const { ticket, authorize, callback } = await start(accounts);
    const idToken = await identity(authorize.searchParams.get("nonce")!);
    vi.spyOn(globalThis, "fetch").mockImplementation(async input =>
      String(input).endsWith("jwks.json") ? Response.json({ keys: [jwk] }) :
        Response.json({ id_token: idToken, scope: "openid profile email" }));
    await accounts.complete(ticket, callback.href);
    expect(accounts.list()[0]).toMatchObject({ planEnabled: false, models: [] });
  });

  it("rejects a validly signed token with the wrong nonce or returning subject", async () => {
    const { accounts, storage } = fixture();
    storage.chatGptAccounts.put({ "account-1": session() });
    const { ticket, authorize, callback } = await start(accounts, "account-1");
    mockOpenAi(await identity(authorize.searchParams.get("nonce")!, "different-subject"));
    await expect(accounts.complete(ticket, callback.href)).rejects.toThrow("identity verification");
    expect(storage.chatGptAccounts.get()["account-1"].refreshToken).toBe("old-refresh");
    const next = await start(accounts);
    mockOpenAi(await identity("wrong-nonce"));
    await expect(accounts.complete(next.ticket, next.callback.href)).rejects.toThrow("identity verification");
  });

  it("does not accept a changed client ID during reauthorization", async () => {
    const { accounts, storage } = fixture();
    storage.chatGptAccounts.put({ "account-1": session() });
    const { ticket, callback } = await start(accounts, "account-1");
    callback.searchParams.set("client_id", "oaiapp_other");
    const network = vi.spyOn(globalThis, "fetch");
    await expect(accounts.complete(ticket, callback.href)).rejects.toThrow("expected client ID");
    expect(network).not.toHaveBeenCalled();
  });

  it("rejects an identity token whose signature was changed", async () => {
    const { accounts } = fixture();
    const { ticket, authorize, callback } = await start(accounts);
    const token = await identity(authorize.searchParams.get("nonce")!);
    const parts = token.split(".");
    parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
    mockOpenAi(parts.join("."));
    await expect(accounts.complete(ticket, callback.href)).rejects.toThrow();
    expect(accounts.list()).toEqual([]);
  });
});

describe("ChatGPT renewable sessions", () => {
  it("coalesces concurrent refreshes and atomically replaces rotating credentials", async () => {
    const { accounts, storage } = fixture();
    storage.chatGptAccounts.put({ "account-1": session({ expiresAt: 0 }) });
    const network = mockOpenAi("unused");
    expect(await Promise.all([accounts.accessToken("account-1"), accounts.accessToken("account-1")]))
      .toEqual(["new-access", "new-access"]);
    expect(network).toHaveBeenCalledTimes(1);
    expect(storage.chatGptAccounts.get()["account-1"]).toMatchObject({
      accessToken: "new-access", refreshToken: "new-refresh",
    });
    expect(new URLSearchParams(network.mock.calls[0][1]!.body as string).has("scope")).toBe(false);
  });

  it("marks an invalid renewable grant for reauthentication without repeated refresh requests", async () => {
    const { accounts, storage } = fixture();
    storage.chatGptAccounts.put({ "account-1": session({ expiresAt: 0 }) });
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 400 }));
    await expect(accounts.accessToken("account-1")).rejects.toThrow("Reconnect");
    expect(accounts.list()[0].needsReauthentication).toBe(true);
    await expect(accounts.accessToken("account-1")).rejects.toThrow("unavailable");
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("clears credentials and stops existing model references even if remote revocation fails", async () => {
    const { accounts, storage } = fixture();
    storage.chatGptAccounts.put({ "account-1": session() });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    expect(await accounts.disconnect("account-1")).toEqual({ revoked: false });
    expect(accounts.list()).toEqual([]);
    expect(accounts.resolve(chatGptModelId("account-1", "gpt-test"))).toBeUndefined();
    await expect(accounts.accessToken("account-1")).rejects.toThrow("unavailable");
  });

  it("does not restore credentials when a refresh finishes after disconnection", async () => {
    const { accounts, storage } = fixture();
    storage.chatGptAccounts.put({ "account-1": session({ expiresAt: 0 }) });
    let finish!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      if (String(input).endsWith("/oauth/token")) return new Promise<Response>(resolve => { finish = resolve; });
      return new Response("", { status: 503 });
    });
    const refreshing = accounts.accessToken("account-1");
    const checked = expect(refreshing).rejects.toThrow("account changed");
    await accounts.disconnect("account-1");
    finish(Response.json({ access_token: "new-access", refresh_token: "new-refresh",
      token_type: "Bearer", expires_in: 3600, scope: SCOPES }));
    await checked;
    expect(storage.chatGptAccounts.get()).toEqual({});
  });
});

describe("local helper endpoint", () => {
  it("rejects browser POSTs, other methods, and oversized bodies before addressing a user", async () => {
    const users = {} as Parameters<typeof chatGptConnectRequest>[1];
    expect((await chatGptConnectRequest(new Request("https://workshop.example/api/chatgpt/connect"), users)).status).toBe(405);
    expect((await chatGptConnectRequest(new Request("https://workshop.example/api/chatgpt/connect", {
      method: "POST", headers: { Origin: "https://evil.example" }, body: "{}",
    }), users)).status).toBe(403);
    expect((await chatGptConnectRequest(new Request("https://workshop.example/api/chatgpt/connect", {
      method: "POST", body: "x".repeat(24_001),
    }), users)).status).toBe(413);
  });
});
