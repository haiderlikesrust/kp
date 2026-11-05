import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import {
  createApproveInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { PackTxRejected, validatePackTx } from '../server/packs/validate.ts'

/** A real unsigned transaction returned by dev-gacha.collectorcrypt.com. */
const fixture = JSON.parse(readFileSync(new URL('./fixtures/cc-devnet-pack.json', import.meta.url), 'utf8'))
const DEVNET_USDC = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr'
const DEVNET_GACHA_USDC = '9ZSgA3PMjeAU8K6CWzgJ8oDnhZwwSgHZu6KP3X95t7Jq'

describe('real provider transaction', () => {
  const expectation = {
    player: fixture.player,
    price: fixture.price,
    memo: fixture.memo,
    usdcMint: DEVNET_USDC,
    gachaUsdcAccount: DEVNET_GACHA_USDC,
  }

  it('passes when everything matches', () => {
    expect(() => validatePackTx(fixture.transaction, expectation)).not.toThrow()
  })

  const cases: [string, Partial<typeof expectation>][] = [
    ['a different price', { price: 25 }],
    ['a different memo', { memo: 'cc-other' }],
    ['a different mint', { usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }],
    ['an unknown destination', { gachaUsdcAccount: 'D9CEogjHA6CpS12F8St9zpSco7pQKJB5uR1RqDsuzQZk' }],
    ['a different player', { player: Keypair.generate().publicKey.toBase58() }],
  ]
  it.each(cases)('fails against %s', (_name, change) => {
    expect(() => validatePackTx(fixture.transaction, { ...expectation, ...change })).toThrow(PackTxRejected)
  })
})

describe('tampered transactions', () => {
  const player = Keypair.generate().publicKey
  const provider = Keypair.generate().publicKey
  const usdc = new PublicKey(DEVNET_USDC)
  const gacha = new PublicKey(DEVNET_GACHA_USDC)
  const memo = 'cc-test'
  const source = getAssociatedTokenAddressSync(usdc, player)
  const expectation = {
    player: player.toBase58(),
    price: 25,
    memo,
    usdcMint: DEVNET_USDC,
    gachaUsdcAccount: DEVNET_GACHA_USDC,
  }
  const memoIx = (text = `${memo}:open`) =>
    new TransactionInstruction({
      programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
      keys: [],
      data: Buffer.from(text),
    })
  const transferIx = (amount = 25_000_000n) =>
    createTransferCheckedInstruction(source, usdc, gacha, player, amount, 6)

  function build(...instructions: TransactionInstruction[]): string {
    const tx = new Transaction({ feePayer: provider, recentBlockhash: Keypair.generate().publicKey.toBase58() })
    tx.add(...instructions)
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')
  }

  it('accepts the expected shape', () => {
    expect(() => validatePackTx(build(memoIx(), transferIx()), expectation)).not.toThrow()
  })

  const attacks: [string, TransactionInstruction[]][] = [
    ['a drain of SOL', [memoIx(), transferIx(), SystemProgram.transfer({ fromPubkey: player, toPubkey: provider, lamports: 1_000_000_000 })]],
    ['a second USDC transfer', [memoIx(), transferIx(), transferIx()]],
    ['an approval that lets someone else spend', [memoIx(), transferIx(), createApproveInstruction(source, provider, player, 1_000_000_000n)]],
    ['an inflated amount', [memoIx(), transferIx(50_000_000n)]],
    ['a missing memo', [transferIx()]],
    ['no transfer', [memoIx()]],
    ['a second memo', [memoIx(), memoIx(), transferIx()]],
    ['a wrong memo', [memoIx('cc-test:other'), transferIx()]],
    ['a huge priority fee', [memoIx(), transferIx(), ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000 })]],
  ]
  it.each(attacks)('rejects %s', (_name, instructions) => {
    expect(() => validatePackTx(build(...instructions), expectation)).toThrow(PackTxRejected)
  })

  it('rejects a transfer pulling from another of our accounts', () => {
    const other = Keypair.generate().publicKey
    const ix = createTransferCheckedInstruction(other, usdc, gacha, player, 25_000_000n, 6)
    expect(() => validatePackTx(build(memoIx(), ix), expectation)).toThrow(/unexpected account/)
  })

  it('rejects garbage', () => {
    expect(() => validatePackTx('not a transaction', expectation)).toThrow(PackTxRejected)
  })
})
