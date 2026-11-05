import { describe, expect, it } from 'vitest'
import { readMemo, verifyBurnTx, verifyVoucherTx } from '../server/chain/verify.ts'
import type { ParsedTx } from '../server/chain/types.ts'
import { burnMemo, parseMemo, voucherMemo } from '../shared/rules.ts'

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const MINT = 'CoinMint111111111111111111111111111111111111'
const WALLET = 'Wallet1111111111111111111111111111111111111'
const ACCOUNT = 'TokenAcct111111111111111111111111111111111'
const target = { mint: MINT, tokenProgram: TOKEN, burnRaw: 100_000_000_000n }

function burnTx(overrides: {
  type?: 'burn' | 'burnChecked'
  amount?: string
  mint?: string
  authority?: string | undefined
  programId?: string
  owner?: string
  signer?: boolean
  err?: unknown
  memo?: string | null
  extraInstructions?: ParsedTx['transaction']['message']['instructions']
} = {}): ParsedTx {
  const type = overrides.type ?? 'burnChecked'
  const amount = overrides.amount ?? '100000000000'
  const authority = 'authority' in overrides ? overrides.authority : WALLET
  const info: Record<string, unknown> = { account: ACCOUNT, mint: overrides.mint ?? MINT, authority }
  if (type === 'burn') info.amount = amount
  else info.tokenAmount = { amount, decimals: 6 }
  return {
    slot: 500,
    meta: {
      err: overrides.err ?? null,
      preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: overrides.owner ?? WALLET }],
    },
    transaction: {
      signatures: ['sig'],
      message: {
        accountKeys: [
          { pubkey: WALLET, signer: overrides.signer ?? true },
          { pubkey: ACCOUNT, signer: false },
        ],
        instructions: [
          { programId: overrides.programId ?? TOKEN, program: 'spl-token', parsed: { type, info } },
          ...(overrides.memo === null
            ? []
            : [{ programId: MEMO, program: 'spl-memo', parsed: overrides.memo ?? burnMemo(3) }]),
          ...(overrides.extraInstructions ?? []),
        ],
      },
    },
  }
}

describe('verifyBurnTx', () => {
  it('accepts a clean burn and names the owner as the ripper', () => {
    expect(verifyBurnTx(burnTx(), target)).toEqual({ ok: true, wallet: WALLET })
  })

  it('accepts a plain burn as well as burnChecked', () => {
    expect(verifyBurnTx(burnTx({ type: 'burn' }), target).ok).toBe(true)
  })

  it('works with Token-2022 mints', () => {
    const result = verifyBurnTx(burnTx({ programId: TOKEN_2022 }), { ...target, tokenProgram: TOKEN_2022 })
    expect(result.ok).toBe(true)
  })

  const rejections: [string, ParsedTx, string][] = [
    ['a failed transaction', burnTx({ err: { InstructionError: [0, 'Custom'] } }), 'tx_failed'],
    ['one token short', burnTx({ amount: '99999999999' }), 'wrong_amount'],
    ['burning extra', burnTx({ amount: '100000000001' }), 'wrong_amount'],
    ['a different coin', burnTx({ mint: 'FakeMint' }), 'wrong_mint'],
    ['the wrong token program', burnTx({ programId: TOKEN_2022 }), 'wrong_token_program'],
    ['a delegate burning for someone else', burnTx({ owner: 'SomeoneElse' }), 'authority_not_owner'],
    ['an authority that never signed', burnTx({ signer: false }), 'authority_not_signer'],
    ['a multisig authority', burnTx({ authority: undefined }), 'no_authority'],
  ]
  it.each(rejections)('rejects %s', (_name, tx, reason) => {
    expect(verifyBurnTx(tx, target)).toEqual({ ok: false, reason })
  })

  it('rejects two burns in one transaction', () => {
    const second = burnTx().transaction.message.instructions[0]!
    const result = verifyBurnTx(burnTx({ extraInstructions: [second] }), target)
    expect(result).toEqual({ ok: false, reason: 'multiple_burns' })
  })

  it('ignores burns that happen only as inner instructions', () => {
    const tx = burnTx()
    tx.transaction.message.instructions = [{ programId: 'SomeProgram', parsed: undefined }]
    expect(verifyBurnTx(tx, target)).toEqual({ ok: false, reason: 'no_top_level_burn' })
  })

  it('rejects a lookalike program with a burn-shaped instruction', () => {
    const tx = burnTx()
    tx.transaction.message.instructions[0]!.programId = 'FakeToken11111111111111111111111111111111'
    expect(verifyBurnTx(tx, target)).toEqual({ ok: false, reason: 'no_top_level_burn' })
  })

  it('rejects when the balance record is for another mint', () => {
    const tx = burnTx()
    tx.meta!.preTokenBalances![0]!.mint = 'OtherMint'
    expect(verifyBurnTx(tx, target)).toEqual({ ok: false, reason: 'wrong_mint' })
  })

  it('handles PublicKey-like objects from web3.js', () => {
    const tx = burnTx()
    const key = { toString: () => WALLET }
    tx.transaction.message.accountKeys[0]!.pubkey = key
    expect(verifyBurnTx(tx, target).ok).toBe(true)
  })
})

describe('readMemo', () => {
  it('reads the round from the real Memo program', () => {
    expect(readMemo(burnTx())).toEqual({ kind: 'burn', roundId: 3 })
  })

  it('reads voucher redemptions', () => {
    expect(readMemo(burnTx({ memo: voucherMemo(4, 'originSig') }))).toEqual({
      kind: 'voucher',
      roundId: 4,
      originSig: 'originSig',
    })
  })

  it('ignores a memo from a fake program', () => {
    const tx = burnTx({ memo: null, extraInstructions: [{ programId: 'FakeMemo', parsed: burnMemo(3) }] })
    expect(readMemo(tx)).toBeNull()
  })

  it('rejects two memos, so a transaction cannot name two rounds', () => {
    const tx = burnTx({ extraInstructions: [{ programId: MEMO, parsed: burnMemo(4) }] })
    expect(readMemo(tx)).toBeNull()
  })

  it('rejects malformed memos', () => {
    for (const memo of ['hello', 'keepripping:v1', 'keepripping:v1:0', 'keepripping:v1:-2', 'keepripping:v1:1.5', 'keepripping:v2:1', 'keepripping:v1:01']) {
      expect(parseMemo(memo)).toBeNull()
    }
  })
})

describe('verifyVoucherTx', () => {
  it('names the fee payer', () => {
    expect(verifyVoucherTx(burnTx())).toEqual({ ok: true, wallet: WALLET })
  })

  it('rejects failed transactions', () => {
    expect(verifyVoucherTx(burnTx({ err: 'boom' })).ok).toBe(false)
  })
})
