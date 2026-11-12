# Upgrade, backup and uninstall

[한국어](upgrade-backup-uninstall.md) · [All user guides](README.md)

`iamceo` below is the command-line tool inside the app (`/Applications/IAMCEO.app/Contents/Resources/runtime/iamceo`) → [Getting started](getting-started.en.md#the-command-line-tool)

## Knowing when a new version is out

- **Mac app:** while it runs, it asks GitHub for the latest release once a day. When there is a newer one, a "새 버전 있음" (new version) row appears under **설정 → 연결 → 앱** (Settings → Connection → App), and **받기** (get) opens the release page. It only tells you; nothing is downloaded or installed on its own. What that request carries is in the [privacy policy](../../PRIVACY.md).
- **iPhone app:** the App Store handles updates.

## Moving to a new version

Update the way you installed. Your data (`~/.iamceo`) stays as it is either way.

| Installed with | Update with |
|---|---|
| Homebrew | `brew upgrade --cask iamceo`. Homebrew stops the server and removes the login item when it upgrades or reinstalls; afterwards press 이 Mac에서 시작 (Start on this Mac) in the app once (staff sessions continue) |
| The install script or the DMG | Quit the IAMCEO app, then `iamceo upgrade` (or run the install script again, or replace the app with the one from the new DMG) |

`iamceo upgrade` works in this order:

1. It downloads the latest release (or the one you name, as in `--version v0.2.4`) and checks the checksum, the publisher's signature and Apple's notarization.
2. **It rehearses the new version on a copy of your current database.** The original is only read. If the rehearsal fails, nothing is changed.
3. It records the previous version in `~/.iamceo/upgrades/<id>/` (service settings, a database copy, the previous app).
4. It stops the server, replaces the app, starts it again and checks that it is ready. **If it is not ready in time, it rolls back to the previous version by itself.**

`iamceo upgrade --dry-run` only shows what it would do. A running app is never replaced, so quit the app first. For an app installed with Homebrew it tells you to use `brew upgrade`, so Homebrew's records stay right. It never moves to a lower version; to go back, use `iamceo rollback` below.

| Option | What it does |
|---|---|
| `--version v0.2.4` | Moves to this version instead of the latest |
| `--dry-run` | Only shows what it would do |
| `--timeout <seconds>` | How long to wait for the new version to be ready (10 to 3600 seconds, 120 by default). It waits longer on its own when the server started slowly in the rehearsal |
| `--from <address or folder>` | Uses the release files (`SHA256SUMS` and the DMG) at this place instead of GitHub. Takes `https://`, `file://` or a folder path (a relative path is taken from the current folder) |
| `--force` | Replaces an app installed with Homebrew with this command anyway (not recommended) |
| `--allow-downgrade` | Allows moving to a lower version |
| `--skip-rehearsal` | Skips the rehearsal on a copy of the database (not recommended) |

If you run the server from source (a git checkout), upgrade to a commit instead of a version: `iamceo upgrade <commit>`. Only a commit ahead of the current one is taken, and a checkout with uncommitted changes is refused.

### The server after you replace the app

- **Homebrew:** `brew upgrade` and `brew reinstall` stop the server and remove the login item before replacing the app. When they finish, open the IAMCEO app and press 이 Mac에서 시작 (Start on this Mac) once to register the new version's server. Staff sessions continue, because the engine holds them.
- **The install script or a DMG:** when you replace only the app, the server keeps running the old version until it restarts. The Mac app notices and asks once: **서버를 새 버전으로 다시 시작할까요?** (restart the server on the new version?). **다시 시작** (restart) switches to the server inside the new app. To do it later, use the "새 버전으로 다시 시작" row under **설정 → 연결 → 접속** (Settings → Connection → Connection). Staff sessions continue through the restart, because the engine holds them.

The question appears only for an installation the app manages itself (installed as an app and registered with 이 Mac에서 시작). A server you run from source is never asked about or restarted.

### When the app and the server do not match

The app shows a notice only when the two really do not match: "update the app" when the app is the older one, "the server is an older version" when the server is. Otherwise nothing is shown, even when the version numbers differ.

## Going back to the previous version

```sh
iamceo rollback --dry-run   # see what it would roll back first
iamceo rollback
```

This returns to the version before the last `iamceo upgrade`. Quit the app first. The options are `--yes` (below), `--dry-run` and `--timeout <seconds>` (how long to wait for the restored version to be ready). It shows the version running now and when the upgrade was recorded.

- **It rolls back only when the version running now is the one that upgrade installed.** If you changed the version after that through a DMG, the install script or Homebrew (or git directly, for a source checkout), it changes nothing and refuses, so you do not skip several versions back or get an old database copy.
- If the new version moved the database structure up, the database copy taken before the upgrade is restored too. That needs `--yes` to proceed.
- In that case **conversations and decisions made after the upgrade are not in the restored database.** They are not deleted; they are kept aside in `~/.iamceo/upgrades/<id>/after-upgrade-<time>/`, and that folder is never removed when old upgrade records are cleaned up. The rollback tells you where it is.
- A rollback puts the app (or the commit, for a source checkout) back first and then the database. If anything fails on the way, it puts everything back as it was and starts the server again. The record is left as it was, so you can run `iamceo rollback` again once the cause is fixed. A source checkout with uncommitted changes is refused before the server is stopped.
- The two most recent upgrade records (`~/.iamceo/upgrades`) are kept whole; older ones lose their large copies (the previous app, the pre-upgrade database copy). An upgrade that was rolled back once is not rolled back again.
- Automatic rollback happens only when a new version fails to start. Whether to roll back a version that is already running well is your call.
- **If you turned on the HTTPS address, it is turned off before the rollback.** The older version may not know about it, and it could treat requests from other devices through that address as coming from this Mac. If it cannot be turned off, nothing is rolled back and you are told why. To use it again afterwards, turn it on in Settings › Connection › HTTPS address and pair iPhones that used it again with a new QR. `iamceo upgrade --allow-downgrade` to an older version does the same; upgrading forward leaves it on.

## Backups

While it runs, the server makes a checked backup in `~/.iamceo/backups` **once a day**, keeping 7 daily and 4 weekly copies. The Backup item of the self-check (`iamceo doctor`) shows when the last one was made.

| In a backup | Not in a backup (keep these yourself) |
|---|---|
| The database (conversations, decisions, to-dos, work, the file list, settings) | Files in your project folders (keep your code in git or similar) |
| The attachments conversations and files refer to | Claude Code and Codex sign-ins and session records |
| `config.json` (with the access code), and `apns.json` if there is one | The iPhone push key (`.p8`) |
| | Role instructions you edited in `~/.iamceo/roles` (`<kind>.md`, `<kind>.extra.md`) |

- A backup records a hash for every file and checks the database's integrity.
- **A backup contains the access code as it is.** Treat a copy like a password. Keys of devices connected with a QR code are stored only as hashes.
- Backups sit on the same disk, so they do not protect against a disk failure. Copy the newest `snapshot-<id>` folder somewhere else, such as an external disk.
- `iamceo backup` works only when it can have the data folder to itself. While the server runs it is refused ("The running server is using the data folder, so no backup was made now"); use the backups the server makes every day.
- If you edited role instructions or added rules (`~/.iamceo/roles/<kind>.md`, `<kind>.extra.md`, see [Troubleshooting](troubleshooting.en.md)), that folder is not in the backup. A restore brings back the default instructions, so copy the folder yourself.

## Starting a new Mac from a backup

When you move to a new Mac or reinstall one, bring conversations, decisions and files back from a backup.

1. **On the old Mac,** copy the newest backup folder (`~/.iamceo/backups/snapshot-<id>`, or one made with `iamceo backup --directory <external disk>`) to the new Mac. On the new Mac, keep it **outside** the data folder (`~/.iamceo`), for example on the Desktop. A backup holds the access code, so treat it like a password. If you edited role instructions, copy the `~/.iamceo/roles` folder too, and put it into `~/.iamceo/roles` on the new Mac after the restore. If you will not keep using the old Mac, run `iamceo uninstall` there after copying (your data stays).
2. **On the new Mac,** install IAMCEO and Claude Code (signed in), and Codex and Tailscale if you use them. Do not press 이 Mac에서 시작 yet: it creates a new data folder, and the restore is then refused. If you already pressed it and have nothing on the new Mac to keep, remove that folder with `iamceo uninstall --purge` first.
3. Restore into the data folder the app uses (`~/.iamceo`). A restore goes only into a folder that is **empty or does not exist yet**, with outgoing delivery switched off. It may be the same path the backup was made from, as on a new Mac with the same user name. A folder that still holds data is refused, never overwritten.

   ```sh
   iamceo restore ~/Desktop/snapshot-<id> --destination ~/.iamceo
   iamceo restore reconcile
   iamceo restore resume
   ```

   `reconcile` and `resume` work on `~/.iamceo` (if you restored elsewhere, point `IAMCEO_HOME` at that folder). `reconcile` conservatively settles the deliveries and notifications that were in flight when the backup was made (it holds them rather than sending them again), and `resume` then allows outgoing delivery and switches back on the projects that were running at backup time. Both run with the server stopped, and neither starts the server or an AI session. To keep using both Macs, add `--clone` to the first line to restore as a new server. The clone refuses the keys of devices connected to the old Mac and gets a new access code (see it with `iamceo open`).
4. Open the IAMCEO app and press 이 Mac에서 시작. The server is registered as a login item with the restored data and access code, and the app connects right away.
5. Put each project's working folder (your code) at the same place on the new Mac, or change the project's folder in project management. CLI session records are not in the backup, so staff start new sessions.
6. The iPhone's address has changed: connect it again with a new QR. A restored server switches every notification device off, so turn notifications on again on a device that used them.

## How long records are kept

- **Conversations, decisions, to-dos and files are kept until you delete them.**
- Records the server keeps only for itself are cleaned up after a fixed time. The copy of the text typed into an AI session is cleared 30 days after that delivery finished (a hash of what was sent is kept), and run records and receipts are deleted 90 days after they finished. Records of work that has not finished are never deleted.
- Server logs roll over when they fill up, and only a few old files are kept. Only the five most recent diagnostic files are kept.

## Exporting and deleting a project

An archived project can be exported or deleted, one project at a time.

- **Export:** get that project's conversations, decisions, to-dos, work and files, with the original attachments, as one zip file. The access code, staff keys and internal delivery records are left out. It works only from the app connected on this Mac. The zip holds your conversations as they are, so keep it carefully.
- **Delete:** only an archived project can be deleted. You are asked to confirm once more, and a deleted project cannot be brought back; export it first if you might need it. The project's attachments are deleted with it; your working folder (your code) is not. Backups already made still hold the deleted project until they are rotated out (up to about four weeks), and so do the database copies in the records `iamceo upgrade` keeps (the two most recent).
- HQ (본사) cannot be archived or deleted.

## Stopping IAMCEO completely on this Mac (uninstall)

Moving the app to the Trash alone can leave a running server and AI sessions behind. Stop IAMCEO completely first, then delete the app.

- **In the app:** **이 Mac에서 완전히 멈추기** (Stop completely on this Mac) at the bottom of **설정 → 연결** (Settings → Connection) in the Mac app. It appears only when you installed the app and no login service is registered, or the registered one is the app's own (it is hidden when a server run from source or an older command-line install is registered). After it stops, a **데이터도 지우기** (delete the data too) row lets you delete the data as well, after one more confirmation. While the app is connected to another Mac's server, it deals only with IAMCEO and the data on this Mac and keeps the connection to that server.
- **On the command line:** `iamceo uninstall` (`--dry-run` shows what it would do first; `--yes` skips the questions)

In this order:

0. First it checks that this command can stop the server. If another installation's login service (an older command-line install, a source checkout) is running on the same data folder, or a server started directly outside the login service is running, it **does nothing** and refuses (no session is put to sleep).
1. If you turned on the HTTPS address, it is turned off first (only the `tailscale serve` setting this server made is removed; that setting lives in Tailscale, so it would otherwise outlive the uninstall). If that fails, you are told to run `tailscale serve --https=443 off` in Terminal and the rest continues. Then, if the server is running, every session IAMCEO manages is put to sleep. Sessions you started and joined yourself are left alone.
2. The server registered as a login item is removed (the server stops). Only the service the app registered is removed; another installation's service is left alone. The service of a server run from source is removed only with `--include-checkout`, and its settings file is kept as a copy in `~/Library/Application Support/IAMCEO/service-backup/`.
3. Every terminal in the engine is ended and the engine is stopped. If the engine does not stop, it tells you to restart the Mac.
4. **Your data is kept by default.** To delete it, use `iamceo uninstall --purge`, which asks once more (in a terminal you type DELETE, or 지우기 when it speaks Korean). It deletes the whole data folder (`~/.iamceo`), **including the backups inside it.** Backups made elsewhere with `iamceo backup --directory` are not deleted. Copy any backup you need somewhere else first. Only a folder holding both the database and a settings file with an access code is deleted, and a folder that is neither the usual place (`~/.iamceo`) nor the registered service's folder needs its path typed exactly, even with `--yes`.

Then delete the app: `brew uninstall --cask iamceo` if you used Homebrew, otherwise move IAMCEO from Applications to the Trash. `brew uninstall --zap --cask iamceo` removes the app, then runs the app's own `iamceo uninstall --purge --yes`: it stops every session and the engine and deletes the data folder, backups inside it included. This cannot be undone. When that step fails, or stops nothing because another installation's login service is still registered (such as a server run from source), the data folder is only moved to the Trash.
