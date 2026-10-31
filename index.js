import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import cfg from '../../lib/config/config.js'

/**
 * 自动同意好友请求
 *
 * - 收到 request.friend 事件后自动通过，可配置延迟、验证关键词、黑白名单、防刷
 * - 通过/拒绝都会私聊通知主人，可通过 welcome 给新好友发欢迎语
 * - 设置文件：<插件目录>/config.json（首次运行自动生成）；状态：state.json
 * - 主人指令（私聊/群聊均可，仅主人生效）：
 *     #自动同意好友                     查看状态
 *     #自动同意好友 开启 / 关闭
 *     #自动同意好友 白名单模式 开 / 关
 *     #自动同意好友 关键词 答案词
 *     #自动同意好友 欢迎语 你好
 *     #自动同意好友 通知 开 / 关
 *     #好友白名单 添加/删除/列表 [QQ]
 *     #好友黑名单 添加/删除/列表 [QQ]
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_FILE = path.join(__dirname, 'config.json')
const STATE_FILE = path.join(__dirname, 'state.json')

const DEFAULTS = {
  enabled: true,
  delayMs: 1500,
  whitelistOnly: false,
  whitelist: [],
  blacklist: [],
  answerKeyword: '',
  minIntervalMs: 0,
  dailyLimit: 0,
  welcome: '',
  notifyMaster: true
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return fallback
  }
}

/** 原子写 JSON，避免写坏配置文件。 */
function writeJson(file, data) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmp, file)
}

function loadConfig() {
  const saved = readJson(CONFIG_FILE, {})
  const config = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) }
  for (const key of ['whitelist', 'blacklist']) {
    config[key] = (Array.isArray(config[key]) ? config[key] : []).map(String)
  }
  config.delayMs = Number(config.delayMs) || 0
  config.minIntervalMs = Number(config.minIntervalMs) || 0
  config.dailyLimit = Number(config.dailyLimit) || 0
  if (!fs.existsSync(CONFIG_FILE)) writeJson(CONFIG_FILE, config)
  return config
}

function saveConfig(config) {
  writeJson(CONFIG_FILE, config)
}

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function loadState() {
  const state = readJson(STATE_FILE, {})
  if (state?.date !== today()) {
    return { date: today(), approvedToday: 0, lastApprovedAt: 0 }
  }
  return {
    date: today(),
    approvedToday: Number(state.approvedToday) || 0,
    lastApprovedAt: Number(state.lastApprovedAt) || 0
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 好友请求事件：自动通过。 */
export class AutoFriendAccept extends plugin {
  constructor() {
    super({
      name: '自动同意好友',
      dsc: '好友请求自动通过（关键词/黑白名单/防刷/通知/欢迎语）',
      event: 'request.friend',
      priority: 100
    })
  }

  /** 加载时生成默认配置并打一条日志，便于确认插件已生效。 */
  init() {
    const config = loadConfig()
    logger.mark(
      `[自动同意好友] 已加载（${config.enabled ? '开启' : '关闭'}）｜关键词：${config.answerKeyword || '不限'}｜白名单模式：${config.whitelistOnly ? '开' : '关'}`
    )
  }

  async accept() {
    const e = this.e
    const config = loadConfig()
    if (!config.enabled) return

    // 兼容不同适配器的子类型：只处理加好友本身
    if (e.sub_type && e.sub_type !== 'add' && e.sub_type !== 'single') return

    const userId = String(e.user_id ?? '')
    if (!userId) return

    const comment = String(e.comment ?? e.msg ?? e.answer ?? e.verify ?? '')
    const nickname = e.nickname ?? e.friend?.nickname ?? '未知昵称'

    const deny = async (reason) => {
      logger.mark(`[自动同意好友] 未通过 ${userId}（${reason}）`)
      await this.notify(config, `收到好友请求：${nickname}(${userId})\n验证信息：${comment || '无'}\n未自动通过：${reason}`)
    }

    if (config.blacklist.includes(userId)) return deny('在黑名单中')
    if (config.whitelistOnly && !config.whitelist.includes(userId)) return deny('不在白名单中')
    if (config.answerKeyword && !comment.includes(config.answerKeyword)) {
      return deny(`验证信息不含「${config.answerKeyword}」`)
    }

    const state = loadState()
    if (config.dailyLimit > 0 && state.approvedToday >= config.dailyLimit) {
      return deny(`今日已通过 ${state.approvedToday} 个，达到上限 ${config.dailyLimit}`)
    }
    if (config.minIntervalMs > 0 && Date.now() - state.lastApprovedAt < config.minIntervalMs) {
      return deny('触发最小间隔限制')
    }

    try {
      if (config.delayMs > 0) await sleep(config.delayMs)

      // 优先用事件自带方法；缺失时回退到 Bot API
      if (typeof e.approve === 'function') await e.approve(true)
      else await Bot.setFriendAddRequest(e.flag, true)

      state.approvedToday += 1
      state.lastApprovedAt = Date.now()
      writeJson(STATE_FILE, state)

      logger.mark(`[自动同意好友] 已通过 ${nickname}(${userId})${comment ? ` 验证信息：${comment}` : ''}`)
      await this.notify(config, `已通过好友请求：${nickname}(${userId})\n验证信息：${comment || '无'}`)

      if (config.welcome) {
        try {
          await Bot.pickFriend(userId).sendMsg(config.welcome)
        } catch (err) {
          logger.warn(`[自动同意好友] 发送欢迎语给 ${userId} 失败：${err?.message ?? err}`)
        }
      }
    } catch (err) {
      logger.error(`[自动同意好友] 通过 ${userId} 失败：${err?.message ?? err}`)
    }
  }

  /** 私聊通知主人（cfg.masterQQ，可以是数组或单个）。 */
  async notify(config, text) {
    if (!config.notifyMaster) return
    const masters = Array.isArray(cfg.masterQQ) ? cfg.masterQQ : [cfg.masterQQ]
    for (const qq of masters) {
      if (!qq) continue
      try {
        await Bot.pickFriend(String(qq)).sendMsg(`[自动同意好友]\n${text}`)
      } catch (err) {
        logger.warn(`[自动同意好友] 通知主人 ${qq} 失败：${err?.message ?? err}`)
      }
    }
  }
}

/** 消息事件：主人用指令管理开关与名单。 */
export class AutoFriendAdmin extends plugin {
  constructor() {
    super({
      name: '自动同意好友-设置',
      dsc: '开关 / 黑白名单 / 关键词 / 欢迎语',
      event: 'message',
      priority: 5000,
      rule: [
        { reg: '^#自动同意好友\\s*(.*)$', fnc: 'setting' },
        { reg: '^#好友(白|黑)名单\\s*(添加|删除|列表)?\\s*(\\d{5,12})?\\s*$', fnc: 'manageList' }
      ]
    })
  }

  async setting() {
    if (!this.e.isMaster) return false
    const config = loadConfig()
    const arg = (this.e.msg.replace(/^#自动同意好友\s*/, '') || '').trim()

    const onOff = (value) => ['开', '开启', '1', 'true', 'on'].includes(String(value).toLowerCase())

    if (/^(开启|关闭)$/.test(arg)) {
      config.enabled = arg === '开启'
      saveConfig(config)
      return this.reply(`自动同意好友已${config.enabled ? '开启' : '关闭'}`)
    }

    let matched = /^白名单模式\s*(开|关|开启|关闭)$/.exec(arg)
    if (matched) {
      config.whitelistOnly = onOff(matched[1])
      saveConfig(config)
      return this.reply(`白名单模式已${config.whitelistOnly ? '开启（只有白名单内 QQ 会被通过）' : '关闭'}`)
    }

    matched = /^关键词\s*(.+)?$/.exec(arg)
    if (matched) {
      config.answerKeyword = (matched[1] || '').trim()
      saveConfig(config)
      return this.reply(config.answerKeyword ? `已设置验证关键词：${config.answerKeyword}` : '已取消验证关键词限制')
    }

    matched = /^欢迎语\s*([\s\S]+)?$/.exec(arg)
    if (matched) {
      config.welcome = (matched[1] || '').trim()
      saveConfig(config)
      return this.reply(config.welcome ? `已设置欢迎语：${config.welcome}` : '已取消欢迎语')
    }

    matched = /^通知\s*(开|关|开启|关闭)$/.exec(arg)
    if (matched) {
      config.notifyMaster = onOff(matched[1])
      saveConfig(config)
      return this.reply(`主人通知已${config.notifyMaster ? '开启' : '关闭'}`)
    }

    if (arg && !/^状态$/.test(arg)) return this.reply('用法：#自动同意好友 [状态|开启|关闭|白名单模式 开/关|关键词 xx|欢迎语 xx|通知 开/关]')

    const state = loadState()
    return this.reply(
      [
        `自动同意好友：${config.enabled ? '开启' : '关闭'}`,
        `白名单模式：${config.whitelistOnly ? '开启' : '关闭'}（白名单 ${config.whitelist.length} 个）`,
        `黑名单：${config.blacklist.length} 个`,
        `验证关键词：${config.answerKeyword || '不限'}`,
        `欢迎语：${config.welcome || '无'}`,
        `主人通知：${config.notifyMaster ? '开启' : '关闭'}`,
        `今日已通过：${state.approvedToday}${config.dailyLimit ? `/${config.dailyLimit}` : ''}`,
        `延迟 ${config.delayMs}ms｜最小间隔 ${config.minIntervalMs}ms`
      ].join('\n')
    )
  }

  async manageList() {
    if (!this.e.isMaster) return false
    const matched = /^#好友(白|黑)名单\s*(添加|删除|列表)?\s*(\d{5,12})?\s*$/.exec(this.e.msg.trim())
    if (!matched) return false
    const [, kind, action = '列表', qq] = matched
    const label = kind === '白' ? '白名单' : '黑名单'
    const key = kind === '白' ? 'whitelist' : 'blacklist'
    const config = loadConfig()

    if (action === '添加') {
      if (!qq) return this.reply(`用法：#${label} 添加 QQ号`)
      if (!config[key].includes(qq)) config[key].push(qq)
      saveConfig(config)
      return this.reply(`${label}已添加 ${qq}，当前 ${config[key].length} 个`)
    }
    if (action === '删除') {
      if (!qq) return this.reply(`用法：#${label} 删除 QQ号`)
      config[key] = config[key].filter((item) => item !== qq)
      saveConfig(config)
      return this.reply(`${label}已删除 ${qq}，当前 ${config[key].length} 个`)
    }
    return this.reply(`${label}（${config[key].length} 个）：${config[key].join('、') || '空'}`)
  }
}
