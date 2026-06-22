import type { AppState } from "./types";
import { zonedToday } from "./time";

export const identityColors = [
  "#00C2A8",
  "#F97316",
  "#38BDF8",
  "#E11D48",
  "#8B5CF6",
  "#22C55E",
  "#F59E0B",
  "#EC4899"
];

export function createInitialState(): AppState {
  const timezone = "America/Edmonton";
  return {
    generalColor: identityColors[0],
    dailyColor: identityColors[1],
    settings: {
      timezone,
      theme: "dark"
    },
    lastDailyResetDate: zonedToday(timezone),
    generalTasks: [
      {
        id: "general-1",
        name: "Return supplier quote with chosen option",
        completed: false,
        stage: "notStarted",
        urgency: "high",
        dueDate: "2026-06-24",
        notes: "Confirm price hold before replying."
      },
      {
        id: "general-2",
        name: "Order replacement label rolls",
        completed: false,
        stage: "notStarted",
        urgency: "medium"
      }
    ],
    dailyTasks: [
      {
        id: "daily-1",
        name: "Check the dispatch box",
        completed: false,
        stage: "notStarted",
        urgency: "high"
      },
      {
        id: "daily-2",
        name: "Review incoming requests",
        completed: false,
        stage: "notStarted",
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
            urgency: "high",
            tasks: [
              {
                id: "project-task-1",
                name: "Confirm aisle map changes",
                completed: false,
                stage: "notStarted",
                urgency: "high",
                dueDate: "2026-06-25",
                notes: "Needed before labels are printed.",
                dependencyIds: []
              },
              {
                id: "project-task-2",
                name: "Approve final label format",
                completed: false,
                stage: "notStarted",
                urgency: "medium",
                dependencyIds: ["project-task-1"]
              }
            ]
          },
          {
            id: "milestone-2",
            name: "Rollout",
            urgency: "medium",
            tasks: [
              {
                id: "project-task-3",
                name: "Print bin labels",
                completed: false,
                stage: "notStarted",
                urgency: "high",
                dependencyIds: ["project-task-2"]
              },
              {
                id: "project-task-4",
                name: "Update picking checklist",
                completed: false,
                stage: "notStarted",
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
            urgency: "medium",
            tasks: [
              {
                id: "project-task-5",
                name: "Create kickoff checklist",
                completed: false,
                stage: "notStarted",
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
