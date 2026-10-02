import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { IsString, Matches, MaxLength } from 'class-validator';
import { Response } from 'express';
import { ApiKeyGuard } from '../common/api-key.guard';
import { LedgerModule } from '../ledger/ledger.module';
import { PayoutsModule } from '../payouts/payouts.module';
import { ReconciliationService } from './reconciliation.service';

export class ReconRunDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) businessDate: string;
  @IsString() @MaxLength(5_000_000) csv: string;
}

@Controller('reconciliation/runs')
@UseGuards(ApiKeyGuard)
export class ReconciliationController {
  constructor(private readonly service: ReconciliationService) {}

  @Post()
  async run(@Body() dto: ReconRunDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.service.run(dto.businessDate, dto.csv);
    res.status(result.replayed ? 200 : 201);
    return result;
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }
}

@Module({
  imports: [LedgerModule, PayoutsModule],
  providers: [ReconciliationService],
  controllers: [ReconciliationController],
})
export class ReconciliationModule {}
