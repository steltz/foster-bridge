import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Bucket, File } from '@google-cloud/storage';
import { STORAGE_BUCKET } from '../firebase/firebase.constants';
import {
  dayTime,
  ES_STORAGE_PREFIX,
  manifestPath,
  parseMmddyyyy,
} from './eminiplayer-validation';

export interface PruneOptions {
  from?: string; // MMDDYYYY inclusive
  to?: string; // MMDDYYYY inclusive
  /** false (default) reports what WOULD be deleted and touches nothing. */
  apply?: boolean;
}

export interface PrunedDay {
  date: string;
  files: string[];
}

export interface PruneReport {
  apply: boolean;
  daysScanned: number;
  prunedDays: PrunedDay[];
  deleted: number;
}

/**
 * Sweeps artifacts belonging to days that were never committed — the residue
 * of a run that died between its first upload and its manifest commit, which
 * in-run cleanup could not remove (a killed process runs no catch block).
 *
 * The manifest is the trust boundary, so the rule is exactly one line: a day
 * folder with no manifest.json owns nothing worth keeping. A committed day is
 * never touched, whatever its contents — reconciling a manifested day against
 * its manifest is the auditor's job, not this one's.
 *
 * Dry-run by default: destructive work needs the caller to say `apply` out
 * loud, after reading the report.
 */
@Injectable()
export class EminiplayerPruneService {
  private readonly logger = new Logger(EminiplayerPruneService.name);

  constructor(@Inject(STORAGE_BUCKET) private readonly bucket: Bucket) {}

  async prune(opts: PruneOptions = {}): Promise<PruneReport> {
    const apply = opts.apply ?? false;
    // The range is caller input — a malformed from/to throws rather than
    // silently widening the sweep to the whole corpus.
    const fromT = opts.from ? parseMmddyyyy(opts.from).getTime() : -Infinity;
    const toT = opts.to ? parseMmddyyyy(opts.to).getTime() : Infinity;

    const [files] = await this.bucket.getFiles({ prefix: ES_STORAGE_PREFIX });
    const dayRegex = new RegExp(`^${ES_STORAGE_PREFIX}(\\d{8})/`);
    const byDay = new Map<string, File[]>();
    for (const f of files) {
      const m = dayRegex.exec(f.name);
      if (!m) continue;
      // A folder that isn't a real calendar date has no position on the
      // calendar and so no defensible range membership. The audit reports it;
      // deleting from it on a range sweep would be acting on a name we cannot
      // interpret.
      const t = dayTime(m[1]);
      if (t === null || t < fromT || t > toT) continue;
      if (!byDay.has(m[1])) byDay.set(m[1], []);
      byDay.get(m[1])!.push(f);
    }

    const prunedDays: PrunedDay[] = [];
    let deleted = 0;
    for (const [date, dayFiles] of [...byDay.entries()].sort()) {
      if (dayFiles.some((f) => f.name === manifestPath(date))) continue; // committed
      // Directory placeholder objects ('.../03052026/') are not artifacts.
      const artifacts = dayFiles.filter((f) => f.name !== `${ES_STORAGE_PREFIX}${date}/`);
      if (artifacts.length === 0) continue;

      prunedDays.push({ date, files: artifacts.map((f) => f.name).sort() });
      if (!apply) continue;
      for (const f of artifacts) {
        await f.delete({ ignoreNotFound: true });
        deleted += 1;
      }
      this.logger.warn(`pruned ${artifacts.length} orphaned artifact(s) from ${date}`);
    }

    return { apply, daysScanned: byDay.size, prunedDays, deleted };
  }
}
