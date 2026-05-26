import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const port = Number.parseInt(process.env.PORT || "8787", 10);
const authDisabled = String(process.env.AUTH_DISABLED || "").toLowerCase() === "true";
const authUser = process.env.APP_USER || "pavelski";
const authPassword = process.env.APP_PASSWORD || "zope2026";
const authRealm = process.env.AUTH_REALM || "Pavelski Zope Map";

const mimeByExt = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

function getPathname(urlValue) {
  return decodeURIComponent(String(urlValue || "/").split("?")[0]);
}

function resolvePath(urlPathname) {
  const pathname = getPathname(urlPathname);
  const cleaned = pathname === "/" ? "/index.html" : pathname;
  const fullPath = path.normalize(path.join(publicDir, cleaned));

  if (!fullPath.startsWith(publicDir)) {
    return null;
  }

  return fullPath;
}

async function fileExists(targetPath) {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function parseBasicAuthHeader(headerValue) {
  if (!headerValue || typeof headerValue !== "string") {
    return null;
  }

  const [scheme, encoded] = headerValue.split(" ");
  if (scheme !== "Basic" || !encoded) {
    return null;
  }

  let decoded;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf-8");
  } catch {
    return null;
  }

  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return null;
  }

  return {
    user: decoded.slice(0, separator),
    password: decoded.slice(separator + 1)
  };
}

function isAuthorized(req) {
  if (authDisabled) {
    return true;
  }

  const parsed = parseBasicAuthHeader(req.headers.authorization);
  if (!parsed) {
    return false;
  }

  return parsed.user === authUser && parsed.password === authPassword;
}

function sendUnauthorized(res) {
  res.writeHead(401, {
    "Content-Type": "text/plain; charset=utf-8",
    "WWW-Authenticate": `Basic realm="${authRealm}", charset="UTF-8"`
  });
  res.end("Authentication required.");
}

const server = http.createServer(async (req, res) => {
  const method = req.method || "GET";
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
    return;
  }

  const pathname = getPathname(req.url || "/");

  if (pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  if (!isAuthorized(req)) {
    sendUnauthorized(res);
    return;
  }

  const resolved = resolvePath(req.url || "/");
  if (!resolved) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
    return;
  }

  let filePath = resolved;
  if (!(await fileExists(filePath))) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  const contentType = mimeByExt[extension] || "application/octet-stream";

  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType });

    if (method === "HEAD") {
      res.end();
      return;
    }

    res.end(content);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Internal Server Error");
  }
});

server.listen(port, "0.0.0.0", () => {
  const authStatus = authDisabled ? "disabled" : `enabled (user: ${authUser})`;
  console.log(`Pavelski Zope Map server listening on port ${port}; auth ${authStatus}`);
});
