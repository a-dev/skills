# Profile and adapter migrations

Load this reference when audit reports a methodology, profile-schema, or adapter-version mismatch.

## Version ownership

- `methodologyVersion` identifies the portable styling contract.
- `profileSchemaVersion` identifies the JSON profile shape.
- `adapter.name` and `adapter.version` identify the tested stack integration.
- The installed skill revision is separate; updating a skill does not authorize changing a project profile.

## Migration boundary

Audit only reports version drift. It does not rewrite the profile, configuration, or source.

Before `migrate` mode writes:

1. compare the installed schema and adapter with the project versions;
2. list behavior changes, profile changes, and expected file diffs;
3. preserve project-selected aliases, boundaries, layers, admission rules, and exceptions where compatible;
4. ask for any decision the new contract cannot derive;
5. receive an explicit migration request.

After migration, run profile validation, project verification, the read-only audit, and a second dry-run. Report any accepted deviation that remains.

**Complete when:** the project has an explicit migration plan, no compatible project choice was replaced silently, and a second run proposes no changes.
