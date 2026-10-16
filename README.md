# RLOS Projects

RLOS quote-vault adapter for [Vault Automation](https://github.com/EugeneChan00/obsidian-vault-automation). It turns the vault's project spec (`spaces/process/project-lifecycle.md` in the vault: `PROJECT` / `RFQ/` / `Rev-N/` / `PO/`, `work_status` / `opp_status` / `rev_status`, margin) into automation rules, project canvases, and Window Spaces, and adds the `RLOS Projects:` commands and a settings tab (canvas folding and card size). Vault inputs: `vault-kit/schemas/projects.schema.json` (allowed values) and `vault-kit/templates/{project,revision,po}.md`.

Requires **Vault Automation** (API v1). Window Spaces integration requires [Window Spaces (RLOS fork)](https://github.com/EugeneChan00/obsidian-window-spaces).

## Document names

**Copy document name for current project** (command, ribbon button, or right-click *Copy document name…* inside a project folder) lists file-name templates rendered for that project and rev and copies the chosen one, extension included. Tokens: `{opp} {name} {folder} {rev} {sap} {pcbr} {po_number} {sales_order} {end_user} {site} {date} {yymmdd}`; `{rev}` is the `Rev-N` you are in, else `current_rev`; `{sap}` comes from the rev note only (the project `sapq` is offered as a prefill to confirm). Tokens with no value are asked for and remembered per project and rev until Obsidian restarts. Edit templates under Settings → RLOS Projects → *Document names* (`Label | extension | pattern` per line).

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
