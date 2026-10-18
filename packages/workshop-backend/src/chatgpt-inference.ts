import type { FetchFunction } from "@earendil-works/pi-ai";

const UNSUPPORTED_FIELDS = [
  "background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation",
  "multi_agent", "prompt", "prompt_cache_retention", "prompt_cache_options", "safety_identifier",
  "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id",
];

/** Apply the public ChatGPT plan Responses contract at the final HTTP boundary. */
export function chatGptFetch(accessToken: () => Promise<string>, transport: FetchFunction = fetch): FetchFunction {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== "https://api.openai.com/v1/responses" || request.method !== "POST") {
      throw new Error("ChatGPT plan credentials can only be sent to the official Responses API.");
    }
    const payload: Record<string, unknown> = await request.json();
    for (const field of UNSUPPORTED_FIELDS) delete payload[field];
    payload.store = false;
    payload.stream = true;
    if (!Array.isArray(payload.input)) throw new Error("ChatGPT requires an input array.");
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    if (tools.some(tool => tool.type !== "function" && tool.type !== "custom")) {
      throw new Error("This tool is unavailable with ChatGPT plan access.");
    }
    // This route accepts local function/custom tools in namespaces. pi preserves the returned
    // namespace on subsequent tool calls, while tool results continue to use their call IDs.
    payload.tools = tools.length ? [{ type: "namespace", name: "cloudflare_os",
      description: "Cloudflare OS workspace tools", tools }] : undefined;
    const toolNames = new Set(tools.map(tool => tool.name));
    payload.input = payload.input.map(item => {
      if (item.role === "system") return { ...item, role: "developer" };
      if ((item.type === "function_call" || item.type === "custom_tool_call") && toolNames.has(item.name)) {
        return { ...item, namespace: "cloudflare_os" };
      }
      return item;
    });
    const headers = new Headers(request.headers);
    headers.delete("cf-aig-authorization");
    headers.delete("cf-aig-metadata");
    headers.set("Authorization", `Bearer ${await accessToken()}`);
    headers.set("Content-Type", "application/json");
    return transport(new Request(request, { method: "POST", headers,
      body: JSON.stringify(payload), redirect: "manual" }));
  };
}
