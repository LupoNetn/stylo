import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/guards/jwt-cookie.guard.js';
import { JwtCookieGuard } from '../auth/guards/jwt-cookie.guard.js';
import { DepositDto } from './dto/deposit.dto.js';
import { WalletsService } from './wallets.service.js';

@Controller('wallets')
@UseGuards(JwtCookieGuard)
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Get()
  getBalances(@Req() request: AuthenticatedRequest) {
    return this.walletsService.getBalances(request.user!.sub);
  }

  // Internal/provider callback placeholder; never allow arbitrary user self-credit in production.
  @Post(':assetId/deposit')
  creditDeposit(
    @Req() request: AuthenticatedRequest,
    @Param('assetId') assetId: string,
    @Body() dto: DepositDto, 
  ) {
    return this.walletsService.creditDeposit(
      request.user!.sub,
      assetId,
      dto.amount,
    );
  }
}
