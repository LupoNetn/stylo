import { ConflictException, HttpException, Injectable } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { CreateUserDto } from './dto/create-user.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import bcrypt from 'bcryptjs';
import { Prisma } from '../generated/prisma/client.js';
import { LoginDto } from './dto/login.dto.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(dto: LoginDto) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });
      const validPassword = user
        ? await bcrypt.compare(dto.password, user.passwordHash)
        : false;

      if (!user || !validPassword) {
        throw new UnauthorizedException('Invalid email or password');
      }

      return this.issueTokens(user);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw error;
    }
  }

  async getMe(userId: string) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          email: true,
          createdAt: true,
        },
      });

      if (!user) {
        throw new UnauthorizedException('User session is no longer valid');
      }

      return user;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new UnauthorizedException('Unable to resolve user session');
    }
  }

  async refresh(refreshToken: string | undefined) {
    try {
      if (!refreshToken) {
        throw new UnauthorizedException('Refresh token is required');
      }

      const payload = await this.jwt.verifyAsync<{
        sub?: string;
        tokenType?: string;
      }>(refreshToken);

      if (payload.tokenType !== 'refresh' || typeof payload.sub !== 'string') {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
      });

      if (!user?.refreshTokenHash) {
        throw new UnauthorizedException('Refresh session is invalid');
      }

      const matches = await bcrypt.compare(refreshToken, user.refreshTokenHash);
      if (!matches) {
        throw new UnauthorizedException('Refresh session is invalid');
      }

      return this.issueTokens(user);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new UnauthorizedException('Refresh session is invalid');
    }
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;

    try {
      const payload = await this.jwt.verifyAsync<{ sub?: string }>(refreshToken);
      if (typeof payload.sub === 'string') {
        await this.prisma.user.updateMany({
          where: { id: payload.sub },
          data: { refreshTokenHash: null },
        });
      }
    } catch {
      // Logout is idempotent: clear the cookies even if the token is expired.
    }
  }

  private async issueTokens(user: {
    id: string;
    name: string;
    email: string;
    createdAt: Date;
  }) {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email: user.email, tokenType: 'access' },
      { expiresIn: '15m' },
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, tokenType: 'refresh' },
      { expiresIn: '7d' },
    );

    await this.prisma.user.update({
      where: { id: user.id },
      data: { refreshTokenHash: await bcrypt.hash(refreshToken, 12) },
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        createdAt: user.createdAt,
      },
    };
  }

  async createUser(req: CreateUserDto) {
    const { email, name, password } = req;
    try {
      const hashedPassword = await bcrypt.hash(password, 10);

      return await this.prisma.$transaction(async (tx) => {
        const existingUser = await tx.user.findUnique({
          where: { email },
          select: { id: true },
        });

        if (existingUser) {
          throw new ConflictException('A user with this email already exists');
        }

        const user = await tx.user.create({
          data: {
            email,
            name,
            passwordHash: hashedPassword,
          },
          select: {
            id: true,
            name: true,
            email: true,
            createdAt: true,
          },
        });

        const assets = await tx.asset.findMany({
          select: { id: true },
        });

        await tx.account.createMany({
          data: assets.map((asset) => ({
            userId: user.id,
            assetId: asset.id,
            balanceAvailable: 0n,
            balanceLocked: 0n,
          })),
        });

        return user;
      });
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('A user with this email already exists');
      }

      throw error;
    }
  }
}
