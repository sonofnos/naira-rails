import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Response } from 'express';
import { DomainError } from './errors';
import { redactPans } from './redact';

/**
 * Maps domain errors to HTTP and makes sure nothing card-shaped leaks into
 * logs or responses: messages are PAN-redacted, request bodies are never
 * echoed, and unexpected errors return a generic 500.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof DomainError) {
      res.status(exception.status).json({ error: exception.code, message: redactPans(exception.message) });
      return;
    }
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const message = typeof body === 'string' ? body : (body as any).message;
      res.status(exception.getStatus()).json({
        error: 'http_error',
        message: Array.isArray(message) ? message.map((m) => redactPans(String(m))) : redactPans(String(message)),
      });
      return;
    }
    const err = exception as Error;
    this.logger.error(redactPans(`${err?.name}: ${err?.message}`), redactPans(err?.stack ?? ''));
    res.status(500).json({ error: 'internal_error', message: 'Internal server error' });
  }
}
