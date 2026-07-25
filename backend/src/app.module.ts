import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { FirebaseModule } from './firebase/firebase.module';
import { HealthController } from './health/health.controller';
import { FirestoreDemoController } from './demo/firestore-demo.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    FirebaseModule,
  ],
  controllers: [HealthController, FirestoreDemoController],
})
export class AppModule {}
