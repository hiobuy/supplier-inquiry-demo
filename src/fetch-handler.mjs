import { Readable, Writable } from "node:stream";

/** Adapt the shared bounded handler without listening ports or persistent HTTP servers. */
export async function handleFetch(core, request) {
  const url = new URL(request.url), headers = new Headers();
  const req = request.body ? Readable.fromWeb(request.body) : Readable.from([]);
  req.headers = Object.fromEntries(request.headers);
  req.headers.host = url.host;
  req.method = request.method;
  req.url = url.pathname + url.search;
  req.complete = false;
  req.on("end", () => { req.complete = true; });
  let status = 200, size = 0;
  const chunks = [];
  return new Promise((resolve) => {
    let done = false;
    const res = new Writable({
      write(chunk, _encoding, next) {
        size += chunk.length;
        if (size > 24 * 1024 * 1024) { next(new Error("Response too large")); return; }
        chunks.push(Buffer.from(chunk)); next();
      },
    });
    res.headersSent = false;
    res.setHeader = (name,value) => headers.set(name,String(value));
    res.writeHead = (code, values = {}) => {
      status = code;
      for (const [name,value] of Object.entries(values)) headers.set(name,String(value));
      res.headersSent = true; return res;
    };
    res.once("finish", () => {
      done = true; req.destroy();
      resolve(new Response(request.method === "HEAD" || [204,304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
    });
    res.once("error", () => {
      if (done) return; done = true; req.destroy();
      resolve(Response.json({error:{code:"INTERNAL_ERROR",message:"Request could not complete."}},{status:500}));
    });
    res.once("close", () => {
      if (done) return; done = true; req.destroy();
      resolve(Response.json({error:{code:"INTERNAL_ERROR",message:"Request could not complete."}},{status:500}));
    });
    core.onRequest(req,res);
  });
}
