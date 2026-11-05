# KeepRipping

Burn to rip real graded card packs. Every rip adds time, and the last ripper takes the whole pot. [keepripp.ing](https://keepripp.ing)

A pump.fun coin earns creator fees, the fees become USDC in the dev wallet, and that treasury buys real packs from Collector Crypt whenever someone burns to rip.

## Try it locally

No keys needed. This runs a fake chain with bot players and a demo wallet.

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

Then open http://127.0.0.1:3000.

| Command | What it does |
|---|---|
| `npm test` | Rules, verifier, validator, crash and full-round tests |
| `npm run sim` | Plays full rounds with bots and checks the books |
| `npm run check:network` | Read-only check of the real adapters. Spends nothing |
| `npm run dev` / `npm run dev:web` | Server and frontend with live reload |

## Game rules

All of these live in [shared/rules.ts](shared/rules.ts) and [shared/ladder.ts](shared/ladder.ts).

- **Rip:** burn exactly 100,000 coins. The treasury pays for the pack.
- **Timer:** the first rip starts about 30s. Each rip then adds time based on how busy the last 10 seconds were: 1–2 rips add +5s, 3–5 add +3s, 6–9 add +1s, and 10 or more add nothing.
- **Winner:** the last counted rip when the timer ends gets every card left in the pot. If the last pack goes first, that ripper wins immediately.
- **5-minute drop:** if nobody has won, 5 random cards go to the 5 biggest burners of that window, one each. A round needs at least 53 packs to last that long.
- **Late burns:** a burn landing after the end becomes a voucher for a free rip in a later round.
- **Round size:** set by the treasury ladder, from 3 $25 packs at $100 up to 114 mixed packs at $10,000. $500 is the most it will spend on one pack.

Timers run on Solana slots, so chain order decides everything and anyone can recheck a result. Dollar values are for display only and never affect the game.

## Going live

### 1. Prepare

- [ ] Launch the coin with the dev wallet as creator-fee recipient, or as a fee-sharing shareholder.
- [ ] Create a new wallet for this only. Its key sits on the server and signs automatically.
- [ ] Fund it with SOL. The game needs about 0.006 SOL per card delivered, an estimate to confirm on the first real payout.
- [ ] Get a paid Solana RPC with DAS support (for example Helius) and a Jupiter API key.
- [ ] Ask Collector Crypt for a partner API key on their Discord, and whether their terms allow this use.
- [ ] Get legal advice. Burning tokens for a chance at prizes may count as gambling in some places.

### 2. Configure

Copy `.env.example` to `.env` and fill it in. Then check the setup. This also reports which token your coin's fees are paid in, and whether they reach the dev wallet:

```bash
npm run check:network
```

### 3. Test before opening

1. Run a real round on devnet with `MODE=devnet`.
2. On mainnet, rip one $25 pack with your own wallet and check that the card arrives. This also measures real gas per card.
3. Open the site.

### 4. Deploy

It needs one long-running process and Postgres, so serverless hosts won't work. Follow [docs/DOKPLOY.md](docs/DOKPLOY.md) for zero-downtime updates on Dokploy.

Set `MODE=mainnet` and `MAINNET_ENABLED=true` to spend real money.

## Running it

- **Alerts:** set `ALERT_WEBHOOK_URL` to a Discord or Slack webhook. Anything that needs a person goes there.
- **Pause:** `npm run pause` stops purchases, payouts and new rounds. `npm run unpause` resumes. The timer can't be paused, because burns happen on-chain.
- **Stuck payouts:** fix the cause, then `npm run payout:retry`.
- **Keep the hot wallet lean:** it only needs what the next rounds will spend. Move any surplus to a cold wallet.

## Layout

```
shared/      rules, ladder, fairness, API types
server/
  engine/    the reducer: pure game logic from chain events
  chain/     indexer, burn verifier, Solana adapter
  packs/     Collector Crypt client, transaction validator, buying pipeline
  payouts/   per-card delivery
  treasury/  fee claims, swaps, gas, burn price
  game/      runs rounds and builds the live state
  mock/      fake chain, provider and bots
web/src/     the site
scripts/     simulation, network check, pause, payout retry
tests/       test suite
```
