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
| Homebrew | `brew upgrade --cask iamceo` |
| The install script or the DMG | Quit the IAMCEO app, then `iamceo upgrade` (or run the install script again, or replace the app with the one from the new DMG) |

`iamceo upgrade` works in this order:

1. It downloads the latest release (or the one you name, as in `--version v0.2.4`) and checks the checksum, the publisher's signature and Apple's notarization.
2. **It rehearses the new version on a copy of your current database.** The original is only read. If the rehearsal fails, nothing is changed.
3. It records the previous version in `~/.iamceo/upgrades/<id>/` (service settings, a database copy, the previous app).
4. It stops the server, replaces the app, starts it again and checks that it is ready. **If it is not ready in time, it rolls back to the previous version by itself.**

`iamceo upgrade --dry-run` only shows what it would do. A running app is never replaced, so quit the app first. For an app installed with Homebrew it tells you to use `brew upgrade`, so Homebrew's records stay right. It never moves to a lower version; to go back, use `iamceo rollback` below.

### The server after you replace the app

When you replace only the app (through Homebrew, the install script or a DMG), the server keeps running the old version until it restarts. The Mac app notices and asks once: **서버를 새 버전으로 다시 시작할까요?** (restart the server on the new version?). **다시 시작** (restart) switches to the server inside the new app. To do it later, use the "새 버전으로 다시 시작" row under **설정 → 연결 → 접속** (Settings → Connection → Connection). Staff sessions continue through the restart, because the engine holds them.

The question appears only for an installation the app manages itself (installed as an app and registered with 이 Mac에서 시작). A server you run from source is never asked about or restarted.

### When the app and the server do not match

The app shows a notice only when the two really do not match: "update the app" when the app is the older one, "the server is an older version" when the server is. Otherwise nothing is shown, even when the version numbers differ.

## Going back to the previous version

```sh
iamceo rollback --dry-run   # see what it would roll back first
iamceo rollback
```

This returns to the version before the last `iamceo upgrade`. Quit the app first.

- If the new version moved the database structure up, the database copy taken before the upgrade is restored too. That needs `--yes` to proceed.
- In that case **conversations and decisions made after the upgrade are not in the restored database.** They are not deleted; they are kept aside in `~/.iamceo/upgrades/<id>/`.
- Automatic rollback happens only when a new version fails to start. Whether to roll back a version that is already running well is your call.

## Backups

While it runs, the server makes a checked backup in `~/.iamceo/backups` **once a day**, keeping 7 daily and 4 weekly copies. The Backup item of the self-check (`iamceo doctor`) shows when the last one was made.

| In a backup | Not in a backup (keep these yourself) |
|---|---|
| The database (conversations, decisions, to-dos, work, the file list, settings) | Files in your project folders (keep your code in git or similar) |
| The attachments conversations and files refer to | Claude Code and Codex sign-ins and session records |
| `config.json` (with the access code), and `apns.json` if there is one | The iPhone push key (`.p8`) |

- A backup records a hash for every file and checks the database's integrity.
- **A backup contains the access code as it is.** Treat a copy like a password. Keys of devices connected with a QR code are stored only as hashes.
- Backups sit on the same disk, so they do not protect against a disk failure. Copy the newest `snapshot-<id>` folder somewhere else, such as an external disk.
- `iamceo backup` works only when it can have the data folder to itself. While the server runs it is refused; use the backups the server makes every day.

## Starting a new Mac from a backup

When you move to a new Mac or reinstall one, bring conversations, decisions and files back from a backup.

1. **On the old Mac,** copy the newest backup folder (`~/.iamceo/backups/snapshot-<id>`) to the new Mac. If you will not keep using the old Mac, run `iamceo uninstall` there after copying (your data stays).
2. **On the new Mac,** install IAMCEO and Claude Code (signed in), and Codex and Tailscale if you use them. Do not press 이 Mac에서 시작 yet.
3. Restore into the data folder the app uses (`~/.iamceo`). A restore goes only into an empty folder, with outgoing delivery switched off.

   ```sh
   iamceo restore ~/Desktop/snapshot-<id> --destination ~/.iamceo
   iamceo restore reconcile
   iamceo restore resume
   ```

   `reconcile` conservatively settles the deliveries and notifications that were in flight when the backup was made, and `resume` then allows outgoing delivery. Neither starts the server or an AI session. To keep using both Macs, add `--clone` to restore as a new server. The clone refuses the keys of devices connected to the old Mac and gets a new access code (see it with `iamceo open`).
4. Open the IAMCEO app and press 이 Mac에서 시작. The server is registered with the restored data and access code.
5. Put each project's working folder (your code) at the same place on the new Mac, or change the project's folder in project management. CLI session records are not in the backup, so staff start new sessions.
6. The iPhone's address has changed: connect it again with a new QR, and turn notifications on again on a device that used them.

## How long records are kept

- **Conversations, decisions, to-dos and files are kept until you delete them.**
- Records the server keeps only for itself are cleaned up after a fixed time. The copy of the text typed into an AI session is cleared 30 days after that delivery finished (a hash of what was sent is kept), and run records and receipts are deleted 90 days after they finished. Records of work that has not finished are never deleted.
- Server logs roll over when they fill up, and only a few old files are kept. Only the five most recent diagnostic files are kept.

## Exporting and deleting a project

An archived project can be exported or deleted, one project at a time.

- **Export:** get that project's conversations, decisions, to-dos, work and files, with the original attachments, as one zip file. The access code, staff keys and internal delivery records are left out. It works only from the app connected on this Mac. The zip holds your conversations as they are, so keep it carefully.
- **Delete:** only an archived project can be deleted. You are asked to confirm once more, and a deleted project cannot be brought back; export it first if you might need it. The project's attachments are deleted with it; your working folder (your code) is not. Backups already made still hold the deleted project until they are rotated out (up to about four weeks).
- HQ (본사) cannot be archived or deleted.

## Stopping IAMCEO completely on this Mac (uninstall)

Moving the app to the Trash alone can leave a running server and AI sessions behind. Stop IAMCEO completely first, then delete the app.

- **In the app:** **이 Mac에서 완전히 멈추기** (Stop completely on this Mac) in Settings
- **On the command line:** `iamceo uninstall` (`--dry-run` shows what it would do first)

In this order:

1. If the server is running, every session IAMCEO manages is put to sleep. Sessions you started and joined yourself are left alone.
2. The server registered as a login item is removed (the server stops). Another installation's service is left alone.
3. Every terminal in the engine is ended and the engine is stopped.
4. **Your data is kept by default.** To delete it, use `iamceo uninstall --purge`, which asks once more. It deletes the whole data folder (`~/.iamceo`), **backups included.** Copy any backup you need somewhere else first.

Then delete the app: `brew uninstall --cask iamceo` if you used Homebrew, otherwise move IAMCEO from Applications to the Trash. `brew uninstall --zap --cask iamceo` also moves the data folder to the Trash.
