import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("the CI workflow deploys a preview and does not promote", () => {
  const action = readFileSync(`${root}/action/action.yml`, "utf8");
  const workflow = readFileSync(`${root}/examples/harbour/.github/workflows/preview.yml`, "utf8");
  for (const text of [action, workflow]) {
    assert.doesNotMatch(text, /quay (promote|rollback|delete)/);
  }
  assert.match(action, /quay deploy/);
  assert.match(action, /--ci/);
  assert.match(action, /QUAY_CI_KEY/);
  assert.doesNotMatch(action, /inputs:\s*\n(?:.*\n)*?\s+QUAY_CI_KEY:/);
  assert.match(workflow, /secrets\.QUAY_CI_KEY/);
  assert.match(workflow, /uses: \.\/action/);
});
