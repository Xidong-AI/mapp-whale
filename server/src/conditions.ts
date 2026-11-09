// 多结果市场条件 DSL（契约第 3 节）：纯解析与求值，无 IO、无副作用。
// 声明式条件，不执行任意用户脚本；解析失败统一抛 INVALID_CONDITION。

export interface ModelRow {
  id: string;
  name: string;
  context_window?: number;
  max_output_tokens?: number;
  input_modalities?: string[];
  [key: string]: unknown;
}

export type Condition =
  | { kind: 'always' }
  | { kind: 'never' }
  | { kind: 'manual' }
  | { kind: 'name_regex'; regex: string; flags?: string }
  | { kind: 'first_seen_between'; regex: string; flags?: string; start: number; end: number | null }
  | {
      kind: 'field_range';
      targetNameRegex: string;
      flags?: string;
      field: string;
      min: number | null;
      max: number | null;
      selector?: 'first' | 'max' | 'min';
    }
  | {
      kind: 'field_includes';
      targetNameRegex: string;
      flags?: string;
      field: string;
      value: string;
      selector?: 'first' | 'any';
    }
  | { kind: 'all'; of: Condition[] }
  | { kind: 'any'; of: Condition[] };

export interface ConditionContext {
  models: ModelRow[];
  firstSeenAt?: number | null;
}

// ---- 内部常量与工具 ----

const MAX_REGEX_LENGTH = 512;
// 组合条件最大嵌套深度，防止超深 JSON 打爆调用栈。
const MAX_DEPTH = 32;
// 只允许无状态 flag；g/y 会保留 lastIndex，跨模型 test 时漏判。
const ALLOWED_FLAGS = 'imsu';

export class InvalidConditionError extends Error {
  constructor() {
    super('INVALID_CONDITION');
    this.name = 'INVALID_CONDITION';
  }
}

function fail(): never {
  throw new InvalidConditionError();
}

/** 清洗 flags：只保留 i/m/s/u，去掉 g/y 等其它字符。 */
function normalizeFlags(flags: string | undefined): string {
  if (flags === undefined) return '';
  return flags.replace(new RegExp(`[^${ALLOWED_FLAGS}]`, 'g'), '');
}

/** 编译正则；长度超限或语法非法返回 null（求值路径宽容，解析路径严格）。 */
function compileRegex(pattern: string, flags: string): RegExp | null {
  if (pattern.length > MAX_REGEX_LENGTH) return null;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

function compileOrThrow(pattern: string, flags: string): void {
  if (pattern.length === 0 || pattern.length > MAX_REGEX_LENGTH || !compileRegex(pattern, flags)) {
    fail();
  }
}

function requireRegexString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.length === 0) fail();
  if (key === 'targetNameRegex') return value;
  return value;
}

function requireFiniteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail();
  return value;
}

function requireFiniteNumberOrNull(value: unknown): number | null {
  if (value === null) return null;
  return requireFiniteNumber(value);
}

function requireNonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) fail();
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') fail();
  return value;
}

// ---- 解析 ----

/** 解析并校验条件对象；结构非法统一抛 INVALID_CONDITION。 */
export function parseCondition(raw: unknown): Condition {
  return parseNode(raw, 0);
}

function parseNode(raw: unknown, depth: number): Condition {
  if (depth > MAX_DEPTH) fail();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail();
  const obj = raw as Record<string, unknown>;
  switch (obj.kind) {
    case 'always':
      return { kind: 'always' };
    case 'never':
      return { kind: 'never' };
    case 'manual':
      return { kind: 'manual' };
    case 'name_regex': {
      const regex = requireRegexString(obj.regex, 'regex');
      const flags = normalizeFlags(obj.flags as string | undefined);
      compileOrThrow(regex, flags);
      return { kind: 'name_regex', regex, flags: flags || undefined };
    }
    case 'first_seen_between': {
      const regex = requireRegexString(obj.regex, 'regex');
      const flags = normalizeFlags(obj.flags as string | undefined);
      compileOrThrow(regex, flags);
      const start = requireFiniteNumber(obj.start);
      // end 必须显式给出：数字或 null（无上限），缺失视为非法。
      const end = requireFiniteNumberOrNull(obj.end);
      return { kind: 'first_seen_between', regex, flags: flags || undefined, start, end };
    }
    case 'field_range': {
      const targetNameRegex = requireRegexString(obj.targetNameRegex, 'targetNameRegex');
      const flags = normalizeFlags(obj.flags as string | undefined);
      compileOrThrow(targetNameRegex, flags);
      const field = requireNonEmptyString(obj.field);
      const min = requireFiniteNumberOrNull(obj.min);
      const max = requireFiniteNumberOrNull(obj.max);
      // 非法 range：min > max，或 min === max（[min, max) 恒为空）。
      if (min !== null && max !== null && min >= max) fail();
      const selector = parseEnum(obj.selector, ['first', 'max', 'min']);
      return {
        kind: 'field_range',
        targetNameRegex,
        flags: flags || undefined,
        field,
        min,
        max,
        selector,
      };
    }
    case 'field_includes': {
      const targetNameRegex = requireRegexString(obj.targetNameRegex, 'targetNameRegex');
      const flags = normalizeFlags(obj.flags as string | undefined);
      compileOrThrow(targetNameRegex, flags);
      const field = requireNonEmptyString(obj.field);
      const value = requireString(obj.value);
      const selector = parseEnum(obj.selector, ['first', 'any']);
      return {
        kind: 'field_includes',
        targetNameRegex,
        flags: flags || undefined,
        field,
        value,
        selector,
      };
    }
    case 'all':
      return { kind: 'all', of: parseChildren(obj.of, depth) };
    case 'any':
      return { kind: 'any', of: parseChildren(obj.of, depth) };
    default:
      fail();
  }
}

function parseChildren(raw: unknown, depth: number): Condition[] {
  if (!Array.isArray(raw)) fail();
  return raw.map((child) => parseNode(child, depth + 1));
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail();
  return value as T;
}

// ---- 求值 ----

/** 纯函数：对模型列表与首次观测时间求值。 */
export function evaluateCondition(condition: Condition, context: ConditionContext): boolean {
  switch (condition.kind) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'manual':
      return false;
    case 'name_regex': {
      const re = compileRegex(condition.regex, normalizeFlags(condition.flags));
      if (!re) return false;
      return context.models.some((m) => re.test(m.name));
    }
    case 'first_seen_between': {
      const t = context.firstSeenAt;
      if (typeof t !== 'number' || !Number.isFinite(t)) return false;
      if (t < condition.start) return false;
      if (condition.end !== null && t >= condition.end) return false;
      return true;
    }
    case 'field_range':
      return evalFieldRange(condition, context.models);
    case 'field_includes':
      return evalFieldIncludes(condition, context.models);
    case 'all':
      return condition.of.every((c) => evaluateCondition(c, context));
    case 'any':
      return condition.of.some((c) => evaluateCondition(c, context));
  }
}

function evalFieldRange(
  condition: Extract<Condition, { kind: 'field_range' }>,
  models: ModelRow[],
): boolean {
  const re = compileRegex(condition.targetNameRegex, normalizeFlags(condition.flags));
  if (!re) return false;
  const matched = models.filter((m) => re.test(m.name));
  if (matched.length === 0) return false;
  const selector = condition.selector ?? 'first';
  let value: number | null = null;
  if (selector === 'first') {
    const v = matched[0]![condition.field];
    if (typeof v === 'number' && Number.isFinite(v)) value = v;
  } else {
    // max/min：在字段为有限数字的命中模型里取极值；全是非数字则视为无值。
    for (const m of matched) {
      const v = m[condition.field];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (value === null || (selector === 'max' ? v > value : v < value)) value = v;
    }
  }
  if (value === null) return false;
  // 半开区间 [min, max)；min/max 为 null 表示该侧无界。
  if (condition.min !== null && value < condition.min) return false;
  if (condition.max !== null && value >= condition.max) return false;
  return true;
}

function evalFieldIncludes(
  condition: Extract<Condition, { kind: 'field_includes' }>,
  models: ModelRow[],
): boolean {
  const re = compileRegex(condition.targetNameRegex, normalizeFlags(condition.flags));
  if (!re) return false;
  const matched = models.filter((m) => re.test(m.name));
  if (matched.length === 0) return false;
  const hasValue = (m: ModelRow): boolean => {
    const arr = m[condition.field];
    return Array.isArray(arr) && arr.includes(condition.value);
  };
  const selector = condition.selector ?? 'first';
  if (selector === 'first') return hasValue(matched[0]!);
  return matched.some(hasValue);
}
