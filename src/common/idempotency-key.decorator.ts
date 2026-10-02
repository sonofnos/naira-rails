import { BadRequestException, ExecutionContext, createParamDecorator } from '@nestjs/common';

/**
 * Required `Idempotency-Key` header for client-initiated money movement.
 * The key is stored in a UNIQUE column of the domain table it creates; this
 * decorator only validates its shape.
 */
export const IdempotencyKey = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const value = ctx.switchToHttp().getRequest().headers['idempotency-key'];
  if (typeof value !== 'string' || !/^[A-Za-z0-9_\-:.]{8,128}$/.test(value)) {
    throw new BadRequestException('Idempotency-Key header is required (8-128 chars of [A-Za-z0-9_-:.])');
  }
  return value;
});
