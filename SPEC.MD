# Task Tracker Specification

## Purpose

Build a web application for personal task tracking across unrelated work, recurring daily responsibilities, and multi-project work with strict hierarchy and dependency rules.

Authentication is intentionally out of scope for the initial version.

## User Workflow

The user is usually working on several projects at the same time while also receiving ad hoc tasks from conversations, quick emails, or interruptions. The app should make it easy to capture those tasks quickly, rank them by urgency, and separate simple standalone work from project work that has milestones, dependencies, and blockers.

The app should support three task categories:

- General tasks
- Daily tasks
- Project tasks

## Core Concepts

### Urgency

Urgency is a first-class sorting and prioritization concept.

General tasks, daily tasks, milestones, and project tasks use a three-level urgency scale:

- Low
- Medium
- High

Projects use a numeric priority scale from 1 to 10. Higher project priority outranks lower project priority.

For project work, project priority and urgency are hierarchical and global:

- A project with higher priority outranks a project with lower priority.
- All tasks inside the higher-priority project outrank all tasks inside the lower-priority project.
- This remains true even if a task in the lower-priority project has high task urgency and a task in the higher-priority project has low task urgency.
- Milestone and task urgency only determine priority within their parent project context.

### Due Dates

Tasks may have optional due dates.

Due dates apply to:

- General tasks
- Daily tasks, if useful
- Project tasks

Due dates should act as visual warnings and secondary sorting criteria. They should not override urgency or project priority.

### Notes

Project tasks must support notes. General and daily tasks may also support notes if this improves consistency and capture speed.

## Task Types

### General Tasks

General tasks are standalone to-do items that do not belong to a project.

Typical examples:

- Do a one-off task
- Set up something
- Order something
- Follow up on a request from an interruption or quick email

General tasks should support:

- Name
- Completion state
- Urgency level
- Optional due date
- Optional notes

General tasks can likely be represented by a conventional to-do list.

### Daily Tasks

Daily tasks are recurring tasks that reset every day.

Typical example:

- Check the dispatch box

Daily tasks behave like general tasks during the current day:

- They can be checked off.
- Once checked off, they remain completed for that day.
- On the next day, they return to an incomplete state.

Daily task reset behavior:

- Daily tasks reset at midnight.
- Midnight is based on the timezone selected in settings.
- The relevant current timezone is MST/MDT, but the app should allow the timezone to be selected.
- The selected timezone should control daily rollover regardless of where the app is accessed from.
- Daily tasks only need to track completion state for the current day.
- Daily tasks should reset when the app is next loaded after midnight.
- The reset will likely happen server side, so an already-open page may need to be reloaded to reflect the new day.

Daily tasks should support:

- Name
- Completion state for the current day
- Urgency level
- Optional due date, if needed
- Optional notes
- Timezone-aware daily reset behavior

### Project Tasks

Project tasks belong to a project and are organized under milestones.

Project work is hierarchical:

```text
Project
  Milestone
    Task
```

Projects can contain several milestones. Each milestone can contain several tasks.

Projects should support:

- Name
- Priority from 1 to 10
- Optional notes or description
- Milestones

Milestones should support:

- Name
- Urgency level
- Optional notes or description
- Tasks

Project tasks should support:

- Name
- Completion state
- Notes
- Urgency level
- Optional due date
- Dependencies
- Blocking tasks

## Dependencies And Blocking

Project tasks can depend on other project tasks.

Project tasks can also block other project tasks.

These relationships describe completion order constraints, not entry order. The user must be able to choose dependency and blocking relationships manually.

Example:

- Task B cannot be completed until Task A is complete.
- Task A blocks Task B from completion.

The app should treat these as two views of the same relationship:

- If Task B depends on Task A, then Task A blocks Task B.
- If Task A blocks Task B, then Task B depends on Task A.

Dependency scope:

- Dependencies are limited to project tasks.
- Dependencies can cross milestones within the same project.
- Dependencies cannot cross projects.
- General and daily tasks cannot be dependencies and cannot be blocked by dependency relationships.

Expected behavior:

- A blocked task should be visibly marked as blocked.
- The app should show which task or tasks are blocking it.
- The app should show which tasks a given task is blocking.
- A blocked task must be impossible to complete until all dependencies are complete.

## Prioritization Model

The app should be able to produce a useful work queue from all active tasks.

Initial prioritization rules:

1. Project priority determines global project-task priority across projects.
2. Within a project, milestone urgency determines priority across milestones.
3. Within a milestone, task urgency determines priority across tasks.
4. General and daily tasks use their own urgency levels.
5. General and daily task urgency ranks against the highest-priority project.
6. A medium general or daily task ranks higher than a low-urgency task in the highest-priority project, but lower than a high-urgency task in the highest-priority project.
7. A high general or daily task ranks the same as a high-urgency task in the highest-priority project.
8. Due dates act as visual warnings and secondary sorting, not as primary priority.
9. Blocked project tasks should not appear as freely actionable work unless the view is specifically showing blocked tasks.

## Settings

The app should include settings for:

- Timezone used for daily task reset

Initial timezone requirement:

- Support MST/MDT via a selectable timezone.
- Prefer storing this as an IANA timezone such as `America/Edmonton` rather than a fixed UTC offset, because daylight saving time changes between MST and MDT.

## User Interface

### Global Layout

The app should use a persistent sidebar for primary navigation.

The sidebar should include:

- Dashboard
- General
- Daily
- One entry for each project
- Settings

Project entries should be listed directly in the sidebar so the user can move between active projects quickly.

### Dashboard

The dashboard should provide a consolidated view of work across general tasks, daily tasks, and project tasks.

The exact dashboard contents and prioritization behavior are not yet defined.

### General Task View

Clicking `General` in the sidebar should show:

- A list of general tasks
- A button to add a general task

Clicking a general task should open a popover for that task.

The task popover should allow the user to view task details, including:

- Name
- Urgency
- Due date, if present
- Notes, if present
- Completion state

The popover should include an edit action that switches the task into edit mode.

### Daily Task View

Clicking `Daily` in the sidebar should show:

- A list of daily tasks
- A button to add a daily task

Clicking a daily task should open a popover for that task.

The daily task popover should behave similarly to the general task popover, showing task details and offering an edit mode.

### Project View

Clicking a project in the sidebar should open that project's milestone board.

Milestones should be displayed as columns.

Project milestone columns should:

- Be arranged horizontally
- Support horizontal scrolling when there are more milestones than fit onscreen
- Show tasks as vertically stacked rows under the milestone

Project tasks should behave similarly to general and daily tasks when clicked:

- Clicking a task opens a task popover.
- The popover shows task details.
- The popover offers an edit mode.

Project task popovers should additionally show project-specific relationships, including:

- Dependencies
- Blocking tasks
- Milestone
- Project context

### Color Coding

General, daily, and each project can have an assigned color.

Colors should be selected from a predetermined set of high-contrast, saturated colors.

These navigation and task identity colors:

- Do not need to come from `palette.json`
- Should contrast clearly against app backgrounds
- Should be visually distinct from each other
- Should be sharp and saturated enough to identify task ownership at a glance

Each task should show a colored band or line on its left edge using the color of the group it belongs to:

- General tasks use the general task color.
- Daily tasks use the daily task color.
- Project tasks use their project color.

This color marker should make it easy to identify task origin in lists, dashboard views, and project views.

## Out Of Scope For Initial Version

- Authentication
- Multi-user collaboration
- Permissions and sharing
- Notifications
- Calendar integration
- Email ingestion
- Mobile app packaging

These may be added later, but the initial product should focus on task capture, hierarchy, priority, and daily reset behavior.

## Open Questions

- What project and milestone fields are needed beyond name, project priority or milestone urgency, and optional notes?

