# KIVO 图谱节点文字对比度修复

## 问题
知识图谱页面中，非高亮节点的文字标签 opacity 为 0.15，在深色背景上几乎不可见。

## 方案
- DIM_OPACITY 从 0.15 提升到 0.4
- 文字 label 的 opacity 使用 Math.max(DIM_OPACITY, 0.6)，确保文字始终可读

## 验收标准
- 非高亮节点的文字在深色模式下清晰可读
- 高亮节点文字保持 opacity=1 不变
