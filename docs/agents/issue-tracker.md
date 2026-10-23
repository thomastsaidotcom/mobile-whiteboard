# Issue tracker: GitHub

Repository: thomastsaidotcom/mobile-whiteboard

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --repo thomastsaidotcom/mobile-whiteboard --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo thomastsaidotcom/mobile-whiteboard --comments`.
- **List issues**: `gh issue list --repo thomastsaidotcom/mobile-whiteboard --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --repo thomastsaidotcom/mobile-whiteboard --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo thomastsaidotcom/mobile-whiteboard --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo thomastsaidotcom/mobile-whiteboard --comment "..."`

Keep the explicit repository target: automatic `gh` selection can choose this fork's upstream repository.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --repo thomastsaidotcom/mobile-whiteboard --comments` and `gh pr diff <number> --repo thomastsaidotcom/mobile-whiteboard` for the diff.
- **List external PRs for triage**: `gh pr list --repo thomastsaidotcom/mobile-whiteboard --state open --json number,title,body,labels,author,comments`. For each PR, read its association with `gh api repos/thomastsaidotcom/mobile-whiteboard/pulls/<number> --jq .author_association`; exclude `OWNER`, `MEMBER`, and `COLLABORATOR`, and triage all other associations.
- **Comment / label / close**: `gh pr comment <number> --repo thomastsaidotcom/mobile-whiteboard --body "..."`, `gh pr edit <number> --repo thomastsaidotcom/mobile-whiteboard --add-label "<label>"` / `--remove-label "<label>"`, `gh pr close <number> --repo thomastsaidotcom/mobile-whiteboard`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42 --repo thomastsaidotcom/mobile-whiteboard` and fall back to `gh issue view 42 --repo thomastsaidotcom/mobile-whiteboard`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue for ordinary work. Report security vulnerabilities privately through the process in root `SECURITY.md` instead.

## When a skill says "fetch the relevant issue"

Run `gh issue view <number> --repo thomastsaidotcom/mobile-whiteboard --comments`.

## Issue blocking

Use native issue dependencies for blocking edges where available; otherwise record blockers in the issue body. Start only after every blocker is closed; significant work also requires maintainer confirmation under root `CONTRIBUTING.md`.
