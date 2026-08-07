import { Controller, Get, Post, Patch, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from './jwt.guard';
import { CreateOrderDto } from './dto';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  @Get()
  findAll() { return []; }

  @Get(':id')
  findOne() { return {}; }

  @Post()
  create(@Body() dto: CreateOrderDto) { return dto; }

  @Patch(':id')
  @UseGuards(AdminGuard)
  update() { return {}; }
}
