import { IsString, Matches } from 'class-validator';

export class DepositDto {
  @IsString()
  @Matches(/^[1-9]\d*$/, {
    message: 'amount must be a positive integer string in smallest asset units',
  })
  amount: string;
}
