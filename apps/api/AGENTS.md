# API application agent rules

These rules apply to all files in `apps/api/`.

## Structure

- Keep `app/main.py` as the process entry point.
- Add a domain package only when a second endpoint or reusable rule needs it.
- Keep provider commands and file-system work behind focused functions.
- Keep temporary files inside one temporary directory.

## Responsibilities

- A route validates HTTP input and maps the result to an HTTP response.
- A Pydantic model defines each stable response contract.
- An external process call must use an argument list. Do not use a shell command string.
- Return a safe protocol error. Do not return command output or local paths.
- Delete temporary audio in success and error cases.
- Do not load the full Whisper model inside the FastAPI process.

## Validation

Run these commands from `apps/api/`:

```sh
.venv/bin/ruff check app tests
.venv/bin/pytest
```

Run a live `/health` check after a process or dependency change.
