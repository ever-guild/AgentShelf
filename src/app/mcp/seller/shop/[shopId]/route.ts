import { handleSellerMcpRequest } from "@/server/mcp/seller-http";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ shopId: string }> }) {
  const { shopId } = await context.params;
  return handleSellerMcpRequest(request, shopId);
}
