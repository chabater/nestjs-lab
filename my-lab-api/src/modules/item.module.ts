import { Module } from '@nestjs/common';
import { ItemsController } from '../controllers/item.controller';

@Module({
  controllers: [ItemsController],
})
export class ItemsModule {}