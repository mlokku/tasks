# Task Tracker

Personal task tracker for general tasks, recurring daily tasks, and hierarchical
project work (Project → Milestone → Task) with dependencies, a priority-ordered
work queue, timezone-aware daily resets, and passkey authentication.

The **backend is a Django app**; the **frontend is the existing React/Vite SPA**
(unchanged) served by Django from `dist/`.

## Architecture

```
tasktracker/      Django project (settings, urls, wsgi/asgi)
tracker/          The app
  models.py       Relational schema (Project, Milestone, ProjectTask,
                  TaskDependency, GeneralTask, DailyTask, InboxMessage,
                  InboxTask, ApiKey, Passkey, Settings, PendingChallenge)
  state.py        AppState JSON  <->  relational rows (serialize / diff-sync)
  auth.py         WebAuthn passkeys (py_webauthn) + JWT session cookie (PyJWT)
  views.py        HTTP endpoints + compiled-SPA serving with history fallback
  urls.py         Route table
  management/commands/
    seed.py          Initial sample workspace
    import_legacy.py Migrate the old single-blob SQLite DB into the new schema
src/, dist/       React frontend source + compiled bundle (served as-is)
```

### Why this layout

The previous Node/Express backend stored the **entire** application state as one
JSON document in a single `app_state` row and shipped it whole over
`GET/PUT /api/state`. This rewrite stores everything **relationally** — real
foreign keys from milestones to projects and tasks to milestones, a
`task_dependency` join table, and a row per entity. Client-minted string ids
(`project-task-1`, `general-…`) are preserved as primary keys so the React UI
keeps working byte-for-byte.

`GET /api/state` assembles the `AppState` document from the relational tables;
`PUT /api/state` diffs the document back into rows inside one transaction
(upsert present, delete absent, rewire dependencies). The JSON shape is only a
wire format — it is never stored.

## Running locally

```bash
./scripts/run.sh        # venv + deps + migrate + seed/import + gunicorn on :8000
```

Or manually:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python manage.py migrate
python manage.py import_legacy --if-empty   # bring over old data if present...
python manage.py seed                        # ...otherwise seed sample data
python manage.py runserver 0.0.0.0:8000      # or: gunicorn tasktracker.wsgi
```

Rebuild the frontend (only needed if you change `src/`):

```bash
npm install && npm run build   # outputs to dist/
```

## API

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| GET | `/api/health` | – | Liveness |
| GET/PUT | `/api/state` | session | Whole-workspace load / save |
| GET | `/api/auth/status` | – | `{authenticated, bootstrapMode}` |
| POST | `/api/auth/register/options`/`verify` | bootstrap or session | Register a passkey |
| POST | `/api/auth/authenticate/options`/`verify` | – | Sign in with a passkey |
| POST | `/api/auth/logout` | – | Clear session |
| GET/DELETE | `/api/auth/passkeys[/<id>]` | session | Manage passkeys |
| POST | `/api/message` | API key | Drop a message in the inbox |
| POST | `/api/task` | API key | Drop a task in the inbox |
| GET | `/api/projects[/<id>]` | API key | Read projects / a project's tasks |

API keys (managed in Settings) are sent as `Authorization: Bearer <key>` or
`X-Api-Key: <key>`.

## Configuration

See `.env.example`. Notable variables: `DATABASE_PATH`, `JWT_SECRET`,
`WEBAUTHN_RP_ID`, `WEBAUTHN_RP_ORIGIN`, `WEBAUTHN_RP_NAME`, `DEBUG`,
`DJANGO_SECRET_KEY`.

## Tests

```bash
python manage.py test tracker
```
