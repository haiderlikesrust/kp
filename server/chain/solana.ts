import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import bs58 from 'bs58'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { fromWeb3JsKeypair } from '@metaplex-foundation/umi-web3js-adapters'
import { createSignerFromKeypair, publicKey, signerIdentity, type TransactionBuilder, type Umi } from '@metaplex-foundation/umi'
import { fetchAsset, fetchCollection, mplCore, transfer } from '@metaplex-foundation/mpl-core'
import {
  TokenStandard,
  fetchDigitalAsset,
  mplTokenMetadata,
  transferV1,
} from '@metaplex-foundation/mpl-token-metadata'
import { setComputeUnitLimit, setComputeUnitPrice } from '@metaplex-foundation/mpl-toolbox'
import { MEMO_PREFIX } from '../../shared/rules.ts'
import { signPartial } from './sign.ts'
import type { AssetInfo, Chain, Commitment, ParsedTx, SignedTx, TxStatus } from './types.ts'

const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const TRANSFER_COMPUTE_UNITS = 400_000

export interface SolanaOptions {
  rpcUrl: string
  dasRpcUrl: string
  devPrivateKey: string
  usdcMint: string
  priorityMicroLamports: number
}

/** Accepts the two usual key formats: base58 or a JSON byte array. */
export function parseKeypair(secret: string): Keypair {
  const trimmed = secret.trim()
  const bytes = trimmed.startsWith('[') ? Uint8Array.from(JSON.parse(trimmed)) : bs58.decode(trimmed)
  return Keypair.fromSecretKey(bytes)
}

export class SolanaChain implements Chain {
  readonly connection: Connection
  readonly dev: Keypair
  private umi: Umi
  private cache = new Map<string, { until: number; value: Promise<unknown> }>()

  /** The state loop runs several times a second, and paid RPC bills per call. */
  private cached<T>(key: string, ttlMs: number, read: () => Promise<T>): Promise<T> {
    const entry = this.cache.get(key)
    if (entry && entry.until > Date.now()) return entry.value as Promise<T>
    const value = read()
    this.cache.set(key, { until: Date.now() + ttlMs, value })
    value.catch(() => this.cache.delete(key))
    return value
  }

  constructor(private opts: SolanaOptions) {
    this.connection = new Connection(opts.rpcUrl, { commitment: 'confirmed' })
    this.dev = parseKeypair(opts.devPrivateKey)
    this.umi = createUmi(opts.rpcUrl).use(mplCore()).use(mplTokenMetadata())
    const signer = createSignerFromKeypair(this.umi, fromWeb3JsKeypair(this.dev))
    this.umi.use(signerIdentity(signer))
  }

  get devAddress(): string {
    return this.dev.publicKey.toBase58()
  }

  slot(): Promise<number> {
    return this.cached('slot', 300, () => this.connection.getSlot('confirmed'))
  }

  finalizedSlot(): Promise<number> {
    return this.cached('finalized', 800, () => this.connection.getSlot('finalized'))
  }

  async getParsedTx(signature: string, commitment: Commitment): Promise<ParsedTx | null> {
    const tx = await this.connection.getParsedTransaction(signature, {
      commitment,
      maxSupportedTransactionVersion: 0,
    })
    return tx as unknown as ParsedTx | null
  }

  async blockIndexOf(slot: number, signature: string): Promise<number> {
    const block = await this.connection.getBlockSignatures(slot, 'confirmed')
    const index = block.signatures.indexOf(signature)
    if (index < 0) throw new Error(`signature not in block ${slot}`)
    return index
  }

  async finalizedBlockhashFrom(slot: number): Promise<{ slot: number; blockhash: string } | null> {
    const blocks = await this.connection.getBlocks(slot, slot + 64, 'finalized')
    const first = blocks[0]
    if (first === undefined) return null
    const block = await this.connection.getBlock(first, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
      transactionDetails: 'none',
      rewards: false,
    })
    return block ? { slot: first, blockhash: block.blockhash } : null
  }

  async memoSignatures(address: string, until: string | null): Promise<string[]> {
    const key = new PublicKey(address)
    const found: string[] = []
    let before: string | undefined
    // With no checkpoint yet there are no rounds to miss, so one page is plenty.
    const pages = until ? 20 : 1
    for (let page = 0; page < pages; page++) {
      const rows = await this.connection.getSignaturesForAddress(
        key,
        { limit: 1_000, ...(before ? { before } : {}), ...(until ? { until } : {}) },
        'confirmed',
      )
      // RPC returns each transaction's memo, which saves fetching every swap.
      for (const row of rows) {
        if (!row.err && row.memo?.includes(MEMO_PREFIX)) found.push(row.signature)
      }
      if (rows.length < 1_000) break
      before = rows.at(-1)?.signature
    }
    return found.reverse()
  }

  watchMemos(address: string, onSignature: (signature: string) => void): void {
    this.connection.onLogs(
      new PublicKey(address),
      (entry) => {
        if (!entry.err && entry.logs.some((line) => line.includes(MEMO_PREFIX))) onSignature(entry.signature)
      },
      'confirmed',
    )
  }

  usdcMicro(): Promise<bigint> {
    return this.cached('usdc', 5_000, async () => {
      const account = getAssociatedTokenAddressSync(new PublicKey(this.opts.usdcMint), this.dev.publicKey)
      try {
        return BigInt((await this.connection.getTokenAccountBalance(account, 'finalized')).value.amount)
      } catch {
        return 0n // No token account until the first USDC arrives.
      }
    })
  }

  lamports(): Promise<bigint> {
    return this.cached('lamports', 5_000, async () => BigInt(await this.connection.getBalance(this.dev.publicKey, 'finalized')))
  }

  async sendMemo(text: string): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed')
    const tx = new Transaction({ feePayer: this.dev.publicKey, blockhash, lastValidBlockHeight })
    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.opts.priorityMicroLamports }),
      new TransactionInstruction({
        programId: MEMO_PROGRAM,
        keys: [{ pubkey: this.dev.publicKey, isSigner: true, isWritable: false }],
        data: Buffer.from(text),
      }),
    )
    tx.sign(this.dev)
    const signature = await this.connection.sendRawTransaction(tx.serialize())
    const result = await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
    if (result.value.err) throw new Error(`memo failed: ${JSON.stringify(result.value.err)}`)
    return signature
  }

  async signatureStatus(signature: string): Promise<TxStatus> {
    const { value } = await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
    const status = value[0]
    if (!status) return null
    if (status.err) return 'failed'
    return status.confirmationStatus === 'finalized' ? 'finalized' : status.confirmationStatus === 'confirmed' ? 'confirmed' : null
  }

  async blockhashExpired(signedTx: string): Promise<boolean> {
    const tx = VersionedTransaction.deserialize(Buffer.from(signedTx, 'base64'))
    const { value } = await this.connection.isBlockhashValid(tx.message.recentBlockhash, { commitment: 'finalized' })
    return !value
  }

  sendRaw(signedTx: string): Promise<string> {
    return this.connection.sendRawTransaction(Buffer.from(signedTx, 'base64'), { skipPreflight: true, maxRetries: 0 })
  }

  signProviderTx(transaction: string): SignedTx {
    return signPartial(transaction, this.dev)
  }

  async asset(address: string): Promise<AssetInfo | null> {
    const res = await fetch(this.opts.dasRpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: address } }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await res.json()) as { result?: any; error?: { message?: string } }
    if (body.error) throw new Error(`DAS: ${body.error.message}`)
    const asset = body.result
    if (!asset?.ownership?.owner) return null
    const attributes: { trait_type?: string; value?: unknown }[] = asset.content?.metadata?.attributes ?? []
    const insured = attributes.find((attr) => /insured.?value/i.test(attr.trait_type ?? ''))?.value
    return {
      address,
      owner: asset.ownership.owner,
      interface: asset.compression?.compressed ? 'Compressed' : asset.interface,
      collection: asset.grouping?.find((group: any) => group.group_key === 'collection')?.group_value ?? null,
      name: asset.content?.metadata?.name ?? null,
      image: asset.content?.files?.[0]?.cc_cdn ?? asset.content?.links?.image ?? null,
      insuredValue: insured != null && Number.isFinite(Number(insured)) ? Number(insured) : null,
    }
  }

  /** Collector Crypt cards are a mix of Metaplex Core and token-based NFTs. */
  async buildCardTransfer(asset: AssetInfo, recipient: string): Promise<SignedTx> {
    const { umi } = this
    const builder =
      asset.interface === 'MplCoreAsset'
        ? await this.coreTransfer(asset, recipient)
        : await this.tokenTransfer(asset, recipient)

    const tx = await builder
      .prepend(setComputeUnitLimit(umi, { units: TRANSFER_COMPUTE_UNITS }))
      .prepend(setComputeUnitPrice(umi, { microLamports: this.opts.priorityMicroLamports }))
      .setLatestBlockhash(umi, { commitment: 'confirmed' })
      .then((ready) => ready.buildAndSign(umi))

    return {
      signedTx: Buffer.from(umi.transactions.serialize(tx)).toString('base64'),
      signature: bs58.encode(tx.signatures[0] as Uint8Array),
    }
  }

  private async coreTransfer(asset: AssetInfo, recipient: string): Promise<TransactionBuilder> {
    const { umi } = this
    const core = await fetchAsset(umi, publicKey(asset.address))
    // Read the collection from the asset itself: a transfer fails without it.
    const authority = core.updateAuthority
    const collection = authority.type === 'Collection' && authority.address
      ? await fetchCollection(umi, authority.address)
      : undefined
    return transfer(umi, { asset: core, ...(collection ? { collection } : {}), newOwner: publicKey(recipient) })
  }

  private async tokenTransfer(asset: AssetInfo, recipient: string): Promise<TransactionBuilder> {
    if (asset.interface === 'Compressed') throw new Error('compressed cards cannot be transferred here')
    const { umi } = this
    const mint = publicKey(asset.address)
    const { metadata } = await fetchDigitalAsset(umi, mint)
    const standard = metadata.tokenStandard.__option === 'Some' ? metadata.tokenStandard.value : TokenStandard.NonFungible
    const config = metadata.programmableConfig
    const ruleSet = config.__option === 'Some' ? config.value.ruleSet : null
    return transferV1(umi, {
      mint,
      authority: umi.identity,
      tokenOwner: umi.identity.publicKey,
      destinationOwner: publicKey(recipient),
      tokenStandard: standard,
      ...(ruleSet?.__option === 'Some' ? { authorizationRules: ruleSet.value } : {}),
    })
  }
}
