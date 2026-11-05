import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { InternalOrder, MatchResult } from '../orders/orders.service.js';

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Settles the outcome of an order matching cycle:
   * 1. If 0 matches: updates the resting LIMIT order status from PENDING to OPEN.
   * 2. If matches occurred: records trades, transfers balances, and updates order statuses.
   */
  async settle(order: InternalOrder, matches: MatchResult[]): Promise<void> {
    const orderIdBig = BigInt(order.id);

    // Case 1: No matches made
    if (matches.length === 0) {
      if (order.type === 'LIMIT') {
        await this.prisma.order.update({
          where: { id: orderIdBig },
          data: { status: 'OPEN' },
        });
      } else {
        await this.refundMarketOrder(order, order.quantity);
      }
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      const involvedOrderIds = new Set<bigint>();
      involvedOrderIds.add(orderIdBig);

      for (const match of matches) {
        involvedOrderIds.add(BigInt(match.buyOrderId));
        involvedOrderIds.add(BigInt(match.sellOrderId));
      }

     
      const dbOrders = await tx.order.findMany({
        where: { id: { in: Array.from(involvedOrderIds) } },
      });

      const orderMap = new Map<string, (typeof dbOrders)[0]>();
      for (const o of dbOrders) {
        orderMap.set(o.id.toString(), o);
      }

      // Track filled quantities per order across this batch of matches
      const filledQuantitiesByOrder = new Map<string, bigint>();

      // 3. Process each match
      for (const match of matches) {
        const matchPrice = match.price;
        const matchQuantity = match.quantity;
        const quoteAmount = matchPrice * matchQuantity;

        const buyerOrder = orderMap.get(match.buyOrderId);
        const sellerOrder = orderMap.get(match.sellOrderId);

        if (!buyerOrder || !sellerOrder) {
          this.logger.error(
            `Missing order in DB for match: buy=${match.buyOrderId}, sell=${match.sellOrderId}`,
          );
          continue;
        }

        // Record the Trade
        await tx.trade.create({
          data: {
            buyOrderId: buyerOrder.id,
            sellOrderId: sellerOrder.id,
            matchPrice,
            matchQuantity,
          },
        });

        // --- BUYER ACCOUNT SETTLEMENT ---
        // Buyer locked quote currency (e.g. USD) at their original limit price
        const buyerLockPrice = buyerOrder.price;
        const buyerLockedDeduction = buyerLockPrice * matchQuantity;
        const priceImprovement =
          buyerLockPrice > matchPrice
            ? (buyerLockPrice - matchPrice) * matchQuantity
            : 0n;

        // Deduct locked quote currency & refund any price improvement
        await tx.account.update({
          where: {
            userId_assetId: {
              userId: buyerOrder.userId,
              assetId: buyerOrder.quoteAssetId,
            },
          },
          data: {
            balanceLocked: { decrement: buyerLockedDeduction },
            balanceAvailable: { increment: priceImprovement },
          },
        });

        // Credit purchased base asset (e.g. BTC) to buyer
        await tx.account.upsert({
          where: {
            userId_assetId: {
              userId: buyerOrder.userId,
              assetId: buyerOrder.baseAssetId,
            },
          },
          update: {
            balanceAvailable: { increment: matchQuantity },
          },
          create: {
            userId: buyerOrder.userId,
            assetId: buyerOrder.baseAssetId,
            balanceAvailable: matchQuantity,
            balanceLocked: 0n,
          },
        });

        // --- SELLER ACCOUNT SETTLEMENT ---
        // Deduct locked base asset (e.g. BTC) from seller
        await tx.account.update({
          where: {
            userId_assetId: {
              userId: sellerOrder.userId,
              assetId: sellerOrder.baseAssetId,
            },
          },
          data: {
            balanceLocked: { decrement: matchQuantity },
          },
        });

        // Credit earned quote currency (e.g. USD) to seller
        await tx.account.upsert({
          where: {
            userId_assetId: {
              userId: sellerOrder.userId,
              assetId: sellerOrder.quoteAssetId,
            },
          },
          update: {
            balanceAvailable: { increment: quoteAmount },
          },
          create: {
            userId: sellerOrder.userId,
            assetId: sellerOrder.quoteAssetId,
            balanceAvailable: quoteAmount,
            balanceLocked: 0n,
          },
        });

        // Accumulate filled quantities
        filledQuantitiesByOrder.set(
          match.buyOrderId,
          (filledQuantitiesByOrder.get(match.buyOrderId) ?? 0n) + matchQuantity,
        );
        filledQuantitiesByOrder.set(
          match.sellOrderId,
          (filledQuantitiesByOrder.get(match.sellOrderId) ?? 0n) + matchQuantity,
        );
      }

      // 4. Update status for all involved orders
      for (const [orderIdStr, filledThisRound] of filledQuantitiesByOrder) {
        const dbOrder = orderMap.get(orderIdStr);
        if (!dbOrder) continue;

        // Fetch previous filled trades for this order to check total filled
        const trades = await tx.trade.findMany({
          where: {
            OR: [{ buyOrderId: dbOrder.id }, { sellOrderId: dbOrder.id }],
          },
          select: { matchQuantity: true },
        });

        const totalFilled = trades.reduce(
          (sum, t) => sum + t.matchQuantity,
          0n,
        );

        let newStatus: 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' =
          dbOrder.status as any;

        if (totalFilled >= dbOrder.quantity) {
          newStatus = 'FILLED';
        } else if (totalFilled > 0n) {
          newStatus = 'PARTIALLY_FILLED';
        }

        await tx.order.update({
          where: { id: dbOrder.id },
          data: { status: newStatus },
        });
      }

      // 5. Market Order remainder refund (if incoming was MARKET and not fully filled)
      if (order.type === 'MARKET' && order.remaining > 0n) {
        const assetId =
          order.side === 'BUY' ? order.quoteAssetId : order.baseAssetId;
        const refundAmount =
          order.side === 'BUY'
            ? order.price * order.remaining
            : order.remaining;

        await tx.account.update({
          where: {
            userId_assetId: {
              userId: order.userId,
              assetId,
            },
          },
          data: {
            balanceLocked: { decrement: refundAmount },
            balanceAvailable: { increment: refundAmount },
          },
        });
      }
    });
  }

  private async refundMarketOrder(
    order: InternalOrder,
    unfilledQuantity: bigint,
  ): Promise<void> {
    const assetId =
      order.side === 'BUY' ? order.quoteAssetId : order.baseAssetId;
    const refundAmount =
      order.side === 'BUY' ? order.price * unfilledQuantity : unfilledQuantity;

    await this.prisma.$transaction([
      this.prisma.order.update({
        where: { id: BigInt(order.id) },
        data: { status: 'CANCELED' },
      }),
      this.prisma.account.update({
        where: {
          userId_assetId: {
            userId: order.userId,
            assetId,
          },
        },
        data: {
          balanceLocked: { decrement: refundAmount },
          balanceAvailable: { increment: refundAmount },
        },
      }),
    ]);
  }
}
