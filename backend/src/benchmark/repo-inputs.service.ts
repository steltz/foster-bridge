import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ZERO_BYTES_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface TraderInput {
  name: string;
  origin: string | null;
  mutation: string | null;
  file: string;
  content: string;
  sha256: string;
}

export interface FeatureInput {
  id: string;
  name: string;
  file: string;
  block: string;
  sha256: string;
  staticDoc: string | null; // repo-relative path
  staticDocContent: string | null;
  staticDocSha256: string | null;
}

export interface GeneralDocs {
  files: { path: string; content: string }[];
  concatenated: string;
  sha256: string;
}

export interface DayInput {
  day: string; // MMDDYYYY (folder + cell key)
  date: string; // YYYY-MM-DD
  prefix: string; // 8-digit TP filename prefix
  pdfPath: string;
  planPath: string;
  recapPath: string;
}

export interface DayIssue {
  day: string; // folder name (MMDDYYYY)
  missing: string[]; // suffixes not found (e.g. '*_ES_RECAP.md')
}

@Injectable()
export class RepoInputsService {
  constructor(private readonly config: ConfigService) {}

  private get root(): string {
    return this.config.get<string>('benchmark.repoRoot') as string;
  }

  sha256(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  // Frontmatter parser ported verbatim from src/lineage.js parseFrontmatter.
  private parseFrontmatter(text: string): Record<string, string> {
    const fm: Record<string, string> = {};
    const lines = text.split('\n');
    if (lines[0]?.trim() !== '---') return fm;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '---') break;
      const colon = line.indexOf(':');
      if (colon === -1 || /^\s/.test(line)) continue;
      fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
    return fm;
  }

  // Body after the frontmatter block; ported from src/features.js extractBlock.
  private extractBlock(text: string): string {
    const lines = text.split('\n');
    if (lines[0]?.trim() !== '---') return text.trim();
    let closeIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        closeIndex = i;
        break;
      }
    }
    if (closeIndex === -1) return text.trim();
    return lines.slice(closeIndex + 1).join('\n').trim();
  }

  collectTraders(): TraderInput[] {
    const dir = join(this.root, 'traders');
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort()
      .map((file) => {
        const content = readFileSync(join(dir, file), 'utf8');
        const fm = this.parseFrontmatter(content);
        return {
          name: fm.name || file.slice(0, -3),
          origin: fm.origin || null,
          mutation: fm.mutation || null,
          file,
          content,
          sha256: this.sha256(content),
        };
      });
  }

  collectFeatures(): FeatureInput[] {
    const dir = join(this.root, 'features');
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort()
      .map((file) => {
        const content = readFileSync(join(dir, file), 'utf8');
        const fm = this.parseFrontmatter(content);
        const id = fm.id || file.slice(0, -3);
        const staticDoc = fm.staticDoc || null;
        let staticDocContent: string | null = null;
        let staticDocSha256: string | null = null;
        if (staticDoc) {
          staticDocContent = readFileSync(join(this.root, staticDoc), 'utf8');
          staticDocSha256 = this.sha256(staticDocContent);
        }
        return {
          id,
          name: fm.name || id,
          file,
          block: this.extractBlock(content),
          sha256: this.sha256(content),
          staticDoc,
          staticDocContent,
          staticDocSha256,
        };
      });
  }

  collectGeneralDocs(): GeneralDocs {
    const dir = join(this.root, 'knowledge-base', 'general');
    if (!existsSync(dir)) {
      return { files: [], concatenated: '', sha256: ZERO_BYTES_SHA256 };
    }
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
      );
    const paths = walk(dir).sort();
    const files = paths.map((path) => ({ path, content: readFileSync(path, 'utf8') }));
    const concatenated = files.map((f) => f.content).join('');
    return {
      files,
      concatenated,
      sha256: concatenated ? this.sha256(concatenated) : ZERO_BYTES_SHA256,
    };
  }

  collectDays(): DayInput[] {
    const dir = join(this.root, 'knowledge-base', 'es');
    if (!existsSync(dir)) return [];
    const days: DayInput[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folder = join(dir, entry.name);
      const files = readdirSync(folder);
      const pdf = files.find((f) => f.endsWith('_ES_TP.pdf'));
      const plan = files.find((f) => f.endsWith('_ES_TP.md'));
      const recap = files.find((f) => f.endsWith('_ES_RECAP.md'));
      if (!pdf || !plan || !recap) continue;
      // Derive the day from the 8-digit TP prefix, not the folder name.
      const prefix = pdf.slice(0, 8);
      if (!/^\d{8}$/.test(prefix) || plan.slice(0, 8) !== prefix) continue;
      const date = `${prefix.slice(4, 8)}-${prefix.slice(0, 2)}-${prefix.slice(2, 4)}`;
      days.push({
        day: prefix,
        date,
        prefix,
        pdfPath: join(folder, pdf),
        planPath: join(folder, plan),
        recapPath: join(folder, recap),
      });
    }
    return days.sort((a, b) => a.date.localeCompare(b.date));
  }

  // Folders under knowledge-base/es/* that are NOT complete days: report which
  // of the three required docs are missing so the run summary can surface them.
  collectDayIssues(): DayIssue[] {
    const dir = join(this.root, 'knowledge-base', 'es');
    if (!existsSync(dir)) return [];
    const required: Array<{ suffix: string; label: string }> = [
      { suffix: '_ES_TP.pdf', label: '*_ES_TP.pdf' },
      { suffix: '_ES_TP.md', label: '*_ES_TP.md' },
      { suffix: '_ES_RECAP.md', label: '*_ES_RECAP.md' },
    ];
    const issues: DayIssue[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const files = readdirSync(join(dir, entry.name));
      const missing = required.filter((r) => !files.some((f) => f.endsWith(r.suffix))).map((r) => r.label);
      if (missing.length) issues.push({ day: entry.name, missing });
    }
    return issues.sort((a, b) => a.day.localeCompare(b.day));
  }

  readMethodsDoc(): string | null {
    const path = join(this.root, 'knowledge-base', 'methods', 'seven-keys.md');
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  }
}
