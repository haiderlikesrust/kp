// Read-only check of the real adapters against live endpoints. It uses a
// throwaway key, spends nothing, and never broadcasts a transaction.
// Usage: npm run check:network
// Set SOLANA_RPC_URL for a private mainnet RPC; DAS checks need one.
import 'dotenv/config'
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { PACK_TIERS } from '../shared/ladder.ts'
import { signPartial } from '../server/chain/sign.ts'
import { SolanaChain } from '../server/chain/solana.ts'
import type { AssetInfo } from '../server/chain/types.ts'
import { CollectorCrypt } from '../server/packs/collector-crypt.ts'
import { validatePackTx } from '../server/packs/validate.ts'

const DEV = { usdc: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr', gacha: '9ZSgA3PMjeAU8K6CWzgJ8oDnhZwwSgHZu6KP3X95t7Jq' }
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
const burner = Keypair.generate()

let failures = 0
async function check(label: string, run: () => Promise<string>): Promise<void> {
  try {
    console.log(`ok   ${label}: ${await run()}`)
  } catch (err) {
    failures += 1
    console.log(`FAIL ${label}: ${err instanceof Error ? err.message : err}`)
  }
}

const production = new CollectorCrypt({ base: 'https://gacha.collectorcrypt.com' })
const sandbox = new CollectorCrypt({ base: 'https://dev-gacha.collectorcrypt.com' })
const chain = new SolanaChain({
  rpcUrl,
  wsUrl: process.env.SOLANA_WS_URL || undefined,
  dasRpcUrl: process.env.DAS_RPC_URL || rpcUrl,
  devPrivateKey: bs58.encode(burner.secretKey),
  usdcMint: USDC,
  priorityMicroLamports: 50_000,
})

await check('treasury worker loads with the pump SDK', async () => {
  const { Treasury } = await import('../server/treasury/worker.ts')
  return typeof Treasury === 'function' ? 'loaded' : 'missing'
})

await check('ladder machines live on mainnet', async () => {
  const machines = await production.machines()
  const rows = PACK_TIERS.map((tier) => {
    const machine = machines.find((entry) => entry.code === tier.machine)
    if (!machine) throw new Error(`${tier.machine} is missing`)
    if (machine.price !== tier.price) throw new Error(`${tier.machine} now costs ${machine.price}`)
    if (!machine.open) throw new Error(`${tier.machine} is closed`)
    return `${tier.machine}=${machine.stock}`
  })
  return rows.join(' ')
})

await check('sandbox pack passes the validator and signs cleanly', async () => {
  const player = burner.publicKey.toBase58()
  const { memo, transaction } = await sandbox.generatePack({ player, packType: 'pokemon_25' })
  validatePackTx(transaction, { player, price: 25, memo, usdcMint: DEV.usdc, gachaUsdcAccount: DEV.gacha })
  const { signedTx } = signPartial(transaction, burner)
  const signed = VersionedTransaction.deserialize(Buffer.from(signedTx, 'base64'))
  const filled = signed.signatures.filter((signature) => signature.some((byte) => byte !== 0)).length
  if (filled !== 2) throw new Error(`expected both signatures, found ${filled}`)
  return memo
})

await check('slots and finality', async () => {
  const [slot, finalized] = await Promise.all([chain.slot(), chain.finalizedSlot()])
  if (slot < finalized) throw new Error('slot is behind finalized')
  return `slot ${slot}, finalized ${finalized}`
})

await check('finalized blockhash lookup for drop seeds', async () => {
  const finalized = await chain.finalizedSlot()
  const block = await chain.finalizedBlockhashFrom(finalized - 40)
  if (!block) throw new Error('no block found')
  return `${block.blockhash} at ${block.slot}`
})

await check('blockhash expiry on a real transaction', async () => {
  const { transaction } = await sandbox.generatePack({ player: burner.publicKey.toBase58(), packType: 'pokemon_25' })
  // A devnet blockhash means nothing on mainnet, so this must report expired.
  if (!(await chain.blockhashExpired(transaction))) throw new Error('reported a foreign blockhash as valid')
  return 'foreign blockhash reported as expired'
})

await check('memo filter reads transaction history', async () => {
  // A quiet address on purpose: any busy one gets rate limited on public RPC.
  const signatures = await chain.memoSignatures(burner.publicKey.toBase58(), null)
  return `${signatures.length} matching signatures`
})

// The indexer needs these. RPCs built only for sending often leave them out.
await check('reads a past transaction and its place in the block', async () => {
  const [recent] = await chain.connection.getSignaturesForAddress(MEMO_PROGRAM, { limit: 1 }, 'confirmed')
  if (!recent) throw new Error('no recent transaction')
  if (!(await chain.getParsedTx(recent.signature, 'confirmed'))) throw new Error('transaction not found')
  const index = await chain.blockIndexOf(recent.slot, recent.signature)
  return `${recent.signature.slice(0, 8)} is number ${index} in block ${recent.slot}`
})

await check('websocket delivers live logs', () =>
  new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('nothing arrived in 20s')), 20_000)
    const listener = chain.connection.onLogs(
      MEMO_PROGRAM,
      (entry) => {
        clearTimeout(timer)
        void chain.connection.removeOnLogsListener(listener)
        resolve(`received ${entry.signature.slice(0, 8)}`)
      },
      'confirmed',
    )
  }),
)

const list = (await (await fetch('https://gacha.collectorcrypt.com/api/getNfts?code=pokemon_25&limit=24')).json()) as {
  nfts: { nft_address: string }[]
}

async function firstOf(kind: 'core' | 'token'): Promise<string> {
  const owner = kind === 'core' ? 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d' : 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
  for (const nft of list.nfts) {
    const { PublicKey } = await import('@solana/web3.js')
    const info = await chain.connection.getAccountInfo(new PublicKey(nft.nft_address))
    if (info?.owner.toBase58() === owner) return nft.nft_address
  }
  throw new Error(`no ${kind} card in the sample`)
}

for (const kind of ['core', 'token'] as const) {
  await check(`builds a ${kind} card transfer (not sent)`, async () => {
    const address = await firstOf(kind)
    const asset: AssetInfo = {
      address,
      owner: chain.devAddress,
      interface: kind === 'core' ? 'MplCoreAsset' : 'ProgrammableNFT',
      collection: null,
      name: null,
      image: null,
      insuredValue: null,
    }
    const { signedTx, signature } = await chain.buildCardTransfer(asset, Keypair.generate().publicKey.toBase58())
    const size = Buffer.from(signedTx, 'base64').length
    if (size > 1232) throw new Error(`transaction is ${size} bytes, over the limit`)
    return `${size} bytes for ${address.slice(0, 8)}, ${signature.slice(0, 8)}`
  })
}

if (process.env.COIN_MINT) {
  await check('your coin', async () => {
    const { PublicKey } = await import('@solana/web3.js')
    const { Treasury } = await import('../server/treasury/worker.ts')
    const { openDb } = await import('../server/db/index.ts')
    const { silentLog } = await import('../server/log.ts')
    const db = await openDb()
    const key = process.env.DEV_WALLET_PRIVATE_KEY
    const owned = key
      ? new SolanaChain({ rpcUrl, dasRpcUrl: rpcUrl, devPrivateKey: key, usdcMint: USDC, priorityMicroLamports: 50_000 })
      : chain
    const treasury = new Treasury({
      db,
      chain: owned,
      log: silentLog,
      coinMint: new PublicKey(process.env.COIN_MINT as string),
      usdcMint: new PublicKey(USDC),
      minClaimUsd: 5,
    })
    const info = await treasury.inspect()
    await db.close()
    const cards = info.quoteMint === 'CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp'
    const routing = {
      direct: 'fees reach the dev wallet directly',
      sharing: 'fees use a sharing config, so the dev wallet must be a shareholder',
      elsewhere: `fees go to ${info.creator}, NOT the dev wallet`,
    }[info.routing]
    return `quote ${cards ? '$CARDS' : info.quoteMint}, ${routing}, ${info.unclaimedRaw} unclaimed`
  })
} else {
  console.log('skip your coin: set COIN_MINT and DEV_WALLET_PRIVATE_KEY to check fee routing')
}

if (process.env.DAS_RPC_URL || process.env.SOLANA_RPC_URL) {
  await check('DAS reads a card', async () => {
    const asset = await chain.asset(list.nfts[0]?.nft_address as string)
    if (!asset) throw new Error('asset not found')
    return `${asset.interface}, owner ${asset.owner.slice(0, 8)}, $${asset.insuredValue}`
  })
} else {
  console.log('skip DAS reads a card: needs a private RPC (set SOLANA_RPC_URL)')
}

console.log(failures === 0 ? '\nAll network checks passed.' : `\n${failures} checks failed.`)
process.exit(failures === 0 ? 0 : 1)
