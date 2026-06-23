import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getState, openDatabase, saveState } from "./database.mjs";
import { createAuthRouter, requireAuth } from "./auth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || "0.0.0.0";

const db = openDatabase();
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(createAuthRouter(db));

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveApiKey(request) {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  const xKey = request.headers["x-api-key"];
  if (typeof xKey === "string") return xKey.trim();
  return null;
}

function validateApiKey(request) {
  const provided = resolveApiKey(request);
  if (!provided) return false;
  const state = getState(db);
  return Array.isArray(state.apiKeys) && state.apiKeys.some((k) => k.key === provided);
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/state", requireAuth, (_request, response) => {
  response.json(getState(db));
});

app.put("/api/state", requireAuth, (request, response) => {
  if (!request.body || typeof request.body !== "object") {
    response.status(400).json({ error: "State payload must be an object." });
    return;
  }
  response.json(saveState(db, request.body));
});

app.post("/api/message", (request, response) => {
  if (!validateApiKey(request)) {
    response.status(401).json({ error: "Invalid or missing API key." });
    return;
  }

  const body = request.body ?? {};
  const from = typeof body.from === "string" ? body.from.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (!from) {
    response.status(400).json({ error: '"from" is required.' });
    return;
  }
  if (!message) {
    response.status(400).json({ error: '"message" is required.' });
    return;
  }

  const state = getState(db);
  const newMessage = {
    id: uid("inbox"),
    from,
    message,
    receivedAt: new Date().toISOString(),
    read: false
  };

  saveState(db, {
    ...state,
    inboxMessages: [...(state.inboxMessages ?? []), newMessage]
  });

  response.status(201).json({ id: newMessage.id });
});

app.post("/api/task", (request, response) => {
  if (!validateApiKey(request)) {
    response.status(401).json({ error: "Invalid or missing API key." });
    return;
  }

  const body = request.body ?? {};

  const nameRaw = (
    (typeof body["task name"] === "string" ? body["task name"] : null) ??
    (typeof body.name === "string" ? body.name : null) ?? ""
  ).trim();

  if (!nameRaw) {
    response.status(400).json({ error: 'Task "name" or "task name" is required.' });
    return;
  }

  const urgencyRaw = body.urgency;
  const urgency = (urgencyRaw === "low" || urgencyRaw === "medium" || urgencyRaw === "high") ? urgencyRaw : "medium";

  const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : undefined;
  const dueDateRaw = (
    typeof body["due date"] === "string" ? body["due date"] :
    typeof body.dueDate === "string" ? body.dueDate :
    typeof body.due_date === "string" ? body.due_date : null
  );
  const dueDate = dueDateRaw?.trim() || undefined;

  const state = getState(db);
  const newTask = {
    id: uid("inbox-task"),
    name: nameRaw,
    urgency,
    receivedAt: new Date().toISOString(),
    ...(dueDate ? { dueDate } : {}),
    ...(notes ? { notes } : {})
  };

  saveState(db, {
    ...state,
    inboxTasks: [...(state.inboxTasks ?? []), newTask]
  });

  response.status(201).json({ id: newTask.id });
});

app.get("/api/projects", (request, response) => {
  if (!validateApiKey(request)) {
    response.status(401).json({ error: "Invalid or missing API key." });
    return;
  }
  const state = getState(db);
  const projects = (state.projects ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    priority: p.priority,
    color: p.color,
    ...(p.notes ? { notes: p.notes } : {})
  }));
  response.json({ projects });
});

app.get("/api/projects/:id", (request, response) => {
  if (!validateApiKey(request)) {
    response.status(401).json({ error: "Invalid or missing API key." });
    return;
  }
  const state = getState(db);
  const project = (state.projects ?? []).find((p) => p.id === request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found." });
    return;
  }
  const allTasks = project.milestones.flatMap((m) => m.tasks);
  const taskById = new Map(allTasks.map((t) => [t.id, t]));
  response.json({
    id: project.id,
    name: project.name,
    priority: project.priority,
    color: project.color,
    ...(project.notes ? { notes: project.notes } : {}),
    milestones: project.milestones.map((m) => ({
      id: m.id,
      name: m.name,
      ...(m.notes ? { notes: m.notes } : {}),
      tasks: m.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        completed: t.completed,
        urgency: t.urgency,
        ...(t.dueDate ? { dueDate: t.dueDate } : {}),
        ...(t.notes ? { notes: t.notes } : {}),
        dependencies: t.dependencyIds.map((depId) => {
          const dep = taskById.get(depId);
          return dep ? { id: depId, name: dep.name } : { id: depId };
        }),
        blockedBy: t.dependencyIds
          .map((depId) => taskById.get(depId))
          .filter((dep) => dep && !dep.completed)
          .map((dep) => ({ id: dep.id, name: dep.name })),
        blocking: allTasks
          .filter((other) => other.dependencyIds.includes(t.id) && !other.completed)
          .map((other) => ({ id: other.id, name: other.name }))
      }))
    }))
  });
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
