import { describe, it, expect } from 'vitest';
import { buildRenderItems, type RenderRowDescriptor } from './dataGrid.rows';

const row = (key: string, over: Partial<RenderRowDescriptor> = {}): RenderRowDescriptor => ({
  key,
  hasSecondLine: false,
  isSelected: false,
  ...over,
});

describe('buildRenderItems', () => {
  it('gera um item "row" por linha', () => {
    const items = buildRenderItems([row('a'), row('b')], false);
    expect(items).toEqual([
      { kind: 'row', rowIndex: 0, key: 'a' },
      { kind: 'row', rowIndex: 1, key: 'b' },
    ]);
  });

  it('insere o item "second" logo após a linha quando há sub-linha', () => {
    const items = buildRenderItems([row('a', { hasSecondLine: true })], false);
    expect(items.map((i) => i.kind)).toEqual(['row', 'second']);
    expect(items[1].key).toBe('a::second');
    expect(items[1].rowIndex).toBe(0);
  });

  it('insere o item "detail" só quando a linha está selecionada E há renderDetail', () => {
    expect(buildRenderItems([row('a', { isSelected: true })], false).map((i) => i.kind)).toEqual(['row']);
    expect(buildRenderItems([row('a', { isSelected: true })], true).map((i) => i.kind)).toEqual(['row', 'detail']);
  });

  it('respeita a ordem row → second → detail na mesma linha', () => {
    const items = buildRenderItems([row('a', { hasSecondLine: true, isSelected: true })], true);
    expect(items.map((i) => i.kind)).toEqual(['row', 'second', 'detail']);
    expect(items.every((i) => i.rowIndex === 0)).toBe(true);
    expect(items.map((i) => i.key)).toEqual(['a', 'a::second', 'a::detail']);
  });
});
