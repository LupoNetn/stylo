import { Injectable } from '@nestjs/common';
import { CreateOrderDto, CreateOrderSide } from './dto/create-order.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettlementService } from '../settlement/settlement.service.js';
import { WsException } from '@nestjs/websockets';

export interface InternalOrder {
  id: string;
  userId: string;
  symbol: string;
  baseAssetId: string;
  quoteAssetId: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET';
  price: bigint;
  quantity: bigint;
  remaining: bigint;
  createdAt: number;
}

export interface MatchResult {
  buyOrderId: string;
  sellOrderId: string;
  price: bigint;
  quantity: bigint;
}

interface OrderBook {
  bids: Map<string, InternalOrder[]>;
  asks: Map<string, InternalOrder[]>;
}

@Injectable()
export class OrdersService {
  private orderBooks = new Map<string, OrderBook>();
  private activeOrdersById = new Map<string, InternalOrder>();

  private orderMatchingEngine(order: InternalOrder): MatchResult[] {
    const { symbol, side, type, price, quantity } = order;

    let book = this.orderBooks.get(symbol);
    if (!book) {
      book = { bids: new Map(), asks: new Map() };
      this.orderBooks.set(symbol, book);
    }

    const isBuy = side === 'BUY';
    const oppositeBook = isBuy ? book.asks : book.bids;

    const pricesArray = Array.from(oppositeBook.keys());
    const sortedPrices = pricesArray
      .map(BigInt)
      .sort((a, b) => (isBuy ? (a < b ? -1 : 1) : a > b ? -1 : 1));

    const matches: MatchResult[] = [];

    for (const matchPrice of sortedPrices) {
      if (order.remaining === 0n) break;

      if (type === 'LIMIT') {
        const canMatch = isBuy ? price >= matchPrice : price <= matchPrice;
        if (!canMatch) break;
      }
      const queue = oppositeBook.get(matchPrice.toString()) || [];

      while (queue.length > 0 && order.remaining > 0n) {
        const makeOrder = queue[0];

        const tradeQuantity =
          order.remaining > makeOrder.remaining
            ? makeOrder.remaining
            : order.remaining;

        order.remaining -= tradeQuantity;
        makeOrder.remaining -= tradeQuantity;

        matches.push({
          buyOrderId: order.id,
          sellOrderId: makeOrder.id,
          price: matchPrice,
          quantity: tradeQuantity,
        });

        if (makeOrder.remaining === 0n) {
          queue.shift();
          this.activeOrdersById.delete(makeOrder.id);
        }

        if (queue.length === 0) {
          oppositeBook.delete(matchPrice.toString());
          break;
        }
      }
    }
    return matches;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly settlementService: SettlementService,
  ) {}

  async createOrderService(
    order: CreateOrderDto,
    userID: string,
  ): Promise<MatchResult[]> {
    const { baseAssetId, quoteAssetId, side, type, price, quantity } = order;
    const priceBig = BigInt(price);
    const quantityBig = BigInt(quantity);
    const symbol = `${baseAssetId}_${quoteAssetId}`;
    try {
      const orderId = BigInt(Date.now());
      const internalOrder: InternalOrder = {
        id: orderId.toString(),
        userId: userID,
        symbol,
        baseAssetId,
        quoteAssetId,
        side,
        type,
        price: priceBig,
        quantity: quantityBig,
        remaining: quantityBig,
        createdAt: Date.now(),
      };

      await this.prisma.$transaction(async (tx) => {
        const assetID =
          side === CreateOrderSide.BUY ? quoteAssetId : baseAssetId;

        const account = await tx.account.findUnique({
          where: {
            userId_assetId: {
              userId: userID,
              assetId: assetID,
            },
          },
          select: { assetId: true },
        });

        if (!account) {
          throw new WsException('This user account does not exist');
        }

        const amountToLock =
          side === CreateOrderSide.BUY ? priceBig * quantityBig : quantityBig;

        const locked = await tx.account.updateMany({
          where: {
            userId: userID,
            assetId: assetID,
            balanceAvailable: { gte: amountToLock },
          },
          data: {
            balanceAvailable: { decrement: amountToLock },
            balanceLocked: { increment: amountToLock },
          },
        });

        if (locked.count !== 1) {
          throw new WsException(`Insufficient available ${assetID} balance`);
        }

        await tx.order.create({
          data: {
            id: orderId,
            userId: userID,
            baseAssetId,
            quoteAssetId,
            side,
            type,
            price: priceBig,
            quantity: quantityBig,
            status: 'PENDING',
          },
        });
      });

      const matches = this.orderMatchingEngine(internalOrder);
      await this.settlementService.settle(internalOrder, matches);
      return matches;
    } catch (error) {
      if (error instanceof WsException) {
        throw error;
      }

      throw new WsException('Unable to create order');
    }
  }
}
