# auto-friend · 自动同意好友请求

Yunzai 插件：收到好友请求时自动通过，可控、可审计。

## 功能

- **自动通过** `request.friend` 事件（延迟可配置，避免秒通过引发风控）
- **验证关键词**：只有验证信息包含指定词才通过
- **白名单模式**：只通过白名单内的 QQ
- **黑名单**：永不通过
- **防刷**：最小通过间隔 `minIntervalMs`、每日上限 `dailyLimit`
- **主人通知**：通过/拒绝都私聊通知主人（`config.other.masterQQ`）
- **欢迎语**：通过后自动给新好友发一条私信

## 配置

首次加载会在插件目录生成 `config.json`：

```json
{
  "enabled": true,
  "delayMs": 1500,
  "whitelistOnly": false,
  "whitelist": [],
  "blacklist": [],
  "answerKeyword": "",
  "minIntervalMs": 0,
  "dailyLimit": 0,
  "welcome": "",
  "notifyMaster": true
}
```

运行时状态（今日已通过数、上次通过时间）写入 `state.json`，按天自动归零。

## 主人指令

| 指令 | 说明 |
| --- | --- |
| `#自动同意好友` | 查看状态 |
| `#自动同意好友 开启` / `关闭` | 开关自动通过 |
| `#自动同意好友 白名单模式 开` / `关` | 只通过白名单 |
| `#自动同意好友 关键词 答案词` | 设置验证关键词（留空取消） |
| `#自动同意好友 欢迎语 你好` | 设置欢迎语（留空取消） |
| `#自动同意好友 通知 开` / `关` | 主人通知开关 |
| `#好友白名单 添加/删除/列表 [QQ]` | 管理白名单 |
| `#好友黑名单 添加/删除/列表 [QQ]` | 管理黑名单 |

## 注意

系统自带的 `plugins/system/friend.js` 也会在 `config.other.autoFriend: 1` 时无条件同意好友，
会绕过本插件的黑名单/关键词限制，因此已把 `autoFriend` 置为 `0`，由本插件接管。
