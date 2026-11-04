/** Writes the committed OpenAPI 3.1 document (docs/api/openapi.json) from the route table. */
import { mkdirSync, writeFileSync } from "node:fs";
import { buildOpenApi } from "@zeb/contracts/openapi";

mkdirSync("docs/api", { recursive: true });
const doc = buildOpenApi({ serverUrl: "https://api.zebscan.example" });
writeFileSync("docs/api/openapi.json", JSON.stringify(doc, null, 2) + "\n");
console.log(`docs/api/openapi.json: ${Object.keys(doc.paths).length} paths`);
