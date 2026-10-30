# Web application agent rules

These rules apply to all files in `apps/web/`.

## Design source

- Read [DESIGN.md](DESIGN.md) before a visual or interaction change.
- Treat `DESIGN.md` as the visual source of truth.
- Use semantic CSS variables for colors and spacing.
- Do not add a shared component before a second equivalent use exists.

## Responsibilities

- A component renders state and reports user actions.
- A hook owns reusable browser state or effects.
- An API module owns HTTP paths and response types.
- Use native buttons for actions.
- Give each control a visible label or an accessible name.
- Preserve loading, success, error, and disabled states.
- Honor `prefers-reduced-motion` for non-essential motion.
- Use one discriminated state for one workflow.

## Validation

Run these commands from `apps/web/`:

```sh
npm run lint
npm run build
```

Add a focused test when you add non-trivial parsing or state transitions.
