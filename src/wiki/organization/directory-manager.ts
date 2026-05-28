/**
 * FR-2 AC-2.1, AC-2.7
 * Directory tree creation, move, delete, and inspection utilities.
 */

import type { CreateDirectoryInput, WikiEntryRecord, WikiTreeNode } from '../types.js';
import { WikiRepository } from '../db/wiki-repository.js';

export class DirectoryManager {
  constructor(private readonly repository: WikiRepository) {}

  createDirectory(input: CreateDirectoryInput): WikiEntryRecord {
    return this.repository.createDirectory(input);
  }

  moveNode(nodeId: string, newParentId: string, sortOrder?: number): WikiEntryRecord {
    return this.repository.moveNode(nodeId, newParentId, sortOrder);
  }

  deleteNode(nodeId: string): WikiEntryRecord {
    return this.repository.softDeleteNode(nodeId);
  }

  restoreNode(nodeId: string): WikiEntryRecord {
    return this.repository.restoreNode(nodeId);
  }

  getTree(spaceId: string): WikiTreeNode {
    return this.repository.getSpaceTree(spaceId);
  }

  listChildren(parentId: string): WikiEntryRecord[] {
    return this.repository.listChildren(parentId);
  }
}
