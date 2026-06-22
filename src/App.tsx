import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { buildWorkQueue, blockedByNames, blockingNames } from "./prioritization";
import { createInitialState, identityColors } from "./sampleData";
import { loadState, saveState, uid, UnauthorizedError } from "./store";
import {
  listPasskeys,
  deletePasskey as deletePasskeyApi,
  performRegistration,
  type PasskeyInfo
} from "./auth";
import { dueSoon, isOverdue, minutesUntilMidnight, zonedToday } from "./time";
import { timezoneGroups, timezoneLabel } from "./timezones";
import { themeVars } from "./palette";
import type {
  ApiKey,
  AppState,
  DailyTask,
  GeneralTask,
  InboxMessage,
  InboxTask,
  Milestone,
  Project,
  ProjectTask,
  TaskBase,
  TaskRef,
  TaskStage,
  Urgency,
  View,
  WorkQueueItem
} from "./types";

const urgencyOptions: Urgency[] = ["low", "medium", "high"];

type EditorDraft = {
  name: string;
  urgency: Urgency;
  dueDate: string;
  notes: string;
  dependencyIds: string[];
};

type Toast = {
  id: string;
  message: string;
  tone: "success" | "danger" | "neutral";
};

type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  tone: "danger" | "primary";
  onConfirm: () => void;
};

type DependencyGroup = {
  id: string;
  name: string;
  tasks: { id: string; label: string }[];
};

type AddTaskTarget =
  | { kind: "general" }
  | { kind: "daily" }
  | { kind: "project"; projectId: string; milestoneId: string };

const emptyDraft: EditorDraft = {
  name: "",
  urgency: "medium",
  dueDate: "",
  notes: "",
  dependencyIds: []
};

const taskStageOptions: { value: Exclude<TaskStage, "notStarted">; label: string; tone: "blue" | "yellow" | "green" }[] = [
  { value: "inProgress", label: "In progress", tone: "blue" },
  { value: "waitingReview", label: "Waiting for review", tone: "yellow" },
  { value: "complete", label: "Complete", tone: "green" }
];

function viewToPath(view: View): string {
  if (view.type === "general") return "/general";
  if (view.type === "daily") return "/daily";
  if (view.type === "project") return `/projects/${view.projectId}`;
  if (view.type === "settings") return "/settings";
  return "/";
}

function viewFromPath(pathname: string): View {
  if (pathname === "/general") return { type: "general" };
  if (pathname === "/daily") return { type: "daily" };
  if (pathname.startsWith("/projects/")) {
    const projectId = pathname.slice("/projects/".length);
    if (projectId) return { type: "project", projectId };
  }
  if (pathname === "/settings") return { type: "settings" };
  return { type: "dashboard" };
}

export default function App({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [state, setState] = useState<AppState>(() => createInitialState());
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [selectedTask, setSelectedTask] = useState<TaskRef | null>(null);
  const [selectedInboxTask, setSelectedInboxTask] = useState<InboxTask | null>(null);
  const [editing, setEditing] = useState(false);
  const [addTarget, setAddTarget] = useState<AddTaskTarget | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [newProjectName, setNewProjectName] = useState("");
  const [newMilestoneName, setNewMilestoneName] = useState("");

  const navigateRouter = useNavigate();
  const location = useLocation();
  const view = viewFromPath(location.pathname);

  function setView(newView: View) {
    navigateRouter(viewToPath(newView));
    setSelectedTask(null);
    setAddTarget(null);
  }

  // Also clear panels on browser back/forward
  useEffect(() => {
    setSelectedTask(null);
    setAddTarget(null);
  }, [location.pathname]);

  useEffect(() => {
    let cancelled = false;
    loadState()
      .then((loadedState) => {
        if (cancelled) return;
        setState(loadedState);
        setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) { onUnauthorized(); return; }
        setState(createInitialState());
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const timeout = window.setTimeout(() => {
      saveState(state)
        .then(() => setSaveError(""))
        .catch((error) => {
          if (error instanceof UnauthorizedError) { onUnauthorized(); return; }
          console.error(error);
          setSaveError("Your changes could not be saved. Please try again.");
        });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [loaded, state]);

  const queue = useMemo(() => buildWorkQueue(state), [state]);
  const selectedDetails = selectedTask ? resolveTask(state, selectedTask) : null;
  const activeProject = view.type === "project" ? state.projects.find((project) => project.id === view.projectId) : null;
  const minsUntilReset = useMinutesUntilMidnight(state.settings.timezone);

  function showToast(message: string, tone: Toast["tone"] = "neutral") {
    const id = uid("toast");
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 3200);
  }

  function requestConfirm(request: ConfirmRequest) {
    setConfirmRequest(request);
  }

  function updateState(mutator: (current: AppState) => AppState) {
    setState((current) => mutator(current));
  }

  function openTask(ref: TaskRef) {
    setSelectedTask(ref);
    setEditing(false);
  }

  function setTaskStage(ref: TaskRef, stage: TaskStage) {
    updateState((current) => updateTask(current, ref, (task, context) => {
      if (context?.blockedBy.length) return task;
      const nextStage = taskStage(task) === stage ? "notStarted" : stage;
      return withTaskStage(task, nextStage, ref.kind === "daily" ? current.settings.timezone : undefined);
    }));
  }

  function saveTask(ref: TaskRef, draft: EditorDraft) {
    updateState((current) => updateTask(current, ref, (task) => ({
      ...task,
      name: draft.name.trim() || task.name,
      urgency: draft.urgency,
      dueDate: draft.dueDate || undefined,
      notes: draft.notes.trim() || undefined,
      ...(ref.kind === "project" ? { dependencyIds: draft.dependencyIds.filter((id) => id !== ref.taskId) } : {})
    })));
    setEditing(false);
    showToast("Task saved", "success");
  }

  function deleteTask(ref: TaskRef) {
    requestConfirm({
      title: "Delete task",
      message: "Delete this task? This cannot be undone.",
      confirmLabel: "Delete",
      tone: "danger",
      onConfirm: () => {
        updateState((current) => removeTask(current, ref));
        setSelectedTask(null);
        setEditing(false);
        showToast("Task deleted", "danger");
      }
    });
  }

  function addTask(target: AddTaskTarget, draft: EditorDraft) {
    const name = draft.name.trim();
    if (!name) return;

    updateState((current) => {
      if (target.kind === "general") {
        return {
          ...current,
          generalTasks: [
            ...current.generalTasks,
            {
              id: uid("general"),
              name,
              completed: false,
              stage: "notStarted",
              urgency: draft.urgency,
              dueDate: draft.dueDate || undefined,
              notes: draft.notes.trim() || undefined
            }
          ]
        };
      }

      if (target.kind === "daily") {
        return {
          ...current,
          dailyTasks: [
            ...current.dailyTasks,
            {
              id: uid("daily"),
              name,
              completed: false,
              stage: "notStarted",
              urgency: draft.urgency,
              dueDate: draft.dueDate || undefined,
              notes: draft.notes.trim() || undefined
            }
          ]
        };
      }

      return {
        ...current,
        projects: current.projects.map((project) => project.id !== target.projectId ? project : {
          ...project,
          milestones: project.milestones.map((milestone) => milestone.id !== target.milestoneId ? milestone : {
            ...milestone,
            tasks: [
              ...milestone.tasks,
              {
                id: uid("project-task"),
                name,
                completed: false,
                stage: "notStarted",
                urgency: draft.urgency,
                dueDate: draft.dueDate || undefined,
                notes: draft.notes.trim() || undefined,
                dependencyIds: draft.dependencyIds
              }
            ]
          })
        })
      };
    });
    setAddTarget(null);
    showToast("Task saved", "success");
  }

  function addProject() {
    const name = newProjectName.trim();
    if (!name) return;
    updateState((current) => ({
      ...current,
      projects: [
        ...current.projects,
        {
          id: uid("project"),
          name,
          priority: 5,
          color: identityColors[current.projects.length % identityColors.length],
          milestones: [
            {
              id: uid("milestone"),
              name: "Backlog",
              urgency: "medium",
              tasks: []
            }
          ]
        }
      ]
    }));
    setNewProjectName("");
    showToast("Project added", "success");
  }

  function addMilestone(projectId: string) {
    const name = newMilestoneName.trim();
    if (!name) return;
    updateState((current) => ({
      ...current,
      projects: current.projects.map((project) => project.id !== projectId ? project : {
        ...project,
        milestones: [
          ...project.milestones,
          {
            id: uid("milestone"),
            name,
            urgency: "medium",
            tasks: []
          }
        ]
      })
    }));
    setNewMilestoneName("");
    showToast("Milestone added", "success");
  }

  function deleteProject(projectId: string) {
    requestConfirm({
      title: "Delete project",
      message: "Delete this project and all of its milestones and tasks? This cannot be undone.",
      confirmLabel: "Delete project",
      tone: "danger",
      onConfirm: () => {
        updateState((current) => ({
          ...current,
          projects: current.projects.filter((project) => project.id !== projectId)
        }));
        setView({ type: "dashboard" });
        setSelectedTask(null);
        setAddTarget(null);
        showToast("Project deleted", "danger");
      }
    });
  }

  function deleteMilestone(projectId: string, milestoneId: string) {
    requestConfirm({
      title: "Delete milestone",
      message: "Delete this milestone and all of its tasks? This cannot be undone.",
      confirmLabel: "Delete milestone",
      tone: "danger",
      onConfirm: () => {
        updateState((current) => ({
          ...current,
          projects: current.projects.map((project) => {
            if (project.id !== projectId) return project;
            const removedTaskIds = new Set(project.milestones.find((milestone) => milestone.id === milestoneId)?.tasks.map((task) => task.id) ?? []);
            return {
              ...project,
              milestones: project.milestones
                .filter((milestone) => milestone.id !== milestoneId)
                .map((milestone) => ({
                  ...milestone,
                  tasks: milestone.tasks.map((task) => ({
                    ...task,
                    dependencyIds: task.dependencyIds.filter((id) => !removedTaskIds.has(id))
                  }))
                }))
            };
          })
        }));
        setSelectedTask(null);
        setAddTarget(null);
        showToast("Milestone deleted", "danger");
      }
    });
  }

  function markMessageRead(id: string) {
    updateState((current) => ({
      ...current,
      inboxMessages: current.inboxMessages.map((msg) =>
        msg.id === id ? { ...msg, read: true } : msg
      )
    }));
  }

  function markAllMessagesRead() {
    updateState((current) => ({
      ...current,
      inboxMessages: current.inboxMessages.map((msg) => ({ ...msg, read: true }))
    }));
  }

  function assignInboxTask(task: InboxTask, target: { kind: "general" } | { kind: "project"; projectId: string; milestoneId: string }) {
    updateState((current) => {
      const remaining = current.inboxTasks.filter((t) => t.id !== task.id);
      const base = {
        name: task.name,
        completed: false,
        stage: "notStarted" as TaskStage,
        urgency: task.urgency,
        ...(task.dueDate ? { dueDate: task.dueDate } : {}),
        ...(task.notes ? { notes: task.notes } : {})
      };
      if (target.kind === "general") {
        return { ...current, inboxTasks: remaining, generalTasks: [...current.generalTasks, { ...base, id: uid("general") }] };
      }
      return {
        ...current,
        inboxTasks: remaining,
        projects: current.projects.map((project) =>
          project.id !== target.projectId ? project : {
            ...project,
            milestones: project.milestones.map((milestone) =>
              milestone.id !== target.milestoneId ? milestone : {
                ...milestone,
                tasks: [...milestone.tasks, { ...base, id: uid("project-task"), dependencyIds: [] }]
              }
            )
          }
        )
      };
    });
    setSelectedInboxTask(null);
    showToast("Task assigned", "success");
  }

  return (
    <div className="app-shell" style={themeVars(state.settings.theme)}>
      <div className="flex min-h-screen">
        <Sidebar
          state={state}
          view={view}
          setView={setView}
          newProjectName={newProjectName}
          setNewProjectName={setNewProjectName}
          addProject={addProject}
          onThemeChange={(theme) => setState((current) => ({ ...current, settings: { ...current.settings, theme } }))}
        />
        <main className="min-w-0 flex-1 px-4 py-4 md:px-6">
          {!loaded && <div className="mb-4 rounded-app border p-3 text-sm subtle" style={{ background: "var(--background-surface)", borderColor: "var(--border-subtle)" }}>Loading your workspace...</div>}
          {saveError && <div className="mb-4 rounded-app border p-3 text-sm" style={{ background: "var(--status-red-background)", borderColor: "var(--status-red-bar)", color: "var(--status-red-text)" }}>{saveError}</div>}
          {view.type === "dashboard" && (
            <Dashboard state={state} queue={queue} openTask={openTask} setTaskStage={setTaskStage} markMessageRead={markMessageRead} markAllMessagesRead={markAllMessagesRead} onSelectInboxTask={setSelectedInboxTask} />
          )}
          {view.type === "general" && (
            <TaskListView
              title="General"
              subtitle="Standalone work that does not belong to a project."
              color={state.generalColor}
              onColorChange={(color) => updateState((current) => ({ ...current, generalColor: color }))}
              tasks={state.generalTasks}
              makeRef={(task) => ({ kind: "general", taskId: task.id })}
              onAdd={() => setAddTarget({ kind: "general" })}
              openTask={openTask}
              setTaskStage={setTaskStage}
              timezone={state.settings.timezone}
            />
          )}
          {view.type === "daily" && (
            <TaskListView
              title="Daily"
              subtitle={`Recurring tasks reset in ${resetCountdownLabel(minsUntilReset)} (${state.settings.timezone}).`}
              color={state.dailyColor}
              onColorChange={(color) => updateState((current) => ({ ...current, dailyColor: color }))}
              tasks={state.dailyTasks}
              makeRef={(task) => ({ kind: "daily", taskId: task.id })}
              onAdd={() => setAddTarget({ kind: "daily" })}
              openTask={openTask}
              setTaskStage={setTaskStage}
              timezone={state.settings.timezone}
            />
          )}
          {activeProject && (
            <ProjectView
              project={activeProject}
              timezone={state.settings.timezone}
              openTask={openTask}
              setTaskStage={setTaskStage}
              setAddTarget={setAddTarget}
              updateProject={(project) => updateState((current) => ({
                ...current,
                projects: current.projects.map((candidate) => candidate.id === project.id ? project : candidate)
              }))}
              deleteProject={() => deleteProject(activeProject.id)}
              deleteMilestone={(milestoneId) => deleteMilestone(activeProject.id, milestoneId)}
              newMilestoneName={newMilestoneName}
              setNewMilestoneName={setNewMilestoneName}
              addMilestone={() => addMilestone(activeProject.id)}
            />
          )}
          {view.type === "settings" && (
            <SettingsView state={state} setState={setState} showToast={showToast} onUnauthorized={onUnauthorized} />
          )}
        </main>
      </div>

      {selectedDetails && (
        <TaskPopover
          details={selectedDetails}
          state={state}
          editing={editing}
          setEditing={setEditing}
          close={() => setSelectedTask(null)}
          save={saveTask}
          setTaskStage={setTaskStage}
          deleteTask={deleteTask}
        />
      )}

      {addTarget && (
        <AddTaskPopover
          target={addTarget}
          state={state}
          close={() => setAddTarget(null)}
          save={addTask}
        />
      )}

      {selectedInboxTask && (
        <AssignTaskPopover
          task={selectedInboxTask}
          state={state}
          onAssign={assignInboxTask}
          onClose={() => setSelectedInboxTask(null)}
        />
      )}

      {confirmRequest && (
        <ConfirmModal
          request={confirmRequest}
          close={() => setConfirmRequest(null)}
        />
      )}
      <ToastStack toasts={toasts} dismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))} />
    </div>
  );
}

function Sidebar(props: {
  state: AppState;
  view: View;
  setView: (view: View) => void;
  newProjectName: string;
  setNewProjectName: (value: string) => void;
  addProject: () => void;
  onThemeChange: (theme: "light" | "dark") => void;
}) {
  const { state, view, setView } = props;
  const navClass = (active: boolean) =>
    `flex w-full items-center gap-2 rounded-app px-3 py-2 text-left text-sm font-semibold transition ${
      active ? "bg-[var(--tile-active)] text-[var(--foreground-primary)]" : "text-[var(--foreground-secondary)] hover:bg-[var(--background-surface-hover)]"
    }`;

  return (
    <aside className="sticky top-0 hidden h-screen w-72 shrink-0 flex-col border-r p-4 md:flex" style={{ borderColor: "var(--border-subtle)", background: "var(--background-surface)" }}>
      <div className="mb-6 shrink-0">
        <div className="text-lg font-bold">Task<span className="font-normal" style={{ color: "var(--foreground-secondary)" }}>Tracker</span></div>
      </div>
      <nav className="flex shrink-0 flex-col">
        <div className="mb-3 pb-3" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
          <button
            className={`flex w-full items-center gap-2 rounded-app px-3 py-2.5 text-left text-base font-bold transition ${view.type === "dashboard" ? "bg-[var(--tile-active)] text-[var(--foreground-primary)]" : "text-[var(--foreground-secondary)] hover:bg-[var(--background-surface-hover)]"}`}
            onClick={() => setView({ type: "dashboard" })}
          >
            Dashboard
          </button>
        </div>
        <div className="flex flex-col gap-1">
          <button className={navClass(view.type === "general")} onClick={() => setView({ type: "general" })}>
            <ColorDot color={state.generalColor} /> General
          </button>
          <button className={navClass(view.type === "daily")} onClick={() => setView({ type: "daily" })}>
            <ColorDot color={state.dailyColor} /> Daily
          </button>
        </div>
      </nav>
      <div className="mt-6 flex min-h-0 flex-1 flex-col">
        <div className="label mb-2 shrink-0">Projects</div>
        <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
          {state.projects.map((project) => (
            <button key={project.id} className={navClass(view.type === "project" && view.projectId === project.id)} onClick={() => setView({ type: "project", projectId: project.id })}>
              <ColorDot color={project.color} /> <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <span className="muted text-xs">P{project.priority}</span>
            </button>
          ))}
        </nav>
        <div className="mt-3 flex shrink-0 gap-2">
          <input className="input min-w-0" placeholder="New project" value={props.newProjectName} onChange={(event) => props.setNewProjectName(event.target.value)} />
          <IconButton variant="secondary" icon="add" label="Add project" onClick={props.addProject} />
        </div>
      </div>
      <div className="mt-6 flex shrink-0 items-center gap-2">
        <ThemePillToggle theme={state.settings.theme} onChange={props.onThemeChange} />
        <IconButton variant="secondary" icon="settings" label="Settings" onClick={() => setView({ type: "settings" })} />
      </div>
    </aside>
  );
}

function SummaryTile({ completedToday, totalDaily, generalRemaining }: {
  completedToday: number;
  totalDaily: number;
  generalRemaining: number;
}) {
  return (
    <div className="tile p-4">
      <div className="label mb-3">Summary</div>
      <div className="grid gap-4">
        <div>
          <div className="subtle text-xs mb-1">Daily tasks done</div>
          <div className="text-2xl font-bold">
            {completedToday}
            <span className="muted text-base font-normal">/{totalDaily}</span>
          </div>
        </div>
        <div>
          <div className="subtle text-xs mb-1">General remaining</div>
          <div className="text-2xl font-bold">{generalRemaining}</div>
        </div>
      </div>
    </div>
  );
}

function ProjectProgressList({ projects }: { projects: Project[] }) {
  return (
    <div className="tile p-4">
      <div className="label mb-3">Projects</div>
      {projects.length === 0 ? (
        <div className="muted text-xs">No projects yet.</div>
      ) : (
        <div className="grid gap-3">
          {projects.map((project) => {
            const allTasks = project.milestones.flatMap((m) => m.tasks);
            const completed = allTasks.filter((t) => t.completed).length;
            const total = allTasks.length;
            const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
            return (
              <div key={project.id}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <ColorDot color={project.color} />
                    <span className="text-xs font-semibold truncate">{project.name}</span>
                  </div>
                  <span className="muted text-xs shrink-0 ml-2">{pct}%</span>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--border-subtle)" }}>
                  <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: project.color }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MiniCalendar({ state }: { state: AppState }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());

  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const dayNames = ["S","M","T","W","T","F","S"];

  const prefix = `${year}-${String(month + 1).padStart(2, "0")}-`;
  const allTasks = [
    ...state.generalTasks,
    ...state.dailyTasks,
    ...state.projects.flatMap((p) => p.milestones.flatMap((m) => m.tasks)),
  ];
  const dueCounts: Record<number, number> = {};
  for (const task of allTasks) {
    if (task.dueDate && !task.completed && task.dueDate.startsWith(prefix)) {
      const day = parseInt(task.dueDate.slice(8, 10), 10);
      dueCounts[day] = (dueCounts[day] || 0) + 1;
    }
  }

  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth();
  const todayDate = now.getDate();

  function prevMonth() {
    if (month === 0) { setYear((y) => y - 1); setMonth(11); }
    else setMonth((m) => m - 1);
  }
  function nextMonth() {
    if (month === 11) { setYear((y) => y + 1); setMonth(0); }
    else setMonth((m) => m + 1);
  }

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div className="tile p-4">
      <div className="flex items-center justify-between mb-3">
        <button className="icon-btn" onClick={prevMonth} aria-label="Previous month">
          <MaterialIcon name="chevron_left" />
        </button>
        <span className="text-sm font-semibold">{monthNames[month]} {year}</span>
        <button className="icon-btn" onClick={nextMonth} aria-label="Next month">
          <MaterialIcon name="chevron_right" />
        </button>
      </div>
      <div className="grid grid-cols-7 text-center text-xs">
        {dayNames.map((d, i) => (
          <div key={i} className="label py-1">{d}</div>
        ))}
        {cells.map((day, i) => {
          const isToday = isCurrentMonth && day === todayDate;
          const count = day ? (dueCounts[day] ?? 0) : 0;
          const dots = Math.min(count, 3);
          return (
            <div key={i} className="flex flex-col items-center py-0.5">
              {day !== null && (
                <>
                  <span
                    className="flex h-6 w-6 items-center justify-center rounded-full text-xs"
                    style={isToday ? { background: "var(--accent-brand)", color: "var(--button-primary-text)", fontWeight: 700 } : {}}
                  >
                    {day}
                  </span>
                  {dots > 0 && (
                    <div className="mt-0.5 flex gap-0.5">
                      {Array.from({ length: dots }).map((_, j) => (
                        <span key={j} className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--foreground-secondary)" }} />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InboxTile({ messages, tasks, onMarkRead, onMarkAllRead, onSelectTask }: {
  messages: InboxMessage[];
  tasks: InboxTask[];
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  onSelectTask: (task: InboxTask) => void;
}) {
  const unreadMessages = messages.filter((m) => !m.read).length;
  const pendingCount = unreadMessages + tasks.length;

  type InboxEntry =
    | { kind: "message"; receivedAt: string; data: InboxMessage }
    | { kind: "task"; receivedAt: string; data: InboxTask };

  const entries: InboxEntry[] = [
    ...messages.map((m): InboxEntry => ({ kind: "message", receivedAt: m.receivedAt, data: m })),
    ...tasks.map((t): InboxEntry => ({ kind: "task", receivedAt: t.receivedAt, data: t }))
  ].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));

  return (
    <div className="tile p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="label">Inbox</span>
          {pendingCount > 0 && (
            <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full" style={{ background: "var(--accent-brand)", color: "var(--foreground-inverse)" }}>
              {pendingCount}
            </span>
          )}
        </div>
        {unreadMessages > 0 && (
          <button className="text-xs subtle hover:opacity-80" onClick={onMarkAllRead}>Mark all read</button>
        )}
      </div>
      {entries.length === 0 ? (
        <div className="muted text-center text-sm py-6">No messages yet.</div>
      ) : (
        <div className="grid gap-2">
          {entries.slice(0, 5).map((entry) =>
            entry.kind === "task" ? (
              <button
                key={entry.data.id}
                className="rounded-app border px-3 py-2 text-left w-full"
                style={{ borderColor: "var(--accent-brand)", background: "var(--accent-brand-soft)" }}
                onClick={() => onSelectTask(entry.data)}
              >
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <span className="text-xs font-semibold">{entry.data.name}</span>
                  <span className="text-xs subtle">{formatInboxTime(entry.receivedAt)}</span>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs" style={{ color: `var(--status-${urgencyTone(entry.data.urgency)}-text)` }}>{capitalize(entry.data.urgency)}</span>
                  {entry.data.dueDate && <span className="text-xs subtle">Due {entry.data.dueDate}</span>}
                  <span className="text-xs subtle ml-auto">Click to assign →</span>
                </div>
              </button>
            ) : (
              <div
                key={entry.data.id}
                className="rounded-app border px-3 py-2"
                style={{
                  borderColor: entry.data.read ? "var(--border-subtle)" : "var(--accent-brand)",
                  background: entry.data.read ? "transparent" : "var(--accent-brand-soft)"
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs font-semibold">{entry.data.from}</span>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-xs subtle">{formatInboxTime(entry.receivedAt)}</span>
                    {!entry.data.read && (
                      <button
                        className="icon-btn btn-secondary"
                        style={{ width: "1.25rem", height: "1.25rem" }}
                        title="Mark as read"
                        onClick={() => onMarkRead(entry.data.id)}
                      >
                        <MaterialIcon name="check" />
                      </button>
                    )}
                  </div>
                </div>
                <p className="subtle text-xs mt-0.5 leading-snug break-words">{entry.data.message}</p>
              </div>
            )
          )}
          {entries.length > 5 && (
            <p className="text-xs subtle text-center">{entries.length - 5} older item{entries.length - 5 !== 1 ? "s" : ""}</p>
          )}
        </div>
      )}
    </div>
  );
}

function Dashboard(props: {
  state: AppState;
  queue: WorkQueueItem[];
  openTask: (ref: TaskRef) => void;
  setTaskStage: (ref: TaskRef, stage: TaskStage) => void;
  markMessageRead: (id: string) => void;
  markAllMessagesRead: () => void;
  onSelectInboxTask: (task: InboxTask) => void;
}) {
  const { state, queue, openTask, setTaskStage, markMessageRead, markAllMessagesRead, onSelectInboxTask } = props;
  const completedToday = state.dailyTasks.filter((t) => t.completed).length;
  const generalRemaining = state.generalTasks.filter((t) => !t.completed).length;

  return (
    <section className="mx-auto max-w-[1400px]">
      <div className="mb-4">
        <h1 className="text-2xl font-bold">Dashboard</h1>
      </div>
      <div className="mb-6 flex justify-center">
        <div className="h-px w-[95%]" style={{ background: "var(--border-subtle)" }} />
      </div>
      <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1fr 2fr", alignItems: "start" }}>
        <div className="grid gap-4">
          <SummaryTile
            completedToday={completedToday}
            totalDaily={state.dailyTasks.length}
            generalRemaining={generalRemaining}
          />
          <ProjectProgressList projects={state.projects} />
        </div>
        <div className="grid gap-4">
          <MiniCalendar state={state} />
          <InboxTile messages={state.inboxMessages} tasks={state.inboxTasks} onMarkRead={markMessageRead} onMarkAllRead={markAllMessagesRead} onSelectTask={onSelectInboxTask} />
        </div>
        <div>
          <h2 className="text-base font-bold mb-3">Work queue</h2>
          <div className="grid gap-2">
            {queue.length === 0 && <EmptyState text="No active unblocked work." />}
            {queue.map((item) => (
              <QueueRow key={item.id} item={item} timezone={state.settings.timezone} openTask={openTask} setTaskStage={setTaskStage} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function TaskListView<T extends TaskBase>(props: {
  title: string;
  subtitle: string;
  color: string;
  onColorChange: (color: string) => void;
  tasks: T[];
  makeRef: (task: T) => TaskRef;
  onAdd: () => void;
  openTask: (ref: TaskRef) => void;
  setTaskStage: (ref: TaskRef, stage: TaskStage) => void;
  timezone: string;
}) {
  return (
    <section className="mx-auto max-w-5xl">
      <Header
        title={props.title}
        subtitle={props.subtitle}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ColorPicker value={props.color} colors={identityColors} onChange={props.onColorChange} />
            <IconButton variant="primary" icon="add" label="Add task" onClick={props.onAdd} />
          </div>
        }
      />
      <div className="grid gap-2">
        {props.tasks.length === 0 && <EmptyState text="No tasks yet." />}
        {props.tasks.map((task) => {
          const ref = props.makeRef(task);
          return (
            <TaskRow
              key={task.id}
              task={task}
              color={props.color}
              timezone={props.timezone}
              blockedBy={[]}
              blocking={[]}
              open={() => props.openTask(ref)}
              setStage={(stage) => props.setTaskStage(ref, stage)}
            />
          );
        })}
      </div>
    </section>
  );
}

function ProjectView(props: {
  project: Project;
  timezone: string;
  openTask: (ref: TaskRef) => void;
  setTaskStage: (ref: TaskRef, stage: TaskStage) => void;
  setAddTarget: (target: AddTaskTarget) => void;
  updateProject: (project: Project) => void;
  deleteProject: () => void;
  deleteMilestone: (milestoneId: string) => void;
  newMilestoneName: string;
  setNewMilestoneName: (value: string) => void;
  addMilestone: () => void;
}) {
  const { project } = props;
  const [notesEditing, setNotesEditing] = useState(false);
  const [editingMilestoneId, setEditingMilestoneId] = useState<string | null>(null);

  useEffect(() => {
    setNotesEditing(false);
    setEditingMilestoneId(null);
  }, [project.id]);

  function updateField<K extends keyof Project>(key: K, value: Project[K]) {
    props.updateProject({ ...project, [key]: value });
  }

  function updateMilestone(milestone: Milestone) {
    props.updateProject({
      ...project,
      milestones: project.milestones.map((candidate) => candidate.id === milestone.id ? milestone : candidate)
    });
  }

  return (
    <section>
      <Header
        title={project.name}
        action={
          <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
            <ProjectPrioritySlider value={project.priority} onChange={(priority) => updateField("priority", priority)} />
            <ColorPicker value={project.color} colors={identityColors} onChange={(color) => updateField("color", color)} />
            <IconButton variant="danger" icon="delete" label="Delete project" onClick={props.deleteProject} />
          </div>
        }
      />
      <div className="mb-4 rounded-app border p-3" style={{ background: "var(--background-surface)", borderColor: "var(--border-subtle)" }}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="label">Project notes</div>
          {notesEditing ? (
            <button className="btn btn-secondary" onClick={() => setNotesEditing(false)}>Done</button>
          ) : (
            <IconButton variant="secondary" icon="edit" label="Edit project notes" onClick={() => setNotesEditing(true)} />
          )}
        </div>
        {notesEditing ? (
          <textarea className="input min-h-24" placeholder="Project notes" value={project.notes ?? ""} onChange={(event) => updateField("notes", event.target.value)} />
        ) : (
          <div className="min-h-10 whitespace-pre-wrap text-sm subtle">{project.notes?.trim() || "No project notes yet."}</div>
        )}
      </div>
      <div className="mb-4 flex max-w-xl gap-2">
        <input className="input" placeholder="New milestone" value={props.newMilestoneName} onChange={(event) => props.setNewMilestoneName(event.target.value)} />
        <IconButton variant="secondary" icon="add" label="Add milestone" onClick={props.addMilestone} />
      </div>
      <div className="flex gap-4 overflow-x-auto pb-3">
        {project.milestones.map((milestone) => (
          <div key={milestone.id} className="w-[420px] shrink-0 rounded-app border p-3" style={{ background: "var(--background-surface)", borderColor: "var(--border-subtle)" }}>
            <div className="mb-3 flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex items-center gap-2">
                  {editingMilestoneId === milestone.id ? (
                    <input className="input font-semibold" value={milestone.name} onChange={(event) => updateMilestone({ ...milestone, name: event.target.value })} />
                  ) : (
                    <h2 className="min-w-0 flex-1 truncate text-base font-bold">{milestone.name}</h2>
                  )}
                  <div className={"milestone-actions " + (editingMilestoneId === milestone.id ? "milestone-actions-editing" : "")}>
                    {editingMilestoneId === milestone.id ? (
                      <>
                        <IconButton variant="secondary" icon="check" label="Done editing milestone" onClick={() => setEditingMilestoneId(null)} />
                        <IconButton variant="danger" icon="delete" label="Delete milestone" onClick={() => props.deleteMilestone(milestone.id)} />
                      </>
                    ) : (
                      <IconButton variant="secondary" icon="edit" label="Edit milestone" onClick={() => setEditingMilestoneId(milestone.id)} />
                    )}
                  </div>
                </div>
                <Dropdown
                  value={milestone.urgency}
                  options={urgencyOptions.map((urgency) => ({ value: urgency, label: capitalize(urgency) + " urgency" }))}
                  onChange={(urgency) => updateMilestone({ ...milestone, urgency: urgency as Urgency })}
                  ariaLabel="Milestone urgency"
                />
              </div>
              <IconButton variant="secondary" icon="add" label="Add task" onClick={() => props.setAddTarget({ kind: "project", projectId: project.id, milestoneId: milestone.id })} />
            </div>
            <div className="grid gap-2">
              {milestone.tasks.length === 0 && <EmptyState text="No tasks in this milestone." compact />}
              {milestone.tasks.map((task) => {
                const ref: TaskRef = { kind: "project", projectId: project.id, milestoneId: milestone.id, taskId: task.id };
                return (
                  <TaskRow
                    key={task.id}
                    task={task}
                    color={project.color}
                    timezone={props.timezone}
                    blockedBy={blockedByNames(task, project)}
                    blocking={blockingNames(task, project)}
                    open={() => props.openTask(ref)}
                    setStage={(stage) => props.setTaskStage(ref, stage)}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SettingsView({ state, setState, showToast, onUnauthorized }: {
  state: AppState;
  setState: (state: AppState) => void;
  showToast: (message: string, tone?: Toast["tone"]) => void;
  onUnauthorized: () => void;
}) {
  return (
    <section className="mx-auto max-w-3xl">
      <Header title="Settings" subtitle="Controls that affect task behavior across the workspace." />
      <div className="grid gap-4 rounded-app border p-4" style={{ background: "var(--background-surface)", borderColor: "var(--border-subtle)" }}>
        <div className="field">
          <span className="label">Daily reset timezone</span>
          <TimezoneSelect value={state.settings.timezone} onChange={(timezone) => setState({ ...state, settings: { ...state.settings, timezone } })} />
        </div>
        <div className="subtle text-sm">Today in the selected timezone is {zonedToday(state.settings.timezone)}.</div>
      </div>
      <ApiKeysSection state={state} setState={setState} />
      <PasskeysSection showToast={showToast} onUnauthorized={onUnauthorized} />
      <ImportProjectSection state={state} setState={setState} showToast={showToast} />
    </section>
  );
}

function TaskPopover(props: {
  details: ResolvedTask;
  state: AppState;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  close: () => void;
  save: (ref: TaskRef, draft: EditorDraft) => void;
  setTaskStage: (ref: TaskRef, stage: TaskStage) => void;
  deleteTask: (ref: TaskRef) => void;
}) {
  const { details, state } = props;
  const [draft, setDraft] = useState<EditorDraft>(() => draftFromTask(details.task));

  useEffect(() => {
    setDraft(draftFromTask(details.task));
  }, [details.task.id]);

  let project: Project | undefined;
  let dependencyGroups: DependencyGroup[] = [];
  if (details.ref.kind === "project") {
    const projectRef = details.ref;
    project = state.projects.find((candidate) => candidate.id === projectRef.projectId);
    dependencyGroups = project ? projectDependencyGroups(project, projectRef.taskId) : [];
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/45 p-4" onMouseDown={props.close}>
      <section className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-app border p-4 shadow-2xl" style={{ background: "var(--background-surface-elevated)", borderColor: "var(--border-default)" }} onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="label">{details.context}</div>
            <h2 className="text-xl font-bold">{details.task.name}</h2>
          </div>
          <IconButton variant="secondary" icon="close" label="Close" onClick={props.close} />
        </div>

        {props.editing ? (
          <TaskEditor draft={draft} setDraft={setDraft} dependencyGroups={dependencyGroups} />
        ) : (
          <TaskDetails details={details} timezone={state.settings.timezone} />
        )}

        <div className="mt-5 flex flex-wrap justify-between gap-3">
          <TaskStageControls task={details.task} disabled={details.blockedBy.length > 0} setStage={(stage) => props.setTaskStage(details.ref, stage)} />
          <div className="flex gap-2">
            <IconButton variant="danger" icon="delete" label="Delete task" onClick={() => props.deleteTask(details.ref)} />
            {props.editing ? (
              <>
                <button className="btn btn-secondary" onClick={() => props.setEditing(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={() => props.save(details.ref, draft)}>Save</button>
              </>
            ) : (
              <IconButton variant="primary" icon="edit" label="Edit task" onClick={() => props.setEditing(true)} />
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function AddTaskPopover(props: {
  target: AddTaskTarget;
  state: AppState;
  close: () => void;
  save: (target: AddTaskTarget, draft: EditorDraft) => void;
}) {
  const [draft, setDraft] = useState<EditorDraft>(emptyDraft);
  let project: Project | undefined;
  let dependencyGroups: DependencyGroup[] = [];
  if (props.target.kind === "project") {
    const projectTarget = props.target;
    project = props.state.projects.find((candidate) => candidate.id === projectTarget.projectId);
    dependencyGroups = project ? projectDependencyGroups(project) : [];
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/45 p-4" onMouseDown={props.close}>
      <section className="w-full max-w-2xl rounded-app border p-4 shadow-2xl" style={{ background: "var(--background-surface-elevated)", borderColor: "var(--border-default)" }} onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-xl font-bold">Add task</h2>
          <IconButton variant="secondary" icon="close" label="Close" onClick={props.close} />
        </div>
        <TaskEditor draft={draft} setDraft={setDraft} dependencyGroups={dependencyGroups} />
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn btn-primary" onClick={() => props.save(props.target, draft)}>Save</button>
        </div>
      </section>
    </div>
  );
}

function TaskEditor(props: {
  draft: EditorDraft;
  setDraft: (draft: EditorDraft) => void;
  dependencyGroups: DependencyGroup[];
}) {
  const { draft, setDraft } = props;
  return (
    <div className="grid gap-4">
      <label className="field">
        <span className="label">Name</span>
        <input className="input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      </label>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="field">
          <span className="label">Urgency</span>
          <Dropdown
            value={draft.urgency}
            options={urgencyOptions.map((urgency) => ({ value: urgency, label: capitalize(urgency) }))}
            onChange={(urgency) => setDraft({ ...draft, urgency: urgency as Urgency })}
            ariaLabel="Task urgency"
          />
        </div>
        <label className="field">
          <span className="label">Due date</span>
          <input className="input" type="date" value={draft.dueDate} onChange={(event) => setDraft({ ...draft, dueDate: event.target.value })} />
        </label>
      </div>
      <label className="field">
        <span className="label">Notes</span>
        <textarea className="input min-h-24" value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
      </label>
      {props.dependencyGroups.length > 0 && (
        <div className="field">
          <span className="label">Dependencies</span>
          <DependencyPicker
            groups={props.dependencyGroups}
            value={draft.dependencyIds}
            onChange={(dependencyIds) => setDraft({ ...draft, dependencyIds })}
          />
        </div>
      )}
    </div>
  );
}

function TaskDetails({ details, timezone }: { details: ResolvedTask; timezone: string }) {
  return (
    <div className="grid gap-3 text-sm">
      <Detail label="Status" value={details.blockedBy.length ? "Blocked" : taskStageLabel(taskStage(details.task))} />
      <Detail label="Urgency" value={capitalize(details.task.urgency)} />
      <Detail label="Due date" value={details.task.dueDate ? dueLabel(details.task.dueDate, timezone) : "None"} />
      {details.task.notes && <Detail label="Notes" value={details.task.notes} />}
      {details.milestoneName && <Detail label="Milestone" value={details.milestoneName} />}
      {details.projectName && <Detail label="Project" value={details.projectName} />}
      {details.blockedBy.length > 0 && <Detail label="Blocked by" value={details.blockedBy.join(", ")} />}
      {details.blocking.length > 0 && <Detail label="Blocking" value={details.blocking.join(", ")} />}
    </div>
  );
}

function TaskRow(props: {
  task: TaskBase;
  color: string;
  timezone: string;
  blockedBy: string[];
  blocking: string[];
  open: () => void;
  setStage: (stage: TaskStage) => void;
}) {
  const blocked = props.blockedBy.length > 0;
  return (
    <div className="tile grid grid-cols-[5px_1fr_auto] overflow-hidden">
      <div style={{ background: props.color }} />
      <button className="min-w-0 p-3 text-left" onClick={props.open}>
        <div className={"font-semibold " + (taskStage(props.task) === "complete" ? "line-through muted" : "")}>{props.task.name}</div>
        <div className="mt-1 flex flex-wrap gap-2 text-xs">
          <Pill tone={urgencyTone(props.task.urgency)}>{capitalize(props.task.urgency)}</Pill>
          <StagePill stage={taskStage(props.task)} />
          {props.task.dueDate && <Pill tone={dateTone(props.task.dueDate, props.timezone)}>{dueLabel(props.task.dueDate, props.timezone)}</Pill>}
          {blocked && <Pill tone="red">Blocked by {props.blockedBy.length}</Pill>}
          {props.blocking.length > 0 && <Pill tone="yellow">Blocking {props.blocking.length}</Pill>}
        </div>
      </button>
      <div className="flex items-center p-3">
        <TaskStageControls task={props.task} disabled={blocked} setStage={props.setStage} compact />
      </div>
    </div>
  );
}

function QueueRow({ item, timezone, openTask, setTaskStage }: {
  item: WorkQueueItem;
  timezone: string;
  openTask: (ref: TaskRef) => void;
  setTaskStage: (ref: TaskRef, stage: TaskStage) => void;
}) {
  return (
    <div className="tile grid grid-cols-[5px_1fr_auto] overflow-hidden">
      <div style={{ background: item.color }} />
      <button className="min-w-0 p-3 text-left" onClick={() => openTask(item.ref)}>
        <div className="font-semibold">{item.label}</div>
        <div className="subtle text-sm">{item.source}</div>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          <Pill tone={urgencyTone(item.urgency)}>{capitalize(item.urgency)}</Pill>
          <StagePill stage={item.stage ?? "notStarted"} />
          {item.dueDate && <Pill tone={dateTone(item.dueDate, timezone)}>{dueLabel(item.dueDate, timezone)}</Pill>}
        </div>
      </button>
      <div className="flex items-center p-3">
        <TaskStageControls stage={item.stage ?? "notStarted"} setStage={(stage) => setTaskStage(item.ref, stage)} compact />
      </div>
    </div>
  );
}

function Dropdown<T extends string>({ value, options, onChange, ariaLabel }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; ariaLabel: string }) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) ?? options[0];

  return (
    <div className="dropdown">
      <button className="dropdown-trigger" type="button" aria-label={ariaLabel} aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className="truncate">{selected?.label}</span>
        <MaterialIcon name="expand_more" />
      </button>
      {open && (
        <div className="dropdown-menu">
          {options.map((option) => (
            <button
              key={option.value}
              className={`dropdown-option ${option.value === value ? "dropdown-option-active" : ""}`}
              type="button"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span className="truncate">{option.label}</span>
              {option.value === value && <MaterialIcon name="check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DependencyPicker({ groups, value, onChange }: { groups: DependencyGroup[]; value: string[]; onChange: (value: string[]) => void }) {
  const initiallyExpanded = groups.filter((group, index) => index === 0 || group.tasks.some((task) => value.includes(task.id))).map((group) => group.id);
  const [expandedIds, setExpandedIds] = useState<string[]>(initiallyExpanded);

  function toggleTask(id: string) {
    onChange(value.includes(id) ? value.filter((candidate) => candidate !== id) : [...value, id]);
  }

  function toggleGroup(id: string) {
    setExpandedIds((current) => current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id]);
  }

  return (
    <div className="dependency-picker">
      {groups.map((group) => {
        const expanded = expandedIds.includes(group.id);
        const selectedCount = group.tasks.filter((task) => value.includes(task.id)).length;
        return (
          <div key={group.id}>
            <button className="dependency-group" type="button" onClick={() => toggleGroup(group.id)} aria-expanded={expanded}>
              <span className="flex min-w-0 items-center gap-2">
                <MaterialIcon name={expanded ? "expand_less" : "expand_more"} />
                <span className="truncate">{group.name}</span>
              </span>
              {selectedCount > 0 && <span className="dependency-count">{selectedCount}</span>}
            </button>
            {expanded && (
              <div className="dependency-task-list">
                {group.tasks.length === 0 ? (
                  <div className="px-3 py-2 text-sm muted">No eligible tasks</div>
                ) : group.tasks.map((task) => {
                  const selected = value.includes(task.id);
                  return (
                    <button key={task.id} className={"dependency-option " + (selected ? "dependency-option-active" : "")} type="button" onClick={() => toggleTask(task.id)}>
                      <span className="truncate">{task.label}</span>
                      {selected && <MaterialIcon name="check" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ColorPicker({ value, colors, onChange }: { value: string; colors: string[]; onChange: (color: string) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        className="btn btn-secondary gap-2"
        aria-label="Choose project color"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="h-5 w-10 rounded border" style={{ background: value, borderColor: "var(--border-strong)" }} />
        <span>Color</span>
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-2 grid w-44 grid-cols-4 gap-2 rounded-app border p-2 shadow-xl" style={{ background: "var(--background-surface-elevated)", borderColor: "var(--border-default)" }}>
          {colors.map((color) => (
            <button
              key={color}
              className="h-8 rounded border transition hover:scale-105"
              aria-label={`Use color ${color}`}
              title={color}
              type="button"
              onClick={() => {
                onChange(color);
                setOpen(false);
              }}
              style={{
                background: color,
                borderColor: color === value ? "var(--foreground-primary)" : "var(--border-strong)",
                boxShadow: color === value ? "0 0 0 2px var(--background-surface-elevated), 0 0 0 4px var(--foreground-primary)" : "none"
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MaterialIcon({ name }: { name: string }) {
  return <span className="material-symbols-rounded" aria-hidden="true">{name}</span>;
}

function IconButton({ variant, icon, label, onClick, disabled = false }: { variant: "primary" | "secondary" | "danger"; icon: string; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      className={`icon-btn btn-${variant}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      type="button"
    >
      <MaterialIcon name={icon} />
    </button>
  );
}


function TaskStageControls({ task, stage, disabled = false, setStage, compact = false }: { task?: TaskBase; stage?: TaskStage; disabled?: boolean; setStage: (stage: TaskStage) => void; compact?: boolean }) {
  const currentStage = stage ?? (task ? taskStage(task) : "notStarted");
  return (
    <div className={compact ? "stage-controls stage-controls-compact" : "stage-controls"} aria-label="Task stage">
      {taskStageOptions.map((option) => {
        const active = currentStage === option.value;
        return (
          <button
            key={option.value}
            className={"stage-button stage-" + option.tone + (active ? " stage-button-active" : "")}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => setStage(option.value)}
          >
            <span className="stage-check" aria-hidden="true">{active && <MaterialIcon name="check" />}</span>
            <span>{compact ? compactStageLabel(option.value) : option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function StagePill({ stage }: { stage: TaskStage }) {
  if (stage === "notStarted") return <Pill tone="neutral">Not started</Pill>;
  const option = taskStageOptions.find((candidate) => candidate.value === stage);
  return <span className={"stage-pill stage-" + (option?.tone ?? "blue")}>{taskStageLabel(stage)}</span>;
}

function ConfirmModal({ request, close }: { request: ConfirmRequest; close: () => void }) {
  function confirm() {
    request.onConfirm();
    close();
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-4" onMouseDown={close}>
      <section className="confirm-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="label">Confirm action</div>
            <h2 className="text-xl font-bold">{request.title}</h2>
          </div>
          <IconButton variant="secondary" icon="close" label="Close" onClick={close} />
        </div>
        <p className="subtle mt-3 text-sm">{request.message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn btn-secondary" type="button" onClick={close}>Cancel</button>
          <button className={"btn btn-" + request.tone} type="button" onClick={confirm}>{request.confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}

function ToastStack({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: string) => void }) {
  return (
    <div className="toast-stack" aria-live="polite" aria-atomic="true">
      {toasts.map((toast) => (
        <button key={toast.id} className={"toast toast-" + toast.tone} type="button" onClick={() => dismiss(toast.id)}>
          {toast.message}
        </button>
      ))}
    </div>
  );
}

function Header({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        {subtitle && <p className="subtle mt-1 max-w-2xl text-sm">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

function ProjectPrioritySlider({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <label className="flex min-w-[260px] flex-1 items-center gap-3 sm:flex-initial">
      <span className="label shrink-0">Priority</span>
      <div className="grid min-w-[180px] flex-1 gap-1">
        <div className="flex items-center gap-2">
          <span className="muted text-xs">Low</span>
          <input
            className="priority-slider"
            type="range"
            min="1"
            max="10"
            step="1"
            value={value}
            aria-label="Project priority from low to high"
            onChange={(event) => onChange(Number(event.target.value))}
          />
          <span className="muted text-xs">High</span>
        </div>
        <div className="text-center text-xs font-semibold">P{value}</div>
      </div>
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-app border p-4" style={{ background: "var(--background-surface)", borderColor: "var(--border-subtle)" }}>
      <div className="label">{label}</div>
      <div className="mt-2 text-2xl font-bold">{value}</div>
    </div>
  );
}

function EmptyState({ text, compact = false }: { text: string; compact?: boolean }) {
  return <div className={`rounded-app border border-dashed text-center muted ${compact ? "p-3 text-sm" : "p-8"}`} style={{ borderColor: "var(--border-default)" }}>{text}</div>;
}

function Pill({ children, tone }: { children: ReactNode; tone: "red" | "yellow" | "green" | "neutral" }) {
  const style = tone === "neutral"
    ? { background: "var(--accent-brand-soft)", color: "var(--foreground-secondary)" }
    : { background: `var(--status-${tone}-background)`, color: `var(--status-${tone}-text)` };
  return <span className="rounded-full px-2 py-1 font-semibold" style={style}>{children}</span>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-app border p-3" style={{ borderColor: "var(--border-subtle)", background: "var(--background-surface)" }}>
      <div className="label">{label}</div>
      <div className="mt-1 whitespace-pre-wrap">{value}</div>
    </div>
  );
}

function ColorDot({ color }: { color: string }) {
  return <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />;
}

function TimezoneSelect({ value, onChange }: { value: string; onChange: (zone: string) => void }) {
  return (
    <select className="input" value={value} aria-label="Daily reset timezone" onChange={(e) => onChange(e.target.value)}>
      {timezoneGroups.map(({ group, zones }) => (
        <optgroup key={group} label={group}>
          {zones.map((zone) => (
            <option key={zone} value={zone}>{timezoneLabel(zone)}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function ThemePillToggle({ theme, onChange }: { theme: "light" | "dark"; onChange: (theme: "light" | "dark") => void }) {
  return (
    <div className="theme-pill">
      <button type="button" className={"theme-pill-option " + (theme === "light" ? "theme-pill-active" : "")} onClick={() => onChange("light")} aria-label="Light mode" aria-pressed={theme === "light"}>
        <MaterialIcon name="light_mode" />
        <span>Light</span>
      </button>
      <button type="button" className={"theme-pill-option " + (theme === "dark" ? "theme-pill-active" : "")} onClick={() => onChange("dark")} aria-label="Dark mode" aria-pressed={theme === "dark"}>
        <MaterialIcon name="dark_mode" />
        <span>Dark</span>
      </button>
    </div>
  );
}

type ResolvedTask = {
  task: TaskBase;
  ref: TaskRef;
  context: string;
  projectName?: string;
  milestoneName?: string;
  blockedBy: string[];
  blocking: string[];
};

function resolveTask(state: AppState, ref: TaskRef): ResolvedTask | null {
  if (ref.kind === "general") {
    const task = state.generalTasks.find((candidate) => candidate.id === ref.taskId);
    return task ? { task, ref, context: "General", blockedBy: [], blocking: [] } : null;
  }
  if (ref.kind === "daily") {
    const task = state.dailyTasks.find((candidate) => candidate.id === ref.taskId);
    return task ? { task, ref, context: "Daily", blockedBy: [], blocking: [] } : null;
  }

  const project = state.projects.find((candidate) => candidate.id === ref.projectId);
  const milestone = project?.milestones.find((candidate) => candidate.id === ref.milestoneId);
  const task = milestone?.tasks.find((candidate) => candidate.id === ref.taskId);
  if (!project || !milestone || !task) return null;
  return {
    task,
    ref,
    context: `${project.name} / ${milestone.name}`,
    projectName: project.name,
    milestoneName: milestone.name,
    blockedBy: blockedByNames(task, project),
    blocking: blockingNames(task, project)
  };
}

function removeTask(state: AppState, ref: TaskRef): AppState {
  if (ref.kind === "general") {
    return { ...state, generalTasks: state.generalTasks.filter((task) => task.id !== ref.taskId) };
  }

  if (ref.kind === "daily") {
    return { ...state, dailyTasks: state.dailyTasks.filter((task) => task.id !== ref.taskId) };
  }

  return {
    ...state,
    projects: state.projects.map((project) => project.id !== ref.projectId ? project : {
      ...project,
      milestones: project.milestones.map((milestone) => ({
        ...milestone,
        tasks: milestone.tasks
          .filter((task) => task.id !== ref.taskId)
          .map((task) => ({ ...task, dependencyIds: task.dependencyIds.filter((id) => id !== ref.taskId) }))
      }))
    })
  };
}

function updateTask(state: AppState, ref: TaskRef, updater: (task: TaskBase, context?: ResolvedTask) => TaskBase): AppState {
  if (ref.kind === "general") {
    return { ...state, generalTasks: state.generalTasks.map((task) => task.id === ref.taskId ? updater(task) as GeneralTask : task) };
  }
  if (ref.kind === "daily") {
    return { ...state, dailyTasks: state.dailyTasks.map((task) => task.id === ref.taskId ? updater(task) as DailyTask : task) };
  }

  const context = resolveTask(state, ref);
  return {
    ...state,
    projects: state.projects.map((project) => project.id !== ref.projectId ? project : {
      ...project,
      milestones: project.milestones.map((milestone) => milestone.id !== ref.milestoneId ? milestone : {
        ...milestone,
        tasks: milestone.tasks.map((task) => task.id === ref.taskId ? updater(task, context ?? undefined) as ProjectTask : task)
      })
    })
  };
}

function draftFromTask(task: TaskBase): EditorDraft {
  return {
    name: task.name,
    urgency: task.urgency,
    dueDate: task.dueDate ?? "",
    notes: task.notes ?? "",
    dependencyIds: hasDependencies(task) ? [...task.dependencyIds] : []
  };
}

function hasDependencies(task: TaskBase): task is ProjectTask {
  return "dependencyIds" in task && Array.isArray((task as ProjectTask).dependencyIds);
}

function taskStage(task: TaskBase): TaskStage {
  return task.stage ?? (task.completed ? "complete" : "notStarted");
}

function withTaskStage<T extends TaskBase>(task: T, stage: TaskStage, timezone?: string): T {
  return {
    ...task,
    stage,
    completed: stage === "complete",
    ...("completedOn" in task ? { completedOn: stage === "complete" && timezone ? zonedToday(timezone) : undefined } : {})
  };
}

function taskStageLabel(stage: TaskStage): string {
  if (stage === "notStarted") return "Not started";
  if (stage === "inProgress") return "In progress";
  if (stage === "waitingReview") return "Waiting for review";
  return "Complete";
}

function compactStageLabel(stage: TaskStage): string {
  if (stage === "inProgress") return "Progress";
  if (stage === "waitingReview") return "Review";
  return "Done";
}

function projectDependencyGroups(project: Project, excludeId?: string): DependencyGroup[] {
  return project.milestones.map((milestone) => ({
    id: milestone.id,
    name: milestone.name,
    tasks: milestone.tasks
      .filter((task) => task.id !== excludeId)
      .map((task) => ({ id: task.id, label: task.name }))
  }));
}


function useMinutesUntilMidnight(timezone: string): number {
  const [minutes, setMinutes] = useState(() => minutesUntilMidnight(timezone));
  const timezoneRef = useRef(timezone);
  timezoneRef.current = timezone;
  useEffect(() => {
    const tick = () => setMinutes(minutesUntilMidnight(timezoneRef.current));
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, []);
  return minutes;
}

function resetCountdownLabel(minutes: number): string {
  if (minutes <= 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) return hours === 1 ? "1 hour" : `${hours} hours`;
  return `${hours}h ${mins}m`;
}

// --- Project import ---

type ImportRawTask = {
  internalId: string;
  name: string;
  uuid: string | undefined;
  notes: string | undefined;
  urgency: Urgency;
  stage: TaskStage;
  dueDate: string | undefined;
  dependencies: string[];
};

type ImportRawMilestone = {
  internalId: string;
  name: string;
  urgency: Urgency;
  notes: string | undefined;
  tasks: ImportRawTask[];
};

function importStr(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
}

function importStrArr(obj: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const v = obj[key];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  }
  return [];
}

function importUrgency(obj: Record<string, unknown>, ...keys: string[]): Urgency {
  for (const key of keys) {
    const v = obj[key];
    if (v === "low" || v === "medium" || v === "high") return v;
  }
  return "medium";
}

function importStage(obj: Record<string, unknown>, ...keys: string[]): TaskStage {
  for (const key of keys) {
    const v = obj[key];
    if (v === "notStarted" || v === "inProgress" || v === "waitingReview" || v === "complete") return v;
  }
  return "notStarted";
}

function parseImportTask(raw: unknown, index: number): ImportRawTask {
  if (!raw || typeof raw !== "object") throw new Error(`Task ${index + 1} must be an object.`);
  const obj = raw as Record<string, unknown>;
  const name = importStr(obj, "task name", "name");
  if (!name) throw new Error(`Task ${index + 1} is missing a name ("task name" or "name").`);
  return {
    internalId: uid("project-task"),
    name,
    uuid: importStr(obj, "task uuid", "uuid", "id"),
    notes: importStr(obj, "task notes", "notes"),
    urgency: importUrgency(obj, "task urgency", "urgency"),
    stage: importStage(obj, "task stage", "stage"),
    dueDate: importStr(obj, "task due date", "dueDate", "due date", "due_date"),
    dependencies: importStrArr(obj, "task dependencies", "dependencies", "dependencyIds", "dependency ids")
  };
}

function parseImportMilestone(raw: unknown, index: number): ImportRawMilestone {
  if (!raw || typeof raw !== "object") throw new Error(`Milestone ${index + 1} must be an object.`);
  const obj = raw as Record<string, unknown>;
  const name = importStr(obj, "milestone name", "name");
  if (!name) throw new Error(`Milestone ${index + 1} is missing a name ("milestone name" or "name").`);
  if (!Array.isArray(obj.tasks)) throw new Error(`Milestone "${name}" is missing a "tasks" array.`);
  return {
    internalId: uid("milestone"),
    name,
    urgency: importUrgency(obj, "urgency"),
    notes: importStr(obj, "notes"),
    tasks: (obj.tasks as unknown[]).map((t, i) => parseImportTask(t, i))
  };
}

function buildProjectFromImport(raw: unknown, existingProjects: Project[]): Project {
  if (!raw || typeof raw !== "object") throw new Error("Import data must be an object.");
  const obj = raw as Record<string, unknown>;
  const name = importStr(obj, "project name", "name");
  if (!name) throw new Error('Project is missing a name ("project name" or "name").');
  if (!Array.isArray(obj.milestones)) throw new Error('Project is missing a "milestones" array.');

  const rawMilestones = (obj.milestones as unknown[]).map((m, i) => parseImportMilestone(m, i));

  const uuidMap = new Map<string, string>();
  for (const m of rawMilestones) {
    for (const t of m.tasks) {
      if (t.uuid) uuidMap.set(t.uuid, t.internalId);
    }
  }

  const color = typeof obj.color === "string" ? obj.color : identityColors[existingProjects.length % identityColors.length];
  const priority = typeof obj.priority === "number" && obj.priority >= 1 && obj.priority <= 10 ? Math.round(obj.priority) : 5;

  return {
    id: uid("project"),
    name,
    priority,
    color,
    notes: importStr(obj, "notes"),
    milestones: rawMilestones.map((m) => ({
      id: m.internalId,
      name: m.name,
      urgency: m.urgency,
      notes: m.notes,
      tasks: m.tasks.map((t) => ({
        id: t.internalId,
        name: t.name,
        completed: t.stage === "complete",
        stage: t.stage,
        urgency: t.urgency,
        dueDate: t.dueDate,
        notes: t.notes,
        dependencyIds: t.dependencies
          .map((uuid) => uuidMap.get(uuid))
          .filter((id): id is string => id !== undefined)
      }))
    }))
  };
}

function ImportProjectSection({ state, setState, showToast }: {
  state: AppState;
  setState: (state: AppState) => void;
  showToast: (message: string, tone?: Toast["tone"]) => void;
}) {
  const [json, setJson] = useState("");
  const [error, setError] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const helpRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!helpOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (helpRef.current && !helpRef.current.contains(e.target as Node)) setHelpOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [helpOpen]);

  function handleImport() {
    setError("");
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      setError("Invalid JSON — check your input and try again.");
      return;
    }
    try {
      const project = buildProjectFromImport(raw, state.projects);
      setState({ ...state, projects: [...state.projects, project] });
      setJson("");
      showToast(`"${project.name}" imported`, "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse project data.");
    }
  }

  const placeholder = `{
  "project name": "Website Redesign",
  "priority": 8,
  "color": "#6366f1",
  "notes": "Optional project-level notes.",
  "milestones": [
    {
      "milestone name": "Discovery",
      "urgency": "high",
      "notes": "Optional milestone-level notes.",
      "tasks": [
        {
          "task name": "Stakeholder kickoff",
          "task uuid": "t-001",
          "task urgency": "high",
          "task stage": "complete",
          "task due date": "2026-07-01",
          "task notes": "Optional task-level notes.",
          "dependencies": []
        },
        {
          "task name": "Requirements doc",
          "task uuid": "t-002",
          "task urgency": "medium",
          "task stage": "inProgress",
          "task due date": "2026-07-15",
          "dependencies": ["t-001"]
        },
        {
          "task name": "Technical scoping",
          "task uuid": "t-003",
          "task urgency": "low",
          "task stage": "waitingReview",
          "dependencies": ["t-001", "t-002"]
        }
      ]
    },
    {
      "milestone name": "Build",
      "urgency": "medium",
      "tasks": [
        {
          "task name": "Implement core features",
          "task uuid": "t-004",
          "task urgency": "high",
          "task stage": "notStarted",
          "dependencies": ["t-003"]
        },
        {
          "task name": "QA pass",
          "task uuid": "t-005",
          "task urgency": "medium",
          "task stage": "notStarted",
          "dependencies": ["t-004"]
        }
      ]
    },
    {
      "milestone name": "Launch",
      "urgency": "low",
      "tasks": [
        {
          "task name": "Deploy to production",
          "task uuid": "t-006",
          "task urgency": "high",
          "task stage": "notStarted",
          "dependencies": ["t-005"]
        }
      ]
    }
  ]
}`;

  return (
    <div className="mt-6 rounded-app border p-4" style={{ background: "var(--background-surface)", borderColor: "var(--border-subtle)" }}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <div className="label mb-1">Import project</div>
          <p className="subtle text-sm">Paste a JSON project definition. The placeholder shows every supported field.</p>
        </div>
        <div className="relative shrink-0" ref={helpRef}>
          <button
            type="button"
            className="icon-btn btn-secondary"
            aria-label="Schema reference"
            aria-expanded={helpOpen}
            onClick={() => setHelpOpen((o) => !o)}
          >
            <MaterialIcon name="help_outline" />
          </button>
          {helpOpen && (
            <div
              className="absolute right-0 top-9 z-10 w-72 max-h-80 overflow-y-auto rounded-app border p-4 shadow-xl text-sm"
              style={{ background: "var(--background-surface-elevated)", borderColor: "var(--border-default)" }}
            >
              <p className="font-semibold mb-3">Schema reference</p>
              <p className="font-medium mb-1">Project</p>
              <ul className="list-disc pl-4 space-y-1 subtle">
                <li><code>project name</code> <span className="opacity-60">(required)</span> — alt: <code>name</code></li>
                <li><code>milestones</code> <span className="opacity-60">(required)</span> — array of milestone objects</li>
                <li><code>priority</code> — integer 1–10, defaults to 5</li>
                <li><code>color</code> — CSS color string, auto-assigned if omitted</li>
                <li><code>notes</code> — string</li>
              </ul>
              <p className="font-medium mt-3 mb-1">Milestone</p>
              <ul className="list-disc pl-4 space-y-1 subtle">
                <li><code>milestone name</code> <span className="opacity-60">(required)</span> — alt: <code>name</code></li>
                <li><code>tasks</code> <span className="opacity-60">(required)</span> — array of task objects</li>
                <li><code>urgency</code> — <code>low</code> | <code>medium</code> | <code>high</code></li>
                <li><code>notes</code> — string</li>
              </ul>
              <p className="font-medium mt-3 mb-1">Task</p>
              <ul className="list-disc pl-4 space-y-1 subtle">
                <li><code>task name</code> <span className="opacity-60">(required)</span> — alt: <code>name</code></li>
                <li><code>task uuid</code> — alt: <code>uuid</code> | <code>id</code> — used to wire dependencies, then discarded</li>
                <li><code>task urgency</code> — alt: <code>urgency</code>: <code>low</code> | <code>medium</code> | <code>high</code></li>
                <li><code>task stage</code> — alt: <code>stage</code>: <code>notStarted</code> | <code>inProgress</code> | <code>waitingReview</code> | <code>complete</code></li>
                <li><code>task due date</code> — alt: <code>dueDate</code> | <code>due date</code> | <code>due_date</code>: YYYY-MM-DD</li>
                <li><code>task notes</code> — alt: <code>notes</code>: string</li>
                <li><code>dependencies</code> — alt: <code>task dependencies</code> | <code>dependencyIds</code>: array of task uuid strings</li>
              </ul>
            </div>
          )}
        </div>
      </div>
      <textarea
        className="input min-h-40 font-mono text-xs"
        placeholder={placeholder}
        value={json}
        onChange={(e) => { setJson(e.target.value); setError(""); }}
      />
      {error && (
        <div className="mt-2 rounded-app border px-3 py-2 text-sm" style={{ background: "var(--status-red-background)", borderColor: "var(--status-red-bar)", color: "var(--status-red-text)" }}>
          {error}
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <button className="btn btn-primary" type="button" disabled={!json.trim()} onClick={handleImport}>
          Import project
        </button>
      </div>
    </div>
  );
}

function ApiKeysSection({ state, setState }: {
  state: AppState;
  setState: (state: AppState) => void;
}) {
  const [newKeyName, setNewKeyName] = useState("");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function handleGenerate() {
    const name = newKeyName.trim();
    if (!name) return;
    const arr = new Uint8Array(18);
    crypto.getRandomValues(arr);
    const key = "tt_" + Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
    const newApiKey: ApiKey = { id: uid("api-key"), name, key, createdAt: new Date().toISOString() };
    setState({ ...state, apiKeys: [...state.apiKeys, newApiKey] });
    setNewKeyName("");
    setRevealedKey(key);
    setCopied(false);
  }

  function handleCopy(key: string) {
    navigator.clipboard.writeText(key);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  function handleDelete(id: string) {
    const dying = state.apiKeys.find((k) => k.id === id);
    setState({ ...state, apiKeys: state.apiKeys.filter((k) => k.id !== id) });
    if (dying?.key === revealedKey) setRevealedKey(null);
  }

  return (
    <div className="mt-6 rounded-app border p-4" style={{ background: "var(--background-surface)", borderColor: "var(--border-subtle)" }}>
      <div className="label mb-1">API Keys</div>
      <p className="subtle text-sm mb-4">
        Generate keys to authenticate requests to <code>/api/message</code> and <code>/api/task</code>.
        Send as <code>Authorization: Bearer &lt;key&gt;</code> or <code>X-Api-Key: &lt;key&gt;</code>.
      </p>
      <div className="flex gap-2 mb-4">
        <input
          className="input flex-1"
          placeholder='Key name (e.g. "Slack bot")'
          value={newKeyName}
          onChange={(e) => setNewKeyName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleGenerate(); }}
        />
        <button className="btn btn-primary" disabled={!newKeyName.trim()} onClick={handleGenerate}>Generate</button>
      </div>
      {revealedKey && (
        <div className="mb-4 rounded-app border px-3 py-2 text-sm" style={{ background: "var(--accent-brand-soft)", borderColor: "var(--accent-brand)" }}>
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="font-medium text-xs">Key generated</span>
            <button className="text-xs subtle hover:opacity-80" onClick={() => handleCopy(revealedKey)}>
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <code className="text-xs font-mono break-all">{revealedKey}</code>
        </div>
      )}
      {state.apiKeys.length === 0 ? (
        <div className="muted text-sm text-center py-4">No API keys yet.</div>
      ) : (
        <div className="grid gap-2">
          {state.apiKeys.map((apiKey) => (
            <div key={apiKey.id} className="flex items-center gap-3 rounded-app border px-3 py-2" style={{ borderColor: "var(--border-subtle)", background: "var(--background-surface-elevated)" }}>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{apiKey.name}</div>
                <code className="text-xs subtle font-mono break-all">{apiKey.key}</code>
              </div>
              <div className="text-xs subtle shrink-0">{apiKey.createdAt.slice(0, 10)}</div>
              <IconButton variant="danger" icon="delete" label="Revoke key" onClick={() => handleDelete(apiKey.id)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PasskeysSection({ showToast, onUnauthorized }: {
  showToast: (message: string, tone?: Toast["tone"]) => void;
  onUnauthorized: () => void;
}) {
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKeyName, setNewKeyName] = useState("My Passkey");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function refresh() {
    listPasskeys()
      .then(setPasskeys)
      .catch((e) => {
        if (e instanceof UnauthorizedError) onUnauthorized();
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => { refresh(); }, []);

  async function handleAdd() {
    setError("");
    setBusy(true);
    try {
      await performRegistration(newKeyName.trim() || "Passkey");
      showToast("Passkey registered", "success");
      setAdding(false);
      setNewKeyName("My Passkey");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Registration failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await deletePasskeyApi(id);
      setPasskeys((prev) => prev.filter((p) => p.id !== id));
      showToast("Passkey removed", "danger");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not remove passkey.", "danger");
    }
  }

  return (
    <div className="mt-6 rounded-app border p-4" style={{ background: "var(--background-surface)", borderColor: "var(--border-subtle)" }}>
      <div className="label mb-1">Passkeys</div>
      <p className="subtle text-sm mb-4">
        Passkeys are used to sign in. You need at least one. Add more from other devices while logged in.
      </p>
      {loading ? (
        <div className="muted text-sm text-center py-4">Loading…</div>
      ) : passkeys.length === 0 ? (
        <div className="muted text-sm text-center py-4">No passkeys found.</div>
      ) : (
        <div className="grid gap-2 mb-4">
          {passkeys.map((passkey) => (
            <div key={passkey.id} className="flex items-center gap-3 rounded-app border px-3 py-2" style={{ borderColor: "var(--border-subtle)", background: "var(--background-surface-elevated)" }}>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{passkey.name}</div>
                <div className="text-xs subtle">{passkey.createdAt.slice(0, 10)}</div>
              </div>
              <IconButton
                variant="danger"
                icon="delete"
                label="Remove passkey"
                onClick={() => handleDelete(passkey.id)}
                disabled={passkeys.length <= 1}
              />
            </div>
          ))}
        </div>
      )}
      {adding ? (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <input
              className="input flex-1"
              placeholder="Passkey name"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); if (e.key === "Escape") setAdding(false); }}
              disabled={busy}
              autoFocus
            />
            <button className="btn btn-primary" onClick={handleAdd} disabled={busy}>
              {busy ? "Waiting…" : "Register"}
            </button>
            <button className="btn btn-secondary" onClick={() => { setAdding(false); setError(""); }} disabled={busy}>
              Cancel
            </button>
          </div>
          {error && <p className="text-sm" style={{ color: "var(--status-red-text)" }}>{error}</p>}
        </div>
      ) : (
        <button className="btn btn-secondary" onClick={() => { setAdding(true); setError(""); }}>
          Add passkey
        </button>
      )}
    </div>
  );
}

function AssignTaskPopover({ task, state, onAssign, onClose }: {
  task: InboxTask;
  state: AppState;
  onAssign: (task: InboxTask, target: { kind: "general" } | { kind: "project"; projectId: string; milestoneId: string }) => void;
  onClose: () => void;
}) {
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedMilestoneId, setSelectedMilestoneId] = useState("");
  const selectedProject = state.projects.find((p) => p.id === selectedProjectId);

  function handleProjectChange(projectId: string) {
    setSelectedProjectId(projectId);
    setSelectedMilestoneId("");
  }

  const canAssignToMilestone = selectedProjectId && selectedMilestoneId;
  const tone = urgencyTone(task.urgency);

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/45 p-4" onMouseDown={onClose}>
      <section
        className="w-full max-w-md rounded-app border p-4 shadow-2xl"
        style={{ background: "var(--background-surface-elevated)", borderColor: "var(--border-default)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="label">Assign task</div>
            <h2 className="text-xl font-bold">{task.name}</h2>
          </div>
          <IconButton variant="secondary" icon="close" label="Close" onClick={onClose} />
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-4">
          <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: `var(--status-${tone}-background)`, color: `var(--status-${tone}-text)` }}>
            {capitalize(task.urgency)} urgency
          </span>
          {task.dueDate && <span className="text-xs subtle">Due {task.dueDate}</span>}
        </div>

        {task.notes && <p className="text-sm subtle mb-4 leading-snug">{task.notes}</p>}

        <div className="grid gap-3">
          <button className="btn btn-primary" onClick={() => onAssign(task, { kind: "general" })}>
            Assign to General tasks
          </button>

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px" style={{ background: "var(--border-subtle)" }} />
            <span className="text-xs subtle shrink-0">or assign to a milestone</span>
            <div className="flex-1 h-px" style={{ background: "var(--border-subtle)" }} />
          </div>

          <select className="input" value={selectedProjectId} onChange={(e) => handleProjectChange(e.target.value)}>
            <option value="">Select project...</option>
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <select className="input" value={selectedMilestoneId} onChange={(e) => setSelectedMilestoneId(e.target.value)} disabled={!selectedProject}>
            <option value="">Select milestone...</option>
            {selectedProject?.milestones.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <button
            className="btn btn-secondary"
            disabled={!canAssignToMilestone}
            onClick={() => { if (canAssignToMilestone) onAssign(task, { kind: "project", projectId: selectedProjectId, milestoneId: selectedMilestoneId }); }}
          >
            Assign to milestone
          </button>
        </div>
      </section>
    </div>
  );
}

function formatInboxTime(isoString: string): string {
  const diffSecs = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diffSecs < 60) return "just now";
  if (diffSecs < 3600) return `${Math.floor(diffSecs / 60)}m ago`;
  if (diffSecs < 86400) return `${Math.floor(diffSecs / 3600)}h ago`;
  return new Date(isoString).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function urgencyTone(urgency: Urgency): "red" | "yellow" | "green" {
  if (urgency === "high") return "red";
  if (urgency === "medium") return "yellow";
  return "green";
}

function dateTone(dueDate: string, timezone: string): "red" | "yellow" | "green" {
  if (isOverdue(dueDate, timezone)) return "red";
  if (dueSoon(dueDate, timezone)) return "yellow";
  return "green";
}

function dueLabel(dueDate: string, timezone: string): string {
  if (isOverdue(dueDate, timezone)) return "Overdue " + dueDate;
  if (dueSoon(dueDate, timezone)) return "Due soon " + dueDate;
  return "Due " + dueDate;
}
