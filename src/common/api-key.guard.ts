import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

/**
 * Deliberately simple service-to-service auth (the API sits behind the
 * super-app's own backend). Constant-time compare so the key can't be
 * recovered byte-by-byte from response timing.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const expected = Buffer.from(this.config.get<string>('API_KEY', 'dev-api-key'));
    const header = ctx.switchToHttp().getRequest().headers['x-api-key'];
    const given = Buffer.from(typeof header === 'string' ? header : '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new UnauthorizedException('Invalid API key');
    }
    return true;
  }
}
