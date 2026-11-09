// CORS：预检 204 不验签、精确 origin、错误响应带 CORS 头。
import { describe, expect, test } from 'bun:test';
import {
  parseAllowedOrigins,
  corsHeaders,
  isPreflight,
  preflightResponse,
  okResponse,
  errorResponse,
} from '../src/cors';

const ALLOWED = ['https://linux.do', 'https://preview.linux.do'];

describe('parseAllowedOrigins', () => {
  test('逗号分隔 + 去空白 + 过滤空项', () => {
    expect(parseAllowedOrigins(' https://a.com , https://b.com ,')).toEqual(['https://a.com', 'https://b.com']);
    expect(parseAllowedOrigins(undefined)).toEqual(['https://linux.do']);
  });
});

describe('corsHeaders', () => {
  test('白名单 origin 精确回 ACAO + Vary: Origin', () => {
    const h = corsHeaders({ origin: 'https://linux.do', allowedOrigins: ALLOWED });
    expect(h['Access-Control-Allow-Origin']).toBe('https://linux.do');
    expect(h['Vary']).toBe('Origin');
    expect(h['Access-Control-Allow-Methods']).toContain('GET');
    expect(h['Access-Control-Allow-Headers']).toContain('Authorization');
  });

  test('非白名单 origin 不回 ACAO，但仍带 Vary', () => {
    const h = corsHeaders({ origin: 'https://evil.com', allowedOrigins: ALLOWED });
    expect(h['Access-Control-Allow-Origin']).toBeUndefined();
    expect(h['Vary']).toBe('Origin');
  });

  test('无 Origin（非浏览器）不回 ACAO', () => {
    const h = corsHeaders({ origin: null, allowedOrigins: ALLOWED });
    expect(h['Access-Control-Allow-Origin']).toBeUndefined();
  });
});

describe('preflight', () => {
  const req = (method: string, headers: Record<string, string>) =>
    new Request('https://whale.example.com/me', { method, headers });

  test('预检 204 放行，带 CORS 头，不验签（无需 Authorization）', () => {
    const r = req('OPTIONS', {
      Origin: 'https://linux.do',
      'Access-Control-Request-Method': 'POST',
    });
    expect(isPreflight(r)).toBe(true);
    const res = preflightResponse({ origin: r.headers.get('Origin'), allowedOrigins: ALLOWED });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://linux.do');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
  });

  test('普通 OPTIONS 不是预检', () => {
    expect(isPreflight(req('OPTIONS', {}))).toBe(false);
  });
});

describe('响应构造', () => {
  test('成功响应带 CORS 头', () => {
    const res = okResponse({ a: 1 }, { origin: 'https://linux.do', allowedOrigins: ALLOWED });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://linux.do');
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });

  test('错误响应（401/500）也带 CORS 头', () => {
    for (const status of [401, 403, 500]) {
      const res = errorResponse(status, 'X', 'x', { origin: 'https://linux.do', allowedOrigins: ALLOWED });
      expect(res.status).toBe(status);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://linux.do');
    }
  });

  test('错误响应结构 {ok:false,error}', async () => {
    const res = errorResponse(400, 'BET_TOO_LARGE', '投入过大', { origin: 'https://linux.do', allowedOrigins: ALLOWED });
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('BET_TOO_LARGE');
  });
});
