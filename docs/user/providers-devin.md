# Devin

Devin is Cognition's coding agent. T3 Code uses the `devin` CLI installed on
the machine hosting your environment, and the provider is disabled by
default.

## Set up Devin

1. Install the [Devin CLI](https://docs.devin.ai/cli) on the machine running
   the environment. T3 Code recommends Devin 3000.11.92 or newer.
2. Open **Settings → Providers** in the web or desktop app, select the
   environment, and enable **Devin**. Set **Binary path** if `devin` is not
   on the host's `PATH`.
3. Sign in (below), then refresh provider status and select Devin in a
   thread's model picker.

The **Update** control in provider settings runs Devin's own updater, or run
`devin update` on the host.

## Sign in

Devin keeps its own credentials on the host; every Devin instance there
shares one login. Sign in from Devin's provider settings — **Devin account**
opens a browser sign-in, and **Run `devin auth login`** completes it in a
terminal on the environment. You can also run `devin auth login` on the host
yourself; on remote or headless machines, pass `--force-manual-token-flow`
to paste a token when the browser cannot return to that machine.

Devin can also read credentials from environment variables such as
`WINDSURF_API_KEY`. Provider status cannot confirm those, so it may report
sign-in needed until a thread runs.

Sign out from provider settings or run `devin auth logout` on the host. Both
remove the saved Devin credentials and keep thread history and workspace
files.

## Models

The model picker lists the models Devin reports for the signed-in account,
and you can switch models in an existing thread. **Default** keeps the model
Devin selected for the session. After changing your Devin login or account,
refresh provider status to reload the list.

## Permission modes

Devin follows the shared [permission modes](./permission-modes.md), mapped
onto Devin's own session modes:

- **Supervised** and **Auto-accept edits** use Devin's code mode: workspace
  edits proceed, while commands and other actions still ask.
- **Auto** uses Devin's smart mode: Devin approves what it judges safe and
  escalates the rest to you.
- **Full access** bypasses approval prompts.

The composer's Plan toggle uses Devin's plan mode: Devin writes a plan and
asks before making changes. Commands Devin runs appear as T3 Code terminals,
so they follow the same approvals and terminal history. Devin's delegated
subagent work shows up as child threads you can inspect. Devin cannot rewind
its conversation; continue with a follow-up message or start a new thread.

## Remote environments

Install and sign in to Devin separately on each host where you want it to
run; devices that connect over [remote access](./remote-access.md) do not
need Devin installed. To stop using Devin in an environment, disable it in
**Settings → Providers**. This keeps the host's Devin login, thread history,
and workspace files.
