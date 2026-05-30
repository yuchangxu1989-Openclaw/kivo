# KIVO Spec 真相源

飞书文档（唯一真相源）：https://www.feishu.cn/docx/QnwVdpEfmoLGbuxtvFmcgScanBd
文档 Token：QnwVdpEfmoLGbuxtvFmcgScanBd

## KIVO 交互设计文档真相源

飞书文档（唯一真相源）：https://www.feishu.cn/docx/AoBfdivUsoZR5axfkA6cl4FmnUd
文档 Token：AoBfdivUsoZR5axfkA6cl4FmnUd

本地 git 备份：`projects/kivo/docs/interaction-design.md`

同步规则：
- 改交互设计前必须 `lark-cli docs +fetch --doc AoBfdivUsoZR5axfkA6cl4FmnUd --as bot` 拉飞书最新
- 改完覆盖本地 md，再 `lark-cli docs +update --doc AoBfdivUsoZR5axfkA6cl4FmnUd --mode overwrite --markdown "$(cat /root/.openclaw/workspace/projects/kivo/docs/interaction-design.md)" --as bot` 推回飞书
- 用户只看飞书，本地 md 只是 git 备份
- 禁止为 KIVO interaction design 新建其他飞书文档作为真相源

本地 git 备份：`projects/kivo/docs/product-requirements.md`

同步规则：
- 改 spec 前必须 `lark-cli docs +fetch --doc QnwVdpEfmoLGbuxtvFmcgScanBd --as bot` 拉飞书最新
- 改完覆盖本地 md，再 `lark-cli docs +update --doc QnwVdpEfmoLGbuxtvFmcgScanBd --mode overwrite --markdown "$(cat /root/.openclaw/workspace/projects/kivo/docs/product-requirements.md)" --as bot` 推回飞书
- 用户只看飞书，本地 md 只是 git 备份
- 禁止为 KIVO spec 新建其他飞书文档作为真相源
