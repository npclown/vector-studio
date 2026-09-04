# P0.4 recovery evidence

The headed `pnpm test:gpu` suite writes a post-recovery foundation-scene screenshot for stable
Chrome and Edge into this directory. The browser test also asserts validation diagnostics,
ordered loss/recovery diagnostics, one generation increment, one recovery attempt, live resource
counts, and a successful presentation from the rebuilt scene.

Each `recovery-<browser>.json` file records the exact browser version, operating system, adapter,
pre-loss and recovered statistics, and observed diagnostic payloads for its headed run. The
matching PNG is captured only after the rebuilt generation presents successfully.
