import { Controller, Get, Module, Param, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NIGERIAN_BANKS } from '../banks/nigerian-banks';
import { ApiKeyGuard } from '../common/api-key.guard';
import { NIP_CLIENT } from './nip-client';
import { NameEnquiryService, maskAccountName } from './name-enquiry.service';
import { NipSimulatorClient } from './nip-simulator.client';

@Controller('banks')
@UseGuards(ApiKeyGuard)
export class BanksController {
  constructor(private readonly names: NameEnquiryService) {}

  @Get()
  list() {
    return NIGERIAN_BANKS;
  }

  /** Customer-facing account resolution: masked name only. */
  @Get(':bankCode/accounts/:accountNumber')
  async resolve(@Param('bankCode') bankCode: string, @Param('accountNumber') accountNumber: string) {
    const r = await this.names.resolve(bankCode, accountNumber);
    return {
      bankNipCode: r.bankNipCode,
      bankName: r.bankName,
      accountNumber: r.accountNumber,
      accountName: maskAccountName(r.accountName),
    };
  }
}

@Module({
  providers: [
    {
      provide: NIP_CLIENT,
      inject: [ConfigService],
      // The only implementation in this repo. A real one (sponsor bank / BaaS
      // HTTP adapter) would be selected here by config.
      useFactory: (config: ConfigService) => new NipSimulatorClient(config.get('NIP_INSTITUTION_CODE', '999240')),
    },
    NameEnquiryService,
  ],
  controllers: [BanksController],
  exports: [NIP_CLIENT, NameEnquiryService],
})
export class NipModule {}
