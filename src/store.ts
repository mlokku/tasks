import { createInitialState } from "./sampleData";
import { zonedToday } from "./time";
import type { AppState, TaskBase, TaskStage } from "./types";

export async function loadState(): Promise<AppState> {
  try {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error(`Unable to load state: ${response.status}`);
    return applyDailyReset(normalizeState(await response.json() as AppState));
  } catch (error) {
    console.error(error);
    return createInitialState();
  }
}

export async function saveState(state: AppState): Promise<AppState> {
  const response = await fetch("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state)
  });
  if (!response.ok) throw new Error(`Unable to save state: ${response.status}`);
  return await response.json() as AppState;
}

function normalizeTask<T extends TaskBase>(task: T): T {
  const stage: TaskStage = task.stage ?? (task.completed ? "complete" : "notStarted");
  return { ...task, stage, completed: stage === "complete" };
}

function normalizeState(state: AppState): AppState {
  return {
    ...state,
    generalTasks: state.generalTasks.map(normalizeTask),
    dailyTasks: state.dailyTasks.map(normalizeTask),
    projects: state.projects.map((project) => ({
      ...project,
      milestones: project.milestones.map((milestone) => ({
        ...milestone,
        tasks: milestone.tasks.map(normalizeTask)
      }))
    }))
  };
}

export function applyDailyReset(state: AppState): AppState {
  const today = zonedToday(state.settings.timezone);
  if (state.lastDailyResetDate === today) return state;

  return {
    ...state,
    lastDailyResetDate: today,
    dailyTasks: state.dailyTasks.map((task) => ({
      ...task,
      completed: false,
      stage: "notStarted",
      completedOn: undefined
    }))
  };
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
