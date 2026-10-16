# RLOS Projects

RLOS quote-vault adapter for [Vault Automation](https://github.com/EugeneChan00/obsidian-vault-automation). It turns the vault's project spec (`spaces/process/project-lifecycle.md` in the vault: `PROJECT` / `RFQ/` / `Rev-N/` / `PO/`, `work_status` / `opp_status` / `rev_status`, margin) into automation rules, project canvases, and Window Spaces, and adds the `RLOS Projects:` commands and a settings tab (canvas folding and card size). Vault inputs: `vault-kit/schemas/projects.schema.json` (allowed values) and `vault-kit/templates/{project,revision,po}.md`.

Requires **Vault Automation** (API v1). Window Spaces integration requires [Window Spaces (RLOS fork)](https://github.com/EugeneChan00/obsidian-window-spaces).

## Document names

**Copy document name for current project** (command, ribbon button, right-click *Copy document name…* inside a project folder, or one *Copy document name: <template>* command per template) renders file-name templates for that project and rev and copies the chosen one, extension included.

- **Fields** bind each `{token}` to a frontmatter property on the project, rev or PO note (defaults: `{opp}` → project `opp`, `{sapq}` → rev `sap` with project `sapq` as prefill, `{sales_order}` → PO `sales_order`, …). Property names are case-sensitive; settings suggest the exact keys your notes use and reject case mismatches with a one-click fix. Bound properties get a type in Obsidian (`types.json`) with that exact spelling.
- **Built-in tokens**: `{folder} {folder_opp} {rev} {date} {yymmdd}`; `{rev}` is the `Rev-N` you are in, else `current_rev`.
- **Missing or ambiguous values** (empty property, several values in a list, no PO note) are asked for, remembered per project and rev for the session, and — with *Save typed values to notes* on — written to the bound property.
- **Validation**: unknown tokens, bad braces/extensions, duplicate labels or tokens, and case mismatches are errors; nothing is saved while one remains and the last valid configuration stays in use.

## Alt+Q menu (QuickAdd)

On start and after template changes, the plugin writes its entries to the top of QuickAdd's menu: New Project, New Revision, Change Status, Add Task (`vault-kit/scripts/add_task.js`), Copy Document Name…, and *Doc Name: <template>*. A QuickAdd choice with one of these names is replaced; other choices stay. Run **Sync Alt+Q (QuickAdd) menu** to force it.

## Install

With [BRAT](https://github.com/TfTHacker/obsidian42-brat), in this order:

1. `EugeneChan00/obsidian-window-spaces`
2. `EugeneChan00/obsidian-vault-automation`
3. `EugeneChan00/obsidian-rlos-projects`

## Develop

```bash
npm install                   # pulls vault-automation (types) from GitHub
npm run build
RLOS_VAULT=/path/to/vault npm run deploy
```

## Release

Bump `version` in `manifest.json` and `package.json`, commit, push, then `npm run release`.
