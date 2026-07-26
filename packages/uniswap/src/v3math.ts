/** Uniswap v3 tick / liquidity amount math (Q96 fixed-point). */

const Q96 = 2n ** 96n;

function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  return (a * b) / denominator;
}

/**
 * Port of TickMath.getSqrtRatioAtTick — returns sqrt(1.0001^tick) * 2^96.
 * @see https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/TickMath.sol
 */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (tick < -887272 || tick > 887272) {
    throw new Error(`tick out of range: ${tick}`);
  }
  const absTick = tick < 0 ? -tick : tick;
  let ratio =
    (absTick & 0x1) !== 0
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2) !== 0) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4) !== 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8) !== 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10) !== 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20) !== 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40) !== 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80) !== 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100) !== 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200) !== 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400) !== 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800) !== 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000) !== 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000) !== 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000) !== 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000) !== 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000) !== 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000) !== 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000) !== 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000) !== 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

  if (tick > 0) ratio = (2n ** 256n - 1n) / ratio;

  // round up in tick → price direction used by Solidity
  return ratio % (1n << 32n) === 0n ? ratio >> 32n : (ratio >> 32n) + 1n;
}

function amount0ForLiquidity(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  let a = sqrtRatioAX96;
  let b = sqrtRatioBX96;
  if (a > b) [a, b] = [b, a];
  return mulDiv(liquidity << 96n, b - a, b) / a;
}

function amount1ForLiquidity(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  let a = sqrtRatioAX96;
  let b = sqrtRatioBX96;
  if (a > b) [a, b] = [b, a];
  return mulDiv(liquidity, b - a, Q96);
}

/** Token amounts currently held by a v3 position at `sqrtPriceX96`. */
export function getAmountsForPosition(opts: {
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}): { amount0: bigint; amount1: bigint } {
  const sqrtA = getSqrtRatioAtTick(opts.tickLower);
  const sqrtB = getSqrtRatioAtTick(opts.tickUpper);
  const sqrtP = opts.sqrtPriceX96;
  const L = opts.liquidity;

  if (sqrtP <= sqrtA) {
    return { amount0: amount0ForLiquidity(sqrtA, sqrtB, L), amount1: 0n };
  }
  if (sqrtP < sqrtB) {
    return {
      amount0: amount0ForLiquidity(sqrtP, sqrtB, L),
      amount1: amount1ForLiquidity(sqrtA, sqrtP, L),
    };
  }
  return { amount0: 0n, amount1: amount1ForLiquidity(sqrtA, sqrtB, L) };
}
