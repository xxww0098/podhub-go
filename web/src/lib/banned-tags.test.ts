import assert from "node:assert/strict"
import test from "node:test"

import { bannedTagRejection, setBannedTagRules } from "./banned-tags"

test("stem match covers case, hash, inflection and a latin lookalike", () => {
  setBannedTagRules([{ term: "сигарета", matchMode: "stem" }])
  for (const sample of ["#сигарета", "Сигарета", "сигареты", "сигаретный", "сигаретами", "сигаретная_пачка"]) {
    assert.ok(bannedTagRejection(sample), sample)
  }
  assert.ok(bannedTagRejection(`#${"c"}игарета`))
  assert.ok(bannedTagRejection("\uFF03сигарета"))
  assert.equal(bannedTagRejection("#роза"), null)
  assert.equal(bannedTagRejection("#сигар"), null)
  assert.match(bannedTagRejection("#сигареты #роза") ?? "", /#сигареты/)
})

test("exact mode does not match an inflection", () => {
  setBannedTagRules([{ term: "роза", matchMode: "exact" }])
  assert.ok(bannedTagRejection("#Роза"))
  assert.equal(bannedTagRejection("#розы"), null)
})

test("tobacco stem catches inflection and the snuffbox", () => {
  setBannedTagRules([{ term: "табак", matchMode: "stem" }])
  for (const sample of ["#табак", "табака", "табачный", "табакерка"]) {
    assert.ok(bannedTagRejection(sample), sample)
  }
  for (const sample of ["таблица", "табор", "табурет", "табель"]) {
    assert.equal(bannedTagRejection(sample), null, sample)
  }
  setBannedTagRules([{ term: "парк", matchMode: "stem" }])
  assert.ok(bannedTagRejection("парка"))
  assert.equal(bannedTagRejection("парча"), null)
})

test("vape stem catches inflection and skips nearby words", () => {
  setBannedTagRules([{ term: "вейп", matchMode: "stem" }])
  for (const sample of ["вейпы", "вейпа", "вейповый", "вейпинг", "вейп-мод"]) {
    assert.ok(bannedTagRejection(sample), sample)
  }
  for (const sample of ["веер", "век", "веймар", "веер-век"]) {
    assert.equal(bannedTagRejection(sample), null, sample)
  }
})

test("nicotine stem keeps the ending and skips names", () => {
  setBannedTagRules([{ term: "никотин", matchMode: "stem" }])
  for (const sample of ["никотина", "никотиновый"]) {
    assert.ok(bannedTagRejection(sample), sample)
  }
  for (const sample of ["никон", "николай", "никонов"]) {
    assert.equal(bannedTagRejection(sample), null, sample)
  }
})

test("vaporizer stem is the full lemma", () => {
  setBannedTagRules([{ term: "испаритель", matchMode: "stem" }])
  for (const sample of ["испарителя", "испарители", "испарителем", "испарительный"]) {
    assert.ok(bannedTagRejection(sample), sample)
  }
  for (const sample of ["испарение", "испариться", "испарить", "искра"]) {
    assert.equal(bannedTagRejection(sample), null, sample)
  }
})

test("e-cigarette stem folds space, underscore, and hyphen", () => {
  setBannedTagRules([{ term: "электронная_сигарета", matchMode: "stem" }])
  for (const sample of [
    "электронная_сигарета",
    "электронная-сигарета",
    "электронная сигарета",
    "электронная_сигареты",
    "электронная\u2014сигаретами",
    "мини_электронная_сигарета",
  ]) {
    assert.ok(bannedTagRejection(sample), sample)
  }
  for (const sample of ["электронная", "электронная_книга", "электронная_сигара", "электронные_сигареты"]) {
    assert.equal(bannedTagRejection(sample), null, sample)
  }
  const phrase = bannedTagRejection("роза электронная сигарета море")
  assert.match(phrase ?? "", /электронная/)
  assert.match(phrase ?? "", /сигарета/)
  assert.doesNotMatch(phrase ?? "", /роза/)
  setBannedTagRules([
    { term: "электронная_сигарета", matchMode: "stem" },
    { term: "сигарета", matchMode: "stem" },
  ])
  assert.ok(bannedTagRejection("электронные_сигареты"))
  assert.ok(bannedTagRejection("электронные-сигареты"))
})
