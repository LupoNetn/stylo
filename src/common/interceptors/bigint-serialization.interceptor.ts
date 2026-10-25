import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

type JsonSafeValue =
  | null
  | boolean
  | number
  | string
  | Date
  | JsonSafeValue[]
  | { [key: string]: JsonSafeValue };

function serializeBigInts(value: unknown): JsonSafeValue {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(serializeBigInts);
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        serializeBigInts(nestedValue),
      ]),
    );
  }

  return String(value);
}

@Injectable()
export class BigIntSerializationInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map(serializeBigInts));
  }
}
