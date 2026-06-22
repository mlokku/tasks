# Repository Guidelines

## Project Structure & Module Organization

This checkout contains `palette.json`, the authoritative color scheme for dark and light modes. Keep design-token data at the repository root until a broader app structure is introduced. If source code is added, place modules under `src/`, tests under `tests/` or beside modules as `*.test.*`, and static assets under `assets/`.

## Build, Test, and Development Commands

No package manifest or build system is present yet. Use lightweight validation commands before committing:

- `python -m json.tool palette.json >/tmp/palette.json` validates JSON syntax.
- `git diff --check` flags trailing whitespace and common patch formatting issues.
- `git status --short` confirms exactly which files will be committed.

If a future `package.json`, `Makefile`, or similar entry point is added, document its canonical commands here and prefer those over ad hoc scripts.

## Coding Style & Naming Conventions

For JSON files, use two-space indentation and keep object keys descriptive. Existing token names use lower camel case for nested properties, such as `surfaceElevated`, `backgroundHover`, and `brandSoft`; follow that pattern for new tokens. Treat `palette.json` as the source of truth for colors. Keep color values as uppercase hex strings where possible, for example `#F4F4F5`, and use `rgba(...)` only when alpha is required.

Group related tokens by purpose: `background`, `foreground`, `border`, `status`, `button`, `input`, `accent`, and `shadow`. Add new groups only when they represent a reusable semantic role rather than a one-off UI detail.

Use Noto Sans as the project font family in UI code and generated assets.

## Testing Guidelines

There is no automated test suite in the current repository. At minimum, validate JSON syntax after editing `palette.json`. When application code is added, include tests for token loading, theme selection, and any transformation logic that maps these tokens into CSS, Tailwind, or runtime theme objects.

## Commit & Pull Request Guidelines

Recent commits use short, imperative summaries such as `Refine topbar and sidebar layout` and `Updated color palette`. Keep commit messages concise and focused on the user-visible or technical change.

Pull requests should include a brief description, the affected token groups or files, validation performed, and screenshots when visual styling changes are involved. Link related issues when available.

## Agent-Specific Instructions

Do not overwrite existing contributor guidance. Keep future edits scoped to repository conventions that are actually present, and avoid documenting tools until they exist in the project.
