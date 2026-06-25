import { ValidationError } from "./validation.mjs";

export function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

export function requireWriteAccess(request) {
  const expected = globalThis.Netlify?.env.get("ORG_CHART_WRITE_KEY")
    || process.env.ORG_CHART_WRITE_KEY
    || "";
  if (!expected) return;
  const provided = request.headers.get("x-org-chart-key") || "";
  if (provided !== expected) {
    const error = new Error("Неверный ключ редактирования.");
    error.status = 401;
    throw error;
  }
}

export function handleError(error) {
  console.error(error);
  if (error instanceof ValidationError) return json({ error: error.message }, 422);
  if (error instanceof SyntaxError) return json({ error: "Некорректный JSON." }, 400);
  if (error?.status) return json({ error: error.message }, error.status);
  return json({ error: "Внутренняя ошибка хранилища." }, 500);
}
