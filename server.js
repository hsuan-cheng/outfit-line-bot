const express = require('express')
const line = require('@line/bot-sdk')
const { GoogleGenerativeAI } = require('@google/generative-ai')
const cron = require('node-cron')
const fs = require('fs')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 3000

// ── LINE Config ───────────────────────────────────────────────────────────────
const lineConfig = {
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
}

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken,
})

// ── Storage (JSON files on Railway filesystem) ────────────────────────────────
const WARDROBE_FILE = path.join(__dirname, 'wardrobe.json')
const USERS_FILE    = path.join(__dirname, 'users.json')

function loadWardrobe() {
  try { return JSON.parse(fs.readFileSync(WARDROBE_FILE, 'utf8')) } catch { return [] }
}
function saveWardrobe(data) { fs.writeFileSync(WARDROBE_FILE, JSON.stringify(data), 'utf8') }

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) } catch { return [] }
}
function saveUsers(data) { fs.writeFileSync(USERS_FILE, JSON.stringify(data), 'utf8') }

// ── Helpers ───────────────────────────────────────────────────────────────────
function getSeason() {
  const m = new Date().getMonth() + 1
  if (m >= 3 && m <= 5)  return '春季'
  if (m >= 6 && m <= 8)  return '夏季'
  if (m >= 9 && m <= 11) return '秋季'
  return '冬季'
}

function getTomorrowStr() {
  const t = new Date()
  t.setDate(t.getDate() + 1)
  return t.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short' })
}

// Download image from LINE content server
async function downloadLineImage(messageId) {
  const blob = await lineClient.getMessageContent(messageId)
  const chunks = []
  for await (const chunk of blob) chunks.push(chunk)
  return Buffer.concat(chunks).toString('base64')
}

// ── Core: Generate outfit suggestion via Gemini ───────────────────────────────
async function generateOutfit(occasion) {
  const apiKey = process.env.GOOGLE_API_KEY || ''
  if (!apiKey) return '❌ 尚未設定 GOOGLE_API_KEY'

  const wardrobe = loadWardrobe()
  if (wardrobe.length === 0) return '👗 衣櫃是空的！\n\n請先傳送衣物照片給我，我就能幫你搭配囉～'

  const genAI  = new GoogleGenerativeAI(apiKey)
  const model  = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })
  const season  = getSeason()
  const tomorrow = getTomorrowStr()
  const occasionLine = occasion
    ? `請特別為「${occasion}」設計一套最適合的穿搭。`
    : '請建議 2 套搭配：\n1️⃣ 日常休閒  2️⃣ 約會/聚餐'

  const prompt = `你是專業時尚造型師。以下是衣物照片（共 ${wardrobe.length} 件）。\n\n明日：${tomorrow}，${season}\n\n${occasionLine}\n\n請用繁體中文，回覆適合在 LINE 上閱讀的格式（簡潔清晰，每套不超過 6 行）。`

  const imageParts = wardrobe.slice(0, 12).map(img => ({
    inlineData: { mimeType: 'image/jpeg', data: img.data },
  }))

  const result = await model.generateContent([prompt, ...imageParts])
  const text   = result.response.text()

  return `✦ 明日穿搭建議 ${tomorrow}\n\n${text}`
}

// ── LINE Webhook ───────────────────────────────────────────────────────────────
app.post(
  '/webhook',
  line.middleware(lineConfig),
  async (req, res) => {
    res.json({ ok: true })  // Respond quickly to LINE

    for (const event of req.body.events) {
      const userId = event.source.userId

      // Register user for daily push
      const users = loadUsers()
      if (!users.includes(userId)) {
        users.push(userId)
        saveUsers(users)
        console.log(`New user registered: ${userId}`)
      }

      if (event.type !== 'message') continue

      // ── Image received → save to wardrobe ───────────────────────────────
      if (event.message.type === 'image') {
        try {
          const base64   = await downloadLineImage(event.message.id)
          const wardrobe = loadWardrobe()
          wardrobe.push({ id: event.message.id, data: base64, addedAt: new Date().toISOString() })
          saveWardrobe(wardrobe)

          await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{
              type: 'text',
              text: `✅ 衣物照片已加入衣櫃！\n目前共 ${wardrobe.length} 件\n\n傳「今日穿搭」獲得建議\n傳「衣櫃」查看數量\n傳「清空衣櫃」重置`,
            }],
          })
        } catch (e) {
          console.error('Image save error:', e.message)
          await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '❌ 圖片儲存失敗，請再試一次。' }],
          })
        }
        continue
      }

      // ── Text commands ─────────────────────────────────────────────────────
      if (event.message.type !== 'text') continue
      const text = event.message.text.trim()

      if (text.includes('穿搭') || text.toLowerCase().includes('outfit')) {
        // Extract occasion if specified: "穿搭 婚禮"
        const parts    = text.split(/\s+/)
        const occasion = parts.length > 1 ? parts.slice(1).join(' ') : null

        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: '⏳ 正在分析你的衣櫃，稍等一下...' }],
        })

        try {
          const suggestion = await generateOutfit(occasion)
          await lineClient.pushMessage({ to: userId, messages: [{ type: 'text', text: suggestion }] })
        } catch (e) {
          console.error('Generate error:', e.message)
          await lineClient.pushMessage({ to: userId, messages: [{ type: 'text', text: `❌ 建議生成失敗：${e.message}` }] })
        }

      } else if (text === '清空衣櫃') {
        saveWardrobe([])
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: '🗑️ 衣櫃已清空！\n\n請重新傳送衣物照片給我。' }],
        })

      } else if (text === '衣櫃') {
        const count = loadWardrobe().length
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: `👗 衣櫃目前有 ${count} 件衣物。\n\n傳照片新增，傳「今日穿搭」獲得建議。` }],
        })

      } else {
        // Help message
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: '穿搭小助手 ✦\n\n📸 傳衣物照片 → 加入衣櫃\n👗 「今日穿搭」→ AI 建議\n👗 「今日穿搭 婚禮」→ 指定場合\n📦 「衣櫃」→ 查看數量\n🗑️ 「清空衣櫃」→ 重置\n\n每晚 22:00 自動推播明日穿搭！',
          }],
        })
      }
    }
  }
)

// ── Daily Push at 22:00 (Taiwan time = UTC+8, so 14:00 UTC) ──────────────────
// On Railway, set TZ=Asia/Taipei in env vars
cron.schedule('0 22 * * *', async () => {
  const users = loadUsers()
  if (users.length === 0) {
    console.log('[Cron] No users registered, skipping.')
    return
  }

  console.log(`[Cron] Generating daily outfit for ${users.length} user(s)...`)

  let suggestion
  try {
    suggestion = await generateOutfit(null)
  } catch (e) {
    console.error('[Cron] Generate failed:', e.message)
    return
  }

  for (const userId of users) {
    try {
      await lineClient.pushMessage({ to: userId, messages: [{ type: 'text', text: suggestion }] })
      console.log(`[Cron] Pushed to ${userId}`)
    } catch (e) {
      console.error(`[Cron] Push failed for ${userId}:`, e.message)
    }
  }
}, {
  timezone: 'Asia/Taipei',
})

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const users    = loadUsers().length
  const wardrobe = loadWardrobe().length
  res.send(`穿搭小助手 LINE Bot ✦ 運作中\n已登記使用者：${users} 人\n衣物件數：${wardrobe} 件`)
})

app.listen(PORT, () => {
  console.log(`✦ LINE Bot 已啟動，Port ${PORT}`)
  console.log(`  Webhook URL: https://<your-railway-url>/webhook`)
})
