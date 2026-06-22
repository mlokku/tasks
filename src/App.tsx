import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { buildWorkQueue, blockedByNames, blockingNames, getProjectTaskMaps } from "./prioritization";
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

export default function App() {
  const [state, setState] = useState<AppState>(() => createInitialState());
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [view, setView] = useState<View>({ type: "dashboard" });
  const [selectedTask, setSelectedTask] = useState<TaskRef | null>(null);
  const [editing, setEditing] = useState(false);
  const [addTarget, setAddTarget] = useState<AddTaskTarget | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [newMilestoneName, setNewMilestoneName] = useState("");

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

  function updateState(mutator: (current: AppState) => AppState) {
    setState((current) => mutator(current));
  }

  function openTask(ref: TaskRef) {
    setSelectedTask(ref);
    setEditing(false);
  }

  function toggleTask(ref: TaskRef) {
    updateState((current) => updateTask(current, ref, (task, context) => {
      if (context?.blockedBy.length) return task;
      const completed = !task.completed;
      return {
        ...task,
        completed,
        ...(ref.kind === "daily" ? { completedOn: completed ? zonedToday(current.settings.timezone) : undefined } : {})
      };
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
  }

  return (
    <div className="app-shell" style={themeVars(state.settings.theme)}>
      <div className="flex min-h-screen">
        <Sidebar
          state={state}
          view={view}
          setView={setView}
          setSelectedTask={setSelectedTask}
          newProjectName={newProjectName}
          setNewProjectName={setNewProjectName}
          addProject={addProject}
        />
        <main className="min-w-0 flex-1 px-4 py-4 md:px-6">
          {!loaded && <div className="mb-4 rounded-app border p-3 text-sm subtle" style={{ background: "var(--background-surface)", borderColor: "var(--border-subtle)" }}>Loading SQLite data...</div>}
          {saveError && <div className="mb-4 rounded-app border p-3 text-sm" style={{ background: "var(--status-red-background)", borderColor: "var(--status-red-bar)", color: "var(--status-red-text)" }}>{saveError}</div>}
          {view.type === "dashboard" && (
            <Dashboard state={state} queue={queue} openTask={openTask} toggleTask={toggleTask} />
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
              toggleTask={toggleTask}
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
              toggleTask={toggleTask}
              timezone={state.settings.timezone}
            />
          )}
          {activeProject && (
            <ProjectView
              project={activeProject}
              timezone={state.settings.timezone}
              openTask={openTask}
              toggleTask={toggleTask}
              setAddTarget={setAddTarget}
              updateProject={(project) => updateState((current) => ({
                ...current,
                projects: current.projects.map((candidate) => candidate.id === project.id ? project : candidate)
              }))}
              newMilestoneName={newMilestoneName}
              setNewMilestoneName={setNewMilestoneName}
              addMilestone={() => addMilestone(activeProject.id)}
            />
          )}
          {view.type === "settings" && (
            <SettingsView state={state} setState={setState} />
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
          toggleTask={toggleTask}
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
    </div>
  );
}

function Sidebar(props: {
  state: AppState;
  view: View;
  setView: (view: View) => void;
  setSelectedTask: (ref: TaskRef | null) => void;
  newProjectName: string;
  setNewProjectName: (value: string) => void;
  addProject: () => void;
}) {
  const { state, view, setView, setSelectedTask } = props;
  const navClass = (active: boolean) =>
    `flex w-full items-center gap-2 rounded-app px-3 py-2 text-left text-sm font-semibold transition ${
      active ? "bg-[var(--tile-active)] text-[var(--foreground-primary)]" : "text-[var(--foreground-secondary)] hover:bg-[var(--background-surface-hover)]"
    }`;

  function navigate(nextView: View) {
    setView(nextView);
    setSelectedTask(null);
  }

  return (
    <aside className="sticky top-0 hidden h-screen w-72 shrink-0 border-r p-4 md:block" style={{ borderColor: "var(--border-subtle)", background: "var(--background-surface)" }}>
      <div className="mb-6">
        <div className="text-lg font-bold">Task Tracker</div>
        <div className="muted text-sm">Local v1 workspace</div>
      </div>
      <nav className="flex flex-col gap-1">
        <button className={navClass(view.type === "dashboard")} onClick={() => navigate({ type: "dashboard" })}>Dashboard</button>
        <button className={navClass(view.type === "general")} onClick={() => navigate({ type: "general" })}>
          <ColorDot color={state.generalColor} /> General
        </button>
        <button className={navClass(view.type === "daily")} onClick={() => navigate({ type: "daily" })}>
          <ColorDot color={state.dailyColor} /> Daily
        </button>
      </nav>
      <div className="mt-6">
        <div className="label mb-2">Projects</div>
        <nav className="flex flex-col gap-1">
          {state.projects.map((project) => (
            <button key={project.id} className={navClass(view.type === "project" && view.projectId === project.id)} onClick={() => navigate({ type: "project", projectId: project.id })}>
              <ColorDot color={project.color} /> <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <span className="muted text-xs">P{project.priority}</span>
            </button>
          ))}
        </nav>
        <div className="mt-3 flex gap-2">
          <input className="input min-w-0" placeholder="New project" value={props.newProjectName} onChange={(event) => props.setNewProjectName(event.target.value)} />
          <IconButton variant="secondary" icon="add" label="Add project" onClick={props.addProject} />
        </div>
      </div>
      <button className={`${navClass(view.type === "settings")} mt-6`} onClick={() => navigate({ type: "settings" })}>Settings</button>
    </aside>
  );
}

function Dashboard(props: {
  state: AppState;
  queue: WorkQueueItem[];
  openTask: (ref: TaskRef) => void;
  toggleTask: (ref: TaskRef) => void;
}) {
  const { state, queue, openTask, toggleTask } = props;
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
          <QueueRow key={item.id} item={item} timezone={state.settings.timezone} openTask={openTask} toggleTask={toggleTask} />
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
  toggleTask: (ref: TaskRef) => void;
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
              toggle={() => props.toggleTask(ref)}
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
  toggleTask: (ref: TaskRef) => void;
  setAddTarget: (target: AddTaskTarget) => void;
  updateProject: (project: Project) => void;
  newMilestoneName: string;
  setNewMilestoneName: (value: string) => void;
  addMilestone: () => void;
}) {
  const { project } = props;
  const [notesEditing, setNotesEditing] = useState(false);

  useEffect(() => {
    setNotesEditing(false);
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
          <div key={milestone.id} className="w-[320px] shrink-0 rounded-app border p-3" style={{ background: "var(--background-surface)", borderColor: "var(--border-subtle)" }}>
            <div className="mb-3 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <input className="input mb-2 font-semibold" value={milestone.name} onChange={(event) => updateMilestone({ ...milestone, name: event.target.value })} />
                <select className="input" value={milestone.urgency} onChange={(event) => updateMilestone({ ...milestone, urgency: event.target.value as Urgency })}>
                  {urgencyOptions.map((urgency) => <option key={urgency} value={urgency}>{capitalize(urgency)} urgency</option>)}
                </select>
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
                    toggle={() => props.toggleTask(ref)}
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

function SettingsView({ state, setState }: { state: AppState; setState: (state: AppState) => void }) {
  return (
    <section className="mx-auto max-w-3xl">
      <Header title="Settings" subtitle="Controls that affect task behavior across the workspace." />
      <div className="grid gap-4 rounded-app border p-4" style={{ background: "var(--background-surface)", borderColor: "var(--border-subtle)" }}>
        <label className="field">
          <span className="label">Daily reset timezone</span>
          <select
            className="input"
            value={state.settings.timezone}
            onChange={(event) => setState({ ...state, settings: { ...state.settings, timezone: event.target.value } })}
          >
            {timezoneOptions.map((timezone) => <option key={timezone} value={timezone}>{timezone}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="label">Theme</span>
          <select
            className="input"
            value={state.settings.theme}
            onChange={(event) => setState({ ...state, settings: { ...state.settings, theme: event.target.value as AppState["settings"]["theme"] } })}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <div className="subtle text-sm">Today in the selected timezone is {zonedToday(state.settings.timezone)}.</div>
      </div>
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
  toggleTask: (ref: TaskRef) => void;
}) {
  const { details, state } = props;
  const [draft, setDraft] = useState<EditorDraft>(() => draftFromTask(details.task));

  useEffect(() => {
    setDraft(draftFromTask(details.task));
  }, [details.task.id]);

  let project: Project | undefined;
  let projectTasks: { id: string; label: string }[] = [];
  if (details.ref.kind === "project") {
    const projectRef = details.ref;
    project = state.projects.find((candidate) => candidate.id === projectRef.projectId);
    projectTasks = project ? allProjectTaskOptions(project, projectRef.taskId) : [];
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
          <TaskEditor draft={draft} setDraft={setDraft} projectTasks={projectTasks} />
        ) : (
          <TaskDetails details={details} timezone={state.settings.timezone} />
        )}

        <div className="mt-5 flex flex-wrap justify-between gap-2">
          <button className="btn btn-secondary" disabled={details.blockedBy.length > 0} onClick={() => props.toggleTask(details.ref)}>
            {details.task.completed ? "Mark incomplete" : "Complete"}
          </button>
          <div className="flex gap-2">
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
  let projectTasks: { id: string; label: string }[] = [];
  if (props.target.kind === "project") {
    const projectTarget = props.target;
    project = props.state.projects.find((candidate) => candidate.id === projectTarget.projectId);
    projectTasks = project ? allProjectTaskOptions(project) : [];
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/45 p-4" onMouseDown={props.close}>
      <section className="w-full max-w-2xl rounded-app border p-4 shadow-2xl" style={{ background: "var(--background-surface-elevated)", borderColor: "var(--border-default)" }} onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-xl font-bold">Add task</h2>
          <IconButton variant="secondary" icon="close" label="Close" onClick={props.close} />
        </div>
        <TaskEditor draft={draft} setDraft={setDraft} projectTasks={projectTasks} />
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn btn-secondary" onClick={props.close}>Cancel</button>
          <IconButton variant="primary" icon="add" label="Add task" onClick={() => props.save(props.target, draft)} />
        </div>
      </section>
    </div>
  );
}

function TaskEditor(props: {
  draft: EditorDraft;
  setDraft: (draft: EditorDraft) => void;
  projectTasks: { id: string; label: string }[];
}) {
  const { draft, setDraft } = props;
  return (
    <div className="grid gap-4">
      <label className="field">
        <span className="label">Name</span>
        <input className="input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      </label>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="field">
          <span className="label">Urgency</span>
          <select className="input" value={draft.urgency} onChange={(event) => setDraft({ ...draft, urgency: event.target.value as Urgency })}>
            {urgencyOptions.map((urgency) => <option key={urgency} value={urgency}>{capitalize(urgency)}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="label">Due date</span>
          <input className="input" type="date" value={draft.dueDate} onChange={(event) => setDraft({ ...draft, dueDate: event.target.value })} />
        </label>
      </div>
      <label className="field">
        <span className="label">Notes</span>
        <textarea className="input min-h-24" value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
      </label>
      {props.projectTasks.length > 0 && (
        <label className="field">
          <span className="label">Dependencies</span>
          <select
            className="input min-h-32"
            multiple
            value={draft.dependencyIds}
            onChange={(event) => setDraft({ ...draft, dependencyIds: Array.from(event.target.selectedOptions).map((option) => option.value) })}
          >
            {props.projectTasks.map((task) => <option key={task.id} value={task.id}>{task.label}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}

function TaskDetails({ details, timezone }: { details: ResolvedTask; timezone: string }) {
  return (
    <div className="grid gap-3 text-sm">
      <Detail label="Status" value={details.task.completed ? "Completed" : details.blockedBy.length ? "Blocked" : "Open"} />
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
  toggle: () => void;
}) {
  const blocked = props.blockedBy.length > 0;
  return (
    <div className="tile grid grid-cols-[5px_1fr_auto] overflow-hidden">
      <div style={{ background: props.color }} />
      <button className="min-w-0 p-3 text-left" onClick={props.open}>
        <div className={`font-semibold ${props.task.completed ? "line-through muted" : ""}`}>{props.task.name}</div>
        <div className="mt-1 flex flex-wrap gap-2 text-xs">
          <Pill tone={urgencyTone(props.task.urgency)}>{capitalize(props.task.urgency)}</Pill>
          {props.task.dueDate && <Pill tone={dateTone(props.task.dueDate, props.timezone)}>{dueLabel(props.task.dueDate, props.timezone)}</Pill>}
          {blocked && <Pill tone="red">Blocked by {props.blockedBy.length}</Pill>}
          {props.blocking.length > 0 && <Pill tone="yellow">Blocking {props.blocking.length}</Pill>}
        </div>
      </button>
      <div className="flex items-center p-3">
        <button className="btn btn-secondary" disabled={blocked} onClick={props.toggle}>{props.task.completed ? "Undo" : "Done"}</button>
      </div>
    </div>
  );
}

function QueueRow({ item, timezone, openTask, toggleTask }: {
  item: WorkQueueItem;
  timezone: string;
  openTask: (ref: TaskRef) => void;
  toggleTask: (ref: TaskRef) => void;
}) {
  return (
    <div className="tile grid grid-cols-[5px_1fr_auto] overflow-hidden">
      <div style={{ background: item.color }} />
      <button className="min-w-0 p-3 text-left" onClick={() => openTask(item.ref)}>
        <div className="font-semibold">{item.label}</div>
        <div className="subtle text-sm">{item.source}</div>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          <Pill tone={urgencyTone(item.urgency)}>{capitalize(item.urgency)}</Pill>
          {item.dueDate && <Pill tone={dateTone(item.dueDate, timezone)}>{dueLabel(item.dueDate, timezone)}</Pill>}
        </div>
      </button>
      <div className="flex items-center p-3">
        <button className="btn btn-secondary" onClick={() => toggleTask(item.ref)}>Done</button>
      </div>
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

function IconButton({ variant, icon, label, onClick, disabled = false }: { variant: "primary" | "secondary"; icon: string; label: string; onClick: () => void; disabled?: boolean }) {
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

function allProjectTaskOptions(project: Project, excludeId?: string): { id: string; label: string }[] {
  const { milestoneByTaskId } = getProjectTaskMaps(project);
  return project.milestones.flatMap((milestone) =>
    milestone.tasks
      .filter((task) => task.id !== excludeId)
      .map((task) => ({ id: task.id, label: `${milestoneByTaskId.get(task.id) === milestone.id ? milestone.name : "Milestone"} / ${task.name}` }))
  );
}

function urgencyTone(urgency: Urgency): "red" | "yellow" | "green" {
  if (urgency === "high") return "red";
  if (urgency === "medium") return "yellow";
  return "green";
}

function dateTone(dueDate: string, timezone: string): "red" | "yellow" | "neutral" {
  if (isOverdue(dueDate, timezone)) return "red";
  if (dueSoon(dueDate, timezone)) return "yellow";
  return "neutral";
}

function dueLabel(dueDate: string, timezone: string): string {
  if (isOverdue(dueDate, timezone)) return `Overdue ${dueDate}`;
  if (dueSoon(dueDate, timezone)) return `Due soon ${dueDate}`;
  return `Due ${dueDate}`;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
