import { handleSellerMcpRequest } from "@/server/mcp/seller-http";

export async function POST(request: Request) {
  return handleSellerMcpRequest(request);
}
