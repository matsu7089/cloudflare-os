import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Parse the short-lived connection capability copied from the authenticated AI Providers page. */
export function parseChatGptConnectUrl(value: string) {
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname))) || url.username || url.password ||
      url.pathname !== "/api/chatgpt/connect" || url.search) {
    throw new Error("Use the connection URL provided by your Cloudflare OS AI Providers page.");
  }
  const fragment = new URLSearchParams(url.hash.slice(1));
  const user = fragment.get("user");
  const ticket = fragment.get("ticket");
  if (!user || !ticket || !/^[a-f0-9]{64}$/.test(user) || !/^[a-f0-9]{64}$/.test(ticket)) {
    throw new Error("Invalid connection capability. Start again from AI Providers.");
  }
  url.hash = "";
  return { endpoint: url.href, user, ticket };
}

/** Run the loopback listener on the browser's computer; OAuth tokens remain on the Worker. */
export async function chatGptLogin(connectUrl: string): Promise<void> {
  const { endpoint, user, ticket } = parseChatGptConnectUrl(connectUrl);
  console.log(`Connecting ChatGPT to ${new URL(endpoint).origin}`);
  const signal = AbortSignal.timeout(10 * 60_000);
  const post = async (data: Record<string, unknown>) => {
    const response = await fetch(endpoint, {
      method: "POST", redirect: "error", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, user, ticket }), signal,
    });
    if (!response.ok) throw new Error(`Connection failed (${response.status}). Start again from AI Providers. ` +
      "For Cloudflare Access deployments, allow the /api/chatgpt/connect helper endpoint.");
    return response.json() as Promise<{ url?: string; connected?: boolean }>;
  };
  let expectedState: string | undefined;
  let callbackInFlight = false;
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const completed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  // Attach a handler immediately; a listener error can precede awaiting `completed`.
  void completed.catch(() => {});
  const server = createServer((request, response) => {
    const callback = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    if (request.method !== "GET" || callback.pathname !== "/auth/callback" ||
        !expectedState || callback.searchParams.get("state") !== expectedState || callbackInFlight) {
      response.writeHead(400).end("Invalid or already used ChatGPT callback.");
      return;
    }
    callbackInFlight = true;
    const address = server.address();
    if (!address || typeof address === "string") return;
    const callbackUrl = `http://127.0.0.1:${address.port}/auth/callback${callback.search}`;
    void post({ action: "complete", callback: callbackUrl }).then(result => {
      if (!result.connected) throw new Error("The server did not confirm the connection.");
      response.end("ChatGPT connected. Return to Cloudflare OS AI Providers to choose a model.", finish);
    }).catch(() => {
      response.writeHead(400).end("ChatGPT connection failed. Start again from AI Providers.");
      fail(new Error("ChatGPT sign-in failed. Start again from AI Providers and approve plan access."));
    });
  });
  const onAbort = () => fail(new Error("ChatGPT sign-in timed out. Start again from AI Providers."));
  signal.addEventListener("abort", onAbort, { once: true });
  server.on("error", fail);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not open the loopback listener.");
    const result = await post({ action: "authorize", port: address.port });
    const authorization = new URL(result.url ?? "");
    if (authorization.origin !== "https://auth.openai.com" ||
        authorization.pathname !== "/api/accounts/authorize") {
      throw new Error("The server returned an unexpected authorization endpoint.");
    }
    expectedState = authorization.searchParams.get("state") ?? undefined;
    console.log("Complete sign-in in your browser. If it does not open, visit:\n" + authorization.href);
    const command = process.platform === "darwin" ? "open" :
      process.platform === "win32" ? "rundll32" : "xdg-open";
    const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", authorization.href] : [authorization.href];
    const browser = spawn(command, args, { stdio: "ignore" });
    browser.on("error", () => {});
    browser.unref();
    await completed;
    console.log("ChatGPT connected. Return to AI Providers and select Check connection.");
  } finally {
    signal.removeEventListener("abort", onAbort);
    server.close();
    server.closeAllConnections();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf("--connect");
  const connectUrl = index >= 0 ? process.argv[index + 1] : undefined;
  if (!connectUrl) {
    console.error("Usage: pnpm chatgpt:login --connect '<connection URL from AI Providers>'");
    process.exitCode = 1;
  } else {
    chatGptLogin(connectUrl).catch(error => {
      console.error(error instanceof Error ? error.message : "ChatGPT connection failed.");
      process.exitCode = 1;
    });
  }
}
