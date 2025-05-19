import {
    Controller,
    Get,
    Post,
    Put,
    Param,
    Body,
    UseGuards
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'

@Controller('items')
@UseGuards(JwtAuthGuard)
export class ItemsController {
    private items = [{ id: 1, name: 'Item One' }];
  
    @Get()
    findAll() {
      return this.items;
    }
  
    @Post()
    create(@Body() body: { name: string }) {
      const newItem = { id: Date.now(), name: body.name };
      this.items.push(newItem);
      return newItem;
    }
  
    @Put(':id')
    update(@Param('id') id: string, @Body() body: { name: string }) {
      const item = this.items.find((item) => item.id === +id);
      if (!item) return { message: 'Item not found' };
      item.name = body.name;
      return item;
    }
}