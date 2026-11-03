import assert from "node:assert/strict"
import test from "node:test"

import { opsHttp } from "@/bindings/http-ops"
import { sendAndReadMessage } from "./message-center-send"

const request = { operation_id: "11111111-1111-4111-8111-111111111111", store_id: "store", chat_id: "chat", text: "Здравствуйте" }

test("a failed history refresh does not turn an acknowledged send into a send failure", async () => {
  const originalSend = opsHttp.messageCenterSend
  const originalHistory = opsHttp.messageCenterHistory
  const refreshError = new Error("history unavailable")
  let sends = 0
  let reads = 0
  try {
    opsHttp.messageCenterSend = async (sent) => {
      sends += 1
      assert.deepEqual(sent, request)
      return { store_id: sent.store_id, chat_id: sent.chat_id, result: "ok" }
    }
    opsHttp.messageCenterHistory = async (query) => {
      reads += 1
      assert.deepEqual(query, { store_id: request.store_id, chat_id: request.chat_id })
      throw refreshError
    }
    const result = await sendAndReadMessage(request)
    assert.equal(sends, 1)
    assert.equal(reads, 1)
    assert.equal(result.status, "failed")
    if (result.status !== "failed") throw new Error("expected history refresh failure")
    assert.equal(result.refreshError, refreshError)
  } finally {
    opsHttp.messageCenterSend = originalSend
    opsHttp.messageCenterHistory = originalHistory
  }
})

test("a completed send skips the old conversation read after a switch", async () => {
  const originalSend = opsHttp.messageCenterSend
  const originalHistory = opsHttp.messageCenterHistory
  let reads = 0
  try {
    opsHttp.messageCenterSend = async () => ({ store_id: request.store_id, chat_id: request.chat_id, result: "ok" })
    opsHttp.messageCenterHistory = async () => {
      reads += 1
      throw new Error("unexpected read")
    }
    const result = await sendAndReadMessage(request, () => false)
    assert.equal(result.status, "skipped")
    assert.equal(reads, 0)
  } finally {
    opsHttp.messageCenterSend = originalSend
    opsHttp.messageCenterHistory = originalHistory
  }
})

test("an unconfirmed send keeps its original error and never reads history", async () => {
  const originalSend = opsHttp.messageCenterSend
  const originalHistory = opsHttp.messageCenterHistory
  const sendError = new Error("result unknown")
  let reads = 0
  try {
    opsHttp.messageCenterSend = async () => { throw sendError }
    opsHttp.messageCenterHistory = async () => {
      reads += 1
      throw new Error("unexpected read")
    }
    await assert.rejects(sendAndReadMessage(request), (error) => error === sendError)
    assert.equal(reads, 0)
  } finally {
    opsHttp.messageCenterSend = originalSend
    opsHttp.messageCenterHistory = originalHistory
  }
})
