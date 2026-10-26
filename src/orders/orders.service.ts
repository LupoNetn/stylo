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

interface OrderBook {
  bids: Map<string, InternalOrder[]>;
  asks: Map<string, InternalOrder[]>;
}

@Injectable()
export class OrdersService {
  private orderBooks = new Map<string, OrderBook>();
  private activeOrdersById = new Map<string, InternalOrder>();

  private orderMatchingEngine(order: InternalOrder) {}

  constructor(private readonly prisma: PrismaService) {}
  
  async createOrderService(order: CreateOrderDto, userID: string): Promise<void> {
    const {baseAssetId,quoteAssetId,side,type,price, quantity} = order;
    const priceBig = BigInt(price)
    const quantityBig = BigInt(quantity)
    try {
        const order: InternalOrder = {
            id: crypto.randomUUID(),
            baseAssetId,
            quoteAssetId,
            side,
            type,
            price: priceBig,
            quantity: quantityBig,
        }

        //user operations from prisma
        const assetID = order.side === CreateOrderSide.BUY ? order.quoteAssetId : order.baseAssetId
        const account = await this.prisma.account.findUnique({
            where: { userId: userID, assetId: assetID},
            select: {
                assetId: true,
                balanceAvailable: true,
                balanceLocked: true,
            }
        })

        if(!account) {
            throw new WsException('this user is not authenticated')
        }

    } catch (error) {
        
    }
  }
}