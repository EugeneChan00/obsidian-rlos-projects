# RLOS Projects

RLOS quote-vault adapter for [Vault Automation](https://github.com/EugeneChan00/obsidian-vault-automation). It turns the vault's project spec (`policy/PROJECTS.md` in the vault: `PROJECT` / `RFQ/` / `Rev-N/` / `PO/`, `work_status` / `opp_status` / `rev_status`, margin) into automation rules, project canvases, and Window Spaces, and adds the `RLOS Projects:` commands and a settings tab (canvas folding and card size).

Requires **Vault Automation** (API v1). Window Spaces integration requires [Window Spaces (RLOS fork)](https://github.com/EugeneChan00/obsidian-window-spaces).

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
