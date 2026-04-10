import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { z } from "zod";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const EnvSchema = z
  .object({
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().positive().default(4312),
    API_ORIGIN: z.string().url().default("http://127.0.0.1:4311"),
    WEB_DIST_DIR: z.string().default(path.resolve(process.cwd(), "apps/web/dist")),
  })
  .strict();

const env = EnvSchema.parse({
  HOST: process.env["HOST"],
  PORT: process.env["PORT"],
  API_ORIGIN: process.env["API_ORIGIN"],
  WEB_DIST_DIR: process.env["WEB_DIST_DIR"],
});

function getContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return contentTypes[extension] ?? "application/octet-stream";
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: object,
): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function resolveAssetPath(requestPath: string): string {
  const trimmedPath = requestPath.startsWith("/")
    ? requestPath.slice(1)
    : requestPath;
  const candidatePath = path.resolve(env.WEB_DIST_DIR, trimmedPath);
  const normalizedRoot = path.resolve(env.WEB_DIST_DIR);
  if (!candidatePath.startsWith(normalizedRoot)) {
    return path.join(env.WEB_DIST_DIR, "index.html");
  }

  if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
    return candidatePath;
  }

  return path.join(env.WEB_DIST_DIR, "index.html");
}

function proxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestPath: string,
): void {
  const upstreamUrl = new URL(requestPath, `${env.API_ORIGIN}/`);
  const proxyTransport = upstreamUrl.protocol === "https:" ? https : http;
  const proxyRequest = proxyTransport.request(
    {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port,
      path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
      method: req.method,
      headers: req.headers,
    },
    (proxyResponse) => {
      const headers: Record<string, string | string[]> = {};
      for (const [headerName, headerValue] of Object.entries(proxyResponse.headers)) {
        if (headerValue === undefined) {
          continue;
        }
        headers[headerName] = headerValue;
      }

      res.writeHead(proxyResponse.statusCode ?? 502, headers);
      proxyResponse.pipe(res);
    },
  );

  proxyRequest.on("error", (error) => {
    sendJson(res, 502, {
      ok: false,
      error: {
        code: "proxyFailed",
        message: error.message,
      },
    });
  });

  req.pipe(proxyRequest);
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    sendJson(res, 400, {
      ok: false,
      error: {
        code: "missingUrl",
        message: "Missing request URL",
      },
    });
    return;
  }

  const url = new URL(req.url, `http://${env.HOST}:${String(env.PORT)}`);
  if (url.pathname.startsWith("/api/") || url.pathname === "/events" || url.pathname === "/api") {
    proxyRequest(req, res, req.url);
    return;
  }

  const assetPath = resolveAssetPath(url.pathname === "/" ? "/index.html" : url.pathname);
  try {
    const body = fs.readFileSync(assetPath);
    res.writeHead(200, {
      "Content-Type": getContentType(assetPath),
      "Content-Length": body.length,
      "Cache-Control": assetPath.endsWith("index.html")
        ? "no-cache"
        : "public, max-age=31536000, immutable",
    });
    res.end(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, {
      ok: false,
      error: {
        code: "staticReadFailed",
        message,
      },
    });
  }
});

server.listen(
  {
    host: env.HOST,
    port: env.PORT,
    exclusive: true,
  },
  () => {
    process.stdout.write(
      `Farfield web-host listening on http://${env.HOST}:${String(env.PORT)}\n`,
    );
  },
);
