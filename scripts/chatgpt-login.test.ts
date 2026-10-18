import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChatGptConnectUrl } from "./chatgpt-login.ts";

const fragment = `#user=${"a".repeat(64)}&ticket=${"b".repeat(64)}`;

test("connection capabilities are removed from the HTTP endpoint and limited to a known path", () => {
  assert.deepEqual(parseChatGptConnectUrl(`https://os.example/api/chatgpt/connect${fragment}`), {
    endpoint: "https://os.example/api/chatgpt/connect", user: "a".repeat(64), ticket: "b".repeat(64),
  });
  assert.equal(parseChatGptConnectUrl(`http://127.0.0.1:8787/api/chatgpt/connect${fragment}`).endpoint,
    "http://127.0.0.1:8787/api/chatgpt/connect");
  for (const url of [
    `http://remote.example/api/chatgpt/connect${fragment}`,
    `https://user:pass@os.example/api/chatgpt/connect${fragment}`,
    `https://os.example/other${fragment}`,
    `https://os.example/api/chatgpt/connect?ticket=secret${fragment}`,
    "https://os.example/api/chatgpt/connect#user=bad&ticket=bad",
  ]) assert.throws(() => parseChatGptConnectUrl(url));
});
