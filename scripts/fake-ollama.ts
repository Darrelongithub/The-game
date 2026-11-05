/**
 * A deterministic local stand-in for Ollama, used by tests and the verified
 * smoke. It reads the PLAN marker out of the request and writes valid lines
 * for that role. It is NOT part of the game's runtime: the production server
 * always talks to the real Ollama at GEN_BASE.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export function fakeOllamaContent(requestBody: string): string {
  const body = JSON.parse(requestBody) as { messages?: { role: string; content: string }[] };
  const user = body.messages?.find((m) => m.role === "user")?.content ?? "";
  const plan = /PLAN: ([a-z-]+)/.exec(user)?.[1] ?? "";
  const want = Number(/exactly (\d+)(?: JSON)? lines/.exec(user)?.[1] ?? 0);
  const lines: string[] = [];
  for (let i = 0; i < want; i++) {
    const n = i + 1;
    if (plan === "look-chain") {
      lines.push(JSON.stringify({
        announce: "Everybody look at {A}.",
        act: `Look at someone you would call at 3am. Flavour ${n}.`,
        guess: `Who is {A} calling at 3am? Flavour ${n}.`,
        why: `Why that one? Flavour ${n}.`,
      }));
    } else if (plan === "subject") {
      if (i % 3 === 0) lines.push(JSON.stringify({ kind: "pick", metric: "sex-desire", text: `Who would you take home tonight? Number ${n}.` }));
      else if (i % 3 === 1) lines.push(JSON.stringify({ kind: "rating", metric: "trust", text: `Rate your own patience from 1 to 10. Number ${n}.` }));
      else lines.push(JSON.stringify({ kind: "text", metric: "liar", text: `What is the worst lie you told this week? Number ${n}.` }));
    } else if (plan === "observer-subject") {
      lines.push(JSON.stringify({ kind: "pick", metric: "would-cheat", text: `Who is {P1} most likely to text at 2am? Number ${n}.` }));
    } else if (plan === "observer-pair") {
      lines.push(JSON.stringify({ kind: "text", metric: "couple-fit", text: `What do you think {P1} and {P2} fight about? Number ${n}.` }));
    } else if (plan === "solo") {
      lines.push(JSON.stringify({ kind: "text", text: `What is the filthiest thought you had today? Number ${n}.` }));
    } else if (plan === "ship-vote") {
      lines.push(JSON.stringify({ kind: "pair_vote", metric: "gay-hypothetical", text: `If {P1} and {P2} were gay, would they make a good couple? Number ${n}.` }));
    } else if (plan === "best-couple") {
      lines.push(JSON.stringify({ kind: "pair_pick", text: `Who do you think would make the best couple here? Number ${n}.` }));
    } else if (plan === "dare") {
      lines.push(JSON.stringify({ kind: "dare", text: `{P1}, read your last text out loud. Dare ${n}.` }));
    } else if (plan === "dare-watch") {
      lines.push(JSON.stringify({ kind: "text", text: `Look at {P1} and {P2}. They were just given a dare. Do you think they will do it? Number ${n}.` }));
    }
  }
  return lines.join("\n");
}

export interface FakeOllama {
  url: string;
  close(): Promise<void>;
}

/** Start a real HTTP server that speaks the native Ollama response shape. */
export async function startFakeOllama(port = 0): Promise<FakeOllama> {
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      try {
        const content = fakeOllamaContent(raw);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: { role: "assistant", content } }));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
