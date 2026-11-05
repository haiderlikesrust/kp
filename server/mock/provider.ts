import { randomUUID } from 'node:crypto'
import { Keypair, PublicKey, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import bs58 from 'bs58'
import { PACK_TIERS } from '../../shared/ladder.ts'
import type { MachineInfo, OpenResult, PackProvider } from '../packs/provider.ts'
import { ProviderError } from '../packs/provider.ts'
import { randomAddress, type MockChain } from './chain.ts'

const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

export const MOCK_USDC_MINT = Keypair.generate().publicKey.toBase58()
export const MOCK_GACHA_USDC = Keypair.generate().publicKey.toBase58()

const ODDS: [string, number, number][] = [
  ['Common', 0.75, 0.6],
  ['Uncommon', 0.95, 1.05],
  ['Rare', 0.99, 2.6],
  ['Epic', 1, 11],
]

export interface CatalogCard {
  name: string
  image: string | null
  rarity: string
  insuredValue: number
}

interface Pack {
  memo: string
  machine: string
  price: number
  paid: boolean
  polls: number
  nft: string | null
  card: CatalogCard | null
}

/**
 * Stands in for Collector Crypt. It returns real, signed, parseable Solana
 * transactions in the provider's exact format, so the validator runs in mock
 * mode too. The switches below let tests misbehave as the real API can.
 */
export class MockProvider implements PackProvider {
  private packs = new Map<string, Pack>()
  private gachaSigner = Keypair.generate()
  stock = new Map<string, number>(PACK_TIERS.map((tier) => [tier.machine, 5_000]))
  catalog = new Map<number, CatalogCard[]>()

  /** Polls that return "waiting" before a pack opens. */
  waitPolls = 1
  /** Number of times to lose the response after a payment lands. */
  dropSubmitResponses = 0
  /** Next generatePack returns a transaction charging this much extra. */
  overchargeNext = 0
  generateCalls = 0

  constructor(private chain: MockChain) {}

  async machines(): Promise<MachineInfo[]> {
    return PACK_TIERS.map((tier) => ({
      code: tier.machine,
      price: tier.price,
      stock: this.stock.get(tier.machine) ?? 0,
      open: true,
    }))
  }

  async generatePack({ player, packType }: { player: string; packType: string }) {
    this.generateCalls += 1
    const tier = PACK_TIERS.find((entry) => entry.machine === packType)
    if (!tier) throw new ProviderError(`unknown machine ${packType}`, true)
    if ((this.stock.get(packType) ?? 0) <= 0) throw new ProviderError('Machine is empty', true)

    const memo = `cc-${randomUUID()}`
    this.packs.set(memo, { memo, machine: packType, price: tier.price, paid: false, polls: 0, nft: null, card: null })

    const playerKey = new PublicKey(player)
    const usdc = new PublicKey(MOCK_USDC_MINT)
    const amount = BigInt(tier.price + this.overchargeNext) * 1_000_000n
    this.overchargeNext = 0
    const tx = new Transaction({
      feePayer: this.gachaSigner.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
    })
    tx.add(
      new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(`${memo}:open`) }),
      createTransferCheckedInstruction(
        getAssociatedTokenAddressSync(usdc, playerKey),
        usdc,
        new PublicKey(MOCK_GACHA_USDC),
        playerKey,
        amount,
        6,
      ),
    )
    tx.partialSign(this.gachaSigner)
    return {
      memo,
      transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    }
  }

  async submit(signedTx: string): Promise<void> {
    const tx = VersionedTransaction.deserialize(Buffer.from(signedTx, 'base64'))
    const signature = bs58.encode(tx.signatures[0] as Uint8Array)
    const memoIx = tx.message.compiledInstructions.find(
      (ix) => tx.message.staticAccountKeys[ix.programIdIndex]?.equals(MEMO),
    )
    const memo = Buffer.from(memoIx?.data ?? []).toString('utf8').replace(/:open$/, '')
    const pack = this.packs.get(memo)
    if (!pack) throw new ProviderError('unknown memo')
    if (!pack.paid) {
      this.chain.landPayment(signature, BigInt(pack.price) * 1_000_000n)
      pack.paid = true
    }
    if (this.dropSubmitResponses > 0) {
      this.dropSubmitResponses -= 1
      throw new ProviderError('connection reset')
    }
  }

  async open(memo: string): Promise<OpenResult> {
    const pack = this.packs.get(memo)
    if (!pack) throw new ProviderError('unknown memo')
    if (!pack.paid) return { kind: 'waiting' }
    if (pack.polls < this.waitPolls) {
      pack.polls += 1
      return { kind: 'waiting' }
    }
    if (!pack.nft) {
      // Same as the real API: a memo only ever produces one card.
      const card = this.rollCard(pack.price)
      const nft = randomAddress()
      pack.nft = nft
      pack.card = card
      this.stock.set(pack.machine, (this.stock.get(pack.machine) ?? 1) - 1)
      this.chain.assets.set(nft, {
        address: nft,
        owner: this.chain.devAddress,
        interface: Math.random() < 0.5 ? 'MplCoreAsset' : 'ProgrammableNFT',
        collection: null,
        name: card.name,
        image: card.image,
        insuredValue: card.insuredValue,
      })
    }
    const card = pack.card as CatalogCard
    return { kind: 'opened', card: { nft: pack.nft, ...card } }
  }

  private rollCard(price: number): CatalogCard {
    const roll = Math.random()
    const [rarity, , multiple] = ODDS.find(([, cutoff]) => roll < cutoff) as [string, number, number]
    const pool = (this.catalog.get(price) ?? []).filter((card) => card.rarity === rarity)
    const fromCatalog = pool[Math.floor(Math.random() * pool.length)]
    if (fromCatalog) return fromCatalog
    const serial = Math.floor(Math.random() * 900) + 100
    return { name: `Sample Card #${serial}`, image: null, rarity, insuredValue: Math.round(price * multiple) }
  }

  /** Uses real card art from Collector Crypt's public list when it can be reached. */
  async loadRealCatalog(base = 'https://gacha.collectorcrypt.com'): Promise<number> {
    let loaded = 0
    await Promise.all(
      PACK_TIERS.map(async (tier) => {
        try {
          const cards: CatalogCard[] = []
          for (const rarity of ['common', 'uncommon', 'rare', 'epic']) {
            const res = await fetch(`${base}/api/getNfts?code=${tier.machine}&rarity=${rarity}&limit=24`, {
              signal: AbortSignal.timeout(6_000),
            })
            if (!res.ok) continue
            const body = (await res.json()) as {
              nfts?: { name: string; image: string; rarity: string; insured_value: number; description?: string }[]
            }
            for (const nft of body.nfts ?? []) {
              cards.push({
                name: nft.description || nft.name,
                image: nft.image,
                rarity: rarity[0]!.toUpperCase() + rarity.slice(1),
                insuredValue: nft.insured_value,
              })
            }
          }
          this.catalog.set(tier.price, cards)
          loaded += cards.length
        } catch {
          // Offline is fine: generated sample cards take over.
        }
      }),
    )
    return loaded
  }
}
