// CORS：精确 origin 白名单、Vary: Origin、预检放行、所有响应（含错误）带 CORS 头。
// 参见契约第 8、12 节与 docs/workers-auth-reference.md。

export interface CorsContext {
  origin: string | null;
  allowedOrigins: string[];
}

export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? 'https://linux.do')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function corsHeaders(ctx: CorsContext): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  // 精确匹配，不用通配符；非白名单 origin 不回 ACAO。
  if (ctx.origin !== null && ctx.allowedOrigins.includes(ctx.origin)) {
    headers['Access-Control-Allow-Origin'] = ctx.origin;
  }
  return headers;
}

export function isPreflight(request: Request): boolean {
  return (
    request.method === 'OPTIONS' &&
    request.headers.has('Access-Control-Request-Method')
  );
}

export function preflightResponse(ctx: CorsContext): Response {
  // 预检直接 204 放行，不验签。
  return new Response(null, { status: 204, headers: corsHeaders(ctx) });
}

export function jsonResponse(
  body: unknown,
  status: number,
  ctx: CorsContext,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(ctx) },
  });
}

export function okResponse(data: unknown, ctx: CorsContext, status = 200): Response {
  return jsonResponse({ ok: true, data }, status, ctx);
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  ctx: CorsContext,
): Response {
  return jsonResponse({ ok: false, error: { code, message } }, status, ctx);
}
