import { Buffer } from 'buffer'
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'
import { createBurnCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import type { PublicConfig } from '../../../shared/api.ts'
import { burnMemo, voucherMemo } from '../../../shared/rules.ts'

// web3.js expects Node's Buffer to exist.
const scope = globalThis as unknown as { Buffer?: typeof Buffer }
scope.Buffer ??= Buffer

const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

const memoIx = (text: string, signer: PublicKey): TransactionInstruction =>
  new TransactionInstruction({
    programId: MEMO_PROGRAM,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(text),
  })

async function serialize(owner: PublicKey, instructions: TransactionInstruction[]): Promise<Uint8Array> {
  // Goes through our /rpc proxy so the paid RPC key stays on the server.
  const connection = new Connection(`${window.location.origin}/rpc`, 'confirmed')
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  const tx = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight })
  tx.add(...instructions)
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false })
}

/** The rip itself: one exact burn, tagged with the round it is for. */
export function buildRip(config: PublicConfig, wallet: string, roundId: number): Promise<Uint8Array> {
  const owner = new PublicKey(wallet)
  const mint = new PublicKey(config.coinMint)
  const tokenProgram = new PublicKey(config.tokenProgram)
  const account = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram)
  return serialize(owner, [
    createBurnCheckedInstruction(account, mint, owner, BigInt(config.burnRaw), config.coinDecimals, [], tokenProgram),
    memoIx(burnMemo(roundId), owner),
  ])
}

/**
 * Spends a voucher. It carries no burn, so a zero-value transfer tags it with a
 * known address, which is how the indexer finds it if the tab closes.
 */
export function buildVoucherRip(config: PublicConfig, wallet: string, roundId: number, originSig: string): Promise<Uint8Array> {
  const owner = new PublicKey(wallet)
  const tag = SystemProgram.transfer({ fromPubkey: owner, toPubkey: owner, lamports: 0 })
  tag.keys.push({ pubkey: new PublicKey(config.voucherReference), isSigner: false, isWritable: false })
  return serialize(owner, [tag, memoIx(voucherMemo(roundId, originSig), owner)])
}
