export type Commitment = 'confirmed' | 'finalized'

/** Same shape as web3.js ParsedTransactionWithMeta, reduced to what we read. */
export interface ParsedIx {
  programId: unknown
  program?: string
  parsed?: any
}

export interface ParsedTx {
  slot: number
  meta: {
    err: unknown
    preTokenBalances?: { accountIndex: number; mint: string; owner?: string }[] | null
  } | null
  transaction: {
    signatures: string[]
    message: {
      accountKeys: { pubkey: unknown; signer: boolean }[]
      instructions: ParsedIx[]
    }
  }
}

export interface AssetInfo {
  address: string
  owner: string
  /** DAS interface, e.g. MplCoreAsset or ProgrammableNFT. */
  interface: string
  collection: string | null
  name: string | null
  image: string | null
  insuredValue: number | null
}

export interface SignedTx {
  signedTx: string
  signature: string
}

export type TxStatus = 'confirmed' | 'finalized' | 'failed' | null

export interface Chain {
  readonly devAddress: string
  slot(): Promise<number>
  finalizedSlot(): Promise<number>
  getParsedTx(signature: string, commitment: Commitment): Promise<ParsedTx | null>
  /** Position of a transaction inside its block, for same-slot ties. */
  blockIndexOf(slot: number, signature: string): Promise<number>
  /** First finalized block at or after a slot, or null if none is finalized yet. */
  finalizedBlockhashFrom(slot: number): Promise<{ slot: number; blockhash: string } | null>
  /** Signatures touching an address that carry a KeepRipping memo, oldest first. */
  memoSignatures(address: string, until: string | null): Promise<string[]>
  /** Calls back with signatures as they land. Polling covers anything missed. */
  watchMemos(address: string, onSignature: (signature: string) => void): void
  usdcMicro(): Promise<bigint>
  lamports(): Promise<bigint>
  /** Sends a memo from the dev wallet and returns its signature. */
  sendMemo(text: string): Promise<string>
  signatureStatus(signature: string): Promise<TxStatus>
  /** True once the transaction's blockhash can no longer land. */
  blockhashExpired(signedTx: string): Promise<boolean>
  sendRaw(signedTx: string): Promise<string>
  /** Adds the dev wallet's signature to a partially signed provider transaction. */
  signProviderTx(transaction: string): SignedTx
  asset(address: string): Promise<AssetInfo | null>
  buildCardTransfer(asset: AssetInfo, recipient: string): Promise<SignedTx>
}
