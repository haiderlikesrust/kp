import { type MachineInfo, type OpenResult, type PackProvider, ProviderError } from './provider.ts'

interface MachineRow {
  code: string
  price: number
  stock?: Partial<Record<'common' | 'uncommon' | 'rare' | 'epic', number>>
}

interface StatusRow {
  code: string
  isOpen?: boolean
}

const STILL_WORKING = new Set(['WAITING_FOR_WEBHOOK', 'SEND_PENDING'])

function attribute(attrs: unknown, pattern: RegExp): string | null {
  if (!Array.isArray(attrs)) return null
  const match = attrs.find((attr) => pattern.test(String(attr?.trait_type ?? '')))
  return match?.value != null ? String(match.value) : null
}

/** Client for Collector Crypt's gacha API. Docs: docs.collectorcrypt.com/gacha/api */
export class CollectorCrypt implements PackProvider {
  constructor(private opts: { base: string; apiKey?: string }) {}

  private async request(path: string, body?: unknown): Promise<{ status: number; data: any }> {
    const headers: Record<string, string> = {}
    if (this.opts.apiKey) headers['x-api-key'] = this.opts.apiKey
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`${this.opts.base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    let data: any = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = { error: text.slice(0, 200) }
    }
    return { status: res.status, data }
  }

  async machines(): Promise<MachineInfo[]> {
    const [machines, status] = await Promise.all([this.request('/api/machines'), this.request('/api/status')])
    if (machines.status !== 200 || status.status !== 200) throw new ProviderError('machine list unavailable')
    const running = status.data?.machineStatus === 'running'
    const open = new Map<string, boolean>(
      ((status.data?.gachas ?? []) as StatusRow[]).map((gacha) => [gacha.code, gacha.isOpen === true]),
    )
    return ((machines.data?.machines ?? []) as MachineRow[]).map((machine) => ({
      code: machine.code,
      price: machine.price,
      stock: Object.values(machine.stock ?? {}).reduce<number>((sum, count) => sum + (count ?? 0), 0),
      open: running && open.get(machine.code) === true,
    }))
  }

  async generatePack({ player, packType }: { player: string; packType: string }) {
    const { status, data } = await this.request('/api/generatePack', {
      playerAddress: player,
      packType,
      turbo: false,
    })
    if (status === 200 && data?.memo && data?.transaction) {
      return { memo: data.memo as string, transaction: data.transaction as string }
    }
    const details = String(data?.details ?? data?.error ?? `status ${status}`)
    throw new ProviderError(details, status === 500 && /machine/i.test(details))
  }

  async submit(signedTx: string): Promise<void> {
    const { status, data } = await this.request('/api/submitTransaction', { signedTransaction: signedTx })
    if (status !== 200 || !data?.success) {
      throw new ProviderError(String(data?.error ?? data?.details ?? `submit status ${status}`))
    }
  }

  async open(memo: string): Promise<OpenResult> {
    const { status, data } = await this.request('/api/openPack', { memo })
    if (status === 404 || STILL_WORKING.has(data?.code)) return { kind: 'waiting' }
    if (status !== 200 || !data?.nft_address) {
      throw new ProviderError(String(data?.error ?? data?.details ?? `open status ${status}`))
    }
    const won = data.nftWon ?? {}
    const metadata = won.content?.metadata ?? {}
    const file = won.content?.files?.[0] ?? {}
    const insured = won.insured_value ?? attribute(metadata.attributes ?? won.attributes, /insured.?value/i)
    return {
      kind: 'opened',
      card: {
        nft: data.nft_address,
        name: metadata.json_name ?? metadata.name ?? won.name ?? null,
        image: file.cc_cdn ?? won.image ?? won.content?.links?.image ?? file.uri ?? null,
        rarity: data.rarity ?? null,
        insuredValue: insured != null && Number.isFinite(Number(insured)) ? Number(insured) : null,
      },
    }
  }
}
