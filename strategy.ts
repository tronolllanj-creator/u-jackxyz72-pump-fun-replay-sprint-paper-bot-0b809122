import { type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';
// Dev-window check (kit engine port, full 24h window, after pending-guard fixes): public net +1.3300 SOL, fail-key mean +1.2553 SOL, 179 fills, 74 coins, max drawdown 0.135, 0 rejected.

export interface Params {
  maxAge: number;
  minBuyers: number;
  maxBuyers: number;
  minDevBuy: number;
  maxDevBuy: number;
  minRealSol: number;
  maxRealSol: number;
  minRunupBps: number;
  maxRunupBps: number;
  flowWindow: number;
  minFlowLamports: number;
  minRecentBuyers: number;
  maxSellRatioBps: number;
  maxBigSellBps: number;
  skipDevSold: boolean;
  buySlippageBps: number;
  stakeLamports: number;
  minBuyLamports: number;
  maxAdds: number;
  addStepBps: number;
  addDelay: number;
  addLamports: number;
  addMinFlowLamports: number;
  trailArmBps: number;
  trailBps: number;
  slBps: number;
  maxHold: number;
  exitOnDevSell: boolean;
  staleSlots: number;
  exitFlowLamports: number;
}

export const DEFAULT_PARAMS: Params = {
  maxAge: 3,
  minBuyers: 6,
  maxBuyers: 100,
  minDevBuy: 0,
  maxDevBuy: 500000000,
  minRealSol: 3000000000,
  maxRealSol: 30000000000,
  minRunupBps: 15000,
  maxRunupBps: 1000000,
  flowWindow: 10,
  minFlowLamports: 0,
  minRecentBuyers: 3,
  maxSellRatioBps: 10000,
  maxBigSellBps: 10000,
  skipDevSold: true,
  buySlippageBps: 10000,
  stakeLamports: 50000000,
  minBuyLamports: 5000000,
  maxAdds: 3,
  addStepBps: 3000,
  addDelay: 5,
  addLamports: 200000000,
  addMinFlowLamports: 0,
  trailArmBps: 1500,
  trailBps: 2500,
  slBps: 2000,
  maxHold: 50000,
  exitOnDevSell: true,
  staleSlots: 1000000,
  exitFlowLamports: 1000000000000,
};

export function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt + tokens <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  const fee = (gross * 125n) / 10000n;
  return gross > fee ? gross - fee : 0n;
}

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: string;
}

interface BookEntry {
  mint: Pubkey;
  createSlot: number;
  creator: string;
  createVq: bigint;
  createVt: bigint;
  devBuy: bigint;
  tradesCount: number;
  buyers: Set<string>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: number;
  devSold: boolean;
  lastTradeSlot: number;
  ticks: Tick[];
  buysSent: number;
  spentSent: bigint;
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuySlot: number;
  done: boolean;
  complete: boolean;
}

interface HeldTracker {
  mint: Pubkey;
  openedSlot: number;
  feesPaid: bigint;
  bestValue: bigint;
  devSoldAtOpen: boolean;
}

export function createStrategy(params: Params = DEFAULT_PARAMS) {
  const books = new Map<Pubkey, BookEntry>();
  const held = new Map<Pubkey, HeldTracker>();

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;

      // 1. Ingest events
      for (const ev of batch.events) {
        if (ev.event === 'CreateEvent') {
          if (!books.has(ev.mint)) {
            books.set(ev.mint, {
              mint: ev.mint,
              createSlot: ev.slot,
              creator: ev.creator,
              createVq: BigInt(ev.virtual_quote_reserves),
              createVt: BigInt(ev.virtual_token_reserves),
              devBuy: 0n,
              tradesCount: 0,
              buyers: new Set<string>(),
              bought: 0n,
              soldByOthers: 0n,
              bigSellBps: 0,
              devSold: false,
              lastTradeSlot: ev.slot,
              ticks: [],
              buysSent: 0,
              spentSent: 0n,
              lastBuyVq: BigInt(ev.virtual_quote_reserves),
              lastBuyVt: BigInt(ev.virtual_token_reserves),
              lastBuySlot: -99999,
              done: false,
              complete: false,
            });
          }
        } else if (ev.event === 'TradeEvent') {
          let b = books.get(ev.mint);
          if (!b) {
            b = {
              mint: ev.mint,
              createSlot: ev.slot,
              creator: ev.user,
              createVq: BigInt(ev.virtual_quote_reserves),
              createVt: BigInt(ev.virtual_token_reserves),
              devBuy: 0n,
              tradesCount: 0,
              buyers: new Set<string>(),
              bought: 0n,
              soldByOthers: 0n,
              bigSellBps: 0,
              devSold: false,
              lastTradeSlot: ev.slot,
              ticks: [],
              buysSent: 0,
              spentSent: 0n,
              lastBuyVq: BigInt(ev.virtual_quote_reserves),
              lastBuyVt: BigInt(ev.virtual_token_reserves),
              lastBuySlot: -99999,
              done: false,
              complete: false,
            };
            books.set(ev.mint, b);
          }
          b.tradesCount++;
          b.lastTradeSlot = Math.max(b.lastTradeSlot, ev.slot);

          const solVal = BigInt(ev.sol_amount);
          const isCreator = ev.user === b.creator;

          if (ev.is_buy) {
            if (isCreator && ev.slot === b.createSlot) {
              b.devBuy += solVal;
            }
            if (!isCreator) {
              b.buyers.add(ev.user);
              b.bought += solVal;
            }
          } else {
            if (isCreator) {
              b.devSold = true;
            } else {
              b.soldByOthers += solVal;
              const prevReal = BigInt(ev.real_quote_reserves) + (ev.is_buy ? -solVal : solVal);
              if (prevReal > 0n) {
                const bps = Number((solVal * 10000n) / prevReal);
                if (bps > b.bigSellBps) {
                  b.bigSellBps = bps;
                }
              }
            }
          }

          b.ticks.push({
            slot: ev.slot,
            isBuy: ev.is_buy,
            sol: solVal,
            user: ev.user,
          });
          // Prune old ticks
          const cutoff = ev.slot - params.flowWindow;
          b.ticks = b.ticks.filter((t) => t.slot >= cutoff);
        } else if (ev.event === 'CompleteEvent') {
          const b = books.get(ev.mint);
          if (b) {
            b.complete = true;
            b.done = true;
          }
        }
      }

      // 2. Process fills
      for (const f of batch.fills) {
        if (f.status === 'filled') {
          if (f.client_id && f.client_id.startsWith('_')) {
            held.delete(f.mint);
            continue;
          }
          const txFee = BigInt(f.tx_fee_lamports);
          let h = held.get(f.mint);
          if (f.side === 'buy') {
            if (!h) {
              const b = books.get(f.mint);
              h = {
                mint: f.mint,
                openedSlot: f.slot,
                feesPaid: txFee,
                bestValue: 0n,
                devSoldAtOpen: b ? b.devSold : false,
              };
              held.set(f.mint, h);
            } else {
              h.feesPaid += txFee;
            }
          } else if (f.side === 'sell') {
            if (h) {
              h.feesPaid += txFee;
            }
          }
        }
      }

      // Clean up orphaned held trackers
      for (const [mint] of held) {
        const hasPos = state.positions.has(mint);
        const hasPendingBuy = Array.from(state.pending.values()).some((p) => p.order.mint === mint && p.order.side === 'buy');
        const hasPendingSell = Array.from(state.pending.values()).some((p) => p.order.mint === mint && p.order.side === 'sell');
        if (!hasPos && !hasPendingBuy && !hasPendingSell) {
          held.delete(mint);
        }
      }

      const orders: OrderInput[] = [];
      const maxOrders = state.hello.caps.max_orders_per_batch;

      // Helper to get current curve marks or state
      const getCurveReserves = (mint: Pubkey) => {
        // check marks first
        for (const m of batch.marks) {
          if (m.mint === mint) {
            return {
              vq: BigInt(m.virtual_quote_reserves),
              vt: BigInt(m.virtual_token_reserves),
            };
          }
        }
        const c = state.curves.get(mint);
        if (c) {
          return {
            vq: c.virtual_quote_reserves,
            vt: c.virtual_token_reserves,
          };
        }
        return null;
      };

      // Helper to calculate flow
      const getFlow = (b: BookEntry) => {
        const cutoff = slot - params.flowWindow;
        let net = 0n;
        const recentBuyers = new Set<string>();
        for (const t of b.ticks) {
          if (t.slot >= cutoff) {
            if (t.isBuy) {
              net += t.sol;
              if (t.user !== b.creator) recentBuyers.add(t.user);
            } else {
              net -= t.sol;
            }
          }
        }
        return { net, recentBuyersCount: recentBuyers.size };
      };

      // 3. Exits first
      for (const [mint, h] of held) {
        if (orders.length >= maxOrders) break;
        const hasPendingSell = Array.from(state.pending.values()).some((p) => p.order.mint === mint && p.order.side === 'sell');
        if (hasPendingSell) continue;
        const pos = state.positions.get(mint);
        if (!pos) continue;

        const res = getCurveReserves(mint);
        if (!res) continue;

        const val = sellValue(pos.token_amount, res.vq, res.vt) - state.txFeeLamports();
        const basis = pos.cost_lamports + h.feesPaid;

        if (val > h.bestValue) {
          h.bestValue = val;
        }

        const b = books.get(mint);
        const ageHold = slot - h.openedSlot;
        const stale = b ? slot - b.lastTradeSlot >= params.staleSlots : false;
        const flowInfo = b ? getFlow(b) : { net: 0n, recentBuyersCount: 0 };
        const flowExit = flowInfo.net < -params.exitFlowLamports;
        const devSellExit = params.exitOnDevSell && b && b.devSold && !h.devSoldAtOpen;

        const slVal = basis - (basis * BigInt(params.slBps)) / 10000n;
        const armed = h.bestValue >= basis + (basis * BigInt(params.trailArmBps)) / 10000n;
        const trailVal = h.bestValue - (h.bestValue * BigInt(params.trailBps)) / 10000n;

        let shouldExit = false;
        if (val <= slVal) shouldExit = true;
        if (armed && val <= trailVal) shouldExit = true;
        if (ageHold >= params.maxHold) shouldExit = true;
        if (devSellExit) shouldExit = true;
        if (stale) shouldExit = true;
        if (flowExit) shouldExit = true;

        if (shouldExit) {
          orders.push({
            side: 'sell',
            mint,
            token_amount: pos.token_amount,
            max_slippage_bps: 10000,
          });
          if (b) {
            b.done = true;
          }
        }
      }

      // 4. Entries and adds
      for (const [mint, b] of books) {
        if (orders.length >= maxOrders) break;
        if (b.done || b.complete) continue;

        const age = slot - b.createSlot;
        const hasPos = state.positions.has(mint) || held.has(mint);
        const pendingOnMint = Array.from(state.pending.values()).some((p) => p.order.mint === mint);

        const isFirstBuy = !hasPos;

        if (isFirstBuy) {
          if (pendingOnMint) continue;
          if (age > params.maxAge || age < 0) continue;
          if (state.committedPositionCount() >= state.hello.caps.max_open_positions) continue;

          // Rug filter checks
          const res = getCurveReserves(mint);
          if (!res) continue;

          const realSol = state.curves.get(mint)?.real_quote_reserves ?? 0n;
          if (realSol < BigInt(params.minRealSol) || realSol > BigInt(params.maxRealSol)) continue;

          if (b.devBuy < BigInt(params.minDevBuy) || b.devBuy > BigInt(params.maxDevBuy)) continue;
          if (b.buyers.size < params.minBuyers || b.buyers.size > params.maxBuyers) continue;

          if (b.bought > 0n && b.soldByOthers * 10000n > b.bought * BigInt(params.maxSellRatioBps)) continue;
          if (b.bigSellBps > params.maxBigSellBps) continue;

          // runup = (vq * createVt * 10000) / (vt * createVq)
          const runup = (res.vq * b.createVt * 10000n) / (res.vt * b.createVq);
          if (runup < BigInt(params.minRunupBps) || runup > BigInt(params.maxRunupBps)) continue;

          const flow = getFlow(b);
          if (flow.net < BigInt(params.minFlowLamports)) continue;
          if (flow.recentBuyersCount < params.minRecentBuyers) continue;

          if (b.devSold && params.skipDevSold) {
            b.done = true;
            continue;
          }

          const rawStake = BigInt(params.stakeLamports);
          const maxCap = state.maxBuyLamports(mint);
          const buyAmt = rawStake < maxCap ? rawStake : maxCap;
          if (buyAmt < BigInt(params.minBuyLamports)) continue;

          const txFee = state.txFeeLamports();
          if (state.freeCashLamports() < buyAmt + txFee) continue;

          b.buysSent++;
          b.spentSent += buyAmt;
          b.lastBuyVq = res.vq;
          b.lastBuyVt = res.vt;
          b.lastBuySlot = slot;

          orders.push({
            side: 'buy',
            mint,
            quote_lamports: buyAmt,
            max_slippage_bps: params.buySlippageBps,
          });
        } else {
          // Add checks
          if (b.buysSent < 1 || b.buysSent > params.maxAdds) continue;
          if (pendingOnMint) continue;

          const res = getCurveReserves(mint);
          if (!res) continue;

          if (slot - b.lastBuySlot < params.addDelay) continue;

          // price now >= last buy decision price * (1 + addStepBps/10000)
          // price = vq/vt => price now * lastBuyVt / lastBuyVq >= 1 + step
          // Equivalently: (vq * b.lastBuyVt * 10000) / (vt * b.lastBuyVq) >= 10000 + addStepBps
          const priceRatio = (res.vq * b.lastBuyVt * 10000n) / (res.vt * b.lastBuyVq);
          if (priceRatio < 10000n + BigInt(params.addStepBps)) continue;

          const flow = getFlow(b);
          if (flow.net < BigInt(params.addMinFlowLamports)) continue;

          const rawAdd = BigInt(params.addLamports);
          const maxCap = state.maxBuyLamports(mint);
          const addAmt = rawAdd < maxCap ? rawAdd : maxCap;
          if (addAmt < BigInt(params.minBuyLamports)) continue;

          const txFee = state.txFeeLamports();
          if (state.freeCashLamports() < addAmt + txFee) continue;

          b.buysSent++;
          b.spentSent += addAmt;
          b.lastBuyVq = res.vq;
          b.lastBuyVt = res.vt;
          b.lastBuySlot = slot;

          orders.push({
            side: 'buy',
            mint,
            quote_lamports: addAmt,
            max_slippage_bps: params.buySlippageBps,
          });
        }
      }

      return orders;
    },
  };
}
