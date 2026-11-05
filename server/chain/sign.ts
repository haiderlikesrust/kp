import { Keypair, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import type { SignedTx } from './types.ts'

/** Adds a signature to a partially signed transaction without changing it. */
export function signPartial(transaction: string, signer: Keypair): SignedTx {
  const tx = VersionedTransaction.deserialize(Buffer.from(transaction, 'base64'))
  tx.sign([signer])
  const index = tx.message.staticAccountKeys.findIndex((key) => key.equals(signer.publicKey))
  const signature = tx.signatures[index]
  if (!signature) throw new Error('signer is not part of this transaction')
  return {
    signedTx: Buffer.from(tx.serialize()).toString('base64'),
    // Solana identifies a transaction by its first signature.
    signature: bs58.encode(tx.signatures[0] as Uint8Array),
  }
}
