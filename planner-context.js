export function compactPlannerConversation(conversation, { fastRetry = false } = {}) {
  const compacted = structuredClone(conversation ?? {});

  if (compacted.validationReport) {
    compacted.validationReport = compactValidationReport(compacted.validationReport, fastRetry ? 8 : 16);
  }

  for (const part of compacted.plan?.parts || []) {
    if (Object.hasOwn(part, "featureTree") && Array.isArray(part.featureTree)) {
      delete part.primitives;
      delete part.features;
    }
    delete part.geometryValidation;
    delete part.featureTrace;
    if (part.standardPart?.resolved) {
      part.standardPart.resolved = {
        provider: part.standardPart.resolved.provider,
        id: part.standardPart.resolved.id,
        name: part.standardPart.resolved.name,
        nominal: structuredClone(part.standardPart.resolved.nominal)
      };
    }
  }

  if (compacted.plan) delete compacted.plan.reply;

  const historyLimit = compacted.currentRevision ? (fastRetry ? 1 : 2) : (fastRetry ? 2 : 4);
  compacted.messages = (compacted.messages || []).slice(-historyLimit).map((message) => ({
    role: message?.role,
    content: message?.content,
    images: structuredClone(message?.images)
  }));

  return compacted;
}

function compactValidationReport(report, issueLimit) {
  return {
    valid: report.valid,
    blockingErrorCount: Number(report.blockingErrorCount || 0),
    summary: structuredClone(report.summary || null),
    issues: (report.issues || []).slice(0, issueLimit).map((issue) => Object.fromEntries(Object.entries({
      stage: issue.stage,
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
      partId: issue.partId,
      featureId: issue.featureId,
      parts: structuredClone(issue.parts),
      path: issue.path,
      measured: issue.measured,
      target: issue.target,
      requiredDepth: issue.requiredDepth,
      partBounds: structuredClone(issue.partBounds),
      overlapBounds: structuredClone(issue.overlapBounds)
    }).filter(([, value]) => value !== undefined)))
  };
}
