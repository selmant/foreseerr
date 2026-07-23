---
title: Backups
description: Understand which data you should back up.
sidebar_position: 4
---

# Which data does Foreseerr save and where?

## Settings  

All configurations from the **Settings** panel in the Foreseerr web UI are saved, including integrations with Radarr, Sonarr, Jellyfin, Plex, and notification settings.  
These settings are stored in the `settings.json` file located in the Foreseerr data folder.

## User Data  

Apart from the settings, all other data—including user accounts, media requests, blocklist etc. are stored in the database (either SQLite or PostgreSQL).

# Backup

### SQLite

If your backup system uses filesystem snapshots (such as Kubernetes with Volsync), you can directly back up the Foreseerr data folder.  
Otherwise, you need to stop the Foreseerr application and back up the `config` folder.

For advanced users, it's possible to back up the database without stopping the application by using the [SQLite CLI](https://www.sqlite.org/download.html). Run the following command to create a backup:  

```bash
sqlite3 db/db.sqlite3 ".backup '/tmp/seerr_db.sqlite3.bak'"
```  

Then, copy the `/tmp/seerr_dump.sqlite3.bak` file to your desired backup location.

### PostgreSQL

You can back up the `config` folder and dump the PostgreSQL database without stopping the Foreseerr application.

Install [postgresql-client](https://www.postgresql.org/download/) and run the following command to create a backup (just replace the placeholders):

:::info
Depending on how your PostgreSQL instance is configured, you may need to add these options to the command below.

  -h, --host=HOSTNAME      database server host or socket directory

  -p, --port=PORT          database server port number
:::

```bash
pg_dump -U <database_user> -d <database_name> -f /tmp/seerr_db.sql
```

### Docker

For Docker, the config directory (mounted at `/app/config`) contains the `settings.json` file and, when using SQLite, the database itself. Back up the whole mounted host directory rather than files inside the container:

```bash
docker stop foreseerr
tar -czf foreseerr-backup-$(date +%Y%m%d).tar.gz -C /path/to/foreseerr-config .
docker start foreseerr
```

If you use PostgreSQL with Docker, back up the config directory as above (for `settings.json`) and separately dump the database from the PostgreSQL container or host, as described above. Stopping the Foreseerr container is optional in that case, but stopping it avoids concurrent writes while `settings.json` is copied.

### Kubernetes

If your backup system supports filesystem/volume snapshots (for example [Volsync](https://volsync.readthedocs.io/) or your CSI driver's native snapshot support), snapshot the PersistentVolumeClaim backing the Foreseerr config directory directly. This is the recommended approach for SQLite deployments, since it captures a consistent copy of both `settings.json` and the database file together.

Without snapshot support, copy the config directory out of a running pod:

```bash
kubectl cp <namespace>/<foreseerr-pod>:/app/config ./foreseerr-backup
```

For PostgreSQL on Kubernetes, dump the database using `pg_dump` from a pod/job with network access to the database (either the in-cluster PostgreSQL service or an external instance), in addition to backing up the config directory for `settings.json`:

```bash
kubectl run pg-dump --rm -i --restart=Never --image=postgres:16-alpine -- \
  pg_dump -h <postgres-host> -U <database_user> -d <database_name> > foreseerr-backup.sql
```

# Restore

### SQLite

After restoring your `db/db.sqlite3` file and, optionally, the `settings.json` file, the `config` folder structure should look like this:

```
.
├── cache            <-- Optional
├── db
│   └── db.sqlite3
├── logs             <-- Optional
└── settings.json    <-- Optional (required if you want to avoid reconfiguring Foreseerr)
```

Once the files are restored, start the Foreseerr application.

### PostgreSQL

Install the [PostgreSQL client](https://www.postgresql.org/download/) and restore the PostgreSQL database using the following command (replace the placeholders accordingly):

:::info
Depending on how your PostgreSQL instance is configured, you may need to add these options to the command below.

  -h, --host=HOSTNAME      database server host or socket directory

  -p, --port=PORT          database server port number
:::

```bash
pg_restore -U <database_user> -d <database_name> /tmp/seerr_db.sql
```

Optionally, restore the `settings.json` file. The `config` folder structure should look like this:

```
.
├── cache            <-- Optional
├── logs             <-- Optional
└── settings.json    <-- Optional (required if you want to avoid reconfiguring Foreseerr)
```

Once the database and files are restored, start the Foreseerr application.

# Upgrading and downgrading

Foreseerr upgrades its database schema and `settings.json` automatically on startup, appending new migrations without altering ones that already shipped. Take a backup (see above) before every upgrade, especially across major/minor version boundaries.

Downgrading (running an older Foreseerr version against a database or `settings.json` produced by a newer one) is **not supported**. Foreseerr detects this at startup — a database or settings file with migrations the running version doesn't recognize causes it to log an actionable error and refuse to start, rather than running against a schema it doesn't fully understand. To recover from an attempted downgrade, restore the backup taken before the upgrade (or the automatic `settings.old.json` written just before the last settings migration ran), or upgrade back to a version that recognizes the newer schema.

:::warning Alpha-to-stable migration policy
Foreseerr is currently alpha software (`0.1.0-alpha.x`). Until the first stable release:

- Database and settings migrations may still be reordered or squashed between alpha releases; they are **not** guaranteed to remain compatible with every prior alpha in the way stable releases will be.
- After the first stable release, all database migrations and persisted `settings.json` changes will be backward compatible: upgrades will always be able to run in place, and this policy note will be updated to reflect that guarantee going forward.
- If an alpha-to-alpha upgrade doesn't apply cleanly, the supported recovery path is to restore your pre-upgrade backup, or to reset (fresh install) and reconfigure. There is no guaranteed automated migration between arbitrary alpha builds.

Once alpha ends, this section will document the exact stable version boundary and confirm the backward-compatibility guarantee is in effect.
:::

Foreseerr's schema/migration history continues directly from upstream Seerr's. The supported upgrade sources are: a fresh Foreseerr install, an upstream Seerr SQLite/PostgreSQL database (validated against the Seerr commit `759e35933860594282bd929587576b003a3efb2d`), and — once a stable Foreseerr release exists — a previous stable Foreseerr database/settings file. Automated upgrade tests covering these sources live under `server/migration/upgradeMatrix.*.test.ts`.
