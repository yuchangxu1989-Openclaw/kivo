/**
 * FR-2 AC-2.1, NFR-5
 * Space CRUD and default Space bootstrap.
 */

import type { CreateSpaceInput, UpdateSpaceInput, WikiEntryRecord } from '../types.js';
import { WikiRepository } from '../db/wiki-repository.js';

export class SpaceManager {
  constructor(private readonly repository: WikiRepository) {}

  ensureDefaultSpace(): WikiEntryRecord {
    const existing = this.repository.listSpaces().find((space) => space.metadata.extra?.isDefault === true);
    if (existing) {
      return existing;
    }
    return this.repository.createSpace({
      title: 'Default Space',
      summary: 'Default knowledge space for imported wiki pages.',
      description: 'System-created default space.',
      metadata: {
        extra: { isDefault: true },
      },
    });
  }

  createSpace(input: CreateSpaceInput): WikiEntryRecord {
    return this.repository.createSpace(input);
  }

  updateSpace(id: string, input: UpdateSpaceInput): WikiEntryRecord {
    return this.repository.updateSpace(id, input);
  }

  listSpaces(): WikiEntryRecord[] {
    return this.repository.listSpaces();
  }

  archiveSpace(id: string): WikiEntryRecord {
    return this.repository.updateSpace(id, { status: 'archived' });
  }
}
