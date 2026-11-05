import { parseMemo, type ParsedMemo } from '../../shared/rules.ts'
import type { ParsedIx, ParsedTx } from './types.ts'

export const MEMO_PROGRAMS = new Set([
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
])

export const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
])

export interface VerifyTarget {
  mint: string
  tokenProgram: string
  burnRaw: bigint
}

export type Verdict<T> = ({ ok: true } & T) | { ok: false; reason: string }

const reject = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })

const isBurnIx = (ix: ParsedIx): boolean =>
  TOKEN_PROGRAMS.has(String(ix.programId)) && (ix.parsed?.type === 'burn' || ix.parsed?.type === 'burnChecked')

/**
 * Reads the round memo. Only top-level instructions from the real Memo program
 * count, so a memo printed in logs or by another program is ignored.
 */
export function readMemo(tx: ParsedTx): ParsedMemo | null {
  const memos = tx.transaction.message.instructions.filter((ix) => MEMO_PROGRAMS.has(String(ix.programId)))
  if (memos.length !== 1) return null
  const text = memos[0]?.parsed
  return typeof text === 'string' ? parseMemo(text) : null
}

/**
 * Decides whether a transaction is a valid rip. Every rule here exists because
 * a real attack gets past the weaker version, so none of them are optional.
 */
export function verifyBurnTx(tx: ParsedTx, target: VerifyTarget): Verdict<{ wallet: string }> {
  if (!tx.meta) return reject('no_meta')
  if (tx.meta.err !== null && tx.meta.err !== undefined) return reject('tx_failed')

  const { accountKeys, instructions } = tx.transaction.message
  const burns = instructions.filter(isBurnIx)
  if (burns.length !== 1) return reject(burns.length === 0 ? 'no_top_level_burn' : 'multiple_burns')
  const burn = burns[0] as ParsedIx

  if (String(burn.programId) !== target.tokenProgram) return reject('wrong_token_program')

  const info = burn.parsed.info
  if (info.mint !== target.mint) return reject('wrong_mint')

  // Compare as BigInt strings: these amounts exceed safe JS numbers.
  const amount = burn.parsed.type === 'burnChecked' ? info.tokenAmount?.amount : info.amount
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) return reject('bad_amount')
  if (BigInt(amount) !== target.burnRaw) return reject('wrong_amount')

  // Multisig burns have no plain authority; they are not supported.
  const authority = info.authority
  if (typeof authority !== 'string') return reject('no_authority')

  const authorityKey = accountKeys.find((key) => String(key.pubkey) === authority)
  if (!authorityKey?.signer) return reject('authority_not_signer')

  // The ripper must be the token account's owner, so a delegate cannot burn
  // someone else's coins and collect the prize for itself.
  const accountIndex = accountKeys.findIndex((key) => String(key.pubkey) === info.account)
  const balance = tx.meta.preTokenBalances?.find((entry) => entry.accountIndex === accountIndex)
  if (!balance) return reject('no_token_balance')
  if (balance.mint !== target.mint) return reject('wrong_mint')
  if (balance.owner !== authority) return reject('authority_not_owner')

  return { ok: true, wallet: authority }
}

/** A voucher redemption is any successful transaction signed by the holder. */
export function verifyVoucherTx(tx: ParsedTx): Verdict<{ wallet: string }> {
  if (!tx.meta) return reject('no_meta')
  if (tx.meta.err !== null && tx.meta.err !== undefined) return reject('tx_failed')
  const payer = tx.transaction.message.accountKeys[0]
  if (!payer?.signer) return reject('no_signer')
  return { ok: true, wallet: String(payer.pubkey) }
}
