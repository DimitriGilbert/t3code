# ZCode

ZCode is disabled by default. T3 Code runs [ZCode](https://github.com/zai-org/ZCode),
z.ai's coding agent, through the `zcode-acp-server` bridge installed on the machine
hosting your environment.

## Set Up ZCode

1. Install the ZCode desktop app or CLI on the host machine so the `zcode` command is
   available. The CLI is not published to npm.
2. Install the bridge on the same machine:

   ```sh
   npm install -g zcode-acp-server
   ```

3. Sign in by running `zcode login` on the host, or use the sign-in action in the
   provider's settings, which runs `zcode login` in a terminal on that environment.
4. Open **Settings → Providers**, select the environment, enable **ZCode**, and refresh
   the provider.

## Settings

- **Binary path** — path to the `zcode-acp-server` bridge when it is not on the host's
  `PATH`.
- **ZCode binary path** — path to the `zcode` CLI the bridge launches. Leave it empty to
  use `PATH` and standard desktop-app install locations.

ZCode keeps its sign-in under `~/.zcode` on the host. Remote and mobile clients do not
need ZCode installed; only the machine running the T3 Code server does.

## Troubleshooting

- If the provider reports the bridge is not installed, confirm `zcode-acp-server` runs
  on the host or set **Binary path**, then refresh the provider.
- If the bridge is installed but the ZCode CLI is not found, install the ZCode desktop
  app or set **ZCode binary path**.
- If threads fail with sign-in errors, run `zcode login` on the host and refresh the
  provider.
