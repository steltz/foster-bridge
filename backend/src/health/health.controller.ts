import { Controller, Get, Inject } from '@nestjs/common';
import type { Firestore } from 'firebase-admin/firestore';
import type { Bucket } from '@google-cloud/storage';
import { FIRESTORE, STORAGE_BUCKET } from '../firebase/firebase.constants';

type DepStatus = 'ok' | 'error';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(FIRESTORE) private readonly firestore: Firestore,
    @Inject(STORAGE_BUCKET) private readonly bucket: Bucket,
  ) {}

  @Get()
  liveness() {
    return { status: 'ok' };
  }

  @Get('ready')
  async readiness() {
    const [firestore, storage] = await Promise.all([
      this.check(() => this.firestore.listCollections()),
      this.check(() => this.bucket.exists()),
    ]);
    const dependencies = { firestore, storage };
    const status = Object.values(dependencies).every((s) => s === 'ok')
      ? 'ok'
      : 'degraded';
    return { status, dependencies };
  }

  private async check(fn: () => Promise<unknown>): Promise<DepStatus> {
    try {
      await fn();
      return 'ok';
    } catch {
      return 'error';
    }
  }
}
