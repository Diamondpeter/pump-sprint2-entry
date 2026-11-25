// Pump.fun Paper Sprint: Any Bot Can Win — early-traction buyer.
//
// Idea: most pump.fun coins die fast. The few that run show it in their
// first slots: several different people (not the creator) buying, the
// creator not dumping, real SOL building up, and the price not yet stretched
// far above where the curve opened. Buy a small stake in those, pyramid a
// little while they climb, and cut losers fast. Winners are let run with a
// trailing stop instead of a fixed take-profit, because on a short 6-hour
// final window the exits and the flattening matter more than a rare 8x.
//
// Fully deterministic: no clock, no randomness, no environment reads.
// Insertion-ordered Maps only. Diagnostics go to stderr only.
//
// Entry (decided while the coin is at most 8 slots old):
//   - at least 7 distinct non-creator buyers
//   - creator has not sold
//   - price at most 1.5x the create price
//   - at least 0.3 SOL of real reserves
//   - first buy ~0.025 SOL, capped by the harness size cap (1% of real
//     quote reserves); a buy only counts if it is at least 0.01 SOL
// Pyramid: further 0.05 SOL adds (max ~0.25 SOL per coin) only while the
// price is above the last buy and the position is not underwater.
// Exits (sell everything): -10% hard stop; trailing stop armed at +150%,
// selling on a 25% fall from the peak value; take-profit at 8x cost;
// max hold 5,000 slots; creator sells while held; no trade for 500 slots.
// At most one entry per coin; at most 5 open positions (harness cap).

import {
  LAMPORTS_PER_SOL,
  runBot,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ---- Tunable strategy constants (FINAL v10: small first buy, -10% stop) ----
const MIN_BUYERS = 7;
const MAX_ENTRY_AGE_SLOTS = 8;
const MAX_ENTRY_PRICE_X_NUM = 3n; // price <= 1.5x create price
const MAX_ENTRY_PRICE_X_DEN = 2n;
const MIN_REAL_SOL_LAMPORTS = (LAMPORTS_PER_SOL * 3n) / 10n; // 0.3 SOL
const FIRST_BUY_LAMPORTS = LAMPORTS_PER_SOL / 40n; // 0.025 SOL
const PYRAMID_BUY_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL
const MAX_SPENT_PER_COIN_LAMPORTS = LAMPORTS_PER_SOL / 4n; // 0.25 SOL
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL (round-trip bar)
const BUY_SLIPPAGE_BPS = 200;
const SELL_SLIPPAGE_BPS = 10_000;
const STOP_LOSS_NUM = 90n; // sell when value <= 90% of cost (-10%)
const STOP_LOSS_DEN = 100n;
const TRAIL_ARM_NUM = 5n; // arm the trailing stop at +150% (value >= 2.5x cost)
const TRAIL_ARM_DEN = 2n;
const TRAIL_FALL_NUM = 75n; // sell when value falls to 75% of peak (-25%)
const TRAIL_FALL_DEN = 100n;
const TAKE_PROFIT_NUM = 8n; // sell-all at 8x cost
const TAKE_PROFIT_DEN = 1n;
const MAX_HOLD_SLOTS = 5_000;
const STALE_SLOTS = 500;

interface Coin {
  creator: string;
  createQuote: bigint; // virtual_quote_reserves at creation
  createToken: bigint; // virtual_token_reserves at creation
  createdSlot: number;
  buyers: Set<string>;
  creatorSold: boolean;
  lastTradeSlot: number;
  entered: boolean;
  spent: bigint; // SOL spent on buys so far (quote_lamports)
  lastBuyQuote: bigint; // virtual_quote at last buy
  lastBuyToken: bigint; // virtual_token at last buy
  entrySlot: number;
  peakValue: bigint;
  trailArmed: boolean;
}

const coins = new Map<string, Coin>();

// Price of one token in lamports, scaled by 1e9, from virtual reserves.
// value = tokenAmount * quote / token, all in bigint, no floats anywhere.
function positionValue(state: BotState, mint: string, tokens: bigint): bigint {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.virtual_token_reserves === 0n) return 0n;
  return (tokens * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
}

// price <= limit * createPrice, compared by cross-multiplication.
function priceAtMost(curveQuote: bigint, curveToken: bigint, coin: Coin, num: bigint, den: bigint): boolean {
  if (curveToken === 0n || coin.createToken === 0n) return false;
  return curveQuote * coin.createToken * den <= coin.createQuote * curveToken * num;
}

// price strictly above the price at the last buy.
function priceAboveLastBuy(curveQuote: bigint, curveToken: bigint, coin: Coin): boolean {
  if (curveToken === 0n || coin.lastBuyToken === 0n) return false;
  return curveQuote * coin.lastBuyToken > coin.lastBuyQuote * curveToken;
}

await runBot({
  onBatch(state, batch) {
    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();
    const maxOrders = state.hello.caps.max_orders_per_batch;

    // ---- 1. Fold this batch's events into per-coin tracking. ----
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint)) {
          coins.set(e.mint, {
            creator: e.creator,
            createQuote: BigInt(e.virtual_quote_reserves),
            createToken: BigInt(e.virtual_token_reserves),
            createdSlot: e.slot,
            buyers: new Set<string>(),
            creatorSold: false,
            lastTradeSlot: e.slot,
            entered: false,
            spent: 0n,
            lastBuyQuote: 0n,
            lastBuyToken: 0n,
            entrySlot: 0,
            peakValue: 0n,
            trailArmed: false,
          });
        }
      } else if (e.event === 'TradeEvent') {
        const coin = coins.get(e.mint);
        if (coin === undefined) continue;
        coin.lastTradeSlot = e.slot;
        if (e.is_buy) {
          if (e.user !== coin.creator) coin.buyers.add(e.user);
        } else if (e.user === coin.creator) {
          coin.creatorSold = true;
        }
      } else if (e.event === 'CompleteEvent') {
        // Harness closes the position itself; drop tracking.
        coins.delete(e.mint);
      }
    }

    // ---- 2. Exits for positions we hold. ----
    for (const [mint, holding] of state.positions) {
      if (orders.length >= maxOrders) break;
      const coin = coins.get(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const value = positionValue(state, mint, holding.token_amount);
      const cost = holding.cost_lamports;
      if (cost === 0n) continue;

      let sell = false;
      let why = '';
      if (value * STOP_LOSS_DEN <= cost * STOP_LOSS_NUM) {
        sell = true;
        why = 'stop';
      } else if (value * TAKE_PROFIT_DEN >= cost * TAKE_PROFIT_NUM) {
        sell = true;
        why = 'take-profit';
      } else if (coin !== undefined) {
        if (!coin.trailArmed && value * TRAIL_ARM_DEN >= cost * TRAIL_ARM_NUM) {
          coin.trailArmed = true;
        }
        if (coin.trailArmed) {
          if (value > coin.peakValue) coin.peakValue = value;
          if (value * TRAIL_FALL_DEN <= coin.peakValue * TRAIL_FALL_NUM) {
            sell = true;
            why = 'trailing';
          }
        } else if (value > coin.peakValue) {
          coin.peakValue = value;
        }
        if (!sell && coin.creatorSold) {
          sell = true;
          why = 'creator-sold';
        }
        if (!sell && batch.slot - coin.entrySlot >= MAX_HOLD_SLOTS) {
          sell = true;
          why = 'max-hold';
        }
        if (!sell && batch.slot - coin.lastTradeSlot >= STALE_SLOTS) {
          sell = true;
          why = 'stale';
        }
      }
      if (sell) {
        const sellOrder: SellInput = {
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        };
        orders.push(sellOrder);
        free -= txFee;
        console.error(`exit ${why} ${mint} value=${value} cost=${cost}`);
      }
    }

    // ---- 3. Entries and pyramids, oldest coins first. ----
    for (const [mint, coin] of coins) {
      if (orders.length >= maxOrders) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const age = batch.slot - coin.createdSlot;
      const holding = state.positions.get(mint);
      const hasPendingBuy = [...state.pending.values()].some(
        (p) => p.order.side === 'buy' && p.order.mint === mint,
      );

      if (holding !== undefined || hasPendingBuy) {
        // Pyramid: only while climbing and not underwater, capped per coin.
        if (
          holding !== undefined &&
          !hasPendingBuy &&
          coin.spent < MAX_SPENT_PER_COIN_LAMPORTS &&
          age <= MAX_HOLD_SLOTS
        ) {
          const value = positionValue(state, mint, holding.token_amount);
          if (value >= holding.cost_lamports && priceAboveLastBuy(curve.virtual_quote_reserves, curve.virtual_token_reserves, coin)) {
            const cap = state.maxBuyLamports(mint);
            const amount = cap < PYRAMID_BUY_LAMPORTS ? cap : PYRAMID_BUY_LAMPORTS;
            const room = MAX_SPENT_PER_COIN_LAMPORTS - coin.spent;
            const sized = amount < room ? amount : room;
            if (sized >= MIN_BUY_LAMPORTS && free >= sized + txFee) {
              const buy: BuyInput = { side: 'buy', mint, quote_lamports: sized, max_slippage_bps: BUY_SLIPPAGE_BPS };
              orders.push(buy);
              free -= sized + txFee;
              coin.spent += sized;
              coin.lastBuyQuote = curve.virtual_quote_reserves;
              coin.lastBuyToken = curve.virtual_token_reserves;
              console.error(`pyramid ${mint} amount=${sized}`);
            }
          }
        }
        continue;
      }

      // Fresh entry: young coin, real traction, creator clean, price sane.
      if (coin.entered || age > MAX_ENTRY_AGE_SLOTS) continue;
      if (coin.buyers.size < MIN_BUYERS) continue;
      if (coin.creatorSold) continue;
      if (curve.real_quote_reserves < MIN_REAL_SOL_LAMPORTS) continue;
      if (!priceAtMost(curve.virtual_quote_reserves, curve.virtual_token_reserves, coin, MAX_ENTRY_PRICE_X_NUM, MAX_ENTRY_PRICE_X_DEN)) continue;
      if (slots <= 0) continue;
      const cap = state.maxBuyLamports(mint);
      const amount = cap < FIRST_BUY_LAMPORTS ? cap : FIRST_BUY_LAMPORTS;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (free < amount + txFee) continue;
      const buy: BuyInput = { side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS };
      orders.push(buy);
      free -= amount + txFee;
      slots -= 1;
      coin.entered = true;
      coin.spent = amount;
      coin.entrySlot = batch.slot;
      coin.lastBuyQuote = curve.virtual_quote_reserves;
      coin.lastBuyToken = curve.virtual_token_reserves;
      coin.peakValue = 0n;
      coin.trailArmed = false;
      console.error(`enter ${mint} age=${age} buyers=${coin.buyers.size} amount=${amount}`);
    }

    return orders;
  },
});
