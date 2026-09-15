import test from "node:test";
import assert from "node:assert/strict";
import { compactPlannerConversation } from "./planner-context.js";

function makeConversation() {
  return {
    id: "conversation-1",
    currentRevision: "rev-0007",
    activePartId: "bracket",
    activeFeatureId: "bracket.hole.01",
    validationReport: { issues: [{ code: "FINISH_FEATURE_FAILED" }] },
    plan: {
      name: "fixture",
      activePartId: "bracket",
      constraints: [{ id: "constraint-1", type: "concentric" }],
      joints: [{ id: "joint-1", type: "revolute" }],
      relations: [{ type: "mate", from: "bracket", to: "bearing" }],
      poses: { home: { bracket: { translate: [1, 2, 3] } } },
      parts: [
        {
          id: "bracket",
          primitives: [{ type: "box", size: [20, 10, 4] }],
          features: [{ type: "hole", radius: 3 }],
          featureTree: [{ id: "bracket.hole.01", type: "hole", params: { diameter: 6 } }],
          pose: { translate: [1, 2, 3], rotate: [0, 0, 0] },
          metadata: { finish: "anodized" }
        },
        {
          id: "bearing",
          mode: "standard_part",
          standardPart: { provider: "step.parts", id: "bearing_608zz", query: "608ZZ bearing" },
          primitives: [{ type: "cylinder", radius: 11, height: 7 }],
          features: [{ type: "hole", radius: 4 }],
          pose: { translate: [0, 0, 5], rotate: [0, 0, 0] }
        }
      ]
    },
    messages: Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `message-${index + 1}`,
      images: index === 4 ? ["reference.png"] : [],
      at: `2026-07-14T00:00:0${index}Z`,
      internal: { index }
    })),
    searchReferences: [{ title: "not needed in assertions" }]
  };
}

test("compaction deep clones without mutating the stored conversation", () => {
  const conversation = makeConversation();
  const original = structuredClone(conversation);

  const compacted = compactPlannerConversation(conversation);
  compacted.plan.parts[0].featureTree[0].params.diameter = 10;
  compacted.validationReport.issues[0].code = "CHANGED";
  compacted.messages[0].images.push("changed.png");

  assert.deepEqual(conversation, original);
  assert.notStrictEqual(compacted, conversation);
  assert.notStrictEqual(compacted.plan, conversation.plan);
});

test("authoritative feature trees drop compatibility geometry while legacy parts keep it", () => {
  const compacted = compactPlannerConversation(makeConversation());
  const [authoritativePart, legacyPart] = compacted.plan.parts;

  assert.equal(Object.hasOwn(authoritativePart, "primitives"), false);
  assert.equal(Object.hasOwn(authoritativePart, "features"), false);
  assert.deepEqual(authoritativePart.featureTree, [
    { id: "bracket.hole.01", type: "hole", params: { diameter: 6 } }
  ]);
  assert.deepEqual(legacyPart.primitives, [{ type: "cylinder", radius: 11, height: 7 }]);
  assert.deepEqual(legacyPart.features, [{ type: "hole", radius: 4 }]);
});

test("compaction preserves important plan and revision context", () => {
  const compacted = compactPlannerConversation(makeConversation());

  assert.equal(compacted.currentRevision, "rev-0007");
  assert.equal(compacted.activePartId, "bracket");
  assert.equal(compacted.activeFeatureId, "bracket.hole.01");
  assert.deepEqual(compacted.validationReport, {
    valid: undefined,
    blockingErrorCount: 0,
    summary: null,
    issues: [{ code: "FINISH_FEATURE_FAILED" }]
  });
  assert.deepEqual(compacted.plan.constraints, [{ id: "constraint-1", type: "concentric" }]);
  assert.deepEqual(compacted.plan.joints, [{ id: "joint-1", type: "revolute" }]);
  assert.deepEqual(compacted.plan.relations, [{ type: "mate", from: "bracket", to: "bearing" }]);
  assert.deepEqual(compacted.plan.poses, { home: { bracket: { translate: [1, 2, 3] } } });
  assert.deepEqual(compacted.plan.parts[0].pose, { translate: [1, 2, 3], rotate: [0, 0, 0] });
  assert.deepEqual(compacted.plan.parts[1].standardPart, {
    provider: "step.parts",
    id: "bearing_608zz",
    query: "608ZZ bearing"
  });
  assert.deepEqual(compacted.plan.parts[0].metadata, { finish: "anodized" });
});

test("existing-revision compaction keeps two sanitized messages", () => {
  const compacted = compactPlannerConversation(makeConversation());

  assert.deepEqual(compacted.messages, [
    { role: "user", content: "message-5", images: ["reference.png"] },
    { role: "assistant", content: "message-6", images: [] }
  ]);
});

test("fast retry compaction keeps two sanitized messages", () => {
  const compacted = compactPlannerConversation(makeConversation(), { fastRetry: true });

  assert.deepEqual(compacted.messages, [
    { role: "assistant", content: "message-6", images: [] }
  ]);
});

test("existing revisions compact validation evidence and standard-part resolution", () => {
  const conversation = makeConversation();
  conversation.validationReport = {
    valid: false,
    blockingErrorCount: 1,
    summary: { errors: 1, warnings: 0, info: 0 },
    measurements: Array.from({ length: 50 }, (_, index) => ({ id: index })),
    issues: [{ code: "PART_INTERFERENCE", severity: "error", parts: ["a", "b"], partBounds: { a: { min: [0, 0, 0] } } }]
  };
  conversation.plan.parts[1].standardPart.resolved = { provider: "step.parts", id: "608", name: "608 bearing", nominal: { boreDiameter: 8 }, checksum: "large-unused-field" };
  const compacted = compactPlannerConversation(conversation);
  assert.equal(compacted.validationReport.measurements, undefined);
  assert.equal(compacted.validationReport.issues[0].code, "PART_INTERFERENCE");
  assert.equal(compacted.plan.parts[1].standardPart.resolved.checksum, undefined);
  assert.equal(compacted.plan.parts[1].standardPart.resolved.nominal.boreDiameter, 8);
});
