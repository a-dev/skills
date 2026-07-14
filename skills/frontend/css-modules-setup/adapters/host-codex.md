# Codex host adapter

Use this adapter only when installing or verifying the skills for Codex. The portable methodology does not depend on these paths or commands.

## Project installation

```sh
npx skills add a-dev/skills \
  --skill css-modules-setup \
  --skill css-modules \
  --agent codex \
  --yes
```

The `skills` CLI targets `.agents/skills/` for a Codex project. Verify both the installer view and the actual Codex available-skills catalog:

```sh
npx skills list --agent codex
node .agents/skills/css-modules-setup/scripts/verify-installation.mjs \
  --host codex \
  --scope project \
  --project-root . \
  --scan .
```

Invoke `css-modules-setup` explicitly through Codex's skill mechanism. Do not assume a slash command exists. The daily `css-modules` skill may activate only after its adoption gate passes.

## User installation

Add `--global` to the install command. The CLI targets `~/.codex/skills/` for Codex user skills.

```sh
npx skills list --global --agent codex
node ~/.codex/skills/css-modules-setup/scripts/verify-installation.mjs \
  --host codex \
  --scope global
```

Do not keep project and user copies with the same name and rely on precedence. The verifier reports that state as ambiguous so an old copy cannot silently shadow an update.

## Host-specific behavior

`disable-model-invocation` is author metadata used to express that setup is manual. It is not part of the portable methodology contract. Confirm invocation behavior in the Codex catalog after installation.

The repository tests the documented discovery directories, canonical-copy comparison, and project/global shadow detection. The catalog check remains a host-level verification step.
