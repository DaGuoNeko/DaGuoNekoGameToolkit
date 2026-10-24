function createUpdateFetch(net) {
  return (url, options = {}) => {
    if (options.redirect !== "manual") return net.fetch(url, options);
    // net.fetch 会把 manual 重定向作为取消错误；ClientRequest 才能读取重定向目标。
    return new Promise((resolve, reject) => {
      const request = net.request({
        url: String(url),
        method: options.method || "GET",
        redirect: "manual",
      });
      for (const [key, value] of Object.entries(options.headers || {}))
        request.setHeader(key, value);
      let controller,
        done = false;
      const cleanup = () => options.signal?.removeEventListener("abort", abort);
      const fail = (error) => {
        cleanup();
        if (!done) {
          done = true;
          controller?.error(error);
        }
        reject(error);
      };
      const abort = () => {
        fail(options.signal.reason || Error("请求已取消"));
        request.abort();
      };
      request.on("error", fail);
      // ClientRequest 的 close 可能先于 response，取消监听要留到响应完成。
      request.on("redirect", (status, method, location) => {
        resolve(new Response(null, { status, headers: { location } }));
        done = true;
        cleanup();
        // 终止旧请求，由服务校验 URL 并以不携带令牌的新请求下载资产。
        request.abort();
      });
      request.on("response", (response) => {
        const headers = new Headers();
        for (const [key, values] of Object.entries(response.headers)) {
          for (const value of [].concat(values)) headers.append(key, value);
        }
        const body = new ReadableStream({
          start(value) {
            controller = value;
            response.once("end", () => {
              if (!done) {
                done = true;
                cleanup();
                controller.close();
              }
            });
            response.once("error", fail);
            response.once("aborted", () => fail(Error("更新下载已中断")));
            response.on("data", (chunk) => {
              if (done) return;
              controller.enqueue(chunk);
              if (controller.desiredSize <= 0) response.pause?.();
            });
          },
          pull() {
            response.resume?.();
          },
          cancel() {
            done = true;
            cleanup();
            request.abort();
          },
        });
        resolve(new Response(body, { status: response.statusCode, headers }));
      });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      request.end(options.body);
    });
  };
}

module.exports = { createUpdateFetch };
