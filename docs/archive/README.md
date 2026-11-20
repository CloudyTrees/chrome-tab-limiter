# Archive: the August 2025 scaffolding

These files were produced by the multi-agent workflow this project started with
(a Claude chat planning, Claude Code implementing, one handoff document per component).
They are kept for history only and are **not maintained**.

They describe a design that no longer exists: a separate selector window
(`selector.html/js/css`), a `windows` permission, and "replace the oldest tab" behavior.
The extension now keeps new tabs pending and lets you choose what to close; see
[../decisions.md](../decisions.md) and [../../CAVEATS.md](../../CAVEATS.md) for the current behavior.

| Path                             | What it was                                           |
| -------------------------------- | ----------------------------------------------------- |
| `meta/` (was `.meta/`)           | Shared context and one handoff document per component |
| `specs/`                         | Per-component specifications                          |
| `progress/`                      | Component status tracker                              |
| `scripts/`                       | Scripts that generated and updated the files above    |
| `project-implementation-plan.md` | The original implementation plan                      |
| `chrome_extension_structure.md`  | The original proposed folder structure                |

The scripts assume the old layout (`.meta/`, `specs/`, `progress/` at the repository root and
the extension in `chrome-tab-limiter/`), so they will not run from here without changes.
