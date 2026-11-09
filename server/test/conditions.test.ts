// 条件 DSL 测试（契约第 3 节）：解析校验、各算子求值、组合、窗口边界、selector。
import { describe, expect, test } from 'bun:test';
import {
  evaluateCondition,
  parseCondition,
  type ConditionContext,
  type ModelRow,
} from '../src/conditions';

const model = (name: string, extra: Partial<ModelRow> = {}): ModelRow => ({
  id: `m_${name}`,
  name,
  ...extra,
});

const ctx = (models: ModelRow[], firstSeenAt?: number | null): ConditionContext => ({
  models,
  firstSeenAt,
});

describe('parseCondition', () => {
  test('解析 always/never/manual', () => {
    expect(parseCondition({ kind: 'always' })).toEqual({ kind: 'always' });
    expect(parseCondition({ kind: 'never' })).toEqual({ kind: 'never' });
    expect(parseCondition({ kind: 'manual' })).toEqual({ kind: 'manual' });
  });

  test('解析 name_regex 并清洗 flags（去掉 g/y）', () => {
    const c = parseCondition({ kind: 'name_regex', regex: 'V5', flags: 'gimuy' });
    expect(c).toEqual({ kind: 'name_regex', regex: 'V5', flags: 'imu' });
  });

  test('非法输入统一抛 INVALID_CONDITION', () => {
    const cases: unknown[] = [
      null,
      undefined,
      42,
      'always',
      [],
      {},
      { kind: 'unknown_kind' },
      { kind: 'name_regex' }, // 缺 regex
      { kind: 'name_regex', regex: '' }, // 空 regex
      { kind: 'name_regex', regex: 123 }, // 类型错误
      { kind: 'name_regex', regex: '[' }, // 非法正则
      { kind: 'first_seen_between', regex: 'V5', start: 100 }, // 缺 end
      { kind: 'first_seen_between', regex: 'V5', end: 200 }, // 缺 start
      { kind: 'first_seen_between', regex: 'V5', start: 100, end: 'x' },
      { kind: 'field_range', targetNameRegex: 'V5', field: 'f', min: 10, max: 5 }, // 非法 range
      { kind: 'field_range', targetNameRegex: 'V5', field: 'f', min: 5, max: 5 }, // 空 range
      { kind: 'field_range', targetNameRegex: 'V5', field: 'f', min: 'a', max: 5 },
      { kind: 'field_range', targetNameRegex: 'V5', field: 'f', min: 0, max: 5, selector: 'bogus' },
      { kind: 'field_includes', targetNameRegex: 'V5', field: 'f' }, // 缺 value
      { kind: 'field_includes', targetNameRegex: 'V5', field: 'f', value: 'image', selector: 'max' }, // 非法 selector
      { kind: 'all', of: 'not-array' },
      { kind: 'any', of: [{ kind: 'bogus' }] }, // 子条件非法
    ];
    for (const raw of cases) {
      expect(() => parseCondition(raw)).toThrow('INVALID_CONDITION');
    }
  });

  test('正则长度超过 512 拒绝', () => {
    expect(() => parseCondition({ kind: 'name_regex', regex: 'a'.repeat(513) })).toThrow(
      'INVALID_CONDITION',
    );
    expect(parseCondition({ kind: 'name_regex', regex: 'a'.repeat(512) })).toBeTruthy();
  });

  test('min/max 可为 null', () => {
    expect(
      parseCondition({ kind: 'field_range', targetNameRegex: 'V5', field: 'f', min: null, max: 100 }),
    ).toEqual({ kind: 'field_range', targetNameRegex: 'V5', field: 'f', min: null, max: 100 });
  });
});

describe('evaluateCondition: 常量与 name_regex', () => {
  test('always 真、never/manual 假', () => {
    const models = [model('gpt-5')];
    expect(evaluateCondition({ kind: 'always' }, ctx(models))).toBe(true);
    expect(evaluateCondition({ kind: 'never' }, ctx(models))).toBe(false);
    expect(evaluateCondition({ kind: 'manual' }, ctx(models))).toBe(false);
  });

  test('name_regex：任一模型 name 命中为真', () => {
    const c = parseCondition({ kind: 'name_regex', regex: 'DeepSeek[- ]?V5', flags: 'i' });
    expect(evaluateCondition(c, ctx([model('claude-4'), model('deepseek v5')]))).toBe(true);
    expect(evaluateCondition(c, ctx([model('claude-4'), model('gpt-5')]))).toBe(false);
    expect(evaluateCondition(c, ctx([]))).toBe(false);
  });

  test('flags i 大小写不敏感', () => {
    const c = parseCondition({ kind: 'name_regex', regex: 'deepseek-v5', flags: 'i' });
    expect(evaluateCondition(c, ctx([model('DeepSeek-V5')]))).toBe(true);
  });
});

describe('evaluateCondition: first_seen_between', () => {
  const c = parseCondition({
    kind: 'first_seen_between',
    regex: 'DeepSeek[- ]?V5',
    flags: 'i',
    start: 1000,
    end: 2000,
  });
  const cOpenEnd = parseCondition({
    kind: 'first_seen_between',
    regex: 'V5',
    start: 1000,
    end: null,
  });
  const models = [model('DeepSeek-V5')];

  test('窗口内为真', () => {
    expect(evaluateCondition(c, ctx(models, 1500))).toBe(true);
  });

  test('半开区间：start 含、end 不含', () => {
    expect(evaluateCondition(c, ctx(models, 1000))).toBe(true);
    expect(evaluateCondition(c, ctx(models, 1999))).toBe(true);
    expect(evaluateCondition(c, ctx(models, 2000))).toBe(false);
    expect(evaluateCondition(c, ctx(models, 999))).toBe(false);
  });

  test('end=null 无上限', () => {
    expect(evaluateCondition(cOpenEnd, ctx(models, 99_999_999))).toBe(true);
  });

  test('firstSeenAt 缺失/null 返回 false', () => {
    expect(evaluateCondition(c, ctx(models, null))).toBe(false);
    expect(evaluateCondition(c, ctx(models, undefined))).toBe(false);
    expect(evaluateCondition(cOpenEnd, ctx(models))).toBe(false);
  });
});

describe('evaluateCondition: field_range', () => {
  const base = {
    kind: 'field_range' as const,
    targetNameRegex: 'DeepSeek[- ]?V5',
    flags: 'i',
    field: 'context_window',
  };

  test('selector first：取数组顺序首个命中模型', () => {
    const c = parseCondition({ ...base, min: 1_000_000, max: 2_000_000, selector: 'first' });
    const models = [
      model('other'),
      model('deepseek v5', { context_window: 1_500_000 }),
      model('DeepSeek-V5', { context_window: 999_999 }),
    ];
    // 首个命中的是 1_500_000 那个（第二个），在 [1M, 2M) 内。
    expect(evaluateCondition(c, ctx(models))).toBe(true);
    const models2 = [
      model('other'),
      model('deepseek v5', { context_window: 999_999 }),
      model('DeepSeek-V5', { context_window: 1_500_000 }),
    ];
    expect(evaluateCondition(c, ctx(models2))).toBe(false);
  });

  test('selector max/min：取字段极值', () => {
    const models = [
      model('deepseek v5', { context_window: 100 }),
      model('DeepSeek-V5', { context_window: 900 }),
      model('DeepSeek V5', { context_window: 500 }),
    ];
    const cMax = parseCondition({ ...base, min: 800, max: 1000, selector: 'max' });
    const cMin = parseCondition({ ...base, min: 50, max: 200, selector: 'min' });
    expect(evaluateCondition(cMax, ctx(models))).toBe(true); // 900 ∈ [800, 1000)
    expect(evaluateCondition(cMin, ctx(models))).toBe(true); // 100 ∈ [50, 200)
    const cMaxOut = parseCondition({ ...base, min: 950, max: 1000, selector: 'max' });
    expect(evaluateCondition(cMaxOut, ctx(models))).toBe(false);
  });

  test('min/max 为 null 表示该侧无界', () => {
    const models = [model('DeepSeek-V5', { context_window: 5 })];
    expect(evaluateCondition(parseCondition({ ...base, min: null, max: 10 }), ctx(models))).toBe(
      true,
    );
    expect(evaluateCondition(parseCondition({ ...base, min: 10, max: null }), ctx(models))).toBe(
      false,
    );
    expect(evaluateCondition(parseCondition({ ...base, min: null, max: null }), ctx(models))).toBe(
      true,
    );
  });

  test('无命中模型或字段非数字为假', () => {
    expect(evaluateCondition(parseCondition({ ...base, min: 0, max: 10 }), ctx([model('gpt')]))).toBe(
      false,
    );
    expect(
      evaluateCondition(
        parseCondition({ ...base, field: 'custom_field', min: 0, max: 10 }),
        ctx([model('DeepSeek-V5', { custom_field: 'big' })]),
      ),
    ).toBe(false);
    expect(evaluateCondition(parseCondition({ ...base, min: 0, max: 10 }), ctx([]))).toBe(false);
  });

  test('max/min 时字段非数字的模型被跳过', () => {
    const models = [
      model('DeepSeek-V5', { custom_field: 'n/a' }),
      model('DeepSeek V5', { custom_field: 300 }),
    ];
    const c = parseCondition({ ...base, field: 'custom_field', min: 0, max: 400, selector: 'max' });
    expect(evaluateCondition(c, ctx(models))).toBe(true);
  });
});

describe('evaluateCondition: field_includes', () => {
  const base = {
    kind: 'field_includes' as const,
    targetNameRegex: 'DeepSeek[- ]?V5',
    flags: 'i',
    field: 'input_modalities',
    value: 'image',
  };

  test('selector first：只看首个命中模型', () => {
    const c = parseCondition({ ...base, selector: 'first' });
    expect(evaluateCondition(c, ctx([model('DeepSeek-V5', { input_modalities: ['text', 'image'] })]))).toBe(
      true,
    );
    expect(evaluateCondition(c, ctx([model('DeepSeek-V5', { input_modalities: ['text'] })]))).toBe(
      false,
    );
    const models = [
      model('deepseek v5', { input_modalities: ['text'] }),
      model('DeepSeek-V5', { input_modalities: ['text', 'image'] }),
    ];
    expect(evaluateCondition(c, ctx(models))).toBe(false);
  });

  test('selector any：任一命中模型包含即真', () => {
    const c = parseCondition({ ...base, selector: 'any' });
    const models = [
      model('deepseek v5', { input_modalities: ['text'] }),
      model('DeepSeek-V5', { input_modalities: ['text', 'image'] }),
    ];
    expect(evaluateCondition(c, ctx(models))).toBe(true);
  });

  test('默认 selector 为 first', () => {
    const c = parseCondition({ ...base });
    const models = [
      model('deepseek v5', { input_modalities: ['text'] }),
      model('DeepSeek-V5', { input_modalities: ['image'] }),
    ];
    expect(evaluateCondition(c, ctx(models))).toBe(false);
  });

  test('无命中模型或非数组字段为假', () => {
    expect(evaluateCondition(parseCondition(base), ctx([model('gpt')]))).toBe(false);
    expect(
      evaluateCondition(
        parseCondition({ ...base, field: 'tags' }),
        ctx([model('DeepSeek-V5', { tags: 'text,image' })]),
      ),
    ).toBe(false);
  });
});

describe('evaluateCondition: 组合 all/any', () => {
  const nameC = parseCondition({ kind: 'name_regex', regex: 'V5' });
  const rangeC = parseCondition({
    kind: 'field_range',
    targetNameRegex: 'V5',
    field: 'context_window',
    min: 1_000_000,
    max: null,
  });
  const models = [model('DeepSeek-V5', { context_window: 2_000_000 })];

  test('all 全真为真', () => {
    const c = parseCondition({ kind: 'all', of: [nameC, rangeC] });
    expect(evaluateCondition(c, ctx(models))).toBe(true);
    const cFalse = parseCondition({ kind: 'all', of: [nameC, { kind: 'never' }] });
    expect(evaluateCondition(cFalse, ctx(models))).toBe(false);
  });

  test('any 任一真为真', () => {
    const c = parseCondition({ kind: 'any', of: [{ kind: 'never' }, nameC] });
    expect(evaluateCondition(c, ctx(models))).toBe(true);
    const cFalse = parseCondition({ kind: 'any', of: [{ kind: 'never' }, { kind: 'manual' }] });
    expect(evaluateCondition(cFalse, ctx(models))).toBe(false);
  });

  test('嵌套组合', () => {
    const c = parseCondition({
      kind: 'all',
      of: [
        { kind: 'any', of: [nameC, { kind: 'never' }] },
        {
          kind: 'first_seen_between',
          regex: 'V5',
          start: 0,
          end: null,
        },
      ],
    });
    expect(evaluateCondition(c, ctx(models, 12345))).toBe(true);
  });

  test('all/any 空数组：all 真、any 假', () => {
    expect(evaluateCondition(parseCondition({ kind: 'all', of: [] }), ctx([]))).toBe(true);
    expect(evaluateCondition(parseCondition({ kind: 'any', of: [] }), ctx([]))).toBe(false);
  });
});
