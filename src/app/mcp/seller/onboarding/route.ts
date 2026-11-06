import { handleSellerMcpRequest } from "@/server/mcp/seller-http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleSellerMcpRequest(request);
}
