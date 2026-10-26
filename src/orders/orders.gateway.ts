import {
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  ConnectedSocket,
  WsException,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import { OrdersService } from './orders.service.js';
import { CreateOrderDto } from './dto/create-order.dto.js';

type ClientConnection = {
  socket: WebSocket;
  connectionId: string;
  userId: string;
  lastPongAt: number;
  isAlive: boolean;
  subscriptions: Set<string>;
};

type AccessTokenPayload = {
  sub?: string;
  email?: string;
  tokenType?: string;
};

function readAccessTokenFromCookie(cookieHeader?: string): string | undefined {
  if (!cookieHeader) return undefined;

  const accessTokenCookie = cookieHeader
    .split(';')
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith('access_token='));

  if (!accessTokenCookie) return undefined;

  try {
    return decodeURIComponent(accessTokenCookie.slice('access_token='.length));
  } catch {
    return undefined;
  }
}

@WebSocketGateway({
  path: '/ws/orders',
})
export class OrdersGateway
  implements
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  private readonly activeConnections = new Map<string, ClientConnection>();

  private readonly connectionIdsBySocket = new WeakMap<WebSocket, string>();

  private heartbeatInterval!: NodeJS.Timeout;

  constructor(
    private readonly ordersService: OrdersService,
    private readonly jwt: JwtService,
  ) {}

  async handleConnection(
    client: WebSocket,
    request: IncomingMessage,
  ): Promise<void> {
    try {
      const token = readAccessTokenFromCookie(request.headers.cookie);

      if (!token) {
        this.rejectConnection(client, 'Authentication required');
        return;
      }

      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);

      if (payload.tokenType !== 'access' || typeof payload.sub !== 'string') {
        this.rejectConnection(client, 'Invalid access token');
        return;
      }

      const connectionId = randomUUID();
      const now = Date.now();
      const connection: ClientConnection = {
        socket: client,
        connectionId,
        userId: payload.sub,
        lastPongAt: now,
        isAlive: true,
        subscriptions: new Set(),
      };

      client.on('pong', () => {
        connection.isAlive = true;
        connection.lastPongAt = Date.now();
      });

      client.on('error', () => {
        client.terminate();
      });

      this.activeConnections.set(connectionId, connection);
      this.connectionIdsBySocket.set(client, connectionId);

      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            type: 'connected',
            connectionId,
          }),
        );
      }
    } catch {
      this.rejectConnection(client, 'Invalid or expired access token');
    }
  }

  handleDisconnect(client: WebSocket): void {
    const connectionId = this.connectionIdsBySocket.get(client);

    if (!connectionId) return;

    const connection = this.activeConnections.get(connectionId);
    connection?.subscriptions.clear();
    this.activeConnections.delete(connectionId);
    this.connectionIdsBySocket.delete(client);
  }

  onModuleInit(): void {
    this.heartbeatInterval = setInterval(() => {
      for (const [connectionId, connection] of this.activeConnections) {
        const socket = connection.socket;

        if (!connection.isAlive || socket.readyState !== WebSocket.OPEN) {
          socket.terminate();
          this.activeConnections.delete(connectionId);
          this.connectionIdsBySocket.delete(socket);
          continue;
        }

        connection.isAlive = false;
        socket.ping();
      }
    }, 30_000);
  }

  onModuleDestroy(): void {
    clearInterval(this.heartbeatInterval);

    for (const connection of this.activeConnections.values()) {
      connection.socket.terminate();
      connection.subscriptions.clear();
    }

    this.activeConnections.clear();
  }

  private rejectConnection(client: WebSocket, reason: string): void {
    if (
      client.readyState === WebSocket.OPEN ||
      client.readyState === WebSocket.CONNECTING
    ) {
      client.close(1008, reason);
    }
  }

  //Websocket Event handlers
  @SubscribeMessage('order:create')
  async handleCreateOrder(
    @MessageBody() order: CreateOrderDto,
    @ConnectedSocket() client: WebSocket,
  ) {
    const connectionId = this.connectionIdsBySocket.get(client);
    if (!connectionId) {
      throw new WsException('Connection is not authenticated');
    }

    const connection = this.activeConnections.get(connectionId);
    if (!connection) {
      throw new WsException('Connection session not found');
    }
    const newOrder = await this.ordersService.createOrderService(
      order,
      connection.userId,
    );

    client.send(JSON.stringify({ type: 'order:ack', data: newOrder }));
  }
}
