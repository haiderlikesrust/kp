export const JUPITER = 'https://api.jup.ag/swap/v2'

export interface JupiterOrder {
  transaction: string | null
  requestId: string
  inAmount: string
  outAmount: string
  errorCode?: number
  errorMessage?: string
}

/** Without a taker this is just a quote: nothing can be signed or spent. */
export async function jupiterOrder(args: {
  input: string
  output: string
  amount: bigint
  taker?: string
  apiKey?: string
}): Promise<JupiterOrder> {
  const params = new URLSearchParams({
    inputMint: args.input,
    outputMint: args.output,
    amount: args.amount.toString(),
  })
  if (args.taker) params.set('taker', args.taker)
  const headers: Record<string, string> = {}
  if (args.apiKey) headers['x-api-key'] = args.apiKey
  const res = await fetch(`${JUPITER}/order?${params}`, { headers, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`jupiter order ${res.status}`)
  return (await res.json()) as JupiterOrder
}
