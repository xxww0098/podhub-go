import assert from "node:assert/strict"
import test from "node:test"

import {
  assembleBrief,
  briefAdvisories,
  briefHasHan,
  emptyBriefValues,
  parseBriefLines,
} from "./brief-lines"

// 反引号在说明的标题公式里是语法字符，用字符码拼出来，避免测试源码里出现嵌套模板串。
const BT = String.fromCharCode(96)
const TITLE = BT + "Кружка керамическая 330 мл с принтом \"<тема>\", для чая и кофе" + BT

// 仓库里一份真实说明（马克杯-陶瓷330ml）的形状——解析/拼装都用它对拍。
const MUG = [
  "Товар: Керамическая кружка 330 мл с одной ручкой и принтом на внешней стороне; это НЕ термокружка, НЕ стакан, НЕ стекло и НЕ металл; без крышки, трубочки, подставки и набора.",
  "Тема: Только принт, без стола, рук, посуды и фона съёмки. Неясно → «Абстрактный принт».",
  "Заголовок: " + TITLE,
  "Не пиши: «чашка», «стакан», «бокал», «термокружка».",
  "Описание: Керамическая кружка объёмом 330 мл с принтом. Корпус выполнен из керамики, принт нанесён на внешнюю сторону кружки. Принт: <видимый принт>. Основные цвета: <цвет1> и <цвет2>. Подойдёт для дома и офиса и станет подарком тем, кто любит <тема или стиль>.",
  "Не выдумывай: посудомойку, микроволновку, стойкость принта, вес, высоту, упаковку.",
].join("\n")

test("parseBriefLines：规范六行解析回字段，往返拼装一致", () => {
  const values = parseBriefLines(MUG)
  assert.ok(values)
  assert.equal(values.title, TITLE)
  assert.equal(assembleBrief(values), MUG)
})

test("parseBriefLines 容差与服务端一致：BOM、CRLF、行间空行", () => {
  const bom = String.fromCharCode(0xfeff)
  const padded = bom + MUG.split("\n").join("\r\n\r")
  const values = parseBriefLines(padded)
  assert.ok(values)
  assert.equal(assembleBrief(values), MUG)
})

test("parseBriefLines：旧整篇、空、行标错位都回落 null", () => {
  assert.equal(parseBriefLines(""), null)
  assert.equal(parseBriefLines("Товар: кружка\nТема: принт"), null)
  assert.equal(parseBriefLines(MUG + "\nТовар: 多了一行"), null)
  // 行标对但某行为空 → 不是规范六行，回落自由文本。
  assert.equal(
    parseBriefLines(
      "Товар: кружка\nТема:\nЗаголовок: x\nНе пиши: y\nОписание: z\nНе выдумывай: w",
    ),
    null,
  )
})

test("assembleBrief：全空字段返回空串（空正文是合法草稿态）", () => {
  assert.equal(assembleBrief(emptyBriefValues()), "")
})

test("briefAdvisories：缺行、汉字、公式缺槽都会点名，齐了就安静", () => {
  const values = emptyBriefValues()
  values.goods = "纯棉抱枕"
  values.theme = "Только принт."
  const messages = briefAdvisories(values).map((item) => item.message)
  assert.ok(messages.some((m) => m.includes("商品") && m.includes("汉字")))
  assert.ok(messages.some((m) => m.includes("标题") && m.includes("还没写")))

  const parsed = parseBriefLines(MUG)!
  assert.deepEqual(briefAdvisories(parsed), [])

  // 公式没有反引号/主题槽：入口点名，但不裁决。
  const broken = { ...parsed, title: "Кружка керамическая 330 мл с принтом \"<тема>\", для чая и кофе" }
  assert.ok(briefAdvisories(broken).some((item) => item.message.includes("反引号")))
})

test("briefHasHan：西里尔与拉丁型号不误报", () => {
  assert.equal(briefHasHan("Кружка 330 мл"), false)
  assert.equal(briefHasHan("для iPhone 17 Pro Max <тема>"), false)
  assert.equal(briefHasHan("Товар: 纯棉"), true)
})
