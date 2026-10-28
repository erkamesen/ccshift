# ccshift

VS Code extension for people who use more than one Claude account with Claude Code. Sign in to each account once, then switch between them from the status bar. You also see the 5-hour and weekly usage of all accounts in one place.

Works with the official Claude Code extension. No patching, no token handling.

## Install

```bash
npm install
npm run package
code --install-extension ccshift.vsix
```

Needs VS Code 1.95+ and either the Claude Code extension or the `claude` CLI.

## Usage

1. Open the **ccshift** view in the activity bar and click **+**.
2. Give the account a name and sign in through the browser.
3. Switch from the status bar (`Claude: Work · 5h 12%`), the dashboard, or with:
   - `Cmd+Alt+Shift+A` to switch account
   - `Cmd+Alt+Shift+T` to toggle between the last two

Your existing `~/.claude` shows up as the **Default** account.

All commands are under **ccshift:** in the command palette: Add, Switch, Quick Toggle, Open Dashboard, Refresh Usage, Rename, Remove, Set Workspace Account, Set Default Account, Reauthenticate, Diagnose Integration, Install/Remove Usage Collector, Clean Up.

## How it works

Claude Code already supports multiple accounts through `CLAUDE_CONFIG_DIR` ([docs](https://code.claude.com/docs/en/authentication)). Each directory has its own login, settings and history. On macOS the Keychain entry is tied to the directory too.

- **New accounts:** each gets a directory under `~/.ccshift/profiles/`. Sign-in runs `claude auth login` with that directory.
- **Switching:** sets `CLAUDE_CONFIG_DIR` in `claudeCode.environmentVariables` (user settings). The Claude Code extension watches that setting and picks up the change without a reload.
  - For the default account the variable is removed rather than set to `~/.claude`. Claude Code treats an explicit `~/.claude` as a different Keychain entry and would ask you to log in again.
- **Verification:** after a switch the extension
  - reads the setting back,
  - runs `claude auth status --json` with the same environment to check the directory and login,
  - and waits for Claude Code to log that it picked up the change.

  If the directory doesn't match, the switch is reverted.
- **Usage:** comes from `claude -p /usage`. That's a local command, so it doesn't use any tokens. It refreshes every 15 minutes while VS Code is focused, or on demand.

### Status line collector (optional)

Claude Code passes rate limits to status line scripts, but status lines only run in terminal sessions, not in the VS Code panel. If you use `claude` in a terminal, you can install the collector per account to pick up usage from those sessions. An existing status line is kept and still runs; removing the collector puts it back as it was.

## Settings

| Setting | Default | |
|---|---|---|
| `ccshift.usage.autoRefreshMinutes` | `15` | `0` to disable |
| `ccshift.usage.staleAfterMinutes` | `30` | |
| `ccshift.recommendations.enabled` | `true` | suggest another account near the limit |
| `ccshift.recommendations.warningThreshold` | `80` | |
| `ccshift.recommendations.criticalThreshold` | `95` | |
| `ccshift.recommendations.maxDataAgeMinutes` | `30` | |
| `ccshift.workspaceAccount.applyOnOpen` | `ask` | `ask` / `always` / `never` |
| `ccshift.terminal.applyAccount` | `true` | set `CLAUDE_CONFIG_DIR` in terminals |
| `ccshift.terminal.followWorkspaceAccount` | `true` | |
| `ccshift.statusBar.enabled` | `true` | |
| `ccshift.claudePath` | | custom `claude` binary |

## Limitations

- **Same account in every window.** `claudeCode.environmentVariables` is a machine-scoped setting, so the Claude Code panel uses the same account in all windows. To use two accounts at once:
  - use a separate VS Code profile for the second window, or
  - run `claude` in the terminal. Terminals follow the workspace account.
- **Running sessions keep their account.** A switch doesn't stop anything; already-running sessions continue on the old account. You get a warning if sessions are running.
- **History is per account.** Nothing is copied between accounts.
- **Usage is a snapshot.** It isn't a live feed.
- **The `/usage` output format is marked experimental by Anthropic.** If it changes, usage shows as unavailable instead of showing wrong numbers.
- **Process wrappers can't be verified.** If you use `claudeCode.claudeProcessWrapper`, the extension can't fully verify a switch.
- **Small trace in each account directory.** Usage queries create an empty `projects/` entry for `~/.ccshift/probe` in each account directory.
- **Platform.** Only tested on macOS.

## Security

- **Tokens:** never read, stored or logged. Only Claude Code's own `auth login`, `auth status` and `auth logout` touch credentials.
- **Local metadata:** `metadata.json` holds names, paths and the email/plan Claude Code reports. `usage-cache.json` holds percentages and timestamps. Both are mode 0600.
- **No shell strings:** commands run with argument arrays.
- **Deletion:** only directories the extension created can be deleted. `~/.claude` can't be.
- **Webview:** strict CSP, no remote content.
- **Network:** the extension itself makes no network requests.

## Development

```bash
npm install
npm run test:unit
npm run test:integration
npm run package
```

The integration tests start your installed VS Code with temporary user-data and extension directories and a temporary `CLAUDE_CONFIG_DIR`, so your real setup isn't touched. Set `CAM_IT_EXTENSION_PATH` to run them against an installed copy of the extension.

## License

MIT
