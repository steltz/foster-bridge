import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import { FieldValue, Firestore } from 'firebase-admin/firestore';
import { FIRESTORE } from '../firebase/firebase.constants';

interface CreateDemoDto {
  message?: string;
}

@Controller('demo/firestore')
export class FirestoreDemoController {
  constructor(@Inject(FIRESTORE) private readonly firestore: Firestore) {}

  @Post()
  async create(@Body() body: CreateDemoDto) {
    const ref = await this.firestore.collection('demo').add({
      message: body.message ?? 'hello from ADC',
      createdAt: FieldValue.serverTimestamp(),
    });
    return { id: ref.id };
  }

  @Get()
  async list() {
    const snapshot = await this.firestore
      .collection('demo')
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }
}
