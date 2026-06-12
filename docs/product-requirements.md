# KIVO Product Requirements

唯一真相源在飞书，本地不保留 spec 详情。

## 飞书文档

- **Token**: QnwVdpEfmoLGbuxtvFmcgScanBd
- **读取命令**: `lark-cli docs +fetch --doc QnwVdpEfmoLGbuxtvFmcgScanBd --as bot`
- **在线地址**: https://www.feishu.cn/docx/QnwVdpEfmoLGbuxtvFmcgScanBd

## 子 Agent 操作规范

- 读 spec：`lark-cli docs +fetch --doc QnwVdpEfmoLGbuxtvFmcgScanBd --as bot`
- 改 spec：`lark-cli docs +update --doc QnwVdpEfmoLGbuxtvFmcgScanBd --mode overwrite --markdown "$(cat file.md)" --as bot`
- 禁止在本地写 spec 内容然后"同步"到飞书
