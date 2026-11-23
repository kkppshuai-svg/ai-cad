const NUMBER = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
const UPPER_LIMIT = String.raw`(?:不超过|不大于|不得超过|不得大于|上限|限值|[<]=|≤|at most|maximum)`;
const ALLOWED_MAXIMUM = String.raw`(?:允许的最大|最大允许|允许最大|最大|maximum allowable|maximum|allowable)`;
const TARGETS = [
  { kind: "envelope", limitKey: "maxMm", term: String.raw`(?:包络(?:尺寸)?|外形尺寸|\benvelope\b)`,
    intent: new RegExp(String.raw`(?:包络|\benvelope\b|外形尺寸\s*(?:${UPPER_LIMIT}|不能太大)|${ALLOWED_MAXIMUM}\s*外形尺寸)`, "i"),
    amount: String.raw`(${NUMBER})\s*[×x*]\s*(${NUMBER})\s*[×x*]\s*(${NUMBER})\s*mm\b` },
  { kind: "deflection", limitKey: "maxMm", term: String.raw`(?:挠度|(?:自由端|末端|端部)位移|\bdeflection\b)`,
    qualitative: /(?:不能|不得|不应|避免|限制|防止)[^，,。；;]{0,12}(?:变形|弯)/i, amount: String.raw`(${NUMBER})\s*mm\b` },
  { kind: "stress", limitKey: "maxMPa", term: String.raw`(?:应力|\bstress\b)`, amount: String.raw`(${NUMBER})\s*MPa\b` }
];
const CLAMP = /(?:固支|完全固定|\bclamped\b)/i;
const FREE_END = /(?:自由端|\b(?:free end|tip)\b)/i;
const STATIC = /(?:静载|静力|静态|\bstatic\b)/i;
const Z_DIRECTION = /(?:(?:沿|平行于|along)\s*[+-]?z(?![a-z0-9])|\bz\s*(?:轴|向|方向|-axis|-direction))/i;
const OTHER_SUPPORT = /(?:(?:不是|不采用|不做|不允许|不|非|无)\s*(?:理想\s*固支|固支|完全固定)|不要固定|(?:两端|双端)(?:理想\s*)?(?:固定|固支)|简支|\bnot\s+(?:fully\s+)?clamped\b|\bboth ends\s+(?:are\s+)?clamped\b|\bsimply supported\b)/i;
const OTHER_LOADING = /(?:(?:不|非)(?:施加|采用)?静载|分布载荷|组合载荷|冲击载荷|循环载荷|动态载荷|扭矩|\b(?:distributed|combined|impact|cyclic|dynamic)\s+load\b|\btorque\b)/i;
const OTHER_DIRECTION = /(?:(?:不|非)\s*沿\s*[+-]?z|(?:沿|平行于|along)\s*[+-]?[xy](?![a-z0-9]|\s*\/)|\b[xy]\s*(?:向|方向|-direction))/i;
const RANGE = String.raw`(${NUMBER})(?:\s*(?:[-~–—]|至|\bto\b)\s*(${NUMBER}))?`;
const FORCE_AMOUNT = String.raw`(?<![\w.,/±−^+-])${RANGE}\s*N\b(?!\s*[·*/×])`;
const FORCE = new RegExp(FORCE_AMOUNT, "gi");
const LABELLED_FORCE = new RegExp(String.raw`(?:载荷|作用力|受力|力值|\b(?:force|load)\b)\s*(?:大小\s*)?[:=：为]?\s*${FORCE_AMOUNT}`, "gi");
const MODULUS = new RegExp(String.raw`(?:弹性模量|杨氏模量|Young['’]s modulus|elastic modulus)\s*[:=：为]?\s*${RANGE}\s*(MPa|GPa)\b`, "gi");

function normalizedText(value) {
  return typeof value === "string" ? value.normalize("NFKC") : "";
}

function mentionsTarget(target, text) {
  return new RegExp(target.term, "i").test(text) || Boolean(target.qualitative?.test(text));
}

function requestsTarget(target, text) {
  const optedOut = new RegExp(String.raw`(?:不用|无需|不需要|不必|忽略|不考虑|不要|\b(?:ignore|skip|do not)\b)\s*(?:计算|检查|验证|评估|check|verify)?\s*${target.term}`, "i");
  return !optedOut.test(text) && (target.intent?.test(text) ?? mentionsTarget(target, text));
}

function acceptanceLimit(target, sentences) {
  const prefix = String.raw`(?:${ALLOWED_MAXIMUM}\s*${target.term}\s*${UPPER_LIMIT}?|${target.term}\s*${UPPER_LIMIT})`;
  const pattern = new RegExp(String.raw`${prefix}\s*[:=：为]?\s*${target.amount}`, "gi");
  return uniqueValue(sentences.flatMap((sentence) => Array.from(sentence.matchAll(pattern), (match) => {
    const values = match.slice(1).map(Number);
    if (!values.every(Number.isFinite)) return undefined;
    return target.kind === "envelope" ? values.every((value) => value > 0) ? values : undefined : values[0];
  })));
}

function uniqueValue(values) {
  if (values.includes(undefined)) return undefined;
  const matches = new Map(values.map((value) => [JSON.stringify(value), value]));
  return matches.size === 1 ? matches.values().next().value : undefined;
}

function positiveRange(match, scale = 1) {
  const low = Number(match[1]) * scale;
  const high = match[2] === undefined ? low : Number(match[2]) * scale;
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high < low) return undefined;
  return low === high ? low : [low, high];
}

function traceIds(fbs, target, requirements, criteria) {
  const ids = [];
  if (mentionsTarget(target, requirements)) ids.push("user-requirements");
  if (mentionsTarget(target, criteria)) ids.push("user-criteria");
  for (const behavior of fbs.behaviors || []) {
    const details = [behavior.label, ...(behavior.specifications || [])].join(" ");
    if (mentionsTarget(target, details)) ids.push(behavior.id);
  }
  for (const check of fbs.acceptanceChecks || []) {
    if (mentionsTarget(target, check.statement || "")) ids.push(check.id, ...(check.sourceIds || []));
  }
  return [...new Set(ids)].filter((id) => typeof id === "string" && id);
}

/** Compile the supported, explicitly stated user requirements. FBS metadata supplies trace IDs. */
export function compileFbsVerification(fbs = {}, { requirements = fbs.requirements, criteria = "" } = {}) {
  requirements = normalizedText(requirements);
  criteria = normalizedText(criteria);
  const sentences = `${requirements}\n${criteria}`.split(/[。;；!！?？\n]+|(?<=\.)\s+/);
  const targets = TARGETS.filter((target) => sentences.some((sentence) => requestsTarget(target, sentence)));
  if (!targets.length) return undefined;

  const compiled = { requirements: [] };
  if (targets.some((target) => target.kind !== "envelope")) {
    const input = sentences.join(" ");
    const loadCase = {};
    if (CLAMP.test(input) && !OTHER_SUPPORT.test(input)) loadCase.support = "ideal_clamp";
    const staticTipLoads = sentences.filter((sentence) => FREE_END.test(sentence) && STATIC.test(sentence) && Z_DIRECTION.test(sentence) && !OTHER_DIRECTION.test(sentence));
    if (staticTipLoads.length && !OTHER_LOADING.test(input)) loadCase.kind = "static_tip_force";
    const forceMatches = [...staticTipLoads.flatMap((sentence) => Array.from(sentence.matchAll(FORCE))), ...input.matchAll(LABELLED_FORCE)];
    const forceN = uniqueValue(forceMatches.map((match) => positiveRange(match)));
    const youngMPa = uniqueValue(Array.from(input.matchAll(MODULUS), (match) => positiveRange(match, match[3].toLowerCase() === "gpa" ? 1000 : 1)));
    if (forceN !== undefined) loadCase.forceN = forceN;
    compiled.loadCase = loadCase;
    if (youngMPa !== undefined) compiled.material = { youngMPa };
  }

  for (const target of targets) {
    const { kind, limitKey } = target;
    const limit = acceptanceLimit(target, sentences.filter((sentence) => requestsTarget(target, sentence)));
    const requirement = { id: `fbs-${kind}`, kind, sourceIds: traceIds(fbs, target, requirements, criteria) };
    const missing = [];
    if (limit === undefined) missing.push(limitKey);
    else requirement[limitKey] = limit;
    if (kind !== "envelope") {
      if (!compiled.loadCase.support) missing.push("loadCase.support");
      if (!compiled.loadCase.kind) missing.push("loadCase.kind");
      if (!compiled.loadCase.forceN) missing.push("loadCase.forceN");
      if (!compiled.material) missing.push("material.youngMPa");
    }
    if (missing.length) requirement.missing = missing;
    compiled.requirements.push(requirement);
  }
  return compiled;
}
