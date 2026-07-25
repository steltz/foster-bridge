import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import type { Bucket } from '@google-cloud/storage';
import { STORAGE_BUCKET } from '../firebase/firebase.constants';

interface UploadDto {
  content?: string;
  name?: string;
}

const SIGNED_URL_TTL_MS = 15 * 60 * 1000;

@Controller('demo/storage')
export class StorageDemoController {
  constructor(@Inject(STORAGE_BUCKET) private readonly bucket: Bucket) {}

  @Post()
  async upload(@Body() body: UploadDto) {
    // Deterministic-ish object name; counter avoids clobbering across calls.
    const name = `demo/${body.name ?? `object-${Date.now()}.txt`}`;
    await this.bucket.file(name).save(body.content ?? 'hello from ADC', {
      contentType: 'text/plain',
    });
    return { name };
  }

  @Get()
  async list() {
    const [files] = await this.bucket.getFiles({ prefix: 'demo/' });
    return files.map((f) => f.name);
  }

  @Get(':name/url')
  async signedUrl(@Param('name') name: string) {
    const [url] = await this.bucket.file(`demo/${name}`).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + SIGNED_URL_TTL_MS,
    });
    return { url };
  }
}
