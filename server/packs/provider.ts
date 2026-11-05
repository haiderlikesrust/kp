export interface MachineInfo {
  code: string
  price: number
  stock: number
  open: boolean
}

export interface OpenedCard {
  nft: string
  name: string | null
  image: string | null
  rarity: string | null
  insuredValue: number | null
}

export type OpenResult = { kind: 'opened'; card: OpenedCard } | { kind: 'waiting' }

export class ProviderError extends Error {
  constructor(
    message: string,
    /** Empty, off or out of balance: this machine cannot sell a pack right now. */
    readonly machineUnavailable = false,
  ) {
    super(message)
  }
}

export interface PackProvider {
  machines(): Promise<MachineInfo[]>
  generatePack(args: { player: string; packType: string }): Promise<{ memo: string; transaction: string }>
  submit(signedTx: string): Promise<void>
  open(memo: string): Promise<OpenResult>
}
