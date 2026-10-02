import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsPositive, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { Response } from 'express';
import { ApiKeyGuard } from '../common/api-key.guard';
import { IdempotencyKey } from '../common/idempotency-key.decorator';
import { LedgerModule } from '../ledger/ledger.module';
import { CARD_PROCESSOR, FakeCardProcessor } from './card-processor';
import { CardsService, cardView, chargeView } from './cards.service';

export class TokenizeCardDto {
  @IsString() @IsNotEmpty() @MaxLength(64) customerId: string;
  @Matches(/^[\d\s-]{12,23}$/) pan: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(12) expMonth: number;
  @Type(() => Number) @IsInt() @Min(0) @Max(2100) expYear: number;
  @Matches(/^\d{3,4}$/) cvv: string;
}

export class ChargeCardDto {
  @IsString() @IsNotEmpty() @MaxLength(64) customerId: string;
  @IsUUID() cardId: string;
  @Type(() => Number) @IsInt() @IsPositive() amountMinor: number;
}

export class OtpDto {
  @Matches(/^\d{4,8}$/) otp: string;
}

@Controller('cards')
@UseGuards(ApiKeyGuard)
export class CardsController {
  constructor(private readonly cards: CardsService) {}

  @Post()
  async tokenize(@Body() dto: TokenizeCardDto) {
    return cardView(await this.cards.tokenize(dto.customerId, dto.pan, dto.expMonth, dto.expYear, dto.cvv));
  }

  @Post('charges')
  async charge(@IdempotencyKey() key: string, @Body() dto: ChargeCardDto, @Res({ passthrough: true }) res: Response) {
    const { charge, replayed } = await this.cards.charge(key, dto.customerId, dto.cardId, BigInt(dto.amountMinor));
    res.status(replayed ? 200 : 201);
    return { ...chargeView(charge), replayed };
  }

  @Post('charges/:id/otp')
  @HttpCode(200)
  async otp(@Param('id', ParseUUIDPipe) id: string, @Body() dto: OtpDto) {
    return chargeView(await this.cards.submitOtp(id, dto.otp));
  }

  @Get('charges/:id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return chargeView(await this.cards.getOrThrow(id));
  }
}

@Module({
  imports: [LedgerModule],
  providers: [CardsService, { provide: CARD_PROCESSOR, useClass: FakeCardProcessor }],
  controllers: [CardsController],
})
export class CardsModule {}
