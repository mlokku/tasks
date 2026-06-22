import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getState, openDatabase, saveState } from "./database.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || "0.0.0.0";

const db = openDatabase();
const app = express();

app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/state", (_request, response) => {
  response.json(getState(db));
});

app.put("/api/state", (request, response) => {
  if (!request.body || typeof request.body !== "object") {
    response.status(400).json({ error: "State payload must be an object." });
    return;
  }
  response.json(saveState(db, request.body));
});

app.use(express.static(distDir));
app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(distDir, "index.html"));
});

const server = app.listen(port, host, () => {
  console.log(`Task Tracker listening at http://localhost:${port}/`);
});

function shutdown(signal) {
  console.log(`\nReceived ${signal}; shutting down server...`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
