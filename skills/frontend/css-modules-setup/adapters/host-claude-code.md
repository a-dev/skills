# Claude Code host adapter

Use this adapter only when installing or verifying the skills for Claude Code. The portable methodology does not depend on these paths or commands.

## Project installation

```sh
npx skills add a-dev/skills \
  --skill css-modules-setup \
  --skill css-modules \
  --agent claude-code \
  --yes
```

The `skills` CLI targets `.claude/skills/` for a Claude Code project. Verify both the installer view and Claude Code's actual skill catalog:

```sh
npx skills list --agent claude-code
node .claude/skills/css-modules-setup/scripts/verify-installation.mjs \
  --host claude-code \
  --scope project \
  --project-root . \
  --scan .
```

Invoke `css-modules-setup` explicitly through Claude Code's skill mechanism. Slash-command projection and manual-only metadata are host behavior, not a portable promise. The daily `css-modules` skill may activate only after its adoption gate passes.

## User installation

Add `--global` to the install command. The CLI targets `~/.claude/skills/` for Claude Code user skills.

```sh
npx skills list --global --agent claude-code
node ~/.claude/skills/css-modules-setup/scripts/verify-installation.mjs \
  --host claude-code \
  --scope global
```

Do not keep project and user copies with the same name and rely on precedence. The verifier reports that state as ambiguous so an old copy cannot silently shadow an update.

## Host-specific behavior

`disable-model-invocation` expresses the author's manual-setup intent, but support and UI behavior belong to Claude Code. Confirm the installed skill's behavior in the host catalog.

The repository tests the documented discovery directories, canonical-copy comparison, and project/global shadow detection. The catalog check remains a host-level verification step.
