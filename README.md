# depot-tools

Build texture depots. A folder of lossless sources becomes a self-describing,
multi-format asset depot.

```bash
npx depot path/to/my-depot
```

The convention is in [SPEC.md](SPEC.md) — that document is the whole contract.
Consumers implement it directly; nothing needs to depend on this package at
runtime.

- [SPEC.md](SPEC.md) — the depot convention
- [ENCODERS.md](ENCODERS.md) — measurements behind the format rules
