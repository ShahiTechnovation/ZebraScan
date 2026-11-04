/** OpenAPI 3.1 document generated from the route table + Zod schemas (zod v4 native JSON Schema). */
import { z } from "zod";
import { ErrorZ } from "./schemas";
import { ROUTES, type RouteDef } from "./routes";

function schema(t: z.ZodType, io: "input" | "output") {
  return z.toJSONSchema(t, { target: "draft-2020-12", io, unrepresentable: "any" });
}

export function buildOpenApi(opts: { environment?: string; serverUrl?: string; includeDemo?: boolean } = {}) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const def of Object.values(ROUTES) as RouteDef[]) {
    if (def.demoOnly && !opts.includeDemo) continue;
    const p = def.path.replace(/:([a-zA-Z]+)/g, "{$1}");
    const parameters: unknown[] = [];
    for (const [name] of Object.entries(def.params?.shape ?? {})) parameters.push({ name, in: "path", required: true, schema: { type: "string" } });
    for (const [name, s] of Object.entries(def.query?.shape ?? {})) parameters.push({ name, in: "query", required: false, schema: schema(s as z.ZodType, "input") });
    parameters.push({ name: "X-Request-Id", in: "header", required: false, schema: { type: "string", maxLength: 100 } });
    if (def.idempotent) parameters.push({ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8, maxLength: 100 } });
    const security =
      def.auth === "public"
        ? []
        : def.auth === "scoped"
          ? [{ checkoutToken: [] }, { sessionCookie: [] }]
          : def.auth === "internal"
            ? [{ mtls: [] }]
            : [{ sessionCookie: [], csrf: [] }];
    (paths[p] ??= {})[def.method.toLowerCase()] = {
      operationId: def.operationId,
      summary: def.summary,
      tags: def.tags,
      parameters,
      security,
      "x-zeb-auth": def.auth,
      ...(def.stepUp ? { "x-zeb-step-up": true } : {}),
      ...(def.dualControl ? { "x-zeb-dual-control": true } : {}),
      ...(def.permission ? { "x-zeb-permission": def.permission } : {}),
      ...(def.body ? { requestBody: { required: true, content: { "application/json": { schema: schema(def.body, "input") } } } } : {}),
      responses: {
        [String(def.status ?? 200)]: { description: "OK", content: { "application/json": { schema: schema(def.response, "output") } } },
        default: { description: "Error (RFC 7807-style)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
    };
  }
  paths["/api/v1/events"] = {
    get: {
      operationId: "streamEvents",
      summary: "Server-Sent Events for one resource (checkout:{id} | withdrawal:{id} | merchant:me). Supports Last-Event-ID replay and heartbeats.",
      tags: ["events"],
      parameters: [
        { name: "resource", in: "query", required: true, schema: { type: "string" } },
        { name: "access_token", in: "query", required: false, schema: { type: "string" } },
        { name: "Last-Event-ID", in: "header", required: false, schema: { type: "string" } },
      ],
      responses: { "200": { description: "text/event-stream", content: { "text/event-stream": { schema: { type: "string" } } } } },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Zeb Scan API",
      version: "1.0.0",
      description: "Pay in ZEC. They get INR. Money fields are integer minor-unit strings (INR paise, ZEC zatoshis, USDC micros).",
    },
    servers: [{ url: opts.serverUrl ?? "/" }],
    paths,
    components: {
      schemas: { Error: schema(ErrorZ, "output") },
      securitySchemes: {
        sessionCookie: { type: "apiKey", in: "cookie", name: "zeb_session" },
        csrf: { type: "apiKey", in: "header", name: "X-CSRF-Token" },
        checkoutToken: { type: "http", scheme: "bearer", description: "Scoped checkout access token returned at intent creation" },
        mtls: { type: "mutualTLS" },
      },
    },
  };
}
