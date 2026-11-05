# Deploy keepripp.ing on Dokploy with zero downtime

KeepRipping is one Docker image: a Node server that serves the site and API and runs the game workers. Dokploy runs it next to Postgres.

| Dokploy service | What it is | Holds |
|---|---|---|
| **Application** `keepripping` | This repo, built from the [`Dockerfile`](../Dockerfile) and run as a Docker Swarm service. Traefik sends `keepripp.ing` to port 3000. | The dev wallet key, at runtime only |
| **Database** `keepripping-db` | PostgreSQL 18 | Rounds, burns, packs, payouts, the ledger |

Use a Dokploy **Application**, not a Docker Compose service. Compose stops the old server before starting the new one, so the site goes down on every deploy. An Application runs on Swarm, which can start the new version first.

## What happens on an update

1. **Build.** Dokploy builds the new image while the old version keeps serving. If the build fails, nothing changes.
2. **Standby.** The new container starts and serves pages from the database. Only one server may run the game and spend money (a Postgres lock), so it waits as a standby, and its health check counts that as healthy.
3. **Hand-over.** Swarm stops the old container. The old server finishes its current work (6 seconds at most, usually under 1), then closes its database connection. The standby takes the lock within a quarter of a second and starts the workers.
4. **Open pages keep working.** Their live feed drops and reconnects to the new server by itself. Their code stays downloadable from the shared volume.
5. **Rollback.** If the new version isn't healthy within a minute, Swarm puts the previous one back.

**The game itself doesn't pause.** Timers and rips live on Solana, so burns landing during the hand-over still count, and the new server picks them up from its checkpoint. Payments and card transfers are saved before they are sent, so the new server resumes them without sending anything twice.

## Set up

1. **Database.**
   - In your Dokploy project, choose **Create Service → Database → PostgreSQL**. Name it `keepripping-db`, keep the default image (`postgres:18`), generate a password, and deploy.
   - Copy its **Internal Connection URL**. That is `DATABASE_URL`.
   - In its **Backups** tab, add an S3 destination and a daily schedule. Run one restore test before launch.
2. **Application.**
   - Choose **Create Service → Application** and name it `keepripping`.
   - In **General**, set the provider to GitHub (`haiderlikesrust/kp`, branch `main`).
   - Set **Build Type** to **Dockerfile**, **Dockerfile Path** to `Dockerfile`, and **Docker Context Path** to `.`.
3. **Environment.**
   - Paste [`deploy/dokploy.env.example`](../deploy/dokploy.env.example).
   - For the first deploy, keep `MODE=mock`. That gives a public practice site with fake burns, and it doesn't need the database or any keys.
   - Add wallet keys only under **Go live**. They are runtime variables. Never put them in **Build-time Arguments**.
4. **Domain.**
   - In **Domains**, add `keepripp.ing` with path `/`, container port **3000**, and HTTPS with Let's Encrypt. Point the domain's DNS at the VPS.
   - For `www.keepripp.ing`, add it the same way, then add a "www to non-www" redirect under **Advanced → Redirects**.
5. **Zero-downtime settings.** In **Advanced → Cluster Settings**, leave **Replicas** at `1`, since only one server can own the database. Then open **Swarm Settings** and fill in these sections. Durations are in nanoseconds (5000000000 = 5 s).

   | Section | Field | Value |
   |---|---|---|
   | **Update Config** | Parallelism | `1` |
   | | Delay | `0` |
   | | Failure Action | Rollback |
   | | Monitor | `60000000000` |
   | | Max Failure Ratio | `0` |
   | | Order | **Start First** |
   | **Rollback Config** | Parallelism | `1` |
   | | Delay | `0` |
   | | Failure Action | Pause |
   | | Monitor | `60000000000` |
   | | Max Failure Ratio | `0` |
   | | Order | **Start First** |
   | **Health Check** | Test Commands, one per row | `CMD`, `node`, `-e`, then the script below |
   | | Interval | `5000000000` |
   | | Timeout | `3000000000` |
   | | Start Period | `60000000000` |
   | | Retries | `3` |

   The health check script is the same one built into the image. Set it anyway, so an update never starts without one:

   ```js
   fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))
   ```

6. **Shared site files.**
   - In **Advanced → Volumes**, add a **Volume Mount** with volume name `keepripping-assets` and mount path `/app/dist/assets`.
   - Each new container adds its build's files there, next to earlier builds'. Without this volume, someone who opened the site just before an update may have to refresh before their next rip.
7. **Deploy.** Click **Deploy** and follow the build log. Then open `https://keepripp.ing/health`. It should show `"ok": true`.
8. **Optional:** turn on **Autodeploy** so every push to `main` deploys the same way.

## Check an update yourself

Leave this running while you click **Deploy**. It should print only `200`:

```bash
while true; do curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' https://keepripp.ing/api/config; sleep 0.5; done
```

On a real deployment, the new container's log shows `standby: waiting for the running server to hand over`, then `active: this server owns the database`. In `MODE=mock` there is no database to hand over, so each container goes active straight away and the practice game restarts from scratch.

## Go live

1. Set `DATABASE_URL`, `COIN_MINT`, `DEV_WALLET_PRIVATE_KEY`, `SOLANA_RPC_URL`, `JUPITER_API_KEY`, `COLLECTOR_CRYPT_API_KEY` and `ALERT_WEBHOOK_URL`.
2. Fund the dev wallet with SOL. The treasury fills from creator fees.
3. Open the application's terminal in Dokploy and run the read-only check. It also reports which token your fees are paid in and whether they reach the dev wallet:
   ```sh
   npm run check:network
   ```
4. Set `MODE=mainnet` and `MAINNET_ENABLED=true`, then redeploy. Rip one $25 pack with your own wallet and confirm the card arrives before announcing anything.

To stop spending at any time, run `npm run pause` in the application's terminal. It takes effect immediately and survives updates. `npm run unpause` resumes.

## Rules that keep updates seamless

- **Database changes must be additive.** Add tables and columns (`ADD COLUMN IF NOT EXISTS` in `server/db/schema.sql`). Don't rename or drop them in the same release, because a rollback runs the previous version against the new schema.
- **Keep one replica.** A second one can't help: it would only wait in standby.
- **Settings need a redeploy.** They are read at startup, and the redeploy goes through the same hand-over.
- **Never point two apps at `keepripping-assets`.**

Reference: [Dokploy zero downtime](https://docs.dokploy.com/docs/core/applications/zero-downtime), [Dokploy advanced settings](https://docs.dokploy.com/docs/core/applications/advanced).
