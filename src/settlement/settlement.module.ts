import { Module } from '@nestjs/common';
import { SettlementService } from './settlement.service.js';

@Module({
  providers: [SettlementService],
  exports: [SettlementService],
})
export class SettlementModule {}

