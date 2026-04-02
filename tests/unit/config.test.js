'use strict';

const { deepGet, deepSet, castEnvValue } = require('../../src/config');

describe('config — deepGet', () => {
  const obj = { a: { b: { c: 42 } }, x: 'hello' };

  it('gets a shallow key', () => {
    expect(deepGet(obj, 'x')).toBe('hello');
  });

  it('gets a nested key', () => {
    expect(deepGet(obj, 'a.b.c')).toBe(42);
  });

  it('returns undefined for missing key', () => {
    expect(deepGet(obj, 'a.z')).toBeUndefined();
  });

  it('returns undefined for deeply missing key', () => {
    expect(deepGet(obj, 'a.b.c.d')).toBeUndefined();
  });

  it('returns undefined for null intermediate', () => {
    expect(deepGet({ a: null }, 'a.b')).toBeUndefined();
  });
});

describe('config — deepSet', () => {
  it('sets a shallow key', () => {
    const obj = {};
    deepSet(obj, 'key', 'val');
    expect(obj.key).toBe('val');
  });

  it('sets a nested key', () => {
    const obj = {};
    deepSet(obj, 'a.b.c', 99);
    expect(obj.a.b.c).toBe(99);
  });

  it('creates intermediate objects', () => {
    const obj = {};
    deepSet(obj, 'x.y', true);
    expect(obj.x).toEqual({ y: true });
  });

  it('overwrites an existing value', () => {
    const obj = { a: { b: 1 } };
    deepSet(obj, 'a.b', 2);
    expect(obj.a.b).toBe(2);
  });

  it('replaces a non-object intermediate with an object', () => {
    const obj = { a: 'string' };
    deepSet(obj, 'a.b', 'val');
    expect(obj.a.b).toBe('val');
  });
});

describe('config — castEnvValue', () => {
  it('returns string as-is when type=string', () => {
    expect(castEnvValue('true', 'string')).toBe('true');
    expect(castEnvValue('42', 'string')).toBe('42');
  });

  it('casts "true" to boolean true', () => {
    expect(castEnvValue('true', 'auto')).toBe(true);
  });

  it('casts "false" to boolean false', () => {
    expect(castEnvValue('false', 'auto')).toBe(false);
  });

  it('casts numeric string to number', () => {
    expect(castEnvValue('3000', 'auto')).toBe(3000);
  });

  it('returns string when not a bool/number', () => {
    expect(castEnvValue('localhost', 'auto')).toBe('localhost');
  });

  it('returns string when value is blank', () => {
    expect(castEnvValue('  ', 'auto')).toBe('  ');
  });
});
