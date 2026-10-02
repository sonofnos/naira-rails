import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsPositive, IsString, Length, Matches, MaxLength } from 'class-validator';
import { Response } from 'express';
import { ApiKeyGuard } from '../common/api-key.guard';
import { IdempotencyKey } from '../common/idempotency-key.decorator';
import { OWNER_TYPES, OwnerType } from '../ledger/chart-of-accounts';
import { PayoutsService, payoutView } from './payouts.service';

export class CreatePayoutDto {
  @IsIn(OWNER_TYPES)
  ownerType: OwnerType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  ownerId: string;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  amountMinor: number;

  @Matches(/^\d{6}$/)
  bankCode: string;

  @Matches(/^\d{10}$/)
  accountNumber: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  narration?: string;
}

export class ResolvePayoutDto {
  @IsIn(['successful', 'failed'])
  outcome: 'successful' | 'failed';

  @IsString()
  @Length(3, 500)
  evidence: string;
}

@Controller('payouts')
@UseGuards(ApiKeyGuard)
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Post()
  async create(@IdempotencyKey() key: string, @Body() dto: CreatePayoutDto, @Res({ passthrough: true }) res: Response) {
    const { payout, replayed } = await this.payouts.create({
      idempotencyKey: key,
      ownerType: dto.ownerType,
      ownerId: dto.ownerId,
      amountMinor: BigInt(dto.amountMinor),
      bankNipCode: dto.bankCode,
      accountNumber: dto.accountNumber,
      narration: dto.narration,
    });
    res.status(replayed ? 200 : 201);
    return { ...payoutView(payout), replayed };
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return payoutView(await this.payouts.getOrThrow(id));
  }

  /** Ops trigger for the requery sweep (also runs on an interval when PAYOUT_SWEEP_INTERVAL_MS > 0). */
  @Post('requery')
  @HttpCode(200)
  sweep() {
    return this.payouts.sweep();
  }

  @Post(':id/resolve')
  @HttpCode(200)
  async resolve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolvePayoutDto) {
    return payoutView(await this.payouts.resolveManually(id, dto.outcome, dto.evidence));
  }
}
