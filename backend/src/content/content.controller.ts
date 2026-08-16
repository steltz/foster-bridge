import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ContentService } from './content.service';

@Controller()
export class ContentController {
  constructor(private readonly content: ContentService) {}

  private requireContent(body: { content?: string }): string {
    if (typeof body?.content !== 'string' || !body.content.length) throw new BadRequestException('body.content (string) is required');
    return body.content;
  }

  @Post('traders')
  createTrader(@Body() body: { content?: string }) {
    return this.content.createTrader(this.requireContent(body));
  }

  @Get('traders')
  listTraders() {
    return this.content.listTraders();
  }

  @Post('features')
  createFeature(@Body() body: { content?: string }) {
    return this.content.createFeature(this.requireContent(body));
  }

  @Get('features')
  listFeatures() {
    return this.content.listFeatures();
  }

  @Put('knowledge/general/:name')
  @HttpCode(200)
  putGeneral(@Param('name') name: string, @Body() body: { content?: string }) {
    return this.content.putGeneral(name, this.requireContent(body));
  }

  @Get('knowledge/general')
  listGeneral() {
    return this.content.listGeneral();
  }

  @Put('knowledge/methods')
  @HttpCode(200)
  putMethods(@Body() body: { content?: string }) {
    return this.content.putMethods(this.requireContent(body));
  }
}
