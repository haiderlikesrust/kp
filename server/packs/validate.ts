import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { USDC_DECIMALS } from '../../shared/rules.ts'

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

const TRANSFER_CHECKED = 12
const SET_COMPUTE_LIMIT = 2
const SET_COMPUTE_PRICE = 3
/** Ceiling on the priority fee if the provider ever makes us pay it. */
const MAX_FEE_LAMPORTS = 2_000_000n

export interface PackTxExpectation {
  player: string
  /** Whole USDC. */
  price: number
  memo: string
  usdcMint: string
  gachaUsdcAccount: string
}

export class PackTxRejected extends Error {}

function fail(reason: string): never {
  throw new PackTxRejected(reason)
}

/**
 * The hot wallet signs what Collector Crypt sends it, so this is the line that
 * stops a bad or compromised response spending our money. The shape it allows
 * is exactly what their API returns: compute budget, one memo, one USDC
 * transfer of the expected price to their known account. Nothing else passes.
 */
export function validatePackTx(transaction: string, expect: PackTxExpectation): void {
  let tx: VersionedTransaction
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(transaction, 'base64'))
  } catch {
    fail('unreadable transaction')
  }

  const message = tx.message
  if (message.addressTableLookups.length > 0) fail('address lookup tables are not allowed')

  const keys = message.staticAccountKeys.map((key) => key.toBase58())
  const signerCount = message.header.numRequiredSignatures
  const signers = keys.slice(0, signerCount)
  if (!signers.includes(expect.player)) fail('player is not a signer')
  if (signerCount > 2) fail('too many signers')

  let memoCount = 0
  let transferCount = 0
  let computeUnits = 200_000n
  let microLamports = 0n

  for (const ix of message.compiledInstructions) {
    const program = keys[ix.programIdIndex]
    const data = Buffer.from(ix.data)
    const accounts = ix.accountKeyIndexes.map((index) => keys[index])

    if (program === COMPUTE_BUDGET) {
      if (data[0] === SET_COMPUTE_LIMIT && data.length === 5) computeUnits = BigInt(data.readUInt32LE(1))
      else if (data[0] === SET_COMPUTE_PRICE && data.length === 9) microLamports = data.readBigUInt64LE(1)
      else fail('unexpected compute budget instruction')
    } else if (program === MEMO) {
      memoCount += 1
      if (data.toString('utf8') !== `${expect.memo}:open`) fail('memo does not match')
    } else if (program === TOKEN) {
      transferCount += 1
      if (data.length !== 10 || data[0] !== TRANSFER_CHECKED) fail('token instruction is not a checked transfer')
      if (data[9] !== USDC_DECIMALS) fail('wrong decimals')
      const expected = BigInt(expect.price) * 10n ** BigInt(USDC_DECIMALS)
      if (data.readBigUInt64LE(1) !== expected) fail('amount does not match the pack price')

      const [source, mint, destination, owner, ...extra] = accounts
      if (mint !== expect.usdcMint) fail('wrong mint')
      if (owner !== expect.player) fail('wrong transfer authority')
      if (destination !== expect.gachaUsdcAccount) fail('payment goes to an unknown account')
      const playerUsdc = getAssociatedTokenAddressSync(
        new PublicKey(expect.usdcMint),
        new PublicKey(expect.player),
      ).toBase58()
      if (source !== playerUsdc) fail('payment comes from an unexpected account')
      // Their transaction repeats the owner as a trailing signer.
      if (extra.some((account) => account !== expect.player)) fail('unexpected transfer account')
    } else {
      fail(`unexpected program ${program}`)
    }
  }

  if (memoCount !== 1) fail('expected exactly one memo')
  if (transferCount !== 1) fail('expected exactly one transfer')
  if ((computeUnits * microLamports) / 1_000_000n > MAX_FEE_LAMPORTS) fail('priority fee is too high')
}
