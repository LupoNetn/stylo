import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SettlementModule } from '../settlement/settlement.module.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { OrdersGateway } from './orders.gateway.js';

@Module({
  imports: [AuthModule, SettlementModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersGateway],
})
export class OrdersModule {}
