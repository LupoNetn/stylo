import { Injectable } from '@nestjs/common';
import { CreateOrderDto, CreateOrderSide } from './dto/create-order.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WsException } from '@nestjs/websockets';

export interface InternalOrder {
  id: string;
  userId: string;
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
    // No immediate match is a valid result; the order will rest in the book.
    return [];
  }

  constructor(private readonly prisma: PrismaService) {}
  
  async createOrderService(
    order: CreateOrderDto,
    userID: string,
  ): Promise<MatchResult[]> {
    const {baseAssetId,quoteAssetId,side,type,price, quantity} = order;
    const priceBig = BigInt(price)
    const quantityBig = BigInt(quantity)
    try {
        const orderId = BigInt(Date.now());
        const internalOrder: InternalOrder = {
            id: orderId.toString(),
            userId: userID,
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
                side === CreateOrderSide.BUY
                    ? priceBig * quantityBig
                    : quantityBig;

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

        return this.orderMatchingEngine(internalOrder);

    } catch (error) {
        if (error instanceof WsException) {
            throw error;
        }

        throw new WsException('Unable to create order');
    }
  }
}
