import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export const defaultDatabasePath = path.resolve("data/task-tracker.sqlite");

export function openDatabase(databasePath = process.env.DATABASE_PATH || defaultDatabasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  seed(db);
  return db;
}

export function getState(db) {
  const row = db.prepare("SELECT data FROM app_state WHERE id = 1").get();
  const state = row ? JSON.parse(row.data) : createInitialState();
  const resetState = applyDailyReset(state);
  if (resetState !== state) saveState(db, resetState);
  return resetState;
}

export function saveState(db, state) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO app_state (id, data, updated_at)
    VALUES (1, @data, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      data = excluded.data,
      updated_at = excluded.updated_at
  `).run({ data: JSON.stringify(state), updatedAt: now });
  return state;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS passkeys (
      id         TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      counter    INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      name       TEXT NOT NULL DEFAULT 'Passkey',
      created_at TEXT NOT NULL
    );
  `);
}

export function listPasskeys(db) {
  return db.prepare("SELECT * FROM passkeys ORDER BY created_at").all();
}

export function savePasskey(db, passkey) {
  db.prepare(`
    INSERT INTO passkeys (id, public_key, counter, transports, name, created_at)
    VALUES (@id, @public_key, @counter, @transports, @name, @created_at)
  `).run(passkey);
}

export function updatePasskeyCounter(db, id, newCounter) {
  db.prepare("UPDATE passkeys SET counter = ? WHERE id = ?").run(newCounter, id);
}

export function deletePasskey(db, id) {
  db.prepare("DELETE FROM passkeys WHERE id = ?").run(id);
}

export function passkeyCount(db) {
  return db.prepare("SELECT COUNT(*) as n FROM passkeys").get().n;
}

function seed(db) {
  const existing = db.prepare("SELECT id FROM app_state WHERE id = 1").get();
  if (existing) return;
  saveState(db, createInitialState());
}

function zonedToday(timezone, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function applyDailyReset(state) {
  const today = zonedToday(state.settings.timezone);
  if (state.lastDailyResetDate === today) return state;
  return {
    ...state,
    lastDailyResetDate: today,
    dailyTasks: state.dailyTasks.map((task) => ({
      ...task,
      completed: false,
      completedOn: undefined
    }))
  };
}

function createInitialState() {
  const timezone = "America/Edmonton";
  const identityColors = [
    "#00C2A8",
    "#F97316",
    "#38BDF8",
    "#E11D48",
    "#8B5CF6",
    "#22C55E",
    "#F59E0B",
    "#EC4899"
  ];

  return {
    generalColor: identityColors[0],
    dailyColor: identityColors[1],
    settings: {
      timezone,
      theme: "dark"
    },
    lastDailyResetDate: zonedToday(timezone),
    inboxMessages: [],
    inboxTasks: [],
    apiKeys: [],
    generalTasks: [
      {
        id: "general-1",
        name: "Return supplier quote with chosen option",
        completed: false,
        urgency: "high",
        dueDate: "2026-06-24",
        notes: "Confirm price hold before replying."
      },
      {
        id: "general-2",
        name: "Order replacement label rolls",
        completed: false,
        urgency: "medium"
      }
    ],
    dailyTasks: [
      {
        id: "daily-1",
        name: "Check the dispatch box",
        completed: false,
        urgency: "high"
      },
      {
        id: "daily-2",
        name: "Review incoming requests",
        completed: false,
        urgency: "medium",
        notes: "Capture anything actionable as a general or project task."
      }
    ],
    projects: [
      {
        id: "project-1",
        name: "Warehouse Refresh",
        priority: 9,
        color: identityColors[2],
        notes: "Layout, labeling, and work queue cleanup.",
        milestones: [
          {
            id: "milestone-1",
            name: "Plan",
            tasks: [
              {
                id: "project-task-1",
                name: "Confirm aisle map changes",
                completed: false,
                urgency: "high",
                dueDate: "2026-06-25",
                notes: "Needed before labels are printed.",
                dependencyIds: []
              },
              {
                id: "project-task-2",
                name: "Approve final label format",
                completed: false,
                urgency: "medium",
                dependencyIds: ["project-task-1"]
              }
            ]
          },
          {
            id: "milestone-2",
            name: "Rollout",
            tasks: [
              {
                id: "project-task-3",
                name: "Print bin labels",
                completed: false,
                urgency: "high",
                dependencyIds: ["project-task-2"]
              },
              {
                id: "project-task-4",
                name: "Update picking checklist",
                completed: false,
                urgency: "low",
                dependencyIds: []
              }
            ]
          }
        ]
      },
      {
        id: "project-2",
        name: "Client Onboarding",
        priority: 6,
        color: identityColors[3],
        milestones: [
          {
            id: "milestone-3",
            name: "Setup",
            tasks: [
              {
                id: "project-task-5",
                name: "Create kickoff checklist",
                completed: false,
                urgency: "high",
                dependencyIds: []
              }
            ]
          }
        ]
      }
    ]
  };
}
