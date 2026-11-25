import {createServer} from "node:http";
import {Readable} from "node:stream";
import {pipeline} from "node:stream/promises";

if (process.argv.includes("--build")) await import("./build.mjs");
const {default: worker} = await import("../dist/server/index.js");

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || (process.argv.includes("--build") ? "0.0.0.0" : "127.0.0.1");
const publicUrl = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN) : null;
if (publicUrl && (!/^https?:$/.test(publicUrl.protocol) || publicUrl.href !== publicUrl.origin + "/")) {
  throw new Error("PUBLIC_ORIGIN must be an HTTP(S) origin without a path, query, or credentials");
}

const server = createServer(async (request, response) => {
  try {
    const origin = publicUrl?.origin || "http://" + request.headers.host;
    const url = new URL(request.url, origin);
    if (!request.url.startsWith("/") || url.origin !== new URL(origin).origin) {
      response.writeHead(400).end();
      return;
    }
    const result = await worker.fetch(new Request(url, {method: request.method, headers: request.headers}), process.env);
    response.statusCode = result.status;
    for (const [key, value] of result.headers) if (key !== "set-cookie") response.setHeader(key, value);
    const cookies = result.headers.getSetCookie();
    if (cookies.length) response.setHeader("set-cookie", cookies);
    if (result.body) await pipeline(Readable.fromWeb(result.body), response);
    else response.end();
  } catch {
    if (response.headersSent) response.destroy();
    else if (!response.destroyed) response.writeHead(500).end();
  }
});

server.listen(port, host, () => console.log("Breeze is listening on port " + server.address().port));
