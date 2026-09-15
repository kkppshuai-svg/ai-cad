export function synchronizeConversationWithAssembly(conversation, job) {
  if (!conversation || !job) return conversation;

  conversation.plan = job.plan || conversation.plan || null;
  conversation.currentRevision = job.currentRevision || null;
  conversation.activePartId = conversation.activePartId || job.plan?.activePartId || null;
  conversation.activeFeatureId = conversation.activeFeatureId || job.plan?.activeFeatureId || null;
  conversation.validationReport = job.validationReport || null;
  return conversation;
}
