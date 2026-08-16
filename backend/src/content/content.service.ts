import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { FIRESTORE, STORAGE_BUCKET } from '../firebase/firebase.constants';
import { parseFrontmatter } from '../common/markdown-frontmatter';
import {
  TRADERS_COLLECTION,
  FEATURES_COLLECTION,
  GENERAL_PREFIX,
  generalDocPath,
  METHODS_PATH,
} from '../benchmark/cloud-inputs.service';

const NAME_RE = /^[A-Za-z0-9_-]+$/; // doubles as a path-traversal guard for bucket keys

interface WritableBucketLike {
  file(path: string): {
    save(content: string, opts?: object): Promise<unknown> | unknown;
    download(): Promise<[Buffer]>;
  };
  getFiles(opts: { prefix: string }): Promise<[{ name: string }[]]>;
}

@Injectable()
export class ContentService {
  constructor(
    @Inject(FIRESTORE) private readonly db: Firestore,
    @Inject(STORAGE_BUCKET) private readonly bucket: WritableBucketLike,
  ) {}

  private sha256(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  // Firestore create() is atomic write-once; ALREADY_EXISTS (gRPC code 6) maps to 409.
  private async createOnce(collection: string, id: string, data: object): Promise<void> {
    try {
      await this.db.collection(collection).doc(id).create(data);
    } catch (err) {
      if ((err as { code?: number }).code === 6) {
        throw new ConflictException(
          `${collection}/${id} already exists — content is write-once; create a new ${collection === TRADERS_COLLECTION ? 'persona' : 'feature'} instead`,
        );
      }
      throw err;
    }
  }

  /**
   * Lineage (origin/mutation) is OPTIONAL: a root persona — the head of a
   * family tree — legitimately has neither. Only `name` is required.
   */
  async createTrader(content: string): Promise<{ name: string; sha256: string }> {
    const fm = parseFrontmatter(content);
    if (!fm.name) throw new BadRequestException('persona frontmatter must declare: name');
    if (!NAME_RE.test(fm.name)) throw new BadRequestException(`invalid persona name: ${fm.name}`);
    const sha256 = this.sha256(content);
    await this.createOnce(TRADERS_COLLECTION, fm.name, { name: fm.name, content, sha256, createdAt: new Date().toISOString() });
    return { name: fm.name, sha256 };
  }

  async createFeature(content: string): Promise<{ id: string; sha256: string }> {
    const fm = parseFrontmatter(content);
    if (!fm.id) throw new BadRequestException('feature frontmatter must declare: id');
    if (!NAME_RE.test(fm.id)) throw new BadRequestException(`invalid feature id: ${fm.id}`);
    const sha256 = this.sha256(content);
    await this.createOnce(FEATURES_COLLECTION, fm.id, { id: fm.id, content, sha256, createdAt: new Date().toISOString() });
    return { id: fm.id, sha256 };
  }

  async putGeneral(name: string, content: string): Promise<{ path: string; sha256: string }> {
    if (!NAME_RE.test(name)) throw new BadRequestException(`invalid general-doc name: ${name}`);
    const path = generalDocPath(name);
    await this.bucket.file(path).save(content, { contentType: 'text/markdown' });
    return { path, sha256: this.sha256(content) };
  }

  async putMethods(content: string): Promise<{ path: string; sha256: string }> {
    await this.bucket.file(METHODS_PATH).save(content, { contentType: 'text/markdown' });
    return { path: METHODS_PATH, sha256: this.sha256(content) };
  }

  async listTraders(): Promise<{ name: string; origin: string | null; mutation: string | null; sha256: string }[]> {
    const snap = await this.db.collection(TRADERS_COLLECTION).get();
    return snap.docs
      .map((d) => d.data() as { name: string; content: string })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((doc) => {
        const fm = parseFrontmatter(doc.content);
        return { name: doc.name, origin: fm.origin || null, mutation: fm.mutation || null, sha256: this.sha256(doc.content) };
      });
  }

  async listFeatures(): Promise<{ id: string; name: string; sha256: string }[]> {
    const snap = await this.db.collection(FEATURES_COLLECTION).get();
    return snap.docs
      .map((d) => d.data() as { id: string; content: string })
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((doc) => ({ id: doc.id, name: parseFrontmatter(doc.content).name || doc.id, sha256: this.sha256(doc.content) }));
  }

  async listGeneral(): Promise<{ path: string; sha256: string }[]> {
    const [objects] = await this.bucket.getFiles({ prefix: GENERAL_PREFIX });
    // Skip directory-placeholder objects, same as CloudInputsService.collectGeneralDocs.
    const paths = objects
      .map((o) => o.name)
      .filter((n) => !n.endsWith('/'))
      .sort();
    return Promise.all(
      paths.map(async (path) => {
        const [buf] = await this.bucket.file(path).download();
        return { path, sha256: this.sha256(buf.toString('utf8')) };
      }),
    );
  }
}
