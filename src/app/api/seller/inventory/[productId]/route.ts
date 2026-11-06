import { z } from "zod";

import { adjustInventoryBody } from "@/server/contracts/inventory";
import { currentOwnerShopPrincipal } from "@/server/seller-identity/http-auth";
import { parseInput } from "@/server/errors";
import { readJsonWithin } from "@/server/http";
import { createSellerInventoryAdapter } from "@/server/inventory/seller-adapter";
import { inventoryHttpErrorResponse } from "@/server/inventory/http";
import { inventoryPool } from "@/server/inventory/runtime";

const productIdSchema = z.uuid();

export async function GET(request: Request, { params }: { params: Promise<{ productId: string }> }) {
  try {
    const principal = await currentOwnerShopPrincipal(request);
    const { productId } = await params;
    const id = parseInput(productIdSchema, productId);
    const adapter = createSellerInventoryAdapter(inventoryPool());
    return Response.json(await adapter.read(principal, id));
  } catch (error) {
    return inventoryHttpErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ productId: string }> }) {
  try {
    const principal = await currentOwnerShopPrincipal(request);
    const { productId } = await params;
    const id = parseInput(productIdSchema, productId);
    const body = parseInput(adjustInventoryBody, await readJsonWithin(request));
    const adapter = createSellerInventoryAdapter(inventoryPool());
    return Response.json(await adapter.adjust(principal, { productId: id, ...body }));
  } catch (error) {
    return inventoryHttpErrorResponse(error);
  }
}
