import assert from "node:assert/strict"
import test from "node:test"

import { toast } from "@/components/ui/toast"
import {
  clearLive,
  notifyCommandError,
  notifyError,
  notifyLive,
  notifySuccess,
} from "@/lib/notify"

function captureConsoleLog(run: () => void): unknown[][] {
  const original = console.log
  const lines: unknown[][] = []
  console.log = (...args: unknown[]) => {
    lines.push(args)
  }
  try {
    run()
  } finally {
    console.log = original
  }
  return lines
}

test("repeated automatic task-in-progress errors reuse one visible notification", () => {
  const reason = {
    code: "workflow_task_in_progress",
    message: "该上架方案有一个正在进行的执行任务；请等待任务完成或先取消任务再编辑",
  }

  try {
    let ids: string[] = []
    captureConsoleLog(() => {
      ids = [
        notifyCommandError(reason, "后台发送暂未恢复"),
        notifyCommandError(reason, "后台发送暂未恢复"),
        notifyCommandError(reason, "后台发送暂未恢复"),
      ]
    })

    assert.equal(new Set(ids).size, 1)
  } finally {
    toast.close()
  }
})

test("one Cloud refusal is one notification, whichever reads failed with it", () => {
  // Opening a screen runs several loads (cards, roster, tree). With no
  // Workspace, Cloud refuses every one with the same sentence; the operator
  // must see one card for the cause, not one per request.
  const noWorkspace = "当前账号尚未加入任何工作空间，请先创建工作空间，或等待他人邀请后在通知中接受"
  const cards = Object.assign(new Error(noWorkspace), { code: "forbidden", status: 403 })
  const roster = Object.assign(new Error(noWorkspace), { code: "forbidden", status: 403 })

  try {
    let ids: string[] = []
    captureConsoleLog(() => {
      ids = [
        notifyCommandError(cards, "无法读取已保存的上架方案，请稍后重试。"),
        notifyCommandError(roster, "无法读取店铺，请稍后重试。"),
      ]
    })

    assert.equal(ids[0], ids[1])
  } finally {
    toast.close()
  }
})

test("different Cloud causes keep separate notifications", () => {
  const forbidden = Object.assign(new Error("当前账号尚未加入任何工作空间，请先创建工作空间，或等待他人邀请后在通知中接受"), { code: "forbidden" })
  const unavailable = Object.assign(new Error("云端服务暂时不可用"), { code: "cloud_unavailable" })
  const missing = Object.assign(new Error("类目不存在"), { code: "cloud_not_found" })

  try {
    let ids: string[] = []
    captureConsoleLog(() => {
      ids = [
        notifyCommandError(forbidden, "无法读取"),
        notifyCommandError(unavailable, "无法读取"),
        notifyCommandError(missing, "无法读取"),
      ]
    })

    assert.equal(new Set(ids).size, 3)
  } finally {
    toast.close()
  }
})

test("repeated Cloud outages replace the same notification", () => {
  const reason = {
    code: "cloud_unavailable",
    message: "云端服务暂时不可用",
    remediation: "请稍后重试；若问题持续，请检查网络连接。",
  }

  try {
    let first = ""
    let second = ""
    captureConsoleLog(() => {
      first = notifyCommandError(reason, "无法登录")
      second = notifyCommandError(reason, "无法登录")
    })

    assert.ok(first)
    assert.equal(second, first)
  } finally {
    toast.close()
  }
})

test("notifyError writes one greppable console line and still toasts", () => {
  let id: string | undefined
  const lines = captureConsoleLog(() => {
    id = notifyError("无法打开上架执行", { description: "请稍后重试" })
  })
  try {
    assert.ok(id)
    assert.equal(lines.length, 1)
    assert.match(String(lines[0]?.[0]), /^\[notify\] error code=operation_failed errorId=[0-9A-F][0-9A-HJKMNP-TV-Z]{12} message=无法打开上架执行$/)
  } finally {
    toast.close()
  }
})

test("notifyCommandError logs code and resolved message on one line", () => {
  const reason = {
    code: "cloud_unavailable",
    message: "云端服务暂时不可用",
    remediation: "请稍后重试。",
  }
  const lines = captureConsoleLog(() => {
    notifyCommandError(reason, "无法登录")
  })
  try {
    assert.equal(lines.length, 1)
    assert.match(String(lines[0]?.[0]), /^\[notify\] error code=cloud_unavailable errorId=[0-9A-F][0-9A-HJKMNP-TV-Z]{12} message=云端服务暂时不可用 请稍后重试。$/)
  } finally {
    toast.close()
  }
})

test("notifyCommandError keeps safe diagnostics and skips arbitrary objects and raw stacks", () => {
  const error = Object.assign(new Error("登录已失效，请重新登录"), {
    code: "unauthenticated",
  })
  const secret = { token: "should-not-appear", nested: { password: "x" } }
  const lines = captureConsoleLog(() => {
    notifyCommandError(error, "无法登录")
    notifyCommandError(secret, "无法登录")
  })
  try {
    assert.equal(lines.length, 2)
    assert.equal(lines[0]?.length, 1)
    assert.match(String(lines[0]?.[0]), /code=unauthenticated.*message=登录已失效，请重新登录/)
    assert.doesNotMatch(String(lines[0]?.[0]), /reason=|\/Users\/|Error:|\n/)
    assert.match(String(lines[1]?.[0]), /^\[notify\] error code=operation_failed errorId=[0-9A-F][0-9A-HJKMNP-TV-Z]{12} message=无法登录$/)
    assert.equal(
      lines.every((line) => !String(line[0]).includes("should-not-appear")),
      true,
    )
  } finally {
    toast.close()
  }
})

test("success toasts do not write a notify console line", () => {
  const lines = captureConsoleLog(() => {
    notifySuccess("已保存")
  })
  try {
    assert.deepEqual(lines, [])
  } finally {
    toast.close()
  }
})

test("live error notices write one notify console line", () => {
  const lines = captureConsoleLog(() => {
    notifyLive({
      id: "live:import-fail",
      type: "error",
      title: "导入失败",
      description: "源图无法读取",
    })
  })
  try {
    assert.equal(lines.length, 1)
    assert.match(String(lines[0]?.[0]), /^\[notify\] error code=operation_failed errorId=[0-9A-F][0-9A-HJKMNP-TV-Z]{12} message=导入失败$/)
  } finally {
    clearLive("live:import-fail")
  }
})

test("live notices reuse a stable id and do not expire", () => {
  try {
    const first = notifyLive({
      id: "live:prepare",
      type: "loading",
      title: "准备进行中",
      description: "AI 识别 0/2",
    })
    const second = notifyLive({
      id: "live:prepare",
      type: "loading",
      title: "准备进行中",
      description: "AI 识别 1/2",
    })
    assert.equal(first, "live:prepare")
    assert.equal(second, "live:prepare")
  } finally {
    clearLive("live:prepare")
  }
})
