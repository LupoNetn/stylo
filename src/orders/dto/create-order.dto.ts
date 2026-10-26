import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export enum CreateOrderSide {
  BUY = 'BUY',
  SELL = 'SELL',
}

export enum CreateOrderType {
  LIMIT = 'LIMIT',
  MARKET = 'MARKET',
}

const assetIdPattern = /^[A-Z0-9_-]+$/;
const positiveIntegerPattern = /^[1-9]\d*$/;

export class CreateOrderDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  @Matches(assetIdPattern, {
    message: 'baseAssetId must contain only uppercase asset characters',
  })
  baseAssetId: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  @Matches(assetIdPattern, {
    message: 'quoteAssetId must contain only uppercase asset characters',
  })
  quoteAssetId: string;

  @IsEnum(CreateOrderSide)
  side: CreateOrderSide;

  @IsEnum(CreateOrderType)
  type: CreateOrderType;

  @IsString()
  @Matches(positiveIntegerPattern, {
    message: 'price must be a positive integer string in smallest units',
  })
  price: string;

  @IsString()
  @Matches(positiveIntegerPattern, {
    message: 'quantity must be a positive integer string in smallest units',
  })
  quantity: string;
}
