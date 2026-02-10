import { BigInt, BigDecimal } from "@graphprotocol/graph-ts"
import { Transfer as TransferEvent } from "../generated/USDC/ERC20"
import { TransferEntity, Pool } from "../generated/schema"

const USDC_DECIMALS = 6
const POOL_ADDR = "0xd093a031df30f186976a1e2936b16d95ca7919d6"

export function handleTransfer(event: TransferEvent): void {
  const from = event.params.from.toHexString().toLowerCase()
  const to = event.params.to.toHexString().toLowerCase()
  const poolId = POOL_ADDR.toLowerCase()

  // Only index transfers where the pool is involved
  if (from != poolId && to != poolId) {
    return
  }

  let pool = Pool.load(poolId)
  if (pool == null) {
    pool = new Pool(poolId)
    pool.address = event.address
    pool.lifetimeVolume = BigDecimal.fromString("0")
    pool.lastUpdated = event.block.timestamp
  }

  const amt = convertTokenToDecimal(event.params.value, USDC_DECIMALS)
  pool.lifetimeVolume = pool.lifetimeVolume.plus(amt)
  pool.lastUpdated = event.block.timestamp
  pool.save()

  const id = event.transaction.hash.toHex() + "-" + event.logIndex.toString()
  const t = new TransferEntity(id)
  t.txHash = event.transaction.hash
  t.from = event.params.from
  t.to = event.params.to
  t.amount = event.params.value
  t.blockNumber = event.block.number
  t.timestamp = event.block.timestamp
  t.pool = pool.id
  t.save()
}

function convertTokenToDecimal(tokenAmount: BigInt, decimals: i32): BigDecimal {
  const precision = BigInt.fromI32(10).pow(<u8>decimals)
  return tokenAmount.toBigDecimal().div(precision.toBigDecimal())
}
