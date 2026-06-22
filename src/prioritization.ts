import type { AppState, Project, ProjectTask, TaskStage, Urgency, WorkQueueItem } from "./types";

function taskStage(task: { completed: boolean; stage?: TaskStage }): TaskStage {
  return task.stage ?? (task.completed ? "complete" : "notStarted");
}

const urgencyRank: Record<Urgency, number> = {
  high: 3,
  medium: 2,
  low: 1
};

export function urgencyValue(urgency: Urgency): number {
  return urgencyRank[urgency];
}

export function getProjectTaskMaps(project: Project) {
  const taskById = new Map<string, ProjectTask>();
  const milestoneByTaskId = new Map<string, string>();
  for (const milestone of project.milestones) {
    for (const task of milestone.tasks) {
      taskById.set(task.id, task);
      milestoneByTaskId.set(task.id, milestone.id);
    }
  }
  return { taskById, milestoneByTaskId };
}

export function blockedByNames(task: ProjectTask, project: Project): string[] {
  const { taskById } = getProjectTaskMaps(project);
  return task.dependencyIds
    .map((id) => taskById.get(id))
    .filter((dependency): dependency is ProjectTask => Boolean(dependency && taskStage(dependency) !== "complete"))
    .map((dependency) => dependency.name);
}

export function blockingNames(task: ProjectTask, project: Project): string[] {
  const names: string[] = [];
  for (const milestone of project.milestones) {
    for (const candidate of milestone.tasks) {
      if (candidate.dependencyIds.includes(task.id) && taskStage(candidate) !== "complete") {
        names.push(candidate.name);
      }
    }
  }
  return names;
}

export function buildWorkQueue(state: AppState, includeBlocked = false): WorkQueueItem[] {
  const highestProjectPriority = Math.max(0, ...state.projects.map((project) => project.priority));
  const queue: WorkQueueItem[] = [];

  for (const task of state.generalTasks) {
    if (taskStage(task) === "complete") continue;
    queue.push({
      id: `general-${task.id}`,
      label: task.name,
      source: "General",
      color: state.generalColor,
      urgency: task.urgency,
      dueDate: task.dueDate,
      notes: task.notes,
      stage: taskStage(task),
      blockedBy: [],
      blocking: [],
      ref: { kind: "general", taskId: task.id },
      sortTuple: [highestProjectPriority, urgencyValue(task.urgency), 0, dueSort(task.dueDate)]
    });
  }

  for (const task of state.dailyTasks) {
    if (taskStage(task) === "complete") continue;
    queue.push({
      id: `daily-${task.id}`,
      label: task.name,
      source: "Daily",
      color: state.dailyColor,
      urgency: task.urgency,
      dueDate: task.dueDate,
      notes: task.notes,
      stage: taskStage(task),
      blockedBy: [],
      blocking: [],
      ref: { kind: "daily", taskId: task.id },
      sortTuple: [highestProjectPriority, urgencyValue(task.urgency), 0, dueSort(task.dueDate)]
    });
  }

  for (const project of state.projects) {
    for (const milestone of project.milestones) {
      for (const task of milestone.tasks) {
        if (taskStage(task) === "complete") continue;
        const blockers = blockedByNames(task, project);
        if (blockers.length && !includeBlocked) continue;
        queue.push({
          id: `project-${task.id}`,
          label: task.name,
          source: `${project.name} / ${milestone.name}`,
          color: project.color,
          urgency: task.urgency,
          dueDate: task.dueDate,
          notes: task.notes,
          stage: taskStage(task),
          blockedBy: blockers,
          blocking: blockingNames(task, project),
          ref: { kind: "project", projectId: project.id, milestoneId: milestone.id, taskId: task.id },
          sortTuple: [
            project.priority,
            urgencyValue(milestone.urgency),
            urgencyValue(task.urgency),
            dueSort(task.dueDate)
          ]
        });
      }
    }
  }

  return queue.sort(compareQueueItems);
}

function compareQueueItems(a: WorkQueueItem, b: WorkQueueItem): number {
  for (let index = 0; index < a.sortTuple.length; index += 1) {
    const diff = b.sortTuple[index] - a.sortTuple[index];
    if (diff !== 0) return diff;
  }
  return a.label.localeCompare(b.label);
}

function dueSort(dueDate: string | undefined): number {
  if (!dueDate) return 0;
  const time = new Date(`${dueDate}T00:00:00`).getTime();
  return Number.isFinite(time) ? -time / 86_400_000 : 0;
}
