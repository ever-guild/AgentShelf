import { z } from "zod";

import { setInventoryModeBody } from "@/server/contracts/inventory";
import { currentOwnerShopPrincipal } from "@/server/seller-identity/http-auth";
import { parseInput } from "@/server/errors";
import { readJsonWithin } from "@/server/http";
import { createSellerInventoryAdapter } from "@/server/inventory/seller-adapter";
import { inventoryHttpErrorResponse } from "@/server/inventory/http";
import { inventoryPool } from "@/server/inventory/runtime";

const productIdSchema = z.uuid();

export async function PUT(request: Request, { params }: { params: Promise<{ productId: string }> }) {
  try {
    const principal = await currentOwnerShopPrincipal(request);
    const { productId } = await params;
    const id = parseInput(productIdSchema, productId);
    const decision = parseInput(setInventoryModeBody, await readJsonWithin(request));
    const adapter = createSellerInventoryAdapter(inventoryPool());
    return Response.json(await adapter.setMode(principal, { productId: id, ...decision }));
  } catch (error) {
    return inventoryHttpErrorResponse(error);
  }
}
