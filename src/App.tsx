import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { buildWorkQueue, blockedByNames, blockingNames } from "./prioritization";
import { createInitialState, identityColors } from "./sampleData";
import { loadState, saveState, uid } from "./store";
import { dueSoon, isOverdue, zonedToday } from "./time";
import { themeVars } from "./palette";
import type {
  AppState,
  DailyTask,
  GeneralTask,
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
const timezoneOptions = [
  "America/Edmonton",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Los_Angeles",
  "UTC"
];

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

export default function App() {
  const [state, setState] = useState<AppState>(() => createInitialState());
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [selectedTask, setSelectedTask] = useState<TaskRef | null>(null);
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
    loadState().then((loadedState) => {
      if (cancelled) return;
      setState(loadedState);
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
          console.error(error);
          setSaveError("Unable to save changes to SQLite.");
        });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [loaded, state]);

  const queue = useMemo(() => buildWorkQueue(state), [state]);
  const selectedDetails = selectedTask ? resolveTask(state, selectedTask) : null;
  const activeProject = view.type === "project" ? state.projects.find((project) => project.id === view.projectId) : null;

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
        />
        <main className="min-w-0 flex-1 px-4 py-4 md:px-6">
          {!loaded && <div className="mb-4 rounded-app border p-3 text-sm subtle" style={{ background: "var(--background-surface)", borderColor: "var(--border-subtle)" }}>Loading SQLite data...</div>}
          {saveError && <div className="mb-4 rounded-app border p-3 text-sm" style={{ background: "var(--status-red-background)", borderColor: "var(--status-red-bar)", color: "var(--status-red-text)" }}>{saveError}</div>}
          {view.type === "dashboard" && (
            <Dashboard state={state} queue={queue} openTask={openTask} setTaskStage={setTaskStage} />
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
              subtitle={`Recurring tasks reset on ${zonedToday(state.settings.timezone)} in ${state.settings.timezone}.`}
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
            <SettingsView state={state} setState={setState} showToast={showToast} />
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
}) {
  const { state, view, setView } = props;
  const navClass = (active: boolean) =>
    `flex w-full items-center gap-2 rounded-app px-3 py-2 text-left text-sm font-semibold transition ${
      active ? "bg-[var(--tile-active)] text-[var(--foreground-primary)]" : "text-[var(--foreground-secondary)] hover:bg-[var(--background-surface-hover)]"
    }`;

  return (
    <aside className="sticky top-0 hidden h-screen w-72 shrink-0 flex-col border-r p-4 md:flex" style={{ borderColor: "var(--border-subtle)", background: "var(--background-surface)" }}>
      <div className="mb-6 shrink-0">
        <div className="text-lg font-bold">Task Tracker</div>
        <div className="muted text-sm">Local v1 workspace</div>
      </div>
      <nav className="flex shrink-0 flex-col gap-1">
        <button className={navClass(view.type === "dashboard")} onClick={() => setView({ type: "dashboard" })}>Dashboard</button>
        <button className={navClass(view.type === "general")} onClick={() => setView({ type: "general" })}>
          <ColorDot color={state.generalColor} /> General
        </button>
        <button className={navClass(view.type === "daily")} onClick={() => setView({ type: "daily" })}>
          <ColorDot color={state.dailyColor} /> Daily
        </button>
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
      <button className={`${navClass(view.type === "settings")} mt-6 shrink-0`} onClick={() => setView({ type: "settings" })}>Settings</button>
    </aside>
  );
}

function Dashboard(props: {
  state: AppState;
  queue: WorkQueueItem[];
  openTask: (ref: TaskRef) => void;
  setTaskStage: (ref: TaskRef, stage: TaskStage) => void;
}) {
  const { state, queue, openTask, setTaskStage } = props;
  const completedToday = state.dailyTasks.filter((task) => task.completed).length;
  const activeProjects = state.projects.length;
  const blockedCount = buildWorkQueue(state, true).filter((item) => item.blockedBy.length).length;

  return (
    <section className="mx-auto max-w-6xl">
      <Header title="Dashboard" subtitle="Prioritized actionable work across general, daily, and project tasks." />
      <div className="mb-5 grid gap-3 md:grid-cols-3">
        <Metric label="Daily done" value={`${completedToday}/${state.dailyTasks.length}`} />
        <Metric label="Active projects" value={String(activeProjects)} />
        <Metric label="Blocked tasks" value={String(blockedCount)} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold">Work queue</h2>
        <span className="muted text-sm">Due dates warn, priority still leads.</span>
      </div>
      <div className="mt-3 grid gap-2">
        {queue.length === 0 && <EmptyState text="No active unblocked work." />}
        {queue.map((item) => (
          <QueueRow key={item.id} item={item} timezone={state.settings.timezone} openTask={openTask} setTaskStage={setTaskStage} />
        ))}
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

function SettingsView({ state, setState, showToast }: {
  state: AppState;
  setState: (state: AppState) => void;
  showToast: (message: string, tone?: Toast["tone"]) => void;
}) {
  return (
    <section className="mx-auto max-w-3xl">
      <Header title="Settings" subtitle="Controls that affect task behavior across the workspace." />
      <div className="grid gap-4 rounded-app border p-4" style={{ background: "var(--background-surface)", borderColor: "var(--border-subtle)" }}>
        <div className="field">
          <span className="label">Daily reset timezone</span>
          <Dropdown
            value={state.settings.timezone}
            options={timezoneOptions.map((timezone) => ({ value: timezone, label: timezone }))}
            onChange={(timezone) => setState({ ...state, settings: { ...state.settings, timezone } })}
            ariaLabel="Daily reset timezone"
          />
        </div>
        <div className="field">
          <span className="label">Theme</span>
          <Dropdown
            value={state.settings.theme}
            options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }]}
            onChange={(theme) => setState({ ...state, settings: { ...state.settings, theme: theme as AppState["settings"]["theme"] } })}
            ariaLabel="Theme"
          />
        </div>
        <div className="subtle text-sm">Today in the selected timezone is {zonedToday(state.settings.timezone)}.</div>
      </div>
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
  "project name": "My Project",
  "milestones": [
    {
      "milestone name": "Sprint 1",
      "tasks": [
        { "task name": "Setup", "task uuid": "t1", "task urgency": "high" },
        { "task name": "Build", "task uuid": "t2", "dependencies": ["t1"] }
      ]
    }
  ]
}`;

  return (
    <div className="mt-6 rounded-app border p-4" style={{ background: "var(--background-surface)", borderColor: "var(--border-subtle)" }}>
      <div className="mb-3">
        <div className="label mb-1">Import project</div>
        <p className="subtle text-sm">Paste a JSON project definition. Task UUIDs are used to resolve dependencies and then discarded.</p>
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
