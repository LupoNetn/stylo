import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class WalletsService {
  constructor(private readonly prisma: PrismaService) {}

  async getBalances(userId: string) {
    try {
      return await this.prisma.account.findMany({
        where: { userId },
        select: {
          assetId: true,
          balanceAvailable: true,
          balanceLocked: true,
          asset: {
            select: {
              id: true,
              name: true,
              precision: true,
            },
          },
        },
        orderBy: { assetId: 'asc' },
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw error;
    }
  }

  /**
   * Credits funds after a trusted deposit-provider/admin confirmation.
   * Do not expose this as an unrestricted user self-credit endpoint in production.
   */
  async creditDeposit(userId: string, assetId: string, amount: string) {
    try {
      const amountInSmallestUnits = BigInt(amount);

      return await this.prisma.$transaction(async (tx) => {
        const asset = await tx.asset.findUnique({
          where: { id: assetId },
          select: { id: true },
        });

        if (!asset) {
          throw new NotFoundException(`Asset ${assetId} does not exist`);
        }

        const account = await tx.account.findUnique({
          where: {
            userId_assetId: { userId, assetId },
          },
          select: { id: true },
        });

        if (!account) {
          throw new NotFoundException('Wallet account does not exist');
        }

        return tx.account.update({
          where: { id: account.id },
          data: {
            balanceAvailable: {
              increment: amountInSmallestUnits,
            },
          },
          select: {
            assetId: true,
            balanceAvailable: true,
            balanceLocked: true,
          },
        });
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;

      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new ConflictException('Wallet balance could not be updated');
      }

      if (error instanceof SyntaxError || error instanceof RangeError) {
        throw new BadRequestException('Invalid deposit amount');
      }

      throw error;
    }
  }
}
