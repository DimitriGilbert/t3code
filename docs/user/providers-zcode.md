# ZCode

ZCode is disabled by default. T3 Code runs [ZCode](https://github.com/zai-org/ZCode),
z.ai's coding agent, through its native `zcode app-server` protocol (ZCode Protocol v4)
on the machine hosting your environment.

## Set Up ZCode

1. Install the ZCode desktop app or CLI on the host machine so the `zcode` command is
   available. The CLI is not published to npm.
2. Sign in by running `zcode login` on the host, or use the sign-in action in the
   provider's settings, which runs `zcode login` in a terminal on that environment.
3. Open **Settings → Providers**, select the environment, enable **ZCode**, and refresh
   the provider.

## Settings

- **Binary path** — path to the `zcode` binary when it is not on the host's `PATH`.
  T3 Code also checks standard desktop-app install locations.

ZCode keeps its sign-in under `~/.zcode` on the host. Remote and mobile clients do not
need ZCode installed; only the machine running the T3 Code server does.

## Troubleshooting

- If the provider reports ZCode is not installed, confirm `zcode --version` runs on the
  host or set **Binary path**, then refresh the provider.
- If threads fail with sign-in errors, run `zcode login` on the host and refresh the
  provider.
