import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { FirebaseModule } from './firebase/firebase.module';
import { GoogleErrorFilter } from './common/google-error.filter';
import { HealthController } from './health/health.controller';
import { FirestoreDemoController } from './demo/firestore-demo.controller';
import { StorageDemoController } from './demo/storage-demo.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    FirebaseModule,
  ],
  controllers: [
    HealthController,
    FirestoreDemoController,
    StorageDemoController,
  ],
  providers: [{ provide: APP_FILTER, useClass: GoogleErrorFilter }],
})
export class AppModule {}
