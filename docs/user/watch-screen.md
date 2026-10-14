# Watch screen

**Watch** is a compose-it-yourself surface for keeping an eye on work and
external services. You build pages out of widgets — shipped starters cover
active work, items needing attention, task starters, recent activity, and
connector status; agents can author their own widgets, and connector packs
add data that lives outside T3 Code.

Open **Watch** from the sidebar on web and desktop, or with **Open watch** in
the command palette. The sidebar icon also shows the unread notification
count. On mobile, open **Watch** from the home screen.

## Pages and edit mode

The first time you open Watch, choose **Start from a template** to
instantiate a starter page from the gallery. Gallery pages are ordinary
pages — you can delete them and create them again at any time. Pages are
global or scoped to a project; a project page resolves unbound widgets
against the project you're viewing, so one page serves every project you
open.

Editing is explicit: select **Edit** on the page, or press `e`, to enter
edit mode. In edit mode you move and resize widgets on the grid, remove
them, change their settings, and add new ones. Every widget's data source is
repointable, and the page tab bar creates, renames, reorders, duplicates,
and deletes pages. Your changes are shared with every client connected to
the same server; a conflicting edit from another client is rejected and
you're asked to reload.

In narrower windows the grid collapses to a stacked view and layout editing
is disabled — the stored layout is never rewritten to fit.

## Connectors

Connector packs feed widgets data that lives outside T3 Code — for example,
workflow runs watched under a project's `.clanker` directory. No packs ship
with the app; you install them on demand from a local path or an https URL.

Installing or upgrading a pack is always confirmed by a person, never by an
agent. Anyone — you or an agent — can create an install request, but the
approval dialog shows what the pack may do before it runs: the hosts it may
reach, the secret keys it may read, its origin, and its content hash (as a
diff on upgrades). After confirming, you create an instance and enter its
configuration; secret values are stored in the server's secret store and
never shown again.

Uninstalling a pack stops it and degrades its widgets to placeholders while
keeping its configuration. Purging an uninstalled pack deletes its stored
data permanently and is also confirm-gated.

## Notifications

Watch notifications cover finished and failed turns, threads awaiting input,
unhealthy connectors, and widget threshold alerts. They show as a badge on
the sidebar and in the app, and as native notifications on desktop when the
window isn't already focused on the relevant thread. Open the bell on the
Watch screen for notification history, per-type and per-page mutes, and
snoozing — every one of them reversible.

## On mobile

The mobile app follows the same pages as a single-column stack in canonical
order. Mobile edit mode can only reorder and hide widgets, and those changes
apply to the mobile view alone — they never alter the desktop layout.
