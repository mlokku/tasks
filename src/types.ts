export type Urgency = "low" | "medium" | "high";
export type ThemeMode = "light" | "dark";
export type View =
  | { type: "dashboard" }
  | { type: "general" }
  | { type: "daily" }
  | { type: "project"; projectId: string }
  | { type: "settings" };

export type TaskBase = {
  id: string;
  name: string;
  completed: boolean;
  urgency: Urgency;
  dueDate?: string;
  notes?: string;
};

export type GeneralTask = TaskBase;

export type DailyTask = TaskBase & {
  completedOn?: string;
};

export type ProjectTask = TaskBase & {
  dependencyIds: string[];
};

export type Milestone = {
  id: string;
  name: string;
  urgency: Urgency;
  notes?: string;
  tasks: ProjectTask[];
};

export type Project = {
  id: string;
  name: string;
  priority: number;
  color: string;
  notes?: string;
  milestones: Milestone[];
};

export type AppSettings = {
  timezone: string;
  theme: ThemeMode;
};

export type AppState = {
  generalColor: string;
  dailyColor: string;
  generalTasks: GeneralTask[];
  dailyTasks: DailyTask[];
  projects: Project[];
  settings: AppSettings;
  lastDailyResetDate: string;
};

export type TaskRef =
  | { kind: "general"; taskId: string }
  | { kind: "daily"; taskId: string }
  | { kind: "project"; projectId: string; milestoneId: string; taskId: string };

export type WorkQueueItem = {
  id: string;
  label: string;
  source: string;
  color: string;
  urgency: Urgency;
  dueDate?: string;
  notes?: string;
  blockedBy: string[];
  blocking: string[];
  ref: TaskRef;
  sortTuple: number[];
};
