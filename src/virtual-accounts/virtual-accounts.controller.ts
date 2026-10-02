import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Request } from 'express';
import { ApiKeyGuard } from '../common/api-key.guard';
import { ValidationError } from '../common/errors';
import { OWNER_TYPES, OwnerType } from '../ledger/chart-of-accounts';
import { VirtualAccountsService } from './virtual-accounts.service';
import { verifyWebhook } from './webhook-signature';

export class AllocateVirtualAccountDto {
  @IsIn(OWNER_TYPES)
  ownerType: OwnerType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  ownerId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  displayName: string;
}

export class InflowNotificationDto {
  @Matches(/^\d{30}$/)
  sessionId: string;

  @Matches(/^\d{10}$/)
  accountNumber: string;

  @IsString()
  @Matches(/^[\d,]+(\.\d{1,2})?$/)
  amount: string;

  @IsOptional() @IsString() @MaxLength(100) originatorAccountName?: string;
  @IsOptional() @IsString() @MaxLength(100) originatorBank?: string;
  @IsOptional() @IsString() @MaxLength(200) narration?: string;
  @IsOptional() @IsString() transactionDate?: string;
}

const view = (va: any) => ({
  id: va.id,
  ownerType: va.owner_type,
  ownerId: va.owner_id,
  accountNumber: va.account_number,
  bankNipCode: va.bank_nip_code,
  accountName: va.account_name,
});

@Controller('virtual-accounts')
@UseGuards(ApiKeyGuard)
export class VirtualAccountsController {
  constructor(private readonly service: VirtualAccountsService) {}

  @Post()
  async allocate(@Body() dto: AllocateVirtualAccountDto) {
    return view(await this.service.allocate(dto.ownerType, dto.ownerId, dto.displayName));
  }

  @Get(':ownerType/:ownerId')
  async get(@Param('ownerType') ownerType: string, @Param('ownerId') ownerId: string) {
    if (!OWNER_TYPES.includes(ownerType as OwnerType)) throw new ValidationError('Unknown owner type');
    return view(await this.service.getOrThrow(ownerType as OwnerType, ownerId));
  }
}

@Controller('webhooks/bank')
export class BankWebhookController {
  constructor(
    private readonly service: VirtualAccountsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Always 200 for an authentic notification, including duplicates — a
   * non-2xx makes the bank retry, which is exactly what a duplicate doesn't need.
   */
  @Post('inflow')
  @HttpCode(200)
  async inflow(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-bank-signature') signature: string,
    @Body() dto: InflowNotificationDto,
  ) {
    const secret = this.config.get<string>('BANK_WEBHOOK_SECRET', 'change-me');
    if (!verifyWebhook(req.rawBody, signature, secret)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    return this.service.handleInflow(dto);
  }
}
