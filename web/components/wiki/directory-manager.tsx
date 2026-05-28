'use client';

import type { DragEvent, KeyboardEvent } from 'react';
import { useState } from 'react';
import {
  ChevronRight,
  FileText,
  FolderOpen,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface WikiTreeNode {
  id: string;
  title: string;
  type: 'space' | 'directory' | 'page';
  summary: string;
  parentId?: string | null;
  children: WikiTreeNode[];
}

interface DirectoryManagerProps {
  tree?: WikiTreeNode;
  spaceId: string;
  selectedDirectoryId: string | null;
  selectedPageId: string | null;
  onSelectDirectory: (directoryId: string) => void;
  onSelectPage: (pageId: string) => void;
  onCreateDirectory: (parentId: string, parentTitle: string) => void;
  onRenameDirectory: (node: WikiTreeNode) => void;
  onDeleteDirectory: (node: WikiTreeNode) => void;
  onMoveNode: (nodeId: string, newParentId: string, sortOrder?: number) => Promise<void>;
  onRestoreToRoot: (rawNode: string) => Promise<void>;
  showMessage: (message: string) => void;
}

function maxDirectoryDepth(node: WikiTreeNode): number {
  if (node.type !== 'directory') return 0;
  return 1 + Math.max(0, ...node.children.filter((child) => child.type === 'directory').map(maxDirectoryDepth));
}

function targetDirectoryDepth(tree: WikiTreeNode | undefined, parentId: string): number {
  if (!tree || parentId === tree.id) return 0;
  let found: number | null = null;
  const visit = (node: WikiTreeNode, depth: number) => {
    if (node.id === parentId) {
      found = depth;
      return;
    }
    node.children.filter((child) => child.type === 'directory').forEach((child) => visit(child, depth + 1));
  };
  visit(tree, 0);
  return found ?? 0;
}

function isDescendant(candidateParentId: string, movingNode: WikiTreeNode): boolean {
  if (candidateParentId === movingNode.id) return true;
  return movingNode.children.some((child) => isDescendant(candidateParentId, child));
}

function ContextMenu({
  x,
  y,
  onClose,
  onCreate,
  onRename,
  onDelete,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onCreate: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <button type="button" aria-label="关闭菜单" className="fixed inset-0 z-40 cursor-default bg-transparent" onClick={onClose} />
      <div className="fixed z-50 min-w-44 rounded-xl border border-slate-200 bg-white p-1 shadow-lg" style={{ left: x, top: y }}>
        <button type="button" onClick={() => { onCreate(); onClose(); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
          <Plus className="h-4 w-4" />新建子目录
        </button>
        <button type="button" onClick={() => { onRename(); onClose(); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
          <Pencil className="h-4 w-4" />重命名
        </button>
        <button type="button" onClick={() => { onDelete(); onClose(); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-600 hover:bg-red-50">
          <Trash2 className="h-4 w-4" />删除
        </button>
      </div>
    </>
  );
}

function visibleDirectoryChildren(node: WikiTreeNode) {
  return node.children.filter((child) => child.type === 'directory');
}

function TreeItem({
  tree,
  node,
  depth,
  sortOrder,
  spaceId,
  selectedDirectoryId,
  selectedPageId,
  onSelectDirectory,
  onSelectPage,
  onCreateDirectory,
  onRenameDirectory,
  onDeleteDirectory,
  onMoveNode,
  showMessage,
}: {
  tree?: WikiTreeNode;
  node: WikiTreeNode;
  depth: number;
  sortOrder: number;
  spaceId: string;
  selectedDirectoryId: string | null;
  selectedPageId: string | null;
  onSelectDirectory: (directoryId: string) => void;
  onSelectPage: (pageId: string) => void;
  onCreateDirectory: (parentId: string, parentTitle: string) => void;
  onRenameDirectory: (node: WikiTreeNode) => void;
  onDeleteDirectory: (node: WikiTreeNode) => void;
  onMoveNode: (nodeId: string, newParentId: string, sortOrder?: number) => Promise<void>;
  showMessage: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const isPage = node.type === 'page';
  const isSelected = isPage ? node.id === selectedPageId : node.id === selectedDirectoryId;
  const directoryChildren = visibleDirectoryChildren(node);
  const hasChildren = directoryChildren.length > 0;

  const readDragNode = (raw: string): WikiTreeNode | null => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as WikiTreeNode;
    } catch {
      return null;
    }
  };

  const canDrop = (movingNode: WikiTreeNode, targetParentId: string) => {
    if (movingNode.type !== 'directory') return true;
    if (isDescendant(targetParentId, movingNode)) return false;
    const targetDepth = targetDirectoryDepth(tree, targetParentId);
    return targetDepth + maxDirectoryDepth(movingNode) <= 3;
  };

  const handleDrop = async (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(false);
    const movingNode = readDragNode(event.dataTransfer.getData('application/json'));
    if (!movingNode || movingNode.id === node.id) return;
    const newParentId = isPage ? (node.parentId || spaceId) : node.id;
    if (!canDrop(movingNode, newParentId)) {
      showMessage('最多只能嵌套 3 层，不能移动到这里');
      return;
    }
    await onMoveNode(movingNode.id, newParentId, isPage ? sortOrder : undefined);
  };

  return (
    <div>
      {menu && !isPage && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onCreate={() => onCreateDirectory(node.id, node.title)}
          onRename={() => onRenameDirectory(node)}
          onDelete={() => onDeleteDirectory(node)}
        />
      )}
      <div
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData('application/json', JSON.stringify(node));
          event.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => void handleDrop(event)}
        onContextMenu={(event) => {
          if (isPage) return;
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
        className={`group rounded-xl border ${dragOver ? 'border-sky-300 bg-sky-50' : 'border-transparent'} transition-colors`}
      >
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            if (isPage) {
              onSelectPage(node.id);
              return;
            }
            onSelectDirectory(node.id);
            setExpanded((value) => !value);
          }}
          onDoubleClick={() => !isPage && onRenameDirectory(node)}
          onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              if (isPage) onSelectPage(node.id);
              else {
                onSelectDirectory(node.id);
                setExpanded((value) => !value);
              }
            }
          }}
          className={`flex items-center gap-2 rounded-xl px-2 py-2 text-sm ${isSelected ? 'bg-sky-100 text-slate-950' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'}`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          <GripVertical className="h-3.5 w-3.5 shrink-0 text-slate-300 opacity-0 group-hover:opacity-100" />
          {!isPage ? (
            <>
              {hasChildren ? <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} /> : <span className="w-3.5" />}
              <FolderOpen className="h-4 w-4 shrink-0 text-sky-600" />
            </>
          ) : (
            <>
              <span className="w-3.5" />
              <FileText className="h-4 w-4 shrink-0 text-slate-400" />
            </>
          )}
          <span className="min-w-0 flex-1 truncate">{node.title}</span>
          {!isPage && (
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100" onClick={(event) => {
              event.stopPropagation();
              setMenu({ x: event.clientX, y: event.clientY });
            }}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      {!isPage && expanded && hasChildren && (
        <div className="mt-1 space-y-1">
          {directoryChildren.map((child, index) => (
            <TreeItem
              key={child.id}
              tree={tree}
              node={child}
              depth={depth + 1}
              sortOrder={index}
              spaceId={spaceId}
              selectedDirectoryId={selectedDirectoryId}
              selectedPageId={selectedPageId}
              onSelectDirectory={onSelectDirectory}
              onSelectPage={onSelectPage}
              onCreateDirectory={onCreateDirectory}
              onRenameDirectory={onRenameDirectory}
              onDeleteDirectory={onDeleteDirectory}
              onMoveNode={onMoveNode}
              showMessage={showMessage}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function DirectoryManager(props: DirectoryManagerProps) {
  const { tree, spaceId, selectedDirectoryId, onRestoreToRoot, selectedPageId } = props;
  const directoryChildren = tree ? visibleDirectoryChildren(tree) : [];

  return (
    <div className="space-y-3">
      <div
        onClick={() => props.onSelectDirectory(spaceId)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => void onRestoreToRoot(event.dataTransfer.getData('application/json'))}
        className={`rounded-2xl border border-dashed px-3 py-3 text-sm ${selectedDirectoryId === spaceId ? 'border-sky-300 bg-sky-50 text-slate-950' : 'border-slate-200 text-slate-500'}`}
      >
        根目录
        <div className="mt-1 text-xs text-slate-500">拖拽条目或目录到这里可回到空间根层级。</div>
      </div>

      {directoryChildren.length > 0 ? (
        <div className="space-y-1">
          {directoryChildren.map((node, index) => (
            <TreeItem
              key={node.id}
              tree={tree}
              node={node}
              depth={0}
              sortOrder={index}
              spaceId={spaceId}
              selectedDirectoryId={selectedDirectoryId}
              selectedPageId={selectedPageId}
              onSelectDirectory={props.onSelectDirectory}
              onSelectPage={props.onSelectPage}
              onCreateDirectory={props.onCreateDirectory}
              onRenameDirectory={props.onRenameDirectory}
              onDeleteDirectory={props.onDeleteDirectory}
              onMoveNode={props.onMoveNode}
              showMessage={props.showMessage}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">
          上传材料后会自动建分类，无需手工整理。
          <div className="mt-1 text-xs text-slate-400">也可点右上「新建目录」手动创建。</div>
        </div>
      )}
    </div>
  );
}
