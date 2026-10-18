import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import type { ChatGptAccount } from "@gadgets/workshop-shared/api";
import type { UserAiModelRecord, UserStorage } from "./storage-schema/user-storage.js";
import { hashPresentedSecret, newSecretToken } from "./connect-handoff.js";

const ISSUER = "https://auth.openai.com";
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = "https://api.openai.com/v1";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
const REQUEST_TIMEOUT = 30_000;

/** Protected, backend-only OAuth registration and its most recent account model catalog. */
export type ChatGptSession = {
  id: string;
  clientId: string;
  subject: string;
  label: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  scopes: string[];
  expiresAt: number;
  needsReauthentication: boolean;
  connectedAt: number;
  models: { id: string; name: string }[];
};

/** A single-use connection capability, bound to a user's local OAuth attempt. */
export type PendingChatGptConnect = {
  ticketHash: string;
  state: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
  accountId?: string;
  redirectUri?: string;
};

const tokenSchema = z.object({
  access_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  token_type: z.string().refine(value => value.toLowerCase() === "bearer").optional(),
  expires_in: z.number().positive().finite().max(86400).optional(),
  scope: z.string().optional(),
}).refine(value => !value.access_token || (value.token_type && value.expires_in));

class TokenRequestError extends Error {
  constructor(readonly status: number) {
    super(`ChatGPT authorization failed (${status}). Reconnect from AI Providers.`);
  }
}

async function tokenRequest(body: URLSearchParams) {
  const response = await fetch(TOKEN_URL, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body, signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (!response.ok) {
    // Never include the OAuth response body: it may contain credentials or personal data.
    throw new TokenRequestError(response.status);
  }
  const parsed = tokenSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("ChatGPT returned an invalid token response.");
  return parsed.data;
}

async function modelCatalog(accessToken: string) {
  const response = await fetch(`${RESOURCE}/models`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (!response.ok) throw new Error(`Could not load ChatGPT models (${response.status}).`);
  const parsed = z.object({ models: z.array(z.object({
    slug: z.string().min(1).max(200).optional(), display_name: z.string().min(1).max(200).optional(),
    visibility: z.string().optional(),
  })) }).safeParse(await response.json());
  if (!parsed.success) throw new Error("ChatGPT returned an invalid model catalog.");
  return parsed.data.models.filter(model => model.visibility === "list")
      .map(model => {
        if (!model.slug || !model.display_name) throw new Error("ChatGPT returned an invalid visible model.");
        return { id: model.slug, name: model.display_name };
      });
}

/** Per-user ChatGPT sessions; rotating refreshes are coalesced in the owning User DO. */
export class ChatGptAccounts {
  #refreshes = new Map<string, Promise<ChatGptSession>>();

  constructor(private storage: UserStorage, private userId: string) {}

  list(): ChatGptAccount[] {
    return Object.values(this.storage.chatGptAccounts.get()).map(session => ({
      id: session.id, label: session.label,
      planEnabled: session.scopes.includes(PLAN_SCOPE),
      needsReauthentication: session.needsReauthentication,
      connectedAt: session.connectedAt,
      models: session.models,
    }));
  }

  models(): UserAiModelRecord[] {
    const models: UserAiModelRecord[] = [];
    for (const account of this.list()) {
      if (!account.planEnabled || account.needsReauthentication) continue;
      for (const model of account.models) models.push({
        profile: { type: "agent", id: chatGptModelId(account.id, model.id),
          name: `${model.name} · ChatGPT (${account.label} · ${account.id.slice(0, 8)})` },
        config: { provider: "openai", model: model.id, apiToken: "",
          chatGptPlan: { userId: this.userId, accountId: account.id } },
      });
    }
    return models;
  }

  resolve(id: string): UserAiModelRecord | undefined {
    return this.models().find(model => model.profile.id === id);
  }

  async begin(baseUrl: string, accountId?: string): Promise<{ connectUrl: string }> {
    if (accountId && !this.storage.chatGptAccounts.get()[accountId]) {
      throw new Error("No such ChatGPT account.");
    }
    const { secret, hash } = await newSecretToken();
    const ticket = secret.toHex();
    this.storage.pendingChatGptConnect.put({
      ticketHash: hash, state: crypto.getRandomValues(new Uint8Array(32)).toHex(),
      nonce: crypto.getRandomValues(new Uint8Array(32)).toHex(),
      verifier: crypto.getRandomValues(new Uint8Array(32)).toHex(),
      expiresAt: Date.now() + 10 * 60_000, accountId,
    });
    if (!this.storage.chatGptHostId.get()) {
      this.storage.chatGptHostId.put(`urn:uuid:${crypto.randomUUID()}`);
    }
    const url = new URL("/api/chatgpt/connect", baseUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname))) {
      throw new Error("ChatGPT connections require HTTPS or a local development server.");
    }
    // Fragments never reach HTTP logs. The helper presents this capability in POST bodies only.
    url.hash = new URLSearchParams({ user: this.userId, ticket }).toString();
    return { connectUrl: url.href };
  }

  async #pending(ticket: string): Promise<PendingChatGptConnect> {
    const hash = await hashPresentedSecret(ticket);
    const pending = this.storage.pendingChatGptConnect.get();
    if (!pending || pending.expiresAt <= Date.now() || pending.ticketHash !== hash) {
      throw new Error("This ChatGPT connection expired or was already used. Start again in AI Providers.");
    }
    return pending;
  }

  async authorize(ticket: string, port: number): Promise<string> {
    const pending = await this.#pending(ticket);
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || pending.redirectUri) {
      throw new Error("Invalid or already started local callback.");
    }
    pending.redirectUri = `http://127.0.0.1:${port}/auth/callback`;
    this.storage.pendingChatGptConnect.put(pending);
    const challenge = new Uint8Array(await crypto.subtle.digest("SHA-256",
        new TextEncoder().encode(pending.verifier)));
    const account = pending.accountId ? this.storage.chatGptAccounts.get()[pending.accountId] : undefined;
    if (pending.accountId && !account) throw new Error("This ChatGPT account was disconnected.");
    const url = new URL(`${ISSUER}/api/accounts/authorize`);
    url.search = new URLSearchParams({
      client_id: account?.clientId ?? "dynamic_agent_client",
      ...(account ? {} : { agent_name_hint: "Cloudflare OS" }),
      ext_agent_host_id: this.storage.chatGptHostId.get(),
      response_type: "code", redirect_uri: pending.redirectUri, resource: RESOURCE,
      scope: SCOPES, state: pending.state, nonce: pending.nonce,
      code_challenge_method: "S256",
      code_challenge: btoa(String.fromCharCode(...challenge)).replace(/\+/g, "-")
          .replace(/\//g, "_").replace(/=+$/, ""),
      ...(account ? { prompt: "consent" } : {}),
    }).toString();
    return url.href;
  }

  async complete(ticket: string, callback: string): Promise<void> {
    const pending = await this.#pending(ticket);
    const url = new URL(callback);
    if (!pending.redirectUri || url.origin + url.pathname !== pending.redirectUri ||
        url.searchParams.get("state") !== pending.state) {
      throw new Error("ChatGPT callback verification failed.");
    }
    // Consume before the first network await. A code is never exchanged twice.
    this.storage.pendingChatGptConnect.put(null);
    if (url.searchParams.has("error")) throw new Error("ChatGPT sign-in was declined. Try again in AI Providers.");
    const accounts = this.storage.chatGptAccounts.get();
    const previous = pending.accountId ? accounts[pending.accountId] : undefined;
    if (pending.accountId && !previous) throw new Error("This ChatGPT account was disconnected.");
    const clientId = url.searchParams.get("client_id") ?? previous?.clientId;
    const code = url.searchParams.get("code");
    if (!clientId || clientId === "dynamic_agent_client" || !code ||
        (previous && clientId !== previous.clientId)) {
      throw new Error("ChatGPT registration did not return the expected client ID and code.");
    }
    const tokens = await tokenRequest(new URLSearchParams({
      grant_type: "authorization_code", client_id: clientId, code,
      code_verifier: pending.verifier, redirect_uri: pending.redirectUri, resource: RESOURCE,
    }));
    if (!tokens.id_token) throw new Error("ChatGPT did not return an identity token.");
    const { payload } = await jwtVerify(tokens.id_token, JWKS, {
      issuer: ISSUER, audience: clientId, requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5,
    });
    if (!payload.sub || payload.nonce !== pending.nonce ||
        (previous && payload.sub !== previous.subject)) {
      throw new Error("ChatGPT identity verification failed.");
    }
    const scopes = tokens.scope?.split(/\s+/).filter(Boolean) ?? [];
    if (scopes.includes(PLAN_SCOPE) && (!tokens.access_token || !tokens.expires_in)) {
      throw new Error("ChatGPT did not return usable plan credentials.");
    }
    const session: ChatGptSession = {
      id: previous?.id ?? crypto.randomUUID(), clientId, subject: payload.sub,
      label: typeof payload.email === "string" ? payload.email :
          typeof payload.name === "string" ? payload.name : "ChatGPT account",
      accessToken: tokens.access_token ?? "", refreshToken: tokens.refresh_token ?? "", idToken: tokens.id_token,
      scopes, expiresAt: Date.now() + (tokens.expires_in ?? 0) * 1000, needsReauthentication: false,
      connectedAt: Date.now(), models: [],
    };
    const current = this.storage.chatGptAccounts.get();
    if (previous && current[previous.id]?.refreshToken !== previous.refreshToken) {
      throw new Error("ChatGPT account changed while signing in. Start again.");
    }
    this.storage.chatGptAccounts.put({ ...current, [session.id]: session });
    // Preserve the verified registration even if catalog loading fails. It can be refreshed from
    // settings without spending another authorization code or losing the newly issued client ID.
    if (session.scopes.includes(PLAN_SCOPE)) await this.refreshModels(session.id);
  }

  async accessToken(accountId: string): Promise<string> {
    let session = this.storage.chatGptAccounts.get()[accountId];
    if (!session || session.needsReauthentication || !session.scopes.includes(PLAN_SCOPE)) {
      throw new Error("ChatGPT plan access is unavailable. Reconnect from AI Providers.");
    }
    if (session.expiresAt <= Date.now() + 60_000) {
      let refresh = this.#refreshes.get(accountId);
      if (!refresh) {
        refresh = this.#refresh(session).finally(() => this.#refreshes.delete(accountId));
        this.#refreshes.set(accountId, refresh);
      }
      session = await refresh;
    }
    if (!session.scopes.includes(PLAN_SCOPE)) throw new Error("ChatGPT plan permission was removed. Reconnect from AI Providers.");
    return session.accessToken;
  }

  async #refresh(session: ChatGptSession): Promise<ChatGptSession> {
    const tokens = await tokenRequest(new URLSearchParams({
      grant_type: "refresh_token", client_id: session.clientId,
      refresh_token: session.refreshToken, resource: RESOURCE,
    })).catch(error => {
      if (error instanceof TokenRequestError && [400, 401].includes(error.status)) {
        const accounts = this.storage.chatGptAccounts.get();
        if (accounts[session.id]?.refreshToken === session.refreshToken) {
          this.storage.chatGptAccounts.put({ ...accounts,
            [session.id]: { ...session, needsReauthentication: true } });
        }
      }
      throw error;
    });
    if (!tokens.access_token || !tokens.refresh_token || !tokens.expires_in) {
      throw new Error("ChatGPT returned incomplete refresh credentials. Reconnect from AI Providers.");
    }
    const accounts = this.storage.chatGptAccounts.get();
    if (accounts[session.id]?.refreshToken !== session.refreshToken) {
      throw new Error("ChatGPT account changed while refreshing.");
    }
    const updated = { ...session, accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token, idToken: tokens.id_token ?? session.idToken,
      scopes: tokens.scope === undefined ? session.scopes : tokens.scope.split(/\s+/).filter(Boolean),
      expiresAt: Date.now() + tokens.expires_in * 1000 };
    this.storage.chatGptAccounts.put({ ...accounts, [session.id]: updated });
    return updated;
  }

  async refreshModels(accountId: string): Promise<void> {
    const accessToken = await this.accessToken(accountId);
    const models = await modelCatalog(accessToken);
    const accounts = this.storage.chatGptAccounts.get();
    if (accounts[accountId]?.accessToken !== accessToken) throw new Error("ChatGPT account changed. Try again.");
    this.storage.chatGptAccounts.put({ ...accounts, [accountId]: { ...accounts[accountId], models } });
  }

  async disconnect(accountId: string): Promise<{ revoked: boolean }> {
    const accounts = this.storage.chatGptAccounts.get();
    const session = accounts[accountId];
    delete accounts[accountId];
    this.storage.chatGptAccounts.put(accounts);
    if (this.storage.pendingChatGptConnect.get()?.accountId === accountId) {
      this.storage.pendingChatGptConnect.put(null);
    }
    if (!session) return { revoked: true };
    try {
      const discovery = await fetch(`${ISSUER}/.well-known/openid-configuration`, {
        redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
      if (!discovery.ok) return { revoked: false };
      const parsed = z.object({ revocation_endpoint: z.string().url() }).safeParse(await discovery.json());
      if (!parsed.success || new URL(parsed.data.revocation_endpoint).origin !== ISSUER) return { revoked: false };
      const response = await fetch(parsed.data.revocation_endpoint, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: session.refreshToken,
          token_type_hint: "refresh_token", client_id: session.clientId }),
      });
      return { revoked: response.status === 200 };
    } catch {
      return { revoked: false };
    }
  }
}

/** Stable, account-scoped Workshop model ID, never used as the provider's model slug. */
export function chatGptModelId(accountId: string, slug: string): string {
  return `chatgpt/${accountId}/${slug}`;
}

const connectRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("authorize"), user: z.string().length(64),
    ticket: z.string().length(64), port: z.number().int().min(1024).max(65535) }),
  z.object({ action: z.literal("complete"), user: z.string().length(64),
    ticket: z.string().length(64), callback: z.string().max(16_384) }),
]);

/** Handle the local helper's bounded POST; the single-use ticket grants only this connection. */
export async function chatGptConnectRequest(request: Request,
    users: DurableObjectNamespace<import("./user.js").UserDurableObject>): Promise<Response> {
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers });
  if (request.headers.has("Origin")) return new Response("Use the local sign-in helper", { status: 403, headers });
  // Read a bounded stream rather than relying on Content-Length, which a caller can omit.
  let body = "";
  const reader = request.body?.getReader();
  if (!reader) return new Response("Missing body", { status: 400, headers });
  try {
    let bytes = 0;
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 24_000) {
        await reader.cancel();
        return new Response("Request too large", { status: 413, headers });
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    const input = connectRequest.parse(JSON.parse(body));
    const user = users.get(users.idFromString(input.user));
    if (input.action === "authorize") {
      return Response.json({ url: await user.authorizeChatGptConnect(input.ticket, input.port) }, { headers });
    }
    await user.completeChatGptConnect(input.ticket, input.callback);
    return Response.json({ connected: true }, { headers });
  } catch {
    return new Response("ChatGPT connection failed. Start again from AI Providers and approve ChatGPT plan access.",
        { status: 400, headers });
  } finally {
    reader.releaseLock();
  }
}
