export type AiCallPrice = {
  billing_mode?: string
  input_microfen_per_million: number
  output_microfen_per_million: number
  per_request_microfen?: number
}

/** docs/pricing.md §0: 40k uncached input + 3.5k ordinary output; extra reasoning is excluded. */
export function estimateCallYuan(price: AiCallPrice): number {
  if (price.billing_mode === "per_request") return (price.per_request_microfen ?? 0) / 100_000_000
  return (40_000 * price.input_microfen_per_million + 3_500 * price.output_microfen_per_million) / 1_000_000 / 100_000_000
}
