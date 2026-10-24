const { app, net } = require("electron");
const http = require("node:http");
const assert = require("node:assert/strict");
const {
  createUpdateFetch,
} = require("../../electron/domains/update/update-fetch.cjs");
const { once } = require("node:events");
process.on("uncaughtException", (error) => {
  console.error(error.stack);
  app.exit(1);
});
process.on("unhandledRejection", (error) => {
  console.error(error.stack);
  app.exit(1);
});
app
  .whenReady()
  .then(async () => {
    const requests = [];
    const server = http.createServer((request, response) => {
      requests.push({ url: request.url, auth: request.headers.authorization });
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/asset" });
        response.end();
      } else if (request.url === "/slow") {
        /* 由取消测试中止连接。 */
      } else {
        response.writeHead(200, { "content-length": "10" });
        response.write("hello");
        response.end("world");
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const fetch = createUpdateFetch(net);
      const redirect = await fetch(base + "/redirect", {
        redirect: "manual",
        headers: { Authorization: "Bearer fixture-only" },
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(redirect.status, 302);
      assert.equal(redirect.headers.get("location"), base + "/asset");
      assert.equal(
        requests.length,
        1,
        "manual request must not automatically follow with credentials",
      );
      const asset = await fetch(base + "/asset", {
        redirect: "manual",
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(await asset.text(), "helloworld");
      assert.equal(requests[1].auth, undefined);
      const cancellation = new AbortController();
      const cancellationTimer = setTimeout(() => cancellation.abort(), 30);
      try {
        await assert.rejects(
          fetch(base + "/slow", {
            redirect: "manual",
            signal: cancellation.signal,
          }),
        );
      } finally {
        clearTimeout(cancellationTimer);
      }
      console.log(
        "PASS Electron updater transport: manual redirect, streamed bytes, no redirected credentials, cancellation",
      );
    } finally {
      server.closeAllConnections();
      server.close();
    }
  })
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error.message);
    app.exit(1);
  });
