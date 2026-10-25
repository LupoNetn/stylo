import { Module } from '@nestjs/common';
import { JwtCookieGuard } from '../auth/guards/jwt-cookie.guard.js';
import { WalletsController } from './wallets.controller.js';
import { WalletsService } from './wallets.service.js';

@Module({
  controllers: [WalletsController],
  providers: [WalletsService, JwtCookieGuard],
})
export class WalletsModule {}
