# Repository agent rules

These rules apply to all files in this repository. A more specific `AGENTS.md` file can add rules for its scope.

## Design and change rules

- Keep the first version small. Add one complete behavior before you add another one.
- Organize deployable applications under `apps/`.
- Add `packages/` only when two applications need the same code.
- Make dependencies explicit in imports, function parameters, and public contracts.
- Validate untrusted input at the first external boundary.
- Keep one rule in one owning location.
- Do not add a wrapper that only forwards arguments and return values.
- Add a focused test for new branching, parsing, or state transitions.
- Do not store recorded audio after transcription.

## Repository structure

- `apps/web/` contains the React application.
- `apps/api/` contains the FastAPI application.
- Each application owns its dependencies and deployment configuration.

## Validation

Run the validation commands in the nearest scoped `AGENTS.md` file.

Run `docker compose config` after a Docker configuration change.
