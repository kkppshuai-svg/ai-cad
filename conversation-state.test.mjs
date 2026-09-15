import test from "node:test";
import assert from "node:assert/strict";

import { synchronizeConversationWithAssembly } from "./conversation-state.js";

test("existing assembly replaces a stale conversation plan with its normalized plan", () => {
  const stalePlan = { parts: [{ id: "frame", primitives: Array.from({ length: 16 }, () => ({})) }] };
  const normalizedPlan = {
    parts: [{ id: "frame", featureTree: [{ id: "frame.base.01", type: "base_box" }] }],
    activePartId: "frame",
    activeFeatureId: "frame.base.01"
  };
  const conversation = { plan: stalePlan };
  const job = {
    plan: normalizedPlan,
    currentRevision: "rev-0002",
    validationReport: { status: "pass" }
  };

  synchronizeConversationWithAssembly(conversation, job);

  assert.equal(conversation.plan, normalizedPlan);
  assert.equal(conversation.currentRevision, "rev-0002");
  assert.deepEqual(conversation.validationReport, { status: "pass" });
  assert.equal(conversation.activePartId, "frame");
  assert.equal(conversation.activeFeatureId, "frame.base.01");
});

test("explicit UI selection is preserved while assembly context is synchronized", () => {
  const conversation = { activePartId: "selected_part", activeFeatureId: "selected_part.hole.03" };
  const job = {
    plan: { activePartId: "default_part", activeFeatureId: "default_part.base.01" },
    currentRevision: "rev-0003"
  };

  synchronizeConversationWithAssembly(conversation, job);

  assert.equal(conversation.activePartId, "selected_part");
  assert.equal(conversation.activeFeatureId, "selected_part.hole.03");
});
