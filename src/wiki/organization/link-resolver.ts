/**
 * FR-2 AC-2.2, AC-2.7
 * Parse [[Title]] links, resolve them to pages, and maintain backlink records.
 */

import { WikiRepository } from '../db/wiki-repository.js';
import type { WikiEntryRecord, WikiLinkRecord } from '../types.js';

const LINK_PATTERN = /\[\[([^\]]+)\]\]/g;

export class LinkResolver {
  constructor(private readonly repository: WikiRepository) {}

  extractLinks(content: string): Array<{ label: string; targetTitle: string }> {
    const links: Array<{ label: string; targetTitle: string }> = [];
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = LINK_PATTERN.exec(content)) !== null) {
      const targetTitle = match[1].trim();
      if (!targetTitle) continue;
      const key = targetTitle.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ label: targetTitle, targetTitle });
    }
    return links;
  }

  syncPageLinks(pageId: string): WikiLinkRecord[] {
    const page = this.repository.findById(pageId);
    if (!page || page.type !== 'wiki_page') {
      throw new Error(`Wiki page ${pageId} not found`);
    }
    const spaceId = this.repository.getSpaceIdForNode(pageId) ?? undefined;
    const links = this.extractLinks(page.content).map((link) => {
      const target = this.repository.findPageByTitle(link.targetTitle, spaceId);
      return {
        targetPageId: target?.id ?? null,
        targetTitle: link.targetTitle,
        label: link.label,
        status: target ? 'resolved' as const : 'missing' as const,
      };
    });
    this.repository.replaceLinks(page.id, links);
    return links.map((link) => ({
      sourcePageId: page.id,
      targetPageId: link.targetPageId,
      targetTitle: link.targetTitle,
      label: link.label,
      status: link.status,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
  }

  listBacklinks(pageId: string): Array<{ sourcePage: WikiEntryRecord | null; link: WikiLinkRecord }> {
    return this.repository.listBacklinks(pageId).map((link) => ({
      sourcePage: this.repository.findById(link.sourcePageId),
      link,
    }));
  }
}
