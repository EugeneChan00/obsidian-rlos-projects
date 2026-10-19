# Issue management

This file is this repository's issue-management policy. Agents read it before
any issue or change-proposal write. The `rlabs88` Linear organization package
of the Issue Management skill still applies.

## Platform

- Canonical work-item platform: Linear
- Organization or workspace: `rlabs88` (Linear workspace slug `rt88`)
- Change-proposal surface: GitHub pull requests and releases on this repository
- External intake: none

## Tags

- Groups or names that apply here: the workspace labels in the Linear
  **Workspace policy tag guide**. Use an `agile` label only when the issue's
  place in the loop is known.
- Required at create: none
- Agents may create new tags: no

The Linear **Team policy tag guide** `RLABS rules` section governs this
repository. Refresh it and the label inventory before any classification write.

## Projects

- Default project: `RLOS` (https://linear.app/rt88/project/rlos-39950ff886ce).
  It covers the Westburne Rockwell RLOS7 Obsidian vault and its plugins:
  obsidian-rlos-projects, obsidian-vault-automation, obsidian-window-spaces.
- What to do when none matches: ask the human.

## Teams and routing

- Default team: `RLABS`
- Human-plane or non-implementation routing: `RLABS`

## Intake and creation

- Who may create: the human, or an agent the human asked to file.
- Coordinates required at create: team `RLABS`, project `RLOS`.
- Human confirmations before create: none beyond the request to file.

## Releases

Each release raises the version by one patch step (0.3.0 → 0.3.1 → 0.3.2).
The GitHub release tag equals `manifest.json` `version`. BRAT installs from
the release assets `main.js`, `manifest.json`, and `styles.css` when present.

## Execution status

- Path: `.policy/execution/<session_id>.json`, one file per agent session.
  Do not commit it.
- Delete the file when this session stops executing that item.
