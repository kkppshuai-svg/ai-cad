export const MAX_ASSEMBLY_PARTS = 16;

export function assertAssemblyPartCount(parts, maximum = MAX_ASSEMBLY_PARTS) {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error("Assembly plan requires at least one part");
  }
  if (parts.length > maximum) {
    throw new Error(`Assembly plan has too many parts (maximum ${maximum}, received ${parts.length})`);
  }
}
