import "server-only";

import type { Client } from "@paypal/paypal-server-sdk";

// PayPal Catalog Products, as far as this product uses it. A record holds a name, a description and
// a type, and nothing about price or stock, so what is on sale and for how much stays local. There
// is no delete operation, and only the description and links of a record can be changed.

const CATALOG_PATH = "/v1/catalogs/products";
const MAX_NAME_LENGTH = 127;
const MAX_DESCRIPTION_LENGTH = 256;

export type CatalogRecord = {
  id: string;
  name: string;
  type: "PHYSICAL" | "SERVICE";
  description?: string;
};

// Chosen here, not by PayPal, so a record can be found again whatever happened to the answer that
// announced it. PayPal allows 6 to 50 characters, and refuses an ID that is already in use.
export function catalogRecordId(productId: string): string {
  return `AS-${productId}`;
}

const cut = (text: string, length: number) => Array.from(text).slice(0, length).join("");

export function buildCatalogRecord(product: {
  id: string;
  kind: "product" | "service";
  title: string;
  description: string;
}): CatalogRecord {
  const description = cut(product.description.trim(), MAX_DESCRIPTION_LENGTH).trim();
  return {
    id: catalogRecordId(product.id),
    name: cut(product.title.trim(), MAX_NAME_LENGTH).trim(),
    type: product.kind === "service" ? "SERVICE" : "PHYSICAL",
    ...(description ? { description } : {}),
  };
}

function readAnswer(text: string): { id?: string } {
  const answer: unknown = JSON.parse(text);
  const id =
    answer !== null && typeof answer === "object"
      ? (answer as Record<string, unknown>).id
      : undefined;
  return typeof id === "string" ? { id } : {};
}

// The SDK has no Catalog Products API, so these go through its request builder, which brings the
// same token, timeout and transport as every other call.
export async function createCatalogRecord(
  client: Client,
  record: CatalogRecord,
  requestId: string,
  paypalAuthAssertion?: string,
): Promise<{ id?: string }> {
  const request = client.getRequestBuilderFactory()("POST", CATALOG_PATH);
  request.header("Content-Type", "application/json");
  request.header("PayPal-Request-Id", requestId);
  request.header("Prefer", "return=representation");
  if (paypalAuthAssertion) request.header("PayPal-Auth-Assertion", paypalAuthAssertion);
  request.json(record);
  request.authenticate([{ oauth2: true }]);
  const { result } = await request.callAsText();
  return readAnswer(result);
}

export async function readCatalogRecord(
  client: Client,
  id: string,
  paypalAuthAssertion?: string,
): Promise<{ id?: string }> {
  const request = client.getRequestBuilderFactory()(
    "GET",
    `${CATALOG_PATH}/${encodeURIComponent(id)}`,
  );
  if (paypalAuthAssertion) request.header("PayPal-Auth-Assertion", paypalAuthAssertion);
  request.authenticate([{ oauth2: true }]);
  const { result } = await request.callAsText();
  return readAnswer(result);
}
