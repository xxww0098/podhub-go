import test from "node:test"

import { runRowRepoContract } from "./row-repo.contract"
import { memoryRowRepo } from "./row-repo"

test("RowRepo contract: memoryRowRepo", async () => {
  await runRowRepoContract(memoryRowRepo())
})
